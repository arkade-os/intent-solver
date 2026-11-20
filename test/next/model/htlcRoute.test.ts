import { describe, expect, it } from 'vitest'
import { explore } from './explore.js'
import { guarded, start, type Scenario } from './htlcRoute.js'

const SHIPPED: Scenario = {
  maxClock: 5,
  quoteUntil: 1,
  payoutRefundAt: 2,
  clientRefundAt: 4,
  workers: 2,
  crashes: 1,
  laggingIndexer: false,
  policies: guarded,
}

describe('hashlocked route: all interleavings', { timeout: 120_000 }, () => {
  it('keeps every invariant with two workers, one crash and a free client', async () => {
    const result = await explore(start(SHIPPED))
    expect(result.violation).toBeNull()
    expect(result.states).toBeGreaterThan(1_000)
  })

  it('breaks NoNetLoss when the refund margin is not checked', async () => {
    const late = { ...SHIPPED, payoutRefundAt: 4, clientRefundAt: 3 }
    const unguarded: Scenario = { ...late, policies: (s) => ({ ...guarded(s), canFill: () => ({ ok: true }) }) }
    expect((await explore(start(unguarded))).violation?.invariant).toBe('NoNetLoss')
    expect((await explore(start(late))).violation).toBeNull()
  })

  const impatient = (scenario: Scenario): Scenario => ({
    ...scenario,
    policies: (s) => ({ ...guarded(s), onLockMissing: () => 'retry' }),
  })

  it('breaks NoDoubleFund when a missing payout is resent at once', async () => {
    expect((await explore(start(impatient(SHIPPED)))).violation?.invariant).toBe('NoDoubleFund')
  })

  it('breaks NoDoubleFund when a missing payout is resent on a rail with a slow indexer', async () => {
    const lagging = { ...SHIPPED, laggingIndexer: true }
    const patient: Scenario = {
      ...lagging,
      policies: (s) => ({
        ...guarded(s),
        onLockMissing: (swap, seen) => (seen.now > swap.to.since ? 'retry' : 'wait'),
      }),
    }
    expect((await explore(start(patient))).violation?.invariant).toBe('NoDoubleFund')
    expect((await explore(start(lagging))).violation).toBeNull()
  })
})
