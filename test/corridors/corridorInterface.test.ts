import { describe, it, expect } from 'vitest'
import { createCorridorSet, type Corridor } from '@arkade-os/solver-core/core/corridor.js'
import { respondToRfqRequest } from '@arkade-os/solver-transport/ingress/rfq.js'
import type { CorridorDescriptor } from '@arkade-os/solver-core/core/corridorDescriptor.js'

// `noun` and `lifecycleLabel` are NOT here: they live on `StoreShape` in
// `db/baseSwapStore.ts`, which is a corridor's persistence concern rather than
// something the host reads.
const descriptor = (pair: string, envStem: string): CorridorDescriptor => ({
  pair,
  envStem,
  payoutRail: 'arkade',
  states: { live: ['quoted'], exposed: [], delivered: ['settled'] },
})

const stub = (pair: string, envStem: string): Corridor => ({
  descriptor: descriptor(pair, envStem),
  quote: async () => ({ kind: 'refused', payload: {} }),
  statusFor: async () => null,
  tick: async () => {},
  tickAll: async () => 0,
  park: async () => ({ state: 'stuck' }),
  findRecoverable: async () => [],
  committedSats: async () => 0,
  page: async () => ({ swaps: [], nextCursor: null }),
  detail: async () => null,
  close: async () => {},
})

describe('createCorridorSet', () => {
  it('looks a corridor up by its pair', () => {
    const set = createCorridorSet([stub('a->b', 'A')])
    expect(set.get('a->b')?.descriptor.envStem).toBe('A')
  })

  /**
   * Undefined rather than a throw, unlike `descriptorFor`: this one IS the
   * dispatch, and an unknown pair is a routine client request to refuse.
   */
  it('answers undefined for a pair nobody registered, rather than throwing', () => {
    expect(createCorridorSet([stub('a->b', 'A')]).get('c->d')).toBeUndefined()
  })

  it('refuses two corridors claiming the same pair', () => {
    expect(() => createCorridorSet([stub('a->b', 'A'), stub('a->b', 'B')])).toThrow(/duplicate corridor pair/)
  })

  it('refuses two corridors claiming the same env stem', () => {
    expect(() => createCorridorSet([stub('a->b', 'A'), stub('c->d', 'A')])).toThrow(/duplicate corridor env stem/)
  })

  it('lists its corridors in registration order', () => {
    const set = createCorridorSet([stub('a->b', 'A'), stub('c->d', 'C')])
    expect([...set].map((c) => c.descriptor.pair)).toEqual(['a->b', 'c->d'])
  })

  it('reports how many corridors it holds', () => {
    expect(createCorridorSet([stub('a->b', 'A'), stub('c->d', 'C')]).size).toBe(2)
  })
})

/**
 * The corridor owns its request schema now, so the host has to verify on the
 * way OUT what it used to guarantee by construction.
 *
 * `ingress/rfq.ts` exists partly to stop a solver narrating its own validation
 * to anyone who asks — six distinct faults on the Lightning send leg reach a
 * client as one coarse `unsupported_payload`. A corridor is third-party code
 * from the host's point of view, so nothing stops it returning a free-text
 * reason except this check.
 */
