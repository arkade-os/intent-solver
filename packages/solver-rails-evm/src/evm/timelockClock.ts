import type { JsonRpc } from '@arkade-os/solver-core/ports/evm.js'
import { messageOf } from '@arkade-os/solver-core/util/poll.js'

/** Creation code that returns `block.number`: `NUMBER PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN`. */
export const BLOCK_NUMBER_INITCODE = '0x4360005260206000f3'

/**
 * `block.number` as a contract executing at `blockTag` reads it. Arbitrum-stack chains return the parent chain's
 * height there, and the HTLC timelock follows it. Throws on any doubt: falling back to the tag is the bug this avoids.
 */
export const readTimelockClock = async (
  rpc: (method: string, params: readonly unknown[]) => Promise<unknown>,
  blockTag: bigint | string,
): Promise<bigint> => {
  const tag = typeof blockTag === 'bigint' ? `0x${blockTag.toString(16)}` : blockTag
  const word = await rpc('eth_call', [{ data: BLOCK_NUMBER_INITCODE }, tag])
  if (typeof word !== 'string' || !/^0x[0-9a-f]{64}$/i.test(word))
    throw new Error(`block.number read returned ${JSON.stringify(word)}`)
  return BigInt(word)
}

export type TimelockClockProbeResult =
  | { kind: 'same'; height: bigint }
  /** Timelocks need their own cadence: `EVM_TIMELOCK_*_SECONDS_PER_BLOCK`. */
  | { kind: 'distinct'; height: bigint; clock: bigint }
  | { kind: 'inconclusive'; message: string }

export const probeTimelockClock = async (rpc: JsonRpc): Promise<TimelockClockProbeResult> => {
  try {
    const raw = await rpc('eth_blockNumber', [])
    if (typeof raw !== 'string' || !/^0x[0-9a-f]+$/i.test(raw))
      return { kind: 'inconclusive', message: `eth_blockNumber returned ${JSON.stringify(raw)}` }
    const height = BigInt(raw)
    const clock = await readTimelockClock(rpc, height)
    return clock === height ? { kind: 'same', height } : { kind: 'distinct', height, clock }
  } catch (error) {
    return { kind: 'inconclusive', message: messageOf(error) }
  }
}
