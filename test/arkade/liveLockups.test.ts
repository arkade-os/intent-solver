/**
 * The completeness guarantee `liveLockupRows` used to get from four named deps.
 *
 * An unregistered lockup gets none of the `isGenericallySpendable: false` gate
 * that protects it from renewal, and no recovery path if it is swept — so a
 * corridor silently dropped from this set is capital lost, not a display bug.
 * It has happened once already: the set was built from the two SEND corridors
 * and never read the receive legs at all.
 *
 * The old signature made completeness a COMPILE-TIME fact: four named fields,
 * all required. A set cannot do that, so the guarantee lives here instead —
 * every corridor read, every corridor's rows kept, and a non-empty set in which
 * NOTHING answered refused rather than silently returning an empty list.
 */
import { describe, it, expect } from 'vitest'
import { liveLockupRows } from '@arkade-os/solver-arkade/arkade/vtxoLifecycle.js'
import { createCorridorReaderSet, type CorridorReader } from '@arkade-os/solver-core/core/corridor.js'

const descriptorFor = (pair: string) => ({
  pair,
  envStem: 'X',
  payoutRail: 'arkade' as const,
  states: { live: [], exposed: [], delivered: [] },
})

/**
 * A COMPLETE row, because `liveLockupRows` now checks the shape rather than
 * casting it. A partial fake would fail for the right reason and stop these
 * tests from reaching what they are actually about.
 */
const rowFor = (id: string) => ({
  id,
  receiverPubkey: 'aa'.repeat(32),
  serverPubkey: 'bb'.repeat(32),
  paymentHash: 'cc'.repeat(32),
  refundLocktime: 1_800_000_000,
  claimDelay: 144,
  emulatorPubkey: null,
  refundPkScript: null,
  pkScript: `ff${id}`,
  clientRefundPubkey: null,
  refundWithoutReceiverDelay: 512,
  refundDelay: 1024,
  receiverPkScript: null,
  // Present and null, as a real row always is: the column selects a covenant
  // suite shape, so `assertCovenantScriptRow` refuses a row that omits it.
  nonInteractiveParameters: null,
})

/** A reader that records the fact it was asked, and hands back `rows` lockups. */
const fakeReader = (pair: string, calls: string[], rows = 1): CorridorReader =>
  ({
    descriptor: descriptorFor(pair),
    liveLockups: async () => {
      calls.push(pair)
      return Array.from({ length: rows }, (_, i) => rowFor(`${pair}-${i}`))
    },
  }) as unknown as CorridorReader

/** A corridor that supplies no lockups at all — the shape the emptiness check is about. */
const muteReader = (pair: string): CorridorReader => ({ descriptor: descriptorFor(pair) }) as unknown as CorridorReader

const setOf = (readers: readonly CorridorReader[]) => createCorridorReaderSet(readers)

