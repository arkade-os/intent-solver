import { describe, it, expect } from 'vitest'
import {
  assertCadence,
  blocksForDuration,
  deadlineSecondsForBlock,
  type EvmBlockCadence,
} from '@arkade-os/solver-rails-evm/evm/blockTime.js'

const NOW = 1_800_000_000

/** Ethereum-ish: slow and fairly stable. */
const ETHEREUM: EvmBlockCadence = { fastestSecondsPerBlock: 10, slowestSecondsPerBlock: 14 }
/** Arbitrum-ish: sub-second, and an order of magnitude from the above. */
const FAST_L2: EvmBlockCadence = { fastestSecondsPerBlock: 0.25, slowestSecondsPerBlock: 2 }

describe('deadlineSecondsForBlock — reading someone else`s timelock', () => {
  it('measures the remaining span from the CURRENT height', () => {
    const at = (currentBlock: bigint) =>
      deadlineSecondsForBlock({ timeoutBlock: 1_000n, currentBlock, nowSeconds: NOW, cadence: ETHEREUM })
    expect(at(900n)).toBe(NOW + 100 * 10)
    // As blocks arrive the span shrinks, and with it how wrong this can be.
    expect(at(990n)).toBe(NOW + 10 * 10)
  })

  it('uses the FASTEST cadence, so it never claims more time than we have', () => {
    // The safe error here is believing the deadline is sooner than it is: we
    // act early, which is free. Using the slow bound would tell us we have
    // time we do not, which is the error that costs money.
    const args = { timeoutBlock: 1_000n, currentBlock: 900n, nowSeconds: NOW, cadence: ETHEREUM }
    const answer = deadlineSecondsForBlock(args)
    const ifItHadUsedSlow = NOW + 100 * ETHEREUM.slowestSecondsPerBlock
    expect(answer).toBeLessThan(ifItHadUsedSlow)
  })

  it('reports a passed deadline as being in the past, unclamped', () => {
    // Once the chain is past the timeout the deadline genuinely IS behind us,
    // and every caller reads that correctly as "too late". Flooring it at now
    // would be a lie in the one direction that costs money.
    const past = deadlineSecondsForBlock({
      timeoutBlock: 900n,
      currentBlock: 1_000n,
      nowSeconds: NOW,
      cadence: ETHEREUM,
    })
    expect(past).toBeLessThan(NOW)
  })
})

describe('blocksForDuration — sizing our own lock', () => {
  it('uses the SLOWEST cadence, so the lock expires no later than intended', () => {
    // Mirror of the above, and the opposite bound. Assuming fast blocks would
    // compute MORE blocks, and the lock would outlive the deadline it was
    // sized against — our own recourse opening after the cross-side deadline.
    expect(blocksForDuration(1_400, ETHEREUM)).toBe(100n)
    const ifItHadUsedFast = BigInt(Math.floor(1_400 / ETHEREUM.fastestSecondsPerBlock))
    expect(blocksForDuration(1_400, ETHEREUM)).toBeLessThan(ifItHadUsedFast)
  })

  it('floors rather than rounds, because a block fewer expires sooner', () => {
    expect(blocksForDuration(1_399, ETHEREUM)).toBe(99n)
  })

  it('never returns zero, which would be refundable in the block it was created', () => {
    expect(blocksForDuration(1, ETHEREUM)).toBe(1n)
  })

  it('scales across chains that differ by an order of magnitude', () => {
    // The reason this is configuration and not a constant: the same duration
    // is 100 blocks on one chain and 1800 on another.
    expect(blocksForDuration(3_600, ETHEREUM)).toBe(257n)
    expect(blocksForDuration(3_600, FAST_L2)).toBe(1_800n)
  })
})

describe('the two directions are not interchangeable', () => {
  it('round-tripping a duration through both is conservative at both ends', () => {
    // Size a lock for an hour, then read back when it lands. The answer must
    // not exceed the hour we asked for — if it did, one of the bounds is being
    // used in the wrong direction and the solver would wait past its own
    // deadline.
    const blocks = blocksForDuration(3_600, FAST_L2)
    const lands = deadlineSecondsForBlock({
      timeoutBlock: blocks,
      currentBlock: 0n,
      nowSeconds: NOW,
      cadence: FAST_L2,
    })
    expect(lands - NOW).toBeLessThanOrEqual(3_600)
  })
})

describe('assertCadence', () => {
  it('refuses swapped bounds, which nothing downstream would notice', () => {
    // Both conversions would keep working and silently return the unsafe
    // answer on every swap. There is no later symptom to catch it.
    expect(() => assertCadence({ fastestSecondsPerBlock: 14, slowestSecondsPerBlock: 10 })).toThrow(/must be <=/)
  })

  it('refuses nonsense values', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertCadence({ fastestSecondsPerBlock: bad, slowestSecondsPerBlock: 10 })).toThrow(
        /must be a positive number/,
      )
    }
  })

  it('accepts a chain whose cadence is stable enough to have equal bounds', () => {
    expect(() => assertCadence({ fastestSecondsPerBlock: 2, slowestSecondsPerBlock: 2 })).not.toThrow()
  })

  it('is enforced by both conversions, not just at config time', () => {
    const bad: EvmBlockCadence = { fastestSecondsPerBlock: 14, slowestSecondsPerBlock: 10 }
    expect(() =>
      deadlineSecondsForBlock({ timeoutBlock: 1n, currentBlock: 0n, nowSeconds: NOW, cadence: bad }),
    ).toThrow(/must be <=/)
    expect(() => blocksForDuration(60, bad)).toThrow(/must be <=/)
  })
})
