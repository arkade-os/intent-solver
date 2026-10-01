import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { UniqueConstraintError, type SqlDriver } from '@arkade-os/solver-core/core/driver.js'
import type { JsonRpc } from '@arkade-os/solver-core/ports/evm.js'
import { addressFromPrivateKey, createAddress, decodeSignedTransaction, signTransaction } from './transaction.js'

export interface DurableEvmRequest {
  to: Uint8Array | null
  data: Uint8Array
}
export interface DurableEvmFees {
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
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
  replace(
    id: string,
    request: DurableEvmRequest,
    fees: DurableEvmFees,
    maxFeeCeiling: bigint,
  ): Promise<DurableEvmAttempt>
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
type AttemptRow = {
  id: string
  sequence: number
  raw: string
  hash: string
  max_fee: string
  tip: string
  ceiling: string
  state: string
}
type StoredRequest = {
  chain: string
  account: string
  to: string | null
  data: string
  gas: string
  maxFee: string
  tip: string
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
const requestBytes = (stored: StoredRequest): DurableEvmRequest => ({
  to: stored.to === null ? null : hexToBytes(stored.to.slice(2)),
  data: hexToBytes(stored.data.slice(2)),
})

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
  await deps.driver.exec(`CREATE TABLE IF NOT EXISTS evm_transaction_attempts (
    id TEXT NOT NULL, sequence INTEGER NOT NULL, raw TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
    max_fee TEXT NOT NULL, tip TEXT NOT NULL, ceiling TEXT NOT NULL, state TEXT NOT NULL,
    PRIMARY KEY(id, sequence)
  )`)
  const oldRows = await deps.driver.all<Row>('SELECT * FROM evm_transaction_journal')
  for (const row of oldRows) {
    const decoded = decodeSignedTransaction(hexToBytes(row.raw.slice(2)))
    await deps.driver.run(
      'INSERT OR IGNORE INTO evm_transaction_attempts (id, sequence, raw, hash, max_fee, tip, ceiling, state) VALUES (?, 0, ?, ?, ?, ?, ?, ?)',
      [
        row.id,
        row.raw,
        row.hash,
        decoded.fields.maxFeePerGas.toString(),
        decoded.fields.maxPriorityFeePerGas.toString(),
        decoded.fields.maxFeePerGas.toString(),
        row.state,
      ],
    )
  }
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
  const storedRequest = (row: Row): StoredRequest => {
    const stored = JSON.parse(row.request) as StoredRequest
    if (stored.chain !== row.chain_id || stored.account !== row.account || !stored.gas || !stored.maxFee || !stored.tip)
      throw new Error('corrupt transaction journal')
    return stored
  }
  const validateIdentity = (row: Row, request: DurableEvmRequest): StoredRequest => {
    const stored = storedRequest(row)
    if (row.chain_id !== chain || row.account !== account || stored.chain !== chain || stored.account !== account)
      throw new Error('transaction identity reused with changed chain or account')
    if (
      stored.to !== (request.to === null ? null : hx(request.to)) ||
      stored.data !== hx(request.data) ||
      (request.to !== null && request.to.length !== 20)
    )
      throw new Error('transaction identity reused with changed request')
    if (!/^[0-9a-f]{16}$/.test(row.nonce)) throw new Error('corrupt transaction journal')
    return stored
  }
  const validateAttempt = (row: Row, attempt: AttemptRow, stored: StoredRequest): DurableEvmAttempt => {
    if (!/^0x[0-9a-f]+$/.test(attempt.raw) || !/^0x[0-9a-f]+$/.test(attempt.hash))
      throw new Error('corrupt transaction journal')
    const decoded = decodeSignedTransaction(hexToBytes(attempt.raw.slice(2)))
    const fields = decoded.fields
    const nonce = BigInt(`0x${row.nonce}`)
    if (
      fields.chainId !== BigInt(stored.chain) ||
      fields.nonce !== nonce ||
      hx(decoded.from) !== row.account ||
      fields.value !== 0n ||
      hx(fields.to) !== (stored.to === null ? '0x' : stored.to) ||
      hx(fields.data) !== stored.data ||
      fields.gas !== BigInt(stored.gas) ||
      fields.maxFeePerGas !== BigInt(attempt.max_fee) ||
      fields.maxPriorityFeePerGas !== BigInt(attempt.tip) ||
      fields.maxFeePerGas > BigInt(attempt.ceiling) ||
      hx(decoded.hash) !== attempt.hash
    )
      throw new Error('persisted signed transaction does not authorize requested call')
    return {
      id: row.id,
      hash: attempt.hash,
      nonce,
      createdAddress: stored.to === null ? createAddress(from, nonce) : null,
      state: attempt.state,
      rawTransaction: attempt.raw,
    }
  }
  const attempts = (id: string): Promise<AttemptRow[]> =>
    deps.driver.all<AttemptRow>('SELECT * FROM evm_transaction_attempts WHERE id = ? ORDER BY sequence', [id])
  const latest = async (id: string): Promise<AttemptRow> => {
    const row = await deps.driver.get<AttemptRow>(
      'SELECT * FROM evm_transaction_attempts WHERE id = ? ORDER BY sequence DESC LIMIT 1',
      [id],
    )
    if (!row) throw new Error('transaction has no durable signed attempt')
    await deps.driver.run('UPDATE evm_transaction_journal SET raw = ?, hash = ? WHERE id = ?', [row.raw, row.hash, id])
    return row
  }
  const canonicalReceipt = async (hash: string): Promise<'success' | 'reverted' | null> => {
    const receipt = (await deps.rpc('eth_getTransactionReceipt', [hash]).catch(() => null)) as {
      transactionHash?: unknown
      blockHash?: unknown
      blockNumber?: unknown
      status?: unknown
    } | null
    if (receipt === null) return null
    if (
      typeof receipt.transactionHash !== 'string' ||
      receipt.transactionHash.toLowerCase() !== hash ||
      typeof receipt.blockHash !== 'string' ||
      !/^0x[0-9a-f]{64}$/i.test(receipt.blockHash) ||
      typeof receipt.blockNumber !== 'string' ||
      typeof receipt.status !== 'string'
    )
      throw new Error('invalid transaction receipt')
    const header = (await deps.rpc('eth_getBlockByNumber', [receipt.blockNumber, false]).catch(() => null)) as {
      hash?: unknown
    } | null
    if (typeof header?.hash !== 'string' || header.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) return null
    const status = quantity(receipt.status)
    if (status > 1n) throw new Error('invalid transaction receipt status')
    return status === 1n ? 'success' : 'reverted'
  }
  const reconcile = async (row: Row, request: DurableEvmRequest): Promise<DurableEvmAttempt | null> => {
    const stored = validateIdentity(row, request)
    await latest(row.id)
    const history = await attempts(row.id)
    for (const item of history) {
      const attempt = validateAttempt(row, item, stored)
      const outcome = await canonicalReceipt(attempt.hash)
      if (outcome) {
        await deps.driver.run('UPDATE evm_transaction_attempts SET state = ? WHERE id = ? AND sequence = ?', [
          outcome,
          row.id,
          item.sequence,
        ])
        return { ...attempt, state: outcome }
      }
    }
    return null
  }
  const prepare = async (id: string, request: DurableEvmRequest): Promise<DurableEvmAttempt> => {
    if (!id || id.length > 256) throw new Error('invalid transaction identity')
    const encodedRequest = requestText(request)
    if (quantity(await deps.rpc('eth_chainId', [])) !== deps.chainId) throw new Error('signing RPC chain mismatch')
    for (let attempt = 0; attempt < 64; attempt++) {
      const existing = await deps.driver.get<Row>('SELECT * FROM evm_transaction_journal WHERE id = ?', [id])
      if (existing) {
        validateIdentity(existing, request)
        const winner = await reconcile(existing, request)
        return winner ?? validateAttempt(existing, await latest(id), storedRequest(existing))
      }
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
      const initial: AttemptRow = {
        id,
        sequence: 0,
        raw: row.raw,
        hash: row.hash,
        max_fee: deps.maxFeePerGas.toString(),
        tip: deps.maxPriorityFeePerGas.toString(),
        ceiling: deps.maxFeePerGas.toString(),
        state: 'prepared',
      }
      validateAttempt(row, initial, storedRequest(row))
      try {
        await deps.driver.transaction(async () => {
          await deps.driver.run(
            'INSERT INTO evm_transaction_journal (id, chain_id, account, nonce, request, raw, hash, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [id, chain, account, row.nonce, encodedRequest, row.raw, row.hash, row.state],
          )
          await deps.driver.run(
            'INSERT INTO evm_transaction_attempts (id, sequence, raw, hash, max_fee, tip, ceiling, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [
              id,
              initial.sequence,
              initial.raw,
              initial.hash,
              initial.max_fee,
              initial.tip,
              initial.ceiling,
              initial.state,
            ],
          )
        })
        return validateAttempt(row, initial, storedRequest(row))
      } catch (error) {
        if (!(error instanceof UniqueConstraintError)) throw error
      }
    }
    throw new Error('transaction reservation contention exceeded limit')
  }
  const submit = async (id: string, request: DurableEvmRequest): Promise<DurableEvmAttempt> => {
    const prepared = await prepare(id, request)
    if (prepared.state === 'success' || prepared.state === 'reverted') return prepared
    const row = await deps.driver.get<Row>('SELECT * FROM evm_transaction_journal WHERE id = ?', [id])
    if (!row) throw new Error('transaction journal disappeared')
    validateIdentity(row, request)
    const item = await latest(id)
    const current = validateAttempt(row, item, storedRequest(row))
    await deps.driver.run("UPDATE evm_transaction_attempts SET state = 'submitting' WHERE id = ? AND sequence = ?", [
      id,
      item.sequence,
    ])
    try {
      const returnedHash = await deps.rpc('eth_sendRawTransaction', [item.raw])
      if (typeof returnedHash !== 'string' || returnedHash.toLowerCase() !== current.hash)
        throw new Error('RPC returned wrong transaction hash')
      await deps.driver.run("UPDATE evm_transaction_attempts SET state = 'submitted' WHERE id = ? AND sequence = ?", [
        id,
        item.sequence,
      ])
      await deps.driver.run("UPDATE evm_transaction_journal SET state = 'submitted' WHERE id = ?", [id])
      return { ...current, state: 'submitted' }
    } catch {
      await deps.driver.run("UPDATE evm_transaction_attempts SET state = 'unknown' WHERE id = ? AND sequence = ?", [
        id,
        item.sequence,
      ])
      await deps.driver.run("UPDATE evm_transaction_journal SET state = 'unknown' WHERE id = ?", [id])
      const winner = await reconcile(row, request)
      return winner ?? { ...current, state: 'unknown' }
    }
  }
  return {
    async getPrepared(id, request) {
      const row = await deps.driver.get<Row>('SELECT * FROM evm_transaction_journal WHERE id = ?', [id])
      if (!row) return null
      validateIdentity(row, request)
      return (await reconcile(row, request)) ?? validateAttempt(row, await latest(id), storedRequest(row))
    },
    prepare,
    submit,
    async replace(id, request, fees, maxFeeCeiling) {
      const row = await deps.driver.get<Row>('SELECT * FROM evm_transaction_journal WHERE id = ?', [id])
      if (!row) throw new Error('transaction identity has no original authorization')
      const stored = validateIdentity(row, request)
      const winner = await reconcile(row, request)
      if (winner) return winner
      const prior = await latest(id)
      const current = validateAttempt(row, prior, stored)
      const minBump = (value: bigint): bigint => (value * 110n + 99n) / 100n
      if (
        maxFeeCeiling < 0n ||
        fees.maxPriorityFeePerGas < minBump(BigInt(prior.tip)) ||
        fees.maxPriorityFeePerGas <= BigInt(prior.tip) ||
        fees.maxFeePerGas < minBump(BigInt(prior.max_fee)) ||
        fees.maxFeePerGas <= BigInt(prior.max_fee) ||
        fees.maxPriorityFeePerGas > fees.maxFeePerGas ||
        fees.maxFeePerGas > maxFeeCeiling
      )
        throw new Error('replacement fees do not satisfy the authorized fee bump and ceiling')
      const signed = signTransaction(
        {
          chainId: BigInt(stored.chain),
          nonce: current.nonce,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          maxFeePerGas: fees.maxFeePerGas,
          gas: BigInt(stored.gas),
          to: request.to ?? new Uint8Array(),
          value: 0n,
          data: request.data,
        },
        deps.privateKey,
      )
      const sequence = prior.sequence + 1
      const replacement: AttemptRow = {
        id,
        sequence,
        raw: hx(signed.raw),
        hash: hx(signed.hash),
        max_fee: fees.maxFeePerGas.toString(),
        tip: fees.maxPriorityFeePerGas.toString(),
        ceiling: maxFeeCeiling.toString(),
        state: 'prepared',
      }
      validateAttempt(row, replacement, stored)
      await deps.driver.run(
        'INSERT INTO evm_transaction_attempts (id, sequence, raw, hash, max_fee, tip, ceiling, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          id,
          sequence,
          replacement.raw,
          replacement.hash,
          replacement.max_fee,
          replacement.tip,
          replacement.ceiling,
          replacement.state,
        ],
      )
      await deps.driver.run("UPDATE evm_transaction_journal SET raw = ?, hash = ?, state = 'prepared' WHERE id = ?", [
        replacement.raw,
        replacement.hash,
        id,
      ])
      return submit(id, request)
    },
    async replay(id, request) {
      const row = await deps.driver.get<Row>('SELECT * FROM evm_transaction_journal WHERE id = ?', [id])
      if (!row) throw new Error('original transaction has no durable authorization')
      validateIdentity(row, request)
      return submit(id, request)
    },
    async pending() {
      const rows = await deps.driver.all<Row>(
        'SELECT * FROM evm_transaction_journal WHERE chain_id = ? AND account = ? ORDER BY nonce',
        [chain, account],
      )
      const pending: (DurableEvmAttempt & { request: DurableEvmRequest; operation: 'deployment' | 'call' })[] = []
      for (const row of rows) {
        const stored = storedRequest(row)
        const request = requestBytes(stored)
        if (await reconcile(row, request)) continue
        const attempt = validateAttempt(row, await latest(row.id), stored)
        pending.push({ ...attempt, request, operation: request.to === null ? 'deployment' : 'call' })
      }
      return pending
    },
    async broadcastRawTransaction(rawTransaction) {
      if (!/^0x(?:[0-9a-f]{2})+$/i.test(rawTransaction)) throw new Error('invalid signed transaction bytes')
      const decoded = decodeSignedTransaction(hexToBytes(rawTransaction.slice(2)))
      const item = await deps.driver.get<AttemptRow>('SELECT * FROM evm_transaction_attempts WHERE hash = ?', [
        hx(decoded.hash),
      ])
      if (!item || item.raw !== rawTransaction.toLowerCase())
        throw new Error('signed transaction has no matching durable authorization')
      const row = await deps.driver.get<Row>('SELECT * FROM evm_transaction_journal WHERE id = ?', [item.id])
      if (!row) throw new Error('signed transaction has no matching durable authorization')
      return submit(row.id, requestBytes(storedRequest(row)))
    },
  }
}
