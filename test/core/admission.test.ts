import { describe, it, expect } from 'vitest'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import type { AdmissionStrategy } from '@arkade-os/solver-core/core/admissionStrategy.js'

/**
 * A `committedSats` that only counts what has "landed" — the durable rows.
 * Quotes in flight are invisible to it, which is precisely the gap the cap race
 * lives in, so the fake reproduces it rather than papering over it.
 */
const ledger = (start = 0) => {
  let landed = start
  return {
    committed: async () => landed,
    land: (sats: number) => {
      landed += sats
    },
  }
}

describe('AdmissionControl', () => {
  it('admits one of two concurrent claims that cannot both fit', async () => {
    const { committed } = ledger()
    const control = new AdmissionControl()

    const [first, second] = await Promise.all([
      control.reserve(50_000, committed, 50_000),
      control.reserve(50_000, committed, 50_000),
    ])

    expect([first, second].filter(Boolean)).toHaveLength(1)
  })

  it('counts an in-flight reservation against the next claim, before any row lands', async () => {
    const { committed } = ledger()
    const control = new AdmissionControl()

    // Nothing is durable yet — a cap check that only read `committed` would
    // see a completely empty ledger here and admit.
    expect(await control.reserve(600, committed, 1_000)).not.toBeNull()
    expect(await committed()).toBe(0)
    expect(await control.reserve(600, committed, 1_000)).toBeNull()
  })

  it('stops counting a reservation once released, so the landed row is not double-counted', async () => {
    const led = ledger()
    const control = new AdmissionControl()

    const reservation = await control.reserve(600, led.committed, 1_000)
    expect(reservation).not.toBeNull()

    // The row lands and the reservation is handed back, in that order — the
    // order `quote()` uses.
    led.land(600)
    reservation?.release()

    expect(control.outstandingSats).toBe(0)
    // 600 durable against a 1_000 cap still leaves room for 400, and not 401.
    expect(await control.reserve(400, led.committed, 1_000)).not.toBeNull()
  })

  it('releases idempotently, so a finally-block release cannot refund twice', async () => {
    const { committed } = ledger()
    const control = new AdmissionControl()

    const reservation = await control.reserve(600, committed, 1_000)
    reservation?.release()
    reservation?.release()
    reservation?.release()

    expect(control.outstandingSats).toBe(0)
    // A double refund would have driven `reserved` negative and handed out
    // headroom that does not exist.
    expect(await control.reserve(1_000, committed, 1_000)).not.toBeNull()
    expect(await control.reserve(1, committed, 1_000)).toBeNull()
  })

  it('refuses the claim that overshoots but keeps serving the ones that fit', async () => {
    const { committed } = ledger()
    const control = new AdmissionControl()

    const outcomes = await Promise.all([
      control.reserve(400, committed, 1_000),
      control.reserve(400, committed, 1_000),
      control.reserve(400, committed, 1_000),
    ])

    expect(outcomes.filter(Boolean)).toHaveLength(2)
    expect(control.outstandingSats).toBe(800)
  })

  it('does not wedge the queue when a committed-total read rejects', async () => {
    const control = new AdmissionControl()
    const exploding = async () => {
      throw new Error('db is down')
    }

    await expect(control.reserve(100, exploding, 1_000)).rejects.toThrow('db is down')

    // The next caller must still be served: a transient read failure that
    // deadlocked admission would take every corridor down with it.
    const { committed } = ledger()
    expect(await control.reserve(100, committed, 1_000)).not.toBeNull()
  })

  it('serialises claims rather than letting them interleave mid-read', async () => {
    const control = new AdmissionControl()
    let concurrent = 0
    let peak = 0
    const committed = async () => {
      concurrent += 1
      peak = Math.max(peak, concurrent)
      await new Promise((resolve) => setTimeout(resolve, 1))
      concurrent -= 1
      return 0
    }

    await Promise.all(Array.from({ length: 5 }, () => control.reserve(100, committed, 10_000)))

    expect(peak).toBe(1)
  })
})

describe('the positive-size invariant', () => {
  it('refuses a non-positive claim rather than handing out headroom', async () => {
    const { committed } = ledger()
    const control = new AdmissionControl()

    // A negative claim is the dangerous one: `release()` subtracts what was
    // added, so it would GROW the cap and every later quote would measure
    // against a bound nobody set.
    await expect(control.reserve(-100, committed, 1_000)).rejects.toThrow(RangeError)
    await expect(control.reserve(0, committed, 1_000)).rejects.toThrow(RangeError)
    expect(control.outstandingSats).toBe(0)

    // And the queue survives it, same as any other rejection.
    expect(await control.reserve(100, committed, 1_000)).not.toBeNull()
  })
})

/**
 * The exposure cap is now one IMPLEMENTATION of admission rather than the only
 * one. `AdmissionControl` satisfies `AdmissionStrategy` directly, so a
 * deployment wanting the default wires it straight in — and one wanting
 * something else supplies its own `admit` without this class being involved.
 */
