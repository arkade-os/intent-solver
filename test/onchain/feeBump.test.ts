/** The whole of the fee-bump policy, with no chain in sight. */

import { describe, it, expect } from 'vitest'
import {
  FEE_BUMP_FACTOR,
  FEE_BUMP_INTERVAL_SECONDS,
  affordableFee,
  outcomeOfAny,
  replacementFeeRate,
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

describe('replacementFeeRate', () => {
  const last = { feeRate: 10, broadcastAt: 1_800_000_000 }

  it('refuses a replacement before the interval is up', () => {
    expect(replacementFeeRate(last, 50, last.broadcastAt)).toBeNull()
    expect(replacementFeeRate(last, 50, last.broadcastAt + FEE_BUMP_INTERVAL_SECONDS - 1)).toBeNull()
  })

  it('replaces at the factor once the interval is up, even with the estimate unmoved', () => {
    const now = last.broadcastAt + FEE_BUMP_INTERVAL_SECONDS
    expect(replacementFeeRate(last, last.feeRate, now)).toBe(last.feeRate * FEE_BUMP_FACTOR)
  })

  it('follows the estimate when the mempool has run past the factor', () => {
    expect(replacementFeeRate(last, 200, last.broadcastAt + FEE_BUMP_INTERVAL_SECONDS)).toBe(200)
  })

  it('always clears the previous rate by a whole sat/vB', () => {
    const tiny = { feeRate: 1, broadcastAt: last.broadcastAt }
    expect(replacementFeeRate(tiny, 1, tiny.broadcastAt + FEE_BUMP_INTERVAL_SECONDS)).toBe(2)
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
