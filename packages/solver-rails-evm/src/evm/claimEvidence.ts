import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import { EvmClaimVerificationError, type Erc20SwapLock, type JsonRpc } from '@arkade-os/solver-core/ports/evm.js'
import { CLAIM_FOR_SIGNATURE, addressWord, claimEventTopic, encodeClaim, selectorFor, uintWord } from './erc20Swap.js'

export interface EvmClaimFinalityPolicy {
  minConfirmations: number
  minAgeSeconds: number
  nowSeconds: number
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
const quantity = (value: unknown): bigint | null =>
  typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value) ? BigInt(value) : null
const fixedHex = (value: unknown, length: number): string | null =>
  typeof value === 'string' && new RegExp(`^0x[0-9a-f]{${length * 2}}$`, 'i').test(value) ? value.toLowerCase() : null
const hex = (value: Uint8Array): string => `0x${bytesToHex(value)}`

const claimPreimage = (value: unknown, contract: string, lock: Erc20SwapLock): string | null => {
  const log = object(value)
  if (!log || fixedHex(log.address, 20) !== contract) return null
  if (
    !Array.isArray(log.topics) ||
    log.topics.length !== 2 ||
    fixedHex(log.topics[0], 32) !== hex(claimEventTopic()) ||
    fixedHex(log.topics[1], 32) !== hex(lock.preimageHash)
  )
    return null
  const preimage = fixedHex(log.data, 32)
  if (preimage === null || hex(sha256(hexToBytes(preimage.slice(2)))) !== hex(lock.preimageHash)) return null
  return preimage
}

const eventPreimage = (value: unknown, contract: string, lock: Erc20SwapLock): string | null => {
  const log = object(value)
  return log && (log.removed === undefined || log.removed === false) ? claimPreimage(log, contract, lock) : null
}

const MAX_TRACE_NODES = 256
const MAX_TRACE_DEPTH = 32
const TRACE_FRAME_TYPES = new Set([
  'CALL',
  'CALLCODE',
  'DELEGATECALL',
  'STATICCALL',
  'CREATE',
  'CREATE2',
  'SELFDESTRUCT',
])
const failed = (frame: Record<string, unknown>): boolean =>
  frame.error !== undefined && frame.error !== null && frame.error !== ''

export const verifyEvmClaimEvidence = async (
  rpc: JsonRpc,
  contractAddress: Uint8Array,
  lock: Erc20SwapLock,
  candidate: unknown,
  policy: EvmClaimFinalityPolicy,
): Promise<Uint8Array | null> => {
  if (contractAddress.length !== 20) throw new Error('Claim contract must be a 20-byte address')
  if (
    !Number.isSafeInteger(policy.minConfirmations) ||
    policy.minConfirmations < 0 ||
    !Number.isSafeInteger(policy.minAgeSeconds) ||
    policy.minAgeSeconds < 0 ||
    !Number.isSafeInteger(policy.nowSeconds) ||
    policy.nowSeconds < 0
  )
    throw new Error('Invalid claim finality policy')
  const contract = hex(contractAddress)
  const log = object(candidate)
  const preimageHex = eventPreimage(log, contract, lock)
  if (!log || preimageHex === null) return null
  const txHash = fixedHex(log.transactionHash, 32)
  const blockHash = fixedHex(log.blockHash, 32)
  const blockNumber = quantity(log.blockNumber)
  const logIndex = quantity(log.logIndex)
  if (!txHash || !blockHash || blockNumber === null || logIndex === null) return null
  const receipt = object(await rpc('eth_getTransactionReceipt', [txHash]))
  if (
    !receipt ||
    quantity(receipt.status) !== 1n ||
    fixedHex(receipt.transactionHash, 32) !== txHash ||
    fixedHex(receipt.blockHash, 32) !== blockHash ||
    quantity(receipt.blockNumber) !== blockNumber ||
    !Array.isArray(receipt.logs)
  )
    return null
  const included = receipt.logs.some((value) => {
    const entry = object(value)
    return (
      entry !== null &&
      eventPreimage(entry, contract, lock) === preimageHex &&
      fixedHex(entry.transactionHash, 32) === txHash &&
      fixedHex(entry.blockHash, 32) === blockHash &&
      quantity(entry.blockNumber) === blockNumber &&
      quantity(entry.logIndex) === logIndex
    )
  })
  if (!included) return null
  const transaction = object(await rpc('eth_getTransactionByHash', [txHash]))
  const transactionTo = fixedHex(transaction?.to, 20)
  if (
    !transaction ||
    fixedHex(transaction.hash, 32) !== txHash ||
    transactionTo === null ||
    fixedHex(receipt.to, 20) !== transactionTo ||
    fixedHex(transaction.blockHash, 32) !== blockHash ||
    quantity(transaction.blockNumber) !== blockNumber
  )
    return null
  const sender = fixedHex(transaction.from, 20)
  if (sender === null || fixedHex(receipt.from, 20) !== sender) return null
  const preimage = hexToBytes(preimageHex.slice(2))
  const claimSelf = hex(encodeClaim(preimage, lock))
  const claimFor = hex(
    concatBytes(
      selectorFor(CLAIM_FOR_SIGNATURE),
      preimage,
      uintWord(lock.amount, 'amount'),
      addressWord(lock.tokenAddress, 'tokenAddress'),
      addressWord(lock.claimAddress, 'claimAddress'),
      addressWord(lock.refundAddress, 'refundAddress'),
      uintWord(lock.timelock, 'timelock'),
    ),
  )
  const input = typeof transaction.input === 'string' ? transaction.input.toLowerCase() : null
  const directClaim =
    transactionTo === contract && (input === claimFor || (input === claimSelf && sender === hex(lock.claimAddress)))
  if (
    !directClaim &&
    !(await nestedClaimExecuted(
      rpc,
      txHash,
      transaction,
      sender,
      transactionTo,
      input,
      contract,
      lock,
      claimFor,
      claimSelf,
      preimageHex,
      receipt.logs,
    ))
  )
    return null
  const tag = `0x${blockNumber.toString(16)}`
  const header = object(await rpc('eth_getBlockByNumber', [tag, false]))
  const timestamp = quantity(header?.timestamp)
  if (
    !header ||
    fixedHex(header.hash, 32) !== blockHash ||
    quantity(header.number) !== blockNumber ||
    timestamp === null ||
    timestamp > BigInt(Number.MAX_SAFE_INTEGER) ||
    policy.nowSeconds - Number(timestamp) < policy.minAgeSeconds
  )
    return null
  const tip = quantity(await rpc('eth_blockNumber', []))
  if (tip === null || tip < blockNumber || tip - blockNumber + 1n < BigInt(Math.max(1, policy.minConfirmations)))
    return null
  // Re-read after the receipt/transaction checks so a replacement canonical block invalidates the evidence.
  const current = object(await rpc('eth_getBlockByNumber', [tag, false]))
  if (!current || fixedHex(current.hash, 32) !== blockHash || quantity(current.number) !== blockNumber) return null
  return preimage
}

