import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CORRIDORS } from '@arkade-os/solver-core/core/corridorPolicy.js'
import { createCorridorRegistry, type CorridorDescriptor } from '@arkade-os/solver-core/core/corridorDescriptor.js'
import { ALL_DESCRIPTORS, CORRIDOR_REGISTRY, descriptorFor } from '@arkade-os/solver-corridors/corridors/index.js'
import {
  lightningReceiveReader,
  lightningSendReader,
  onchainReceiveReader,
  onchainSendReader,
} from '@arkade-os/solver-corridors/corridors/adapters.js'
import { valueImports } from '../support/importScan.js'
import { EXPOSED as LN_SEND_EXPOSED, NON_TERMINAL as LN_SEND_LIVE } from '@arkade-os/solver-corridors/db/swaps.js'
import {
  EXPOSED as LN_RECV_EXPOSED,
  NON_TERMINAL as LN_RECV_LIVE,
} from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import {
  EXPOSED as ON_SEND_EXPOSED,
  NON_TERMINAL as ON_SEND_LIVE,
} from '@arkade-os/solver-corridors/db/onchainSwaps.js'
import {
  EXPOSED as ON_RECV_EXPOSED,
  NON_TERMINAL as ON_RECV_LIVE,
} from '@arkade-os/solver-corridors/db/onchainReceiveSwaps.js'

const CORRIDORS_DIR = fileURLToPath(new URL('../../packages/solver-corridors/src/corridors/', import.meta.url))

const stub = (pair: string, envStem: string): CorridorDescriptor => ({
  pair,
  envStem,
  payoutRail: 'arkade',
  states: { live: ['quoted'], exposed: [], delivered: ['settled'] },
})

describe('the corridor registry', () => {
  /**
   * The bridge that keeps the forcing function alive while BOTH forms exist.
   * `Corridor` is still a closed union, so this failing is how a fifth corridor
   * added to CORRIDORS without a descriptor gets caught.
   */
  it('describes exactly the corridors CORRIDORS declares', () => {
    expect([...CORRIDOR_REGISTRY.keys()].sort()).toEqual([...CORRIDORS].sort())
  })

  it('refuses two descriptors claiming the same pair', () => {
    expect(() => createCorridorRegistry([stub('a->b', 'A'), stub('a->b', 'B')])).toThrow(/duplicate corridor pair/)
  })

  /**
   * Two corridors sharing a stem would silently share every `<STEM>_*` knob, so
   * disabling one would dark the other. Caught at construction, not at quote.
   */
  it('refuses two descriptors claiming the same env stem', () => {
    expect(() => createCorridorRegistry([stub('a->b', 'A'), stub('c->d', 'A')])).toThrow(/duplicate corridor env stem/)
  })

  it('gives every corridor a shell-safe env stem', () => {
    for (const descriptor of ALL_DESCRIPTORS) expect(descriptor.envStem).toMatch(/^[A-Z][A-Z0-9_]*$/)
  })

  /**
   * The server-independent exit is offered on EVERY row, so it must be able to
   * reach every corridor's rows. A lever rendered everywhere and keyed to one
   * store is the shape of bug `tick` and `park-swap` each shipped once, and this
   * one is reached for a parked row on the leg where the Arkade Service stopped
   * answering — the worst moment to discover it only ever read one table.
   *
   * `readerFor` writes `lockupFor` once for all four, which is what makes this
   * hold; the check exists so a fifth reader built by hand cannot quietly skip
   * it. Stub stores, because what is under test is which methods exist.
   */
  it('lets every BTC corridor describe one row’s lockup, not just its live ones', () => {
    const store = {} as never
    const readers = [
      lightningSendReader(store),
      lightningReceiveReader(store),
      onchainSendReader(store),
      onchainReceiveReader(store),
    ]
    for (const reader of readers) expect(typeof reader.lockupFor).toBe('function')
  })

  it('never lists a delivered state as live', () => {
    for (const descriptor of ALL_DESCRIPTORS) {
      const overlap = descriptor.states.delivered.filter((state) => descriptor.states.live.includes(state))
      expect({ pair: descriptor.pair, overlap }).toEqual({ pair: descriptor.pair, overlap: [] })
    }
  })
})

describe('descriptor state vocabularies', () => {
  it.each([
    ['arkade:BTC->lightning:BTC', LN_SEND_LIVE, LN_SEND_EXPOSED],
    ['lightning:BTC->arkade:BTC', LN_RECV_LIVE, LN_RECV_EXPOSED],
    ['arkade:BTC->onchain:BTC', ON_SEND_LIVE, ON_SEND_EXPOSED],
    ['onchain:BTC->arkade:BTC', ON_RECV_LIVE, ON_RECV_EXPOSED],
  ] as const)('for %s still match the store that owns them', (pair, live, exposed) => {
    const { states } = descriptorFor(pair)
    expect({ live: [...states.live], exposed: [...states.exposed] }).toEqual({
      live: [...live],
      exposed: [...exposed],
    })
  })
})

