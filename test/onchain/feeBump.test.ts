/** The whole of the fee-bump policy, with no chain in sight. */

import { describe, it, expect } from 'vitest'
import {
  FEE_BUMP_ALL_IN_SECONDS,
  FEE_BUMP_INTERVAL_SECONDS,
  FEE_BUMP_RAMP_SECONDS,
  affordableFee,
  outcomeOfAny,
  urgencyFeeRate,
} from '@arkade-os/solver-rails/onchain/feeBump.js'
import type { OnchainTxOutcome } from '@arkade-os/solver-core/ports/onchain.js'

const backendOver = (outcomes: Record<string, OnchainTxOutcome>) => {
  const asked: string[] = []
  return {
    asked,
    transactionOutcome: async (txid: string): Promise<OnchainTxOutcome> => {
      asked.push(txid)
      return outcomes[txid] ?? 'unknown'
    },
  }
}

describe('urgencyFeeRate', () => {
  const deadline = 1_800_000_000
  const estimate = 5
  const cap = 650

  it('only follows the estimate while the deadline is further than the ramp', () => {
    expect(urgencyFeeRate(estimate, cap, deadline, deadline - FEE_BUMP_RAMP_SECONDS)).toBe(estimate)
    expect(urgencyFeeRate(estimate, cap, deadline, deadline - 7 * 24 * 3600)).toBe(estimate)
  })

  it('pays everything above dust inside the last window', () => {
    expect(urgencyFeeRate(estimate, cap, deadline, deadline - FEE_BUMP_ALL_IN_SECONDS)).toBe(cap)
    expect(urgencyFeeRate(estimate, cap, deadline, deadline + 3600)).toBe(cap)
  })

  it('climbs geometrically between the two, strictly upward', () => {
    const halfway = deadline - (FEE_BUMP_RAMP_SECONDS + FEE_BUMP_ALL_IN_SECONDS) / 2
    expect(urgencyFeeRate(estimate, cap, deadline, halfway)).toBeCloseTo(Math.sqrt(estimate * cap))
    const rates = [6, 5, 4, 3].map((steps) =>
      urgencyFeeRate(estimate, cap, deadline, deadline - steps * FEE_BUMP_INTERVAL_SECONDS),
    )
    expect(rates).toEqual([...rates].sort((a, b) => a - b))
    expect(new Set(rates).size).toBe(rates.length)
  })

  it('never asks more than the cap, even when the estimate does', () => {
    expect(urgencyFeeRate(1_000, cap, deadline, deadline - 7 * 24 * 3600)).toBe(cap)
  })

  it('ramps from the relay minimum when the estimator answers zero', () => {
    const halfway = deadline - (FEE_BUMP_RAMP_SECONDS + FEE_BUMP_ALL_IN_SECONDS) / 2
    expect(urgencyFeeRate(0, cap, deadline, halfway)).toBeCloseTo(Math.sqrt(cap))
  })

  it('reaches the cap on the 20-minute cadence however late the spend starts inside the ramp', () => {
    // The receive leg's worst case: P learned 70 minutes before htlc_locktime.
    const start = deadline - 70 * 60
    const bumps = [0, 1, 2].map((n) => start + n * FEE_BUMP_INTERVAL_SECONDS)
    expect(bumps.some((at) => urgencyFeeRate(estimate, cap, deadline, at) === cap)).toBe(true)
  })
})

describe('affordableFee', () => {
  it('charges the asked rate when the output can carry it', () => {
    expect(affordableFee(150, 4, 50_000, 330)).toBe(600)
  })

  it('caps the fee so the output stays at dust rather than refusing outright', () => {
    expect(affordableFee(150, 5_000, 1_000, 330)).toBe(670)
  })

  it('refuses only when the cap cannot even meet the relay minimum', () => {
    expect(affordableFee(150, 5, 479, 330)).toBeNull()
    expect(affordableFee(150, 5, 480, 330)).toBe(150)
  })
})

describe('outcomeOfAny', () => {
  it('names the OLDER version when that is the one that landed', async () => {
    const backend = backendOver({ latest: 'mempool', older: 'confirmed' })
    expect(await outcomeOfAny(backend, ['latest', 'older'])).toEqual({ outcome: 'confirmed', txid: 'older' })
  })

  it('reports mempool while any version is still pending, naming none', async () => {
    const backend = backendOver({ latest: 'mempool' })
    expect(await outcomeOfAny(backend, ['latest', 'older'])).toEqual({ outcome: 'mempool', txid: null })
  })

  it('reports unknown when every version has gone', async () => {
    const backend = backendOver({})
    expect(await outcomeOfAny(backend, ['latest', 'older'])).toEqual({ outcome: 'unknown', txid: null })
    expect(await outcomeOfAny(backend, [])).toEqual({ outcome: 'unknown', txid: null })
  })
})
