import { describe, it, expect } from 'vitest'
import { blocksBefore, priceTransaction, worstCaseBaseFee } from '@arkade-os/solver-rails-evm/evm/fees.js'

const GWEI = 1_000_000_000n

describe('worstCaseBaseFee', () => {
  it('compounds the 12.5% per-block rise EIP-1559 permits', () => {
    // One block: 10 gwei -> 11.25, floored by integer division.
    expect(worstCaseBaseFee(10n * GWEI, 1)).toBe(11_250_000_000n)
    // Two: another eighth on top of that, not two eighths of the original.
    expect(worstCaseBaseFee(10n * GWEI, 2)).toBe(12_656_250_000n)
  })

  it('roughly quintuples over fourteen full blocks', () => {
    // The number that makes this module necessary. A fee priced at the market
    // rate is unincludable well before here, and the deadline does not move.
    const grown = worstCaseBaseFee(10n * GWEI, 14)
    expect(grown).toBeGreaterThan(48n * GWEI)
    expect(grown).toBeLessThan(53n * GWEI)
  })

  it('returns the input for a zero-block window', () => {
    expect(worstCaseBaseFee(7n * GWEI, 0)).toBe(7n * GWEI)
  })

  it('is EIP-1559`s own step, not a multiply that rounds near it', () => {
    // `parent + parent / 8` and `parent * 9 / 8` are the same expression once
    // `parent / 8` reaches one, so this pins the ordinary range. Rounding the
    // multiply UP instead would overshoot what the chain can actually reach —
    // 15 would give 17 — and compound that error across the window.
    for (const parent of [8n, 15n, 16n, 100n, 12_345n, 10n * GWEI]) {
      expect(worstCaseBaseFee(parent, 1)).toBe(parent + parent / 8n)
    }
    expect(worstCaseBaseFee(15n, 1)).toBe(16n)
  })

  it('still rises below 8 wei, where a bare eighth is a fixed point', () => {
    // The protocol's `max(parent / 8, 1)` is a floor, not a rounding detail.
    // Without it the integer division yields zero and the fee never moves: the
    // ceiling would claim a base fee of 7 cannot rise in a hundred blocks. A
    // base fee decays by an eighth per empty block, so any sufficiently quiet
    // chain reaches this range — and this corridor targets any EVM chain, not
    // one that happens to enforce a floor.
    expect(worstCaseBaseFee(7n, 1)).toBe(8n)
    expect(worstCaseBaseFee(1n, 3)).toBe(4n)
    expect(worstCaseBaseFee(7n, 100)).toBeGreaterThan(7n)
  })

  it('refuses nonsense inputs', () => {
    expect(() => worstCaseBaseFee(-1n, 1)).toThrow(/must not be negative/)
    expect(() => worstCaseBaseFee(GWEI, -1)).toThrow(/non-negative integer/)
    expect(() => worstCaseBaseFee(GWEI, 1.5)).toThrow(/non-negative integer/)
  })
})

describe('priceTransaction', () => {
  const base = { baseFeePerGas: 10n * GWEI, tipPerGas: GWEI, maxFeeCeilingPerGas: 1000n * GWEI }

  it('prices for the whole window, not the current block', () => {
    const priced = priceTransaction({ ...base, blocksOfHeadroom: 10 })
    expect(priced.maxFeePerGas).toBe(worstCaseBaseFee(10n * GWEI, 10) + GWEI)
    expect(priced.cappedByPolicy).toBe(false)
  })

  it('prices a longer window higher, which is the entire point', () => {
    const short = priceTransaction({ ...base, blocksOfHeadroom: 2 })
    const long = priceTransaction({ ...base, blocksOfHeadroom: 20 })
    expect(long.maxFeePerGas).toBeGreaterThan(short.maxFeePerGas)
  })

  it('reports when policy capped it, rather than quietly underpricing', () => {
    // A capped transaction is NOT priced for its window. For a claim that is a
    // reason to act early or raise the ceiling — never something to proceed
    // past silently, which is why this is a return value and not a log line.
    const priced = priceTransaction({ ...base, blocksOfHeadroom: 60, maxFeeCeilingPerGas: 50n * GWEI })
    expect(priced.cappedByPolicy).toBe(true)
    expect(priced.maxFeePerGas).toBe(50n * GWEI)
  })

  it('never lets the tip exceed the ceiling', () => {
    // A node rejects `maxPriorityFeePerGas > maxFeePerGas` outright, so a low
    // ceiling has to reduce the tip rather than produce an unsubmittable
    // transaction.
    const priced = priceTransaction({
      baseFeePerGas: GWEI,
      tipPerGas: 100n * GWEI,
      blocksOfHeadroom: 0,
      maxFeeCeilingPerGas: 5n * GWEI,
    })
    expect(priced.maxPriorityFeePerGas).toBeLessThanOrEqual(priced.maxFeePerGas)
    expect(priced.maxFeePerGas).toBe(5n * GWEI)
  })

  it('always leaves room for the tip on top of the base fee', () => {
    const priced = priceTransaction({ ...base, blocksOfHeadroom: 5 })
    expect(priced.maxFeePerGas).toBeGreaterThan(worstCaseBaseFee(10n * GWEI, 5))
  })

  it('refuses nonsense inputs', () => {
    expect(() => priceTransaction({ ...base, blocksOfHeadroom: 1, tipPerGas: -1n })).toThrow(/must not be negative/)
    expect(() => priceTransaction({ ...base, blocksOfHeadroom: 1, maxFeeCeilingPerGas: 0n })).toThrow(
      /must be positive/,
    )
  })
})

describe('blocksBefore', () => {
  it('uses the fastest cadence, so the window is never underestimated', () => {
    // Same safe direction as reading a deadline: more blocks means a higher
    // ceiling, and erring high costs gas while erring low costs the swap.
    expect(blocksBefore(60, 0.25)).toBe(240)
    expect(blocksBefore(60, 12)).toBe(5)
  })

  it('rounds up, because a partial block is still a block to survive', () => {
    expect(blocksBefore(10, 3)).toBe(4)
  })

  it('refuses nonsense inputs', () => {
    expect(() => blocksBefore(0, 1)).toThrow(/must be positive/)
    expect(() => blocksBefore(60, 0)).toThrow(/must be positive/)
  })
})
