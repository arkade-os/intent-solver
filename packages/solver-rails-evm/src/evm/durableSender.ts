import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { UniqueConstraintError, type SqlDriver } from '@arkade-os/solver-core/core/driver.js'
import type { JsonRpc } from '@arkade-os/solver-core/ports/evm.js'
import { addressFromPrivateKey, createAddress, decodeSignedTransaction, signTransaction } from './transaction.js'

export interface DurableEvmRequest {
  to: Uint8Array | null
  data: Uint8Array
}
export interface DurableEvmAttempt {
  id: string
  hash: string
  nonce: bigint
  createdAddress: Uint8Array | null
  state: string
  rawTransaction: string
}
export interface DurableEvmSender {
  getPrepared(id: string, request: DurableEvmRequest): Promise<DurableEvmAttempt | null>
  prepare(id: string, request: DurableEvmRequest): Promise<DurableEvmAttempt>
  submit(id: string, request: DurableEvmRequest): Promise<DurableEvmAttempt>
  replay(id: string, request: DurableEvmRequest): Promise<DurableEvmAttempt>
  broadcastRawTransaction(rawTransaction: string): Promise<DurableEvmAttempt>
  pending(): Promise<(DurableEvmAttempt & { request: DurableEvmRequest; operation: 'deployment' | 'call' })[]>
}
export interface DurableEvmSenderDeps {
  driver: SqlDriver
  rpc: JsonRpc
  chainId: bigint
  privateKey: Uint8Array
  gasLimit: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}
type Row = {
  id: string
  chain_id: string
  account: string
  nonce: string
  request: string
  raw: string
  hash: string
  state: string
}
const hx = (bytes: Uint8Array): string => `0x${bytesToHex(bytes)}`
const nonceKey = (nonce: bigint): string => {
  if (nonce < 0n || nonce >= 2n ** 64n - 1n) throw new Error('nonce out of EVM range')
  return nonce.toString(16).padStart(16, '0')
}
const quantity = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw new Error('invalid EVM quantity')
  return BigInt(value)
}