describe('the wire contract, enforced on a corridor’s way out', () => {
  const rogue = (payload: Record<string, unknown>): Corridor => ({
    ...stub('arkade:BTC->rogue:BTC', 'ROGUE'),
    quote: async () => ({ kind: 'refused', payload }),
  })

  const ask = (corridor: Corridor) =>
    respondToRfqRequest(createCorridorSet([corridor]), {
      v: 1,
      type: 'rfq_request',
      rfq_id: 'e'.repeat(64),
      pair: 'arkade:BTC->rogue:BTC',
    })

  it('replaces a free-text refusal reason rather than forwarding it', async () => {
    const outcome = await ask(rogue({ reason: 'internal: float below 12000 sats on node 03ab' }))
    expect(JSON.stringify(outcome.payload)).not.toContain('float below')
    expect(outcome.payload).toMatchObject({ reason: 'unsupported_payload' })
  })

  it('keeps the corridor’s real answer in detail, which no payload builder reads', async () => {
    const outcome = await ask(rogue({ reason: 'internal: float below 12000 sats' }))
    expect(outcome.detail).toContain('not in the closed set')
  })

  /**
   * ABSENCE, not just a wrong value. The gate only fired on a reason that was
   * PRESENT, so a corridor omitting the field entirely put a reasonless refusal
   * on the wire — and a client cannot tell "we do not serve this pair" from
   * "try again in a minute", which is the whole point of the closed set.
   *
   * This is the one place that enforces it for corridor code this build never
   * compiled against.
   */
  it('refuses a refusal that names no reason at all', async () => {
    const outcome = await ask(rogue({ v: 1, type: 'rfq_refusal' }))
    expect(outcome.payload).toMatchObject({ reason: 'unsupported_payload' })
    expect(outcome.detail).toContain('must name a refusal reason')
  })

  it('refuses an INVALID outcome that names no reason either', async () => {
    // Both refusing kinds build through `rfqRefusalPayload`, which always
    // names one — so an absent reason means the corridor bypassed it.
    const corridor = {
      ...stub('arkade:BTC->rogue:BTC', 'ROGUE'),
      quote: async () => ({ kind: 'invalid' as const, payload: { v: 1, type: 'rfq_refusal' } }),
    }
    const outcome = await ask(corridor as never)
    expect(outcome.detail).toContain('must name a refusal reason')
  })
  it('passes a reason that IS in the closed set straight through', async () => {
    const outcome = await ask(rogue({ reason: 'exposure_cap' }))
    expect(outcome.payload).toMatchObject({ reason: 'exposure_cap' })
  })

  it('refuses an oversized payload rather than relaying it', async () => {
    const outcome = await ask(rogue({ reason: 'exposure_cap', filler: 'x'.repeat(9_000) }))
    expect(outcome.payload).toMatchObject({ reason: 'unsupported_payload' })
    expect(outcome.detail).toContain('over the')
  })

  it('refuses an outcome kind it has never heard of', async () => {
    const corridor = { ...stub('arkade:BTC->rogue:BTC', 'ROGUE'), quote: async () => ({ kind: 'ok', payload: {} }) }
    const outcome = await ask(corridor as unknown as Corridor)
    expect(outcome.kind).toBe('invalid')
    expect(outcome.detail).toContain('unknown outcome kind')
  })
})

/**
 * THE ACID TEST for the whole SDK effort.
 *
 * A corridor this build has never been compiled against must quote, tick, page
 * and report detail with ZERO edits under `src/core/`, `packages/solver-app/src/admin/` or
 * `src/ingress/`. If serving one needs a change in any of those, the interface
 * is incomplete and the fix is to extend `Corridor` — never to special-case the
 * host.
 *
 * The fake deliberately shares NOTHING with the four built-ins: its own pair,
 * its own env stem, its own state vocabulary, its own payload shape. Reusing a
 * real corridor's schema would prove only that the registry can find something
 * it already knew about.
 */
