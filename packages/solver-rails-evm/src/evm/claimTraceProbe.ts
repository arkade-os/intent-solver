import type { JsonRpc } from '@arkade-os/solver-core/ports/evm.js'
import { bytesToHex } from '@noble/hashes/utils.js'

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
const quantity = (value: unknown): bigint | null =>
  typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value) ? BigInt(value) : null
const fixedHex = (value: unknown, length: number): string | null =>
  typeof value === 'string' && new RegExp(`^0x[0-9a-f]{${length * 2}}$`, 'i').test(value) ? value.toLowerCase() : null
const dataHex = (value: unknown): string | null =>
  typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(value) ? value.toLowerCase() : null
const failed = (frame: Record<string, unknown>): boolean =>
  frame.error !== undefined && frame.error !== null && frame.error !== ''
const validRemoved = (log: Record<string, unknown>): boolean => log.removed === undefined || log.removed === false

const eventPayload = (value: unknown): { address: string; topics: string[]; data: string } | null => {
  const log = object(value)
  if (!log || !validRemoved(log)) return null
  const address = fixedHex(log.address, 20)
  const data = dataHex(log.data)
  if (address === null || data === null || !Array.isArray(log.topics)) return null
  const topics = log.topics.map((topic) => fixedHex(topic, 32))
  return topics.some((topic) => topic === null) ? null : { address, topics: topics as string[], data }
}

const sameEvent = (left: unknown, right: unknown): boolean => {
  const a = eventPayload(left)
  const b = eventPayload(right)
  return (
    a !== null &&
    b !== null &&
    a.address === b.address &&
    a.data === b.data &&
    a.topics.length === b.topics.length &&
    a.topics.every((topic, index) => topic === b.topics[index])
  )
}

const traceContainsEvent = (trace: Record<string, unknown>, event: unknown): boolean => {
  // ponytail: cap probe traces at 256 frames and 32 levels; raise if wallet traces grow larger.
  let nodes = 0
  let found = false
  const visit = (value: unknown, depth: number): boolean | null => {
    if (++nodes > 256 || depth > 32) return null
    const frame = object(value)
    if (!frame || (frame.calls !== undefined && !Array.isArray(frame.calls))) return null
    if (failed(frame)) return false
    if (frame.logs !== undefined && !Array.isArray(frame.logs)) return null
    if (Array.isArray(frame.logs) && frame.logs.slice(-128).some((entry) => sameEvent(entry, event))) found = true
    for (const child of (frame.calls as unknown[] | undefined) ?? []) {
      const childResult = visit(child, depth + 1)
      if (childResult === null) return null
    }
    return found
  }
  return visit(trace, 0) === true
}

const logIdentity = (
  value: unknown,
): { txHash: string; blockHash: string; blockNumber: bigint; logIndex: bigint } | null => {
  const log = object(value)
  if (!log || eventPayload(log) === null) return null
  const txHash = fixedHex(log.transactionHash, 32)
  const blockHash = fixedHex(log.blockHash, 32)
  const blockNumber = quantity(log.blockNumber)
  const logIndex = quantity(log.logIndex)
  return txHash && blockHash && blockNumber !== null && logIndex !== null
    ? { txHash, blockHash, blockNumber, logIndex }
    : null
}

const includesReceiptLog = (
  receipt: Record<string, unknown>,
  sample: unknown,
  identity: NonNullable<ReturnType<typeof logIdentity>>,
): boolean =>
  Array.isArray(receipt.logs) &&
  receipt.logs.some((value) => {
    const entry = object(value)
    return (
      entry !== null &&
      sameEvent(entry, sample) &&
      fixedHex(entry.transactionHash, 32) === identity.txHash &&
      fixedHex(entry.blockHash, 32) === identity.blockHash &&
      quantity(entry.blockNumber) === identity.blockNumber &&
      quantity(entry.logIndex) === identity.logIndex
    )
  })

export const assertEvmClaimTraceSupport = async (rpc: JsonRpc, emitterAddress: Uint8Array): Promise<void> => {
  const emitter = fixedHex(`0x${bytesToHex(emitterAddress)}`, 20)
  if (!emitter) throw new Error('Trace probe emitter must be a 20-byte address')
  const tip = quantity(await rpc('eth_blockNumber', []))
  if (tip === null) throw new Error('EVM callTracer withLog probe could not read the chain tip')
  const fromBlock = tip > 127n ? tip - 127n : 0n
  const fromTag = `0x${fromBlock.toString(16)}`
  const toTag = `0x${tip.toString(16)}`
  const logs = await rpc('eth_getLogs', [{ address: emitter, fromBlock: fromTag, toBlock: toTag }])
  if (!Array.isArray(logs)) throw new Error('EVM callTracer withLog probe received an invalid log sample')
  const seen = new Set<string>()
  const candidates = logs
    .slice(-128)
    .slice()
    .reverse()
    .filter((entry) => {
      const identity = logIdentity(entry)
      const payload = eventPayload(entry)
      if (
        !identity ||
        payload?.address !== emitter ||
        identity.blockNumber < fromBlock ||
        identity.blockNumber > tip ||
        seen.has(identity.txHash)
      )
        return false
      seen.add(identity.txHash)
      return true
    })
    .slice(0, 3)
  for (const sample of candidates) {
    const identity = logIdentity(sample)
    if (!identity) continue
    const receipt = object(await rpc('eth_getTransactionReceipt', [identity.txHash]))
    const transaction = object(await rpc('eth_getTransactionByHash', [identity.txHash]))
    const transactionTo = fixedHex(transaction?.to, 20)
    const sender = fixedHex(transaction?.from, 20)
    const input = dataHex(transaction?.input)
    if (
      !receipt ||
      quantity(receipt.status) !== 1n ||
      fixedHex(receipt.transactionHash, 32) !== identity.txHash ||
      fixedHex(receipt.blockHash, 32) !== identity.blockHash ||
      quantity(receipt.blockNumber) !== identity.blockNumber ||
      transactionTo === null ||
      sender === null ||
      input === null ||
      fixedHex(receipt.to, 20) !== transactionTo ||
      fixedHex(receipt.from, 20) !== sender ||
      fixedHex(transaction?.hash, 32) !== identity.txHash ||
      fixedHex(transaction?.blockHash, 32) !== identity.blockHash ||
      quantity(transaction?.blockNumber) !== identity.blockNumber ||
      !includesReceiptLog(receipt, sample, identity)
    )
      continue
    let trace: Record<string, unknown> | null
    try {
      trace = object(
        await rpc('debug_traceTransaction', [
          identity.txHash,
          { tracer: 'callTracer', tracerConfig: { withLog: true } },
        ]),
      )
    } catch {
      continue
    }
    if (
      !trace ||
      failed(trace) ||
      trace.type !== 'CALL' ||
      fixedHex(trace.from, 20) !== sender ||
      fixedHex(trace.to, 20) !== transactionTo ||
      dataHex(trace.input) !== input ||
      !traceContainsEvent(trace, sample)
    )
      continue
    const canonical = object(await rpc('eth_getBlockByNumber', [`0x${identity.blockNumber.toString(16)}`, false]))
    if (fixedHex(canonical?.hash, 32) === identity.blockHash && quantity(canonical?.number) === identity.blockNumber)
      return
  }
  throw new Error('EVM callTracer withLog probe could not verify a recent canonical emitter log')
}