const nestedClaimExecuted = async (
  rpc: JsonRpc,
  txHash: string,
  transaction: Record<string, unknown>,
  sender: string,
  transactionTo: string,
  input: string | null,
  contract: string,
  lock: Erc20SwapLock,
  claimFor: string,
  claimSelf: string,
  preimage: string,
  receiptLogs: unknown[],
): Promise<boolean> => {
  if (input === null) throw new EvmClaimVerificationError('claim transaction has no usable root calldata')
  if (transactionTo === contract) return false
  let traceValue: unknown
  try {
    traceValue = await rpc('debug_traceTransaction', [
      txHash,
      { tracer: 'callTracer', tracerConfig: { withLog: true } },
    ])
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 256)
    throw new EvmClaimVerificationError(`claim transaction trace ${txHash} is unavailable: ${reason}`)
  }
  const trace = object(traceValue)
  if (
    !trace ||
    failed(trace) ||
    trace.type !== 'CALL' ||
    fixedHex(trace.from, 20) !== sender ||
    fixedHex(trace.to, 20) !== transactionTo ||
    typeof trace.input !== 'string' ||
    !/^0x(?:[0-9a-f]{2})*$/i.test(trace.input) ||
    trace.input.toLowerCase() !== input
  )
    throw new EvmClaimVerificationError('claim transaction trace does not match the canonical transaction')
  const matchingReceiptEvents = receiptLogs.filter((entry) => claimPreimage(entry, contract, lock) === preimage)
  if (matchingReceiptEvents.length === 0) return false
  // ponytail: cap untrusted traces at 256 nodes and 32 levels; raise for larger wallet batches.
  let nodes = 0
  let matches = 0
  const visit = (frameValue: unknown, depth: number): void => {
    if (++nodes > MAX_TRACE_NODES)
      throw new EvmClaimVerificationError(`claim transaction trace exceeds the ${MAX_TRACE_NODES}-frame limit`)
    if (depth > MAX_TRACE_DEPTH)
      throw new EvmClaimVerificationError(`claim transaction trace exceeds the ${MAX_TRACE_DEPTH}-level depth limit`)
    const frame = object(frameValue)
    if (!frame || (frame.calls !== undefined && !Array.isArray(frame.calls)))
      throw new EvmClaimVerificationError('claim transaction trace is malformed')
    if (frame.error !== undefined && frame.error !== null && frame.error !== '' && typeof frame.error !== 'string')
      throw new EvmClaimVerificationError('claim transaction trace has a malformed error field')
    if (failed(frame)) return
    if (
      typeof frame.type !== 'string' ||
      !TRACE_FRAME_TYPES.has(frame.type) ||
      fixedHex(frame.from, 20) === null ||
      fixedHex(frame.to, 20) === null ||
      typeof frame.input !== 'string' ||
      !/^0x(?:[0-9a-f]{2})*$/i.test(frame.input) ||
      (frame.logs !== undefined && !Array.isArray(frame.logs))
    )
      throw new EvmClaimVerificationError('claim transaction trace is malformed')
    if (
      frame.type === 'CALL' &&
      fixedHex(frame.to, 20) === contract &&
      typeof frame.input === 'string' &&
      (frame.input.toLowerCase() === claimFor ||
        (frame.input.toLowerCase() === claimSelf && fixedHex(frame.from, 20) === hex(lock.claimAddress)))
    ) {
      matches++
      if (!Array.isArray(frame.logs) || !frame.logs.some((entry) => claimPreimage(entry, contract, lock) === preimage))
        throw new EvmClaimVerificationError('claim trace cannot attribute the receipt event to its exact call')
    }
    for (const child of (frame.calls as unknown[] | undefined) ?? []) {
      visit(child, depth + 1)
    }
  }
  visit(trace, 0)
  if (matches > 1) throw new EvmClaimVerificationError('claim trace has multiple exact successful claim calls')
  return matches === 1
}