/**
 * The replacement for the exhaustive `switch (corridor)` in
 * `admin/routes/swaps.ts`, which Plan C Task 4 deletes.
 *
 * Those switches were the LAST compile-time gate forcing a new corridor to
 * answer its money-critical questions. `config.ts`'s nine `Record<Corridor, …>`
 * never forced anything — they all sit behind `Object.fromEntries(...) as
 * Record<Corridor, …>`, and a cast suppresses the very exhaustiveness error the
 * table is credited with. That was MEASURED, not assumed: a fifth member was
 * added to `CORRIDORS` and the only TS2366s came from those two switches.
 *
 * Deleting them without this check would leave nothing at all, which is the
 * exact shape of issue #88 — a bound whose documented reason is satisfied while
 * an unnamed invariant still rides on it.
 */
describe('every corridor answers the questions the switches used to force', () => {
  it.each(ALL_DESCRIPTORS.map((d) => [d.pair, d] as const))('%s declares a complete descriptor', (_pair, d) => {
    expect({
      envStem: typeof d.envStem === 'string' && /^[A-Z][A-Z0-9_]*$/.test(d.envStem),
      payoutRail: ['lightning', 'arkade', 'onchain'].includes(d.payoutRail),
      live: Array.isArray(d.states.live) && d.states.live.length > 0,
      delivered: Array.isArray(d.states.delivered) && d.states.delivered.length > 0,
      exposedWithinLive: d.states.exposed.every((s) => d.states.live.includes(s)),
    }).toEqual({ envStem: true, payoutRail: true, live: true, delivered: true, exposedWithinLive: true })
  })

  /**
   * Guards the guard: `it.each` over an empty array silently asserts nothing, so
   * a registry that lost its corridors would make the check above VACUOUS rather
   * than red — the failure mode that makes a replacement gate worse than none.
   */
  it('is checking a non-empty registry', () => {
    expect(ALL_DESCRIPTORS.length).toBeGreaterThan(0)
  })
})

describe('payout rails', () => {
  /**
   * Transcribed from the `PAYOUT_RAIL` table in `admin/routes/diagnostics.ts`
   * before that table was deleted. Two corridors pay out on Arkade, which is
   * why diagnostics reads once per RAIL rather than once per corridor — asking
   * the wallet twice could return two numbers and report the pair inconsistently.
   */
  it.each([
    ['arkade:BTC->lightning:BTC', 'lightning'],
    ['lightning:BTC->arkade:BTC', 'arkade'],
    ['arkade:BTC->onchain:BTC', 'onchain'],
    ['onchain:BTC->arkade:BTC', 'arkade'],
  ] as const)('funds %s from the %s balance', (pair, rail) => {
    expect(descriptorFor(pair).payoutRail).toBe(rail)
  })
})

describe('the descriptor modules', () => {
  /**
   * `config.ts` imports these as VALUES, and `db/driver.ts` statically imports
   * the `better-sqlite3` native binding. An import that survives compilation
   * here is therefore one native module away from being loaded by every caller
   * of `loadConfig()` — including tests that touch no database at all.
   */
  /**
   * Named explicitly rather than "every file here except index.ts".
   *
   * `src/corridors/` also holds `adapters.ts`, which legitimately value-imports
   * orchestrators, stores and responders — it is not on `config.ts`'s import
   * path, so it cannot drag a native binding into `loadConfig()`. A
   * subtract-the-exceptions rule would have had to grow an exception for it,
   * and the next file added here would be checked by accident or missed by
   * accident. The property being protected belongs to these four files.
   */
  const DESCRIPTOR_MODULES = ['lnSend.ts', 'lnReceive.ts', 'onchainSend.ts', 'onchainReceive.ts']

  it('are all present, so this guard cannot pass by checking nothing', () => {
    const here = readdirSync(CORRIDORS_DIR)
    expect(DESCRIPTOR_MODULES.filter((name) => !here.includes(name))).toEqual([])
  })

  it('emit no runtime imports at all, so config stays free of native bindings', () => {
    const offenders = DESCRIPTOR_MODULES.flatMap((name) =>
      valueImports(readFileSync(join(CORRIDORS_DIR, name), 'utf8')).map(
        (specifier) => `${name} value-imports ${specifier}`,
      ),
    )
    expect(offenders.sort()).toEqual([])
  })
})
