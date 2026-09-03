/**
 * The authoring example is a WORKING corridor, not a sketch.
 *
 * `examples/` is the integration surface — the code someone copies — and it has
 * shipped silently broken twice already (see `tsconfig.examples.json`). Types
 * alone would not have caught either: both compiled. So this drives
 * `examples/lib/example-corridor.mjs` through the same host the daemon serves
 * with, and asserts the four obligations `docs/authoring.md` records as
 * documented-but-unenforced — because an example that quietly violates them
 * teaches the violation to everyone who copies it.
 */
import { describe, it, expect } from 'vitest'
import * as sdk from '@arkade-os/solver-app/index.js'
import { descriptorFor } from '@arkade-os/solver-corridors/corridors/index.js'
import type { Corridor } from '@arkade-os/solver-app/index.js'
// @ts-expect-error -- untyped .mjs example; the root program has no allowJs
import { VOUCHER, voucherCorridor } from '../../examples/lib/example-corridor.mjs'

const RFQ_ID = 'a'.repeat(64)

const make = (): Corridor => voucherCorridor({ now: () => 1_700_000_000 }) as Corridor

const hostFor = (corridor: Corridor) =>
  sdk.buildApp({
    corridors: sdk.createCorridorSet([corridor]),
    readers: sdk.createCorridorReaderSet([corridor]),
    network: 'regtest',
  })

const post = async (app: ReturnType<typeof sdk.buildApp>, body: unknown) =>
  app.fetch(
    new Request('http://host/v1/swap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

const quoteBody = (amount: unknown, rfqId: string = RFQ_ID) => ({
  v: 1,
  type: 'rfq_request',
  rfq_id: rfqId,
  pair: 'arkade:BTC->voucher:BTC',
  amount,
})

describe('the example corridor, served by the shipped host', () => {
  it('quotes through the host’s own dispatch', async () => {
    const res = await post(hostFor(make()), quoteBody(10_000))
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ type: 'rfq_quote', from_amount: 10_000, to_amount: 9_993 })
  })

  /**
   * 422, not 400. A valid request the solver declines is a different fact to a
   * client than an unserviceable one, and the example has to model that split
   * or every copy of it collapses the two.
   */
  it('refuses an out-of-range amount as refused, not invalid', async () => {
    const res = await post(hostFor(make()), quoteBody(10))
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ reason: 'amount_out_of_range' })
  })

  it('rejects a payload it cannot parse as invalid', async () => {
    const res = await post(hostFor(make()), quoteBody('ten thousand'))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ reason: 'unsupported_payload' })
  })

  /**
   * The host replaces any reason outside the closed RFQ set on the way out, so
   * a corridor that invented one would look fine here and be mute on the wire.
   * Both refusals above naming their own reason is what proves the example
   * builds them through `rfqRefusalPayload`.
   */
  it('never lets an internal detail reach the client', async () => {
    const body = JSON.stringify(await (await post(hostFor(make()), quoteBody('ten thousand'))).json())
    expect(body).not.toContain('whole number of sats')
  })

  /**
   * Through the READER set, which is the wider one. A corridor registered only
   * as quotable serves swaps that `rfq_status_request` then cannot find.
   */
  it('answers rfq_status_request for a swap it quoted', async () => {
    const app = hostFor(make())
    await post(app, quoteBody(10_000))
    const res = await app.fetch(new Request(`http://host/v1/rfq/${RFQ_ID}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ type: 'rfq_status', state: 'quoted' })
  })

  it('is a 404 rather than an error for an rfq_id nobody holds', async () => {
    const res = await hostFor(make()).fetch(new Request(`http://host/v1/rfq/${'b'.repeat(64)}`))
    expect(res.status).toBe(404)
  })

  /**
   * NULL, never a refusal. A refusal would end the host's fall-through across
   * corridors and hide a live swap belonging to the corridor registered after
   * this one — the failure `core/corridor.ts` warns about and nothing enforces.
   */
  it('answers null for an rfq_id it does not hold', async () => {
    await expect(make().statusFor('b'.repeat(64))).resolves.toBeNull()
  })
})