describe('a corridor the host has never compiled against', () => {
  type FakeRow = { id: string; state: string; pkScript: string; createdAt: number; updatedAt: number }

  const fakeCorridor = (rows: FakeRow[]): Corridor => ({
    descriptor: {
      pair: 'arkade:BTC->fake:BTC',
      envStem: 'FAKE',
      payoutRail: 'arkade',
      states: { live: ['dreaming'], exposed: ['dreaming'], delivered: ['woken'] },
    },
    quote: async (payload) => {
      const amount = (payload as { amount?: unknown }).amount
      if (typeof amount !== 'number') {
        return { kind: 'invalid', payload: { v: 1, type: 'rfq_refusal', reason: 'unsupported_payload' } }
      }
      rows.push({ id: `fake-${rows.length}`, state: 'dreaming', pkScript: 'ff', createdAt: 1, updatedAt: 1 })
      return { kind: 'quote', payload: { v: 1, type: 'rfq_quote', to_amount: amount - 7 } }
    },
    statusFor: async (rfqId) => (rfqId === 'known' ? { v: 1, type: 'rfq_status', state: 'dreaming' } : null),
    tick: async (id) => {
      const row = rows.find((r) => r.id === id)
      if (row) row.state = 'woken'
    },
    tickAll: async () => {
      const due = rows.filter((r) => r.state === 'dreaming')
      for (const row of due) row.state = 'woken'
      return due.length
    },
    // Its OWN parked word, not the built-ins' `stuck`/`refused`: the point of
    // this fixture is a corridor whose vocabulary the host has never seen.
    park: async (id) => {
      const row = rows.find((r) => r.id === id)
      if (row) row.state = 'abandoned'
      return { state: 'abandoned' }
    },
    findRecoverable: async () => rows.filter((r) => r.state === 'dreaming'),
    committedSats: async () => rows.length * 100,
    page: async () => ({
      swaps: rows.map((r) => ({ id: r.id, state: r.state, phase: 'open' as const, createdAt: 1, updatedAt: 1 })),
      nextCursor: null,
    }),
    detail: async (id) => {
      const row = rows.find((r) => r.id === id)
      return row ? { raw: row, swap: { ...row, phase: 'open' as const }, history: [] } : null
    },
    close: async () => {},
  })

  it('is quoted through the host’s own dispatch, with its own payload shape', async () => {
    const rows: FakeRow[] = []
    const set = createCorridorSet([fakeCorridor(rows)])
    const outcome = await respondToRfqRequest(set, {
      v: 1,
      type: 'rfq_request',
      rfq_id: 'a'.repeat(64),
      pair: 'arkade:BTC->fake:BTC',
      amount: 1000,
    })
    expect(outcome.kind).toBe('quote')
    expect(outcome.payload).toMatchObject({ to_amount: 993 })
    expect(rows).toHaveLength(1)
  })

  it('refuses through the host’s wire contract, using its own validation', async () => {
    const set = createCorridorSet([fakeCorridor([])])
    const outcome = await respondToRfqRequest(set, {
      v: 1,
      type: 'rfq_request',
      rfq_id: 'a'.repeat(64),
      pair: 'arkade:BTC->fake:BTC',
    })
    expect(outcome.kind).toBe('invalid')
    expect(outcome.payload).toMatchObject({ reason: 'unsupported_payload' })
  })

  it('is driven the way the sweep drives one: findRecoverable then tick', async () => {
    const rows: FakeRow[] = []
    const corridor = fakeCorridor(rows)
    await corridor.quote({ amount: 500 })
    const due = await corridor.findRecoverable()
    expect(due).toHaveLength(1)
    for (const row of due) await corridor.tick(row.id)
    expect(await corridor.findRecoverable()).toHaveLength(0)
    expect(rows[0]?.state).toBe('woken')
  })

  it('pages and reports detail the way the console reads one', async () => {
    const rows: FakeRow[] = []
    const corridor = fakeCorridor(rows)
    await corridor.quote({ amount: 500 })
    expect((await corridor.page({})).swaps.map((s) => s.id)).toEqual(['fake-0'])
    expect(await corridor.detail('fake-0')).not.toBeNull()
    expect(await corridor.detail('nope')).toBeNull()
  })

  it('coexists with the built-ins rather than replacing them', () => {
    const set = createCorridorSet([stub('a->b', 'A'), fakeCorridor([]), stub('c->d', 'C')])
    expect(set.size).toBe(3)
    expect(set.get('arkade:BTC->fake:BTC')?.descriptor.envStem).toBe('FAKE')
  })
})