export const createDurableEvmSender = async (deps: DurableEvmSenderDeps): Promise<DurableEvmSender> => {
  if (
    deps.chainId <= 0n ||
    deps.gasLimit <= 0n ||
    deps.maxPriorityFeePerGas < 0n ||
    deps.maxFeePerGas < deps.maxPriorityFeePerGas
  )
    throw new Error('invalid EVM signing policy')
  const from = addressFromPrivateKey(deps.privateKey)
  const account = hx(from)
  const chain = deps.chainId.toString()
  await deps.driver.exec(`CREATE TABLE IF NOT EXISTS evm_transaction_journal (
    id TEXT PRIMARY KEY, chain_id TEXT NOT NULL, account TEXT NOT NULL, nonce TEXT NOT NULL,
    request TEXT NOT NULL, raw TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL,
    UNIQUE(chain_id, account, nonce), UNIQUE(hash)
  )`)
  const requestText = (request: DurableEvmRequest): string => {
    if (request.to !== null && request.to.length !== 20) throw new Error('destination must be 20 bytes')
    return JSON.stringify({
      chain,
      account,
      to: request.to === null ? null : hx(request.to),
      data: hx(request.data),
      gas: deps.gasLimit.toString(),
      maxFee: deps.maxFeePerGas.toString(),
      tip: deps.maxPriorityFeePerGas.toString(),
    })
  }
  const validate = (row: Row, request: DurableEvmRequest): DurableEvmAttempt => {
    if (row.chain_id !== chain || row.account !== account || row.request !== requestText(request))
      throw new Error('transaction identity reused with changed request or signing policy')
    if (!/^[0-9a-f]{16}$/.test(row.nonce) || !/^0x[0-9a-f]+$/.test(row.raw))
      throw new Error('corrupt transaction journal')
    const decoded = decodeSignedTransaction(hexToBytes(row.raw.slice(2)))
    const fields = decoded.fields
    const nonce = BigInt(`0x${row.nonce}`)
    if (
      fields.chainId !== deps.chainId ||
      fields.nonce !== nonce ||
      hx(decoded.from) !== account ||
      fields.value !== 0n ||
      hx(fields.to) !== (request.to === null ? '0x' : hx(request.to)) ||
      hx(fields.data) !== hx(request.data) ||
      fields.gas !== deps.gasLimit ||
      fields.maxFeePerGas !== deps.maxFeePerGas ||
      fields.maxPriorityFeePerGas !== deps.maxPriorityFeePerGas ||
      hx(decoded.hash) !== row.hash
    )
      throw new Error('persisted signed transaction does not authorize requested call')
    return {
      id: row.id,
      hash: row.hash,
      nonce,
      createdAddress: request.to === null ? createAddress(from, nonce) : null,
      state: row.state,
      rawTransaction: row.raw,
    }
  }
  const prepare = async (id: string, request: DurableEvmRequest): Promise<DurableEvmAttempt> => {
    if (!id || id.length > 256) throw new Error('invalid transaction identity')
    const encodedRequest = requestText(request)
    if (quantity(await deps.rpc('eth_chainId', [])) !== deps.chainId) throw new Error('signing RPC chain mismatch')
    for (let attempt = 0; attempt < 64; attempt++) {
      const existing = await deps.driver.get<Row>('SELECT * FROM evm_transaction_journal WHERE id = ?', [id])
      if (existing) return validate(existing, request)
      const pending = quantity(await deps.rpc('eth_getTransactionCount', [account, 'pending']))
      const high = await deps.driver.get<{ nonce: string }>(
        'SELECT nonce FROM evm_transaction_journal WHERE chain_id = ? AND account = ? ORDER BY nonce DESC LIMIT 1',
        [chain, account],
      )
      const mark = high ? BigInt(`0x${high.nonce}`) + 1n : 0n
      if (high && mark > pending)
        throw new Error('unresolved earlier nonce blocks this signing account; reconcile its durable transaction')
      const nonce = pending > mark ? pending : mark
      const signed = signTransaction(
        {
          chainId: deps.chainId,
          nonce,
          maxPriorityFeePerGas: deps.maxPriorityFeePerGas,
          maxFeePerGas: deps.maxFeePerGas,
          gas: deps.gasLimit,
          to: request.to ?? new Uint8Array(),
          value: 0n,
          data: request.data,
        },
        deps.privateKey,
      )
      const row: Row = {
        id,
        chain_id: chain,
        account,
        nonce: nonceKey(nonce),
        request: encodedRequest,
        raw: hx(signed.raw),
        hash: hx(signed.hash),
        state: 'prepared',
      }
      validate(row, request)
      try {
        await deps.driver.run(
          'INSERT INTO evm_transaction_journal (id, chain_id, account, nonce, request, raw, hash, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [id, chain, account, row.nonce, encodedRequest, row.raw, row.hash, row.state],
        )
        return validate(row, request)
      } catch (error) {
        if (!(error instanceof UniqueConstraintError)) throw error
      }
    }
    throw new Error('transaction reservation contention exceeded limit')
  }
  const submit = async (id: string, request: DurableEvmRequest): Promise<DurableEvmAttempt> => {
    const prepared = await prepare(id, request)
    const row = await deps.driver.get<Row>('SELECT * FROM evm_transaction_journal WHERE id = ?', [id])
    if (!row) throw new Error('transaction journal disappeared')
    validate(row, request)
    await deps.driver.run("UPDATE evm_transaction_journal SET state = 'submitting' WHERE id = ?", [id])
    try {
      const returnedHash = await deps.rpc('eth_sendRawTransaction', [row.raw])
      if (typeof returnedHash !== 'string' || returnedHash.toLowerCase() !== prepared.hash)
        throw new Error('RPC returned wrong transaction hash')
      await deps.driver.run("UPDATE evm_transaction_journal SET state = 'submitted' WHERE id = ?", [id])
      return { ...prepared, state: 'submitted' }
    } catch (error) {
      await deps.driver.run("UPDATE evm_transaction_journal SET state = 'unknown' WHERE id = ?", [id])
      const receipt = await deps.rpc('eth_getTransactionReceipt', [prepared.hash]).catch(() => null)
      if (receipt !== null) return { ...prepared, state: 'unknown' }
      const known = (await deps.rpc('eth_getTransactionByHash', [prepared.hash]).catch(() => null)) as {
        hash?: unknown
      } | null
      if (typeof known?.hash === 'string' && known.hash.toLowerCase() === prepared.hash)
        return { ...prepared, state: 'unknown' }
      throw error
    }
  }
  return {
    async getPrepared(id, request) {
      const row = await deps.driver.get<Row>('SELECT * FROM evm_transaction_journal WHERE id = ?', [id])
      return row ? validate(row, request) : null
    },
    prepare,
    submit,
    async replay(id, request) {
      const row = await deps.driver.get<Row>('SELECT * FROM evm_transaction_journal WHERE id = ?', [id])
      if (!row) throw new Error('original transaction has no durable authorization')
      validate(row, request)
      return submit(id, request)
    },
    async pending() {
      const rows = await deps.driver.all<Row>(
        'SELECT * FROM evm_transaction_journal WHERE chain_id = ? AND account = ? ORDER BY nonce',
        [chain, account],
      )
      const attempts: (DurableEvmAttempt & { request: DurableEvmRequest; operation: 'deployment' | 'call' })[] = []
      for (const row of rows) {
        const stored = JSON.parse(row.request) as { to: string | null; data: string }
        const request = {
          to: stored.to === null ? null : hexToBytes(stored.to.slice(2)),
          data: hexToBytes(stored.data.slice(2)),
        }
        const attempt = validate(row, request)
        const receipt = (await deps.rpc('eth_getTransactionReceipt', [attempt.hash])) as {
          transactionHash?: unknown
        } | null
        if (receipt === null)
          attempts.push({ ...attempt, request, operation: request.to === null ? 'deployment' : 'call' })
        else if (typeof receipt.transactionHash !== 'string' || receipt.transactionHash.toLowerCase() !== attempt.hash)
          throw new Error('invalid pending transaction receipt')
      }
      return attempts
    },
    async broadcastRawTransaction(rawTransaction) {
      if (!/^0x(?:[0-9a-f]{2})+$/i.test(rawTransaction)) throw new Error('invalid signed transaction bytes')
      const decoded = decodeSignedTransaction(hexToBytes(rawTransaction.slice(2)))
      const row = await deps.driver.get<Row>('SELECT * FROM evm_transaction_journal WHERE hash = ?', [hx(decoded.hash)])
      if (!row || row.raw !== rawTransaction.toLowerCase())
        throw new Error('signed transaction has no matching durable authorization')
      const stored = JSON.parse(row.request) as { to: string | null; data: string }
      const request = {
        to: stored.to === null ? null : hexToBytes(stored.to.slice(2)),
        data: hexToBytes(stored.data.slice(2)),
      }
      validate(row, request)
      return submit(row.id, request)
    },
  }
}