describe('AdmissionStrategy', () => {
  it('is satisfied by AdmissionControl itself, with no wrapper', async () => {
    const strategy: AdmissionStrategy = new AdmissionControl()
    const admitted = await strategy.admit({
      pair: 'arkade:BTC->lightning:BTC',
      giveSats: 1_000,
      capSats: 10_000,
      committedSats: async () => 0,
    })
    expect(admitted).not.toBeNull()
  })

  it('refuses through the same path when the cap is already met', async () => {
    const strategy: AdmissionStrategy = new AdmissionControl()
    const admitted = await strategy.admit({
      pair: 'arkade:BTC->lightning:BTC',
      giveSats: 1_000,
      capSats: 10_000,
      committedSats: async () => 9_500,
    })
    expect(admitted).toBeNull()
  })

  /**
   * The reason this is an interface: a replacement can admit on something the
   * exposure cap cannot see. What it may NOT drop is the reserve/release
   * pairing — see `admissionStrategy.ts`.
   */
  it('lets a custom strategy admit per corridor rather than per sat', async () => {
    const dark = new Set(['arkade:BTC->onchain:BTC'])
    const released: string[] = []
    const perCorridor: AdmissionStrategy = {
      admit: async ({ pair }) => (dark.has(pair) ? null : { release: () => released.push(pair) }),
    }
    expect(
      await perCorridor.admit({
        pair: 'arkade:BTC->onchain:BTC',
        giveSats: 1,
        capSats: 0,
        committedSats: async () => 0,
      }),
    ).toBeNull()
    const ok = await perCorridor.admit({
      pair: 'arkade:BTC->lightning:BTC',
      giveSats: 1_000_000,
      capSats: 0,
      committedSats: async () => 0,
    })
    expect(ok).not.toBeNull()
    ok?.release()
    expect(released).toEqual(['arkade:BTC->lightning:BTC'])
  })
})

describe('AdmissionControl — the float ceiling', () => {
  const req = (over: Record<string, unknown> = {}) => ({
    pair: 'arkade:BTC->onchain:BTC',
    giveSats: 10_000,
    capSats: 1_000_000,
    committedSats: async () => 0,
    ...over,
  })
  const float = (over: Record<string, unknown> = {}) => ({
    requiredSats: 10_000,
    available: { sats: 25_000, ageMs: 0 },
    owedSats: async () => 0,
    ...over,
  })

  it('admits when the wallet covers what the quote needs', async () => {
    expect(await new AdmissionControl().admit(req({ float: float() }))).not.toBeNull()
  })

  it('refuses when it does not, and names the float rather than the cap', async () => {
    const ceilings: string[] = []
    const control = new AdmissionControl()
    const got = await control.admit(
      req({ float: float({ available: { sats: 9_999, ageMs: 0 } }), onRefused: (c: string) => ceilings.push(c) }),
    )
    expect(got).toBeNull()
    expect(ceilings).toEqual(['float'])
    expect(control.outstandingSats).toBe(0)
    expect(control.outstandingFloatSats).toBe(0)
  })

  it('counts payouts already owed by rows that have not funded', async () => {
    const got = await new AdmissionControl().admit(
      req({ float: float({ available: { sats: 15_000, ageMs: 0 }, owedSats: async () => 6_000 }) }),
    )
    expect(got).toBeNull()
  })

  it('admits only one of two concurrent quotes the wallet cannot both cover', async () => {
    const control = new AdmissionControl()
    const one = float({ available: { sats: 15_000, ageMs: 0 } })
    const [a, b] = await Promise.all([control.admit(req({ float: one })), control.admit(req({ float: one }))])
    expect([a, b].filter((r) => r !== null)).toHaveLength(1)
  })

  it('gives the float claim back on release, so a dead quote frees the wallet', async () => {
    const control = new AdmissionControl()
    const taken = await control.admit(req({ float: float() }))
    expect(control.outstandingFloatSats).toBe(10_000)
    taken?.release()
    expect(control.outstandingFloatSats).toBe(0)
    taken?.release()
    expect(control.outstandingFloatSats).toBe(0)
  })

  it('still admits against a STALE reading — it is evidence, not noise', async () => {
    const got = await new AdmissionControl().admit(
      req({ float: float({ available: { sats: 25_000, ageMs: 6 * 60 * 60 * 1000 } }) }),
    )
    expect(got).not.toBeNull()
  })

  it('refuses on a stale reading that is short, rather than treating age as permission', async () => {
    const got = await new AdmissionControl().admit(
      req({ float: float({ available: { sats: 100, ageMs: 6 * 60 * 60 * 1000 } }) }),
    )
    expect(got).toBeNull()
  })

  it('refuses while no float reading is available, including after invalidation', async () => {
    const ceilings: string[] = []
    const got = await new AdmissionControl().admit(
      req({ float: float({ available: null }), onRefused: (ceiling: string) => ceilings.push(ceiling) }),
    )
    expect(got).toBeNull()
    expect(ceilings).toEqual(['float'])
  })

  it('leaves a request carrying no float exactly as it was', async () => {
    const control = new AdmissionControl()
    expect(await control.admit(req())).not.toBeNull()
    expect(control.outstandingFloatSats).toBe(0)
  })

  it('names the CAP when that is what refused, not the float', async () => {
    const ceilings: string[] = []
    const got = await new AdmissionControl().admit(
      req({ capSats: 1, float: float(), onRefused: (c: string) => ceilings.push(c) }),
    )
    expect(got).toBeNull()
    expect(ceilings).toEqual(['exposure'])
  })
})
