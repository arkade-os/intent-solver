/**
 * Checking `EVM_LOG_SCAN_RANGE` against the endpoint that has to serve it.
 *
 * The cap on an `eth_getLogs` range is a PROVIDER fact, so no constant can be
 * right: a hosted endpoint caps at 2k-10k, a self-hosted Geth or Erigon caps at
 * nothing. That is why the knob exists, and why it cannot simply be bounded.
 *
 * Left unchecked it fails the worst way. An oversized range is rejected, the
 * send corridor degrades a rejected scan to "not claimed yet", and the solver
 * never learns a preimage the client has already used. Worse, it hides: a
 * request spans `min(range, tip - floor)`, so recent swaps are one short page
 * that fits whatever was set, and only a long scan - the genesis fallback, or a
 * lock far behind the tip - ever uses the full span. An operator can be
 * misconfigured for weeks and meet it on the row where it costs money.
 *
 * So it is asked once, at startup, against the real endpoint - the standard
 * `config.ts` already sets for block cadence, which is rejected there rather
 * than at first use for the same reason: it "keeps working and silently returns
 * the unsafe answer on every swap".
 *
 * WHY A NETWORK PROBE CANNOT JUST THROW. `assertCadence` is pure arithmetic and
 * can only fail because the config is wrong. This call can fail because a node
 * blinked. Refusing to start on a flaky RPC would trade an invisible bug for an
 * outage, so the two are separated: a provider that says the RANGE is too large
 * has stated a fact about the configuration that no retry changes, and that is
 * fatal; anything else is not evidence about the configuration at all.
 */

import type { JsonRpc } from '@arkade-os/solver-core/ports/evm.js'

/**
 * Provider phrasings that mean the BLOCK RANGE was too large, and nothing else.
 *
 * Data rather than a condition so a reviewer who has met a provider this misses
 * can add its wording without reading the logic. Matched case-insensitively as
 * substrings of the error message, because `rpc.ts` flattens a JSON-RPC error
 * into `Error.message`.
 *
 * INFERRED FROM PUBLISHED PROVIDER DOCUMENTATION, not verified against a live
 * capped endpoint. An unrecognised phrasing is not fatal (see
 * {@link probeLogScanRange}), so the cost of a gap here is a warning instead of
 * a refusal - the safe direction.
 *
 * Result-count limits ("query returned more than N results") are deliberately
 * ABSENT: they are a different cap, and this probe cannot trip them because its
 * filter matches nothing.
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
  /** The endpoint served a request of this width. */
  | { kind: 'ok'; blocks: bigint }
  /** The endpoint refused the WIDTH. No retry fixes this. */
  | { kind: 'range_rejected'; message: string }
  /** Something else went wrong, which says nothing about the setting. */
  | { kind: 'inconclusive'; message: string }

export interface LogScanProbeDeps {
  rpc: JsonRpc
  /** The `ERC20Swap` deployment, so the probe is shaped like a real scan. */
  contractAddress: Uint8Array
  logScanRange: number
}

const hexOf = (bytes: Uint8Array): string => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`

/**
 * A topic no event can carry: `topics[0]` is a keccak of a signature, and the
 * zero word is not one. Matching nothing is the point - the probe is asking
 * whether the WIDTH is allowed, not what is in it, and a filter that matched
 * real logs would risk a result-count limit answering a range question.
 */
const MATCHES_NOTHING = `0x${'00'.repeat(32)}`

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Ask the endpoint to serve one `logScanRange`-wide `eth_getLogs`.
 *
 * Ends at the tip and reaches back, so the width is real rather than notional.
 * A chain younger than the range yields a SHORTER request than configured and
 * therefore proves less - `blocks` reports what was actually asked so a caller
 * can say so rather than claim a check it did not get.
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