describe('the example corridor’s sweep', () => {
  const quote = async (corridor: Corridor, amount = 10_000) => {
    const outcome = await corridor.quote(quoteBody(amount))
    expect(outcome.kind).toBe('quote')
  }

  it('reports how many rows MOVED, not how many exist', async () => {
    const corridor = make()
    await quote(corridor)
    expect(await corridor.tickAll()).toBe(1) // quoted -> issuing
    expect(await corridor.tickAll()).toBe(1) // issuing -> issued
    // Terminal. The row is still there and still pages; nothing moved.
    expect(await corridor.tickAll()).toBe(0)
    expect((await corridor.page({})).swaps).toHaveLength(1)
  })

  /**
   * The in-flight guard, observed rather than asserted about.
   *
   * Two sweeps overlapping is the ordinary case — a timer firing while an
   * operator's recheck is still running. Without the guard both passes advance
   * the same row, so it crosses two states on one observation and the counts sum
   * to 2. That is a state machine being driven from a stale read, which on a
   * real corridor is how a payment goes out twice.
   */
  it('does not advance one row twice when two sweeps overlap', async () => {
    const corridor = make()
    await quote(corridor)
    const [first, second] = await Promise.all([corridor.tickAll(), corridor.tickAll()])
    expect(first + second).toBe(1)
    expect((await corridor.page({})).swaps[0]?.state).toBe('issuing')
  })

  it('counts only live rows as committed, and stops watching terminal ones', async () => {
    const corridor = make()
    await quote(corridor, 10_000)
    expect(await corridor.committedSats()).toBe(10_000)
    expect(await corridor.findRecoverable()).toHaveLength(1)
    await corridor.tickAll()
    await corridor.tickAll()
    expect(await corridor.committedSats()).toBe(0)
    expect(await corridor.findRecoverable()).toEqual([])
  })

  /**
   * `tick` is NOT gated by the in-flight guard: a direct caller is a human or an
   * event asking once. Gating it would make the console's recheck button report
   * "nothing happened" while something plainly had.
   */
  it('advances a single row through the direct tick, and ignores an unknown id', async () => {
    const corridor = make()
    await quote(corridor)
    await corridor.tick('voucher-0')
    expect((await corridor.page({})).swaps[0]?.state).toBe('issuing')
    await expect(corridor.tick('no-such-row')).resolves.toBeUndefined()
  })

  it('buckets each state into the phase the console reads', async () => {
    const corridor = make()
    await quote(corridor)
    const phaseNow = async () => (await corridor.page({})).swaps[0]?.phase
    expect(await phaseNow()).toBe('open') // quoted
    await corridor.tickAll()
    expect(await phaseNow()).toBe('exposed') // issuing — money out, checked first
    await corridor.tickAll()
    expect(await phaseNow()).toBe('done') // issued
  })

  it('reports detail for its own row and null for anyone else’s', async () => {
    const corridor = make()
    await quote(corridor)
    expect(await corridor.detail('voucher-0')).toMatchObject({ swap: { id: 'voucher-0' } })
    expect(await corridor.detail('voucher-99')).toBeNull()
  })
})

/**
 * The descriptor obligations `docs/authoring.md` lists as stated-and-unenforced.
 *
 * `test/corridors/registry.test.ts` checks these over `ALL_DESCRIPTORS`, which
 * holds the four built-ins and nothing else — so neither the EVM descriptors nor
 * a consumer's are covered by it. Asserted here for the example specifically,
 * because a template that violates them propagates the violation.
 */
describe('the example descriptor keeps the promises nothing else checks', () => {
  it('lists every exposed state as live', () => {
    expect(VOUCHER.states.exposed.filter((s: string) => !VOUCHER.states.live.includes(s))).toEqual([])
  })

  it('never lists a delivered state as live', () => {
    expect(VOUCHER.states.delivered.filter((s: string) => VOUCHER.states.live.includes(s))).toEqual([])
  })

  it('has a shell-safe env stem, since it becomes `<STEM>_ENABLED`', () => {
    expect(VOUCHER.envStem).toMatch(/^[A-Z][A-Z0-9_]*$/)
  })

  it('names a payout rail the console can resolve', () => {
    // A rail this build does not have reads UNKNOWN forever rather than
    // throwing, so a typo here is invisible at runtime.
    expect(sdk.balanceOfRail(new Map(), VOUCHER.payoutRail).error).toContain('no rail registered')
  })
})

describe('the example corridor joins the registry beside the built-ins', () => {
  it('coexists with a built-in rather than replacing it', () => {
    const set = sdk.createCorridorSet([make()])
    expect(set.get('arkade:BTC->voucher:BTC')?.descriptor.envStem).toBe('VOUCHER')
  })

  /**
   * The example must not model a corridor that could shadow a real one.
   *
   * Through `corridorSetFromDeps`, because that is the composition root's own
   * assembly — the built-ins are in the set there, and a collision is only
   * detectable against corridors that are actually present. `createCorridorSet`
   * on a one-element array can never collide with anything.
   */
  it('would be refused at composition if it claimed a built-in stem', () => {
    const deps = { store: {}, onchainStore: {}, service: {} } as unknown as sdk.FlatCorridorDeps
    const hijack = {
      ...make(),
      descriptor: { ...VOUCHER, envStem: descriptorFor('arkade:BTC->lightning:BTC').envStem },
    }
    expect(() => sdk.corridorSetFromDeps(deps, [hijack])).toThrow(/duplicate corridor env stem/)
  })

  it('is admitted by that same assembly under its own stem', () => {
    const deps = { store: {}, onchainStore: {}, service: {} } as unknown as sdk.FlatCorridorDeps
    expect(sdk.corridorSetFromDeps(deps, [make()]).get('arkade:BTC->voucher:BTC')?.descriptor.envStem).toBe('VOUCHER')
  })
})