describe('liveLockupRows', () => {
  it('reads EVERY corridor in the set, not a prefix of it', async () => {
    const calls: string[] = []
    const readers = [1, 2, 3, 4, 5].map((n) => fakeReader(`c${n}`, calls))
    await liveLockupRows(setOf(readers))
    expect(calls).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])
  })

  it('concatenates every corridor’s rows rather than stopping at the first that answers', async () => {
    const calls: string[] = []
    const rows = await liveLockupRows(setOf([fakeReader('a', calls, 2), fakeReader('b', calls, 3)]))
    expect(rows).toHaveLength(5)
  })

  /**
   * The guarantee the old signature gave for free and an array cannot. A set in
   * which nothing answered is far more likely to be a wiring fault than a
   * genuinely empty solver — and returning [] there would report every contract
   * as no longer live, which is what drives retirement.
   */
  it('refuses a non-empty set in which no corridor supplies lockups', async () => {
    await expect(liveLockupRows(setOf([muteReader('x->y')]))).rejects.toThrow(/no corridor supplied/)
  })

  it('accepts an EMPTY set, which is a solver serving nothing at all', async () => {
    await expect(liveLockupRows(setOf([]))).resolves.toEqual([])
  })

  /**
   * A corridor that holds no lockups right now is normal and must not poison
   * the pass — what matters is that SOMETHING answered.
   */
  it('tolerates a mute corridor alongside one that answers', async () => {
    const calls: string[] = []
    const rows = await liveLockupRows(setOf([muteReader('mute'), fakeReader('live', calls, 2)]))
    expect({ rows: rows.length, calls }).toEqual({ rows: 2, calls: ['live'] })
  })

  /**
   * The gap the emptiness throw cannot see, raised in review of #215.
   *
   * The test above is the SAFE reading of partial silence; this is the unsafe
   * one. `answered` is non-zero, so the throw passes, and a corridor that
   * holds real lockups but omits `liveLockups` has them dropped with nothing
   * said. It cannot throw — a corridor with nothing to report may legitimately
   * omit the method, and this layer cannot tell the two apart — so the
   * requirement is that it becomes VISIBLE.
   */
  it('names the mute corridors when others answered, so a partial wiring fault is visible', async () => {
    const calls: string[] = []
    const logged: string[] = []
    // Named 'answering' rather than 'live': the message itself opens with
    // "live lockups:", so a corridor called 'live' would satisfy the negative
    // assertion below against the PREFIX and prove nothing.
    await liveLockupRows(setOf([muteReader('mute-a'), fakeReader('answering', calls), muteReader('mute-b')]), (line) =>
      logged.push(line),
    )
    expect(logged).toHaveLength(1)
    // Named individually: "2 corridors were mute" does not tell an operator
    // WHICH wiring to go and look at.
    expect(logged[0]).toContain('mute-a')
    expect(logged[0]).toContain('mute-b')
    expect(logged[0]).not.toContain('answering')
  })

  it('says nothing when every corridor answers', async () => {
    const logged: string[] = []
    await liveLockupRows(setOf([fakeReader('a', []), fakeReader('b', [])]), (line) => logged.push(line))
    expect(logged).toEqual([])
  })

  /**
   * `liveLockups` is typed `readonly unknown[]`, and a plugged-in corridor is
   * third-party code. A cast would carry a malformed row into
   * `covenantScriptFromRow`, which builds a script from whatever it is handed —
   * and a wrong script registers the wrong contract, hiding the real lockup
   * from `getVtxos`. Failing here names the corridor that produced it.
   */
  it('rejects a malformed row, naming the corridor that supplied it', async () => {
    const rogue = {
      descriptor: descriptorFor('rogue->pair'),
      liveLockups: async () => [{ ...rowFor('x'), refundLocktime: 'not-a-number' }],
    } as unknown as CorridorReader
    await expect(liveLockupRows(setOf([rogue]))).rejects.toThrow(/rogue->pair.*refundLocktime/)
  })

  /**
   * The message must name the value it rejected, and NaN is the case that
   * decides how. `JSON.stringify(NaN)` is `"null"`, so the obvious
   * implementation reports the wrong fault in the very case a finite-number
   * check most often catches.
   */
  it('reports NaN as NaN rather than null', async () => {
    const rogue = {
      descriptor: descriptorFor('rogue->pair'),
      liveLockups: async () => [{ ...rowFor('x'), claimDelay: Number.NaN }],
    } as unknown as CorridorReader
    await expect(liveLockupRows(setOf([rogue]))).rejects.toThrow(/claimDelay is NaN/)
  })

  it('quotes a string that should have been a number, so 5 and "5" read differently', async () => {
    const rogue = {
      descriptor: descriptorFor('rogue->pair'),
      liveLockups: async () => [{ ...rowFor('x'), refundDelay: '512' }],
    } as unknown as CorridorReader
    await expect(liveLockupRows(setOf([rogue]))).rejects.toThrow(/refundDelay is "512"/)
  })

  it('rejects a row that is not an object at all', async () => {
    const rogue = {
      descriptor: descriptorFor('rogue->pair'),
      liveLockups: async () => ['just a string'],
    } as unknown as CorridorReader
    await expect(liveLockupRows(setOf([rogue]))).rejects.toThrow(/rogue->pair/)
  })
})
