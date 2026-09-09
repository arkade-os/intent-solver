/**
 * Checking `EVM_LOG_SCAN_RANGE` against the endpoint that has to serve it.
 *
 * The cap is a PROVIDER fact - hosted endpoints cap at 2k-10k, a self-hosted
 * node at nothing - so no constant is right and the knob cannot be bounded.
 * Unchecked it fails silently: an oversized page is rejected, and the send
 * corridor reads a rejected scan as "not claimed yet".
 *
 * WHY IT DOES NOT SIMPLY THROW, unlike `assertCadence` next door. That is pure
 * arithmetic and can only fail because the config is wrong; this call can fail
 * because a node blinked, and refusing to boot on that trades an invisible bug
 * for an outage. Only a stated RANGE rejection is a fact no retry changes.
 */

import type { JsonRpc } from '@arkade-os/solver-core/ports/evm.js'

/**
 * Provider phrasings meaning the BLOCK RANGE was too large, and nothing else.
 *
 * Data, not a condition, so a reviewer who has met a provider this misses can
 * add its wording without reading the logic. INFERRED FROM PUBLISHED PROVIDER
 * DOCS, not verified against a live capped endpoint - which is safe because an
 * unrecognised phrasing degrades to a warning rather than a refusal to start.
 *
 * Result-count limits are excluded: a different cap, and unreachable from a
 * filter that matches nothing.
 */
export const LOG_RANGE_REJECTIONS: readonly string[] = [
  'block range is too large',
  'block range too large',
  'exceed maximum block range',
  'exceeds max block range',
  'query exceeds max block range',
  'maximum block range',
  'block range limit',
  'range is too wide',
  'requested too many blocks',
  'eth_getlogs is limited to',
  'up to a 10k block range',
]

export type LogScanProbeResult =
  | { kind: 'ok'; blocks: bigint }
  /** The endpoint refused the WIDTH. No retry fixes this. */
  | { kind: 'range_rejected'; message: string }
  | { kind: 'inconclusive'; message: string }

export interface LogScanProbeDeps {
  rpc: JsonRpc
  contractAddress: Uint8Array
  logScanRange: number
}

const hexOf = (bytes: Uint8Array): string => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`

/** No event carries this: `topics[0]` is a keccak of a signature, never the zero word. */
const MATCHES_NOTHING = `0x${'00'.repeat(32)}`

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Ask the endpoint to serve one `logScanRange`-wide `eth_getLogs`.
 *
 * Matching nothing on purpose: the question is whether the WIDTH is allowed,
 * and a filter returning real logs risks a result-count cap answering it. A
 * chain younger than the range yields a narrower request, so `blocks` reports
 * what was actually asked rather than what was configured.
 */
export const probeLogScanRange = async (deps: LogScanProbeDeps): Promise<LogScanProbeResult> => {
  const { rpc, contractAddress, logScanRange } = deps
  try {
    const tipRaw = await rpc('eth_blockNumber', [])
    if (typeof tipRaw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(tipRaw)) {
      return { kind: 'inconclusive', message: `eth_blockNumber returned ${JSON.stringify(tipRaw)}` }
    }
    const tip = BigInt(tipRaw)
    const span = BigInt(logScanRange)
    const from = tip + 1n > span ? tip + 1n - span : 0n
    await rpc('eth_getLogs', [
      {
        address: hexOf(contractAddress),
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${tip.toString(16)}`,
        topics: [MATCHES_NOTHING],
      },
    ])
    return { kind: 'ok', blocks: tip - from + 1n }
  } catch (error) {
    const message = messageOf(error)
    const haystack = message.toLowerCase()
    if (LOG_RANGE_REJECTIONS.some((phrase) => haystack.includes(phrase))) {
      return { kind: 'range_rejected', message }
    }
    return { kind: 'inconclusive', message }
  }
}
