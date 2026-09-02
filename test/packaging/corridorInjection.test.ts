/**
 * A consumer corridor reaches the shipped daemon, not just a hand-built host.
 *
 * `createServices` cannot be called here — it needs an Arkade wallet, a
 * Lightning node and a chain — so the registry assembly it delegates to is
 * tested directly, plus a source check that it threads the option through.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as sdk from '../../src/index.js'
import { corridorSetFromDeps, readerSetFromDeps, type FlatCorridorDeps } from '../../src/ops/corridorSet.js'
import { descriptorFor } from '@arkade-os/solver-corridors/corridors/index.js'
import type { Corridor, CorridorDescriptor } from '../../src/index.js'

const servicesSource = readFileSync(fileURLToPath(new URL('../../src/ops/services.ts', import.meta.url)), 'utf8')

const descriptor = (pair: string, envStem: string): CorridorDescriptor => ({
  pair,
  envStem,
  payoutRail: 'arkade',
  states: { live: ['open'], exposed: [], delivered: ['done'] },
})

const corridorFor = (pair: string, envStem: string): Corridor => ({
  descriptor: descriptor(pair, envStem),
  quote: async () => ({ kind: 'refused' as const, payload: { reason: 'unsupported_pair' } }),
  statusFor: async (rfqId) => (rfqId === 'known' ? { v: 1, type: 'rfq_status' } : null),
  tick: async () => {},
  tickAll: async () => 3,
  findRecoverable: async () => [],
  committedSats: async () => 0,
  page: async () => ({ swaps: [], nextCursor: null }),
  detail: async () => null,
  close: async () => {},
})

/** Only the two stores `readerSetFromDeps` requires; no corridor is enabled. */
const bareDeps = { store: {}, onchainStore: {} } as unknown as FlatCorridorDeps

describe('a consumer corridor joins the shipped registry', () => {
  it('is quotable beside the built-ins', () => {
    const set = corridorSetFromDeps(bareDeps, [corridorFor('arkade:BTC->example:BTC', 'EXAMPLE')])
    expect(set.get('arkade:BTC->example:BTC')?.descriptor.envStem).toBe('EXAMPLE')
  })

  it('is driven by the same sweep, so its swaps reach a terminal state', async () => {
    // The watch loop is `for (const corridor of services.corridors) corridor.tickAll()`.
    // Absent from the set, an injected corridor quotes and then never advances.
    const set = corridorSetFromDeps(bareDeps, [corridorFor('arkade:BTC->example:BTC', 'EXAMPLE')])
    let ticked = 0
    for (const corridor of set) ticked += await corridor.tickAll()
    expect(ticked).toBe(3)
  })

  it('answers rfq_status_request, which needs it in the READER set too', async () => {
    const readers = readerSetFromDeps(bareDeps, [corridorFor('arkade:BTC->example:BTC', 'EXAMPLE')])
    const found = await readers.get('arkade:BTC->example:BTC')?.statusFor('known')
    expect(found).toMatchObject({ type: 'rfq_status' })
  })

  it('cannot shadow a built-in pair — the collision is refused at composition', () => {
    // Silently overriding `arkade:BTC->lightning:BTC` would route real swaps to
    // consumer code. `createCorridorSet` refuses duplicates, and routing the
    // extras through it rather than merging afterwards is what applies that.
    const deps = { store: {}, onchainStore: {}, service: {}, onchainService: {} } as unknown as FlatCorridorDeps
    expect(() => corridorSetFromDeps(deps, [corridorFor('arkade:BTC->lightning:BTC', 'HIJACK')])).toThrow(
      /duplicate corridor pair/,
    )
  })

  it('cannot shadow a built-in env stem either', () => {
    // A duplicate stem darkens a corridor the operator did not name, because
    // `<STEM>_ENABLED=false` would hit both.
    const deps = { store: {}, onchainStore: {}, service: {} } as unknown as FlatCorridorDeps
    const stem = descriptorFor('arkade:BTC->lightning:BTC').envStem
    expect(() => corridorSetFromDeps(deps, [corridorFor('arkade:BTC->other:BTC', stem)])).toThrow(
      /duplicate corridor env stem/,
    )
  })
})

describe('createServices exposes the extension point', () => {
  it('is exported from the entrypoint', () => {
    expect(sdk.createServices).toBeTypeOf('function')
  })

  it('threads opts.corridors into BOTH the quoting set and the readers', () => {
    // Passing it to only one leaves a corridor that quotes but reports no
    // status, or reports status it never served.
    expect(servicesSource).toContain('corridorSetFromDeps(corridorDeps, opts?.corridors ?? [])')
    expect(servicesSource).toContain('readerSetFromDeps(corridorDeps, opts?.corridors ?? [])')
  })
})
