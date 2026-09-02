import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { registerDiagnosticsRoutes } from '../../src/admin/routes/diagnostics.js'
import { buildAdminApp } from '../../src/admin/server.js'
import { AdPublisher, type AdPublishMode } from '@arkade-os/solver-transport/relay/adPublisher.js'

/** Every corridor at the same cap, so a test that cares about caps must say so. */
const flatLimits = (maxSats: number) => ({
  'arkade:BTC->lightning:BTC': { minSats: 1_000, maxSats },
  'lightning:BTC->arkade:BTC': { minSats: 1_000, maxSats },
  'arkade:BTC->onchain:BTC': { minSats: 1_000, maxSats },
  'onchain:BTC->arkade:BTC': { minSats: 1_000, maxSats },
})

const allCorridors = <T>(value: T) => ({
  'arkade:BTC->lightning:BTC': value,
  'lightning:BTC->arkade:BTC': value,
  'arkade:BTC->onchain:BTC': value,
  'onchain:BTC->arkade:BTC': value,
})

/**
 * A COMPLETE service double, every member the route actually reaches.
 *
 * Deliberately a factory rather than a shared literal. The headroom answer is
 * a function of three separate balances and four separate caps, so a test that
 * cannot vary them one at a time cannot tell a correct implementation from one
 * that reads a single wallet — which is exactly how the first version of this
 * route shipped measuring every corridor against the Arkade balance and the
 * global cap, with a green suite.
 *
 * `as never` means `tsc` will not catch a member missing from here, so
 * completeness is held in place by the "drives every probe green" test below
 * rather than by the compiler.
 */
const makeDeps = (
  over: {
    lnSats?: number
    lnThrows?: string
    arkadeSats?: number
    arkadeThrows?: string
    onchainConfirmed?: number
    onchainUnconfirmed?: number
    onchainThrows?: string
    corridorLimits?: ReturnType<typeof flatLimits>
    globalMaxSats?: number
    overrides?: Record<string, string>
    overridesThrows?: string
    relay?: { url: string; isConnected: () => boolean }
    nostrAdPublish?: AdPublishMode
    adPublisher?: AdPublisher
  } = {},
) =>
  ({
    services: {
      config: {
        lnBackend: 'lnd',
        arkade: { arkServerUrl: 'http://ark' },
        emulatorUrl: 'http://emu',
        // Kept deliberately DIFFERENT from the per-corridor caps in the tests
        // that care, so reverting to it is detectable rather than invisible.
        limits: { minSats: 1_000, maxSats: over.globalMaxSats ?? 50_000 },
        corridorLimits: over.corridorLimits ?? flatLimits(50_000),
        corridorFees: allCorridors({ bps: 0, flatSats: 0 }),
        corridorEnabled: allCorridors(true),
        maxExposedSats: 100_000,
        // The reported publish mode is read from here, never synthesised, so
        // this page cannot disagree with /api/card about it.
        nostrAdPublish: over.nostrAdPublish ?? 'off',
      },
      ln: {
        getBalance: async () => {
          if (over.lnThrows) throw new Error(over.lnThrows)
          return { availableSats: over.lnSats ?? 5, incomingSats: 0 }
        },
      },
      arkade: {
        wallet: {
          getAddress: async () => 'tark1x',
          getBalance: async () => {
            if (over.arkadeThrows) throw new Error(over.arkadeThrows)
            return { available: over.arkadeSats ?? 40_000 }
          },
        },
      },
      emulatorPubkey: 'ab'.repeat(16),
      onchain: {
        estimateFeeRate: async () => 7,
        getBalance: async () => {
          if (over.onchainThrows) throw new Error(over.onchainThrows)
          return {
            confirmedSats: over.onchainConfirmed ?? 1,
            unconfirmedSats: over.onchainUnconfirmed ?? 0,
          }
        },
      },
      adminStore: {
        getOverrides: async () => {
          if (over.overridesThrows) throw new Error(over.overridesThrows)
          return over.overrides ?? {}
        },
      },
    },
    startedAt: 1_800_000_000,
    mode: 'relay',
    now: () => 1_800_000_060,
    ...(over.relay ? { relay: over.relay } : {}),
    ...(over.adPublisher ? { adPublisher: over.adPublisher } : {}),
  }) as never

const deps = makeDeps()

interface CorridorRow {
  corridor: string
  advertisedMaxSats: number
  payoutRail: string
  availableSats: number | null
  balanceError: string | null
  canHonourMax: boolean
}

const diagnose = async (d: ReturnType<typeof makeDeps>) => {
  const app = new Hono()
  registerDiagnosticsRoutes(app, d)
  const response = await app.request('/api/diagnostics')
  return { response, body: (await response.json()) as Record<string, unknown> }
}

const corridorsOf = async (d: ReturnType<typeof makeDeps>): Promise<Record<string, CorridorRow>> => {
  const { body } = await diagnose(d)
  return Object.fromEntries((body['corridors'] as CorridorRow[]).map((row) => [row.corridor, row]))
}

describe('GET /api/diagnostics', () => {
  it('stamps every probe so a frozen one is distinguishable from a fresh one', async () => {
    const app = new Hono()
    registerDiagnosticsRoutes(app, deps)
    // `lastCheckedAt` is typed `unknown` deliberately: it is the property under
    // test, and a cast that declared it a number would assert the very thing
    // the assertion is meant to establish at runtime.
    const body = (await (await app.request('/api/diagnostics')).json()) as {
      backends: { lastCheckedAt: unknown }[]
    }
    expect(body.backends.length).toBeGreaterThan(0)
    for (const b of body.backends) expect(typeof b.lastCheckedAt).toBe('number')
  })

  it('reports uptime from the injected clock', async () => {
    const app = new Hono()
    registerDiagnosticsRoutes(app, deps)
    const body = (await (await app.request('/api/diagnostics')).json()) as { uptimeSeconds: number }
    expect(body.uptimeSeconds).toBe(60)
  })

  // The question the page exists to answer: can this corridor honour what it
  // advertises? A corridor whose max quote exceeds available funds is the
  // thing an operator needs to see, and no existing view shows it.
  it('flags a corridor whose advertised max exceeds available funds', async () => {
    const app = new Hono()
    registerDiagnosticsRoutes(app, deps)
    const body = (await (await app.request('/api/diagnostics')).json()) as {
      corridors: { canHonourMax: boolean }[]
    }
    const short = body.corridors.find((c: { canHonourMax: boolean }) => !c.canHonourMax)
    expect(short).toBeDefined()
  })

  /**
   * Guards the DOUBLE, not the route.
   *
   * A probe that threw is still stamped and its `lastCheckedAt` is still a
   * number, so the first test above passes just as happily against four dead
   * backends. That is not hypothetical: a double missing `onchain.getBalance`
   * once let three tests run a failing probe and stay green, because none of
   * them asserted the row. `as never` means the compiler will not catch the
   * next one either, so the assertion has to live here.
   */
  it('drives every probe green, so the stamps above are stamps on real reads', async () => {
    const app = new Hono()
    registerDiagnosticsRoutes(app, deps)
    const body = (await (await app.request('/api/diagnostics')).json()) as {
      backends: { name: string; ok: boolean; error: string | null }[]
      overridesError: string | null
    }
    expect(body.backends.map((b) => b.name)).toEqual(['lightning', 'arkade', 'emulator', 'onchain'])
    // Compared as rows rather than as a count: a failure here should name the
    // backend and quote its error, not just say "expected 0 to be 4".
    expect(body.backends.filter((b) => !b.ok)).toEqual([])
    expect(body.overridesError).toBeNull()
  })

  /**
   * The headroom question, on the axis a single-wallet implementation gets
   * wrong: the solver pays out on the corridor's DESTINATION leg.
   *
   * Arkade is deliberately RICH and Lightning deliberately POOR, so reading one
   * wallet for every corridor gives the opposite answer for
   * `arkade:BTC->lightning:BTC`. The caps deliberately diverge too — and
   * `arkade:BTC->onchain:BTC` sits BELOW its own cap but above the global one —
   * so measuring against `config.limits.maxSats` also flips an answer. The
   * previous fixture (40k against a flat 50k) could detect neither, because it
   * made every corridor short whichever number was consulted.
   */
  it('measures each corridor against its own payout rail and its own cap', async () => {
    const rows = await corridorsOf(
      makeDeps({
        lnSats: 1_000, // poor
        arkadeSats: 100_000, // rich
        onchainConfirmed: 5_000,
        globalMaxSats: 50_000,
        corridorLimits: {
          'arkade:BTC->lightning:BTC': { minSats: 1_000, maxSats: 25_000 },
          'lightning:BTC->arkade:BTC': { minSats: 1_000, maxSats: 50_000 },
          'arkade:BTC->onchain:BTC': { minSats: 1_000, maxSats: 3_000 },
          'onchain:BTC->arkade:BTC': { minSats: 1_000, maxSats: 50_000 },
        },
      }),
    )

    // Pays out over Lightning, which holds 1 000 against a 25 000 cap. A
    // single-wallet implementation reads Arkade's 100 000 here and says true.
    expect(rows['arkade:BTC->lightning:BTC']).toMatchObject({
      payoutRail: 'lightning',
      advertisedMaxSats: 25_000,
      availableSats: 1_000,
      canHonourMax: false,
    })

    // Pays out on Arkade, which is rich enough.
    expect(rows['lightning:BTC->arkade:BTC']).toMatchObject({
      payoutRail: 'arkade',
      advertisedMaxSats: 50_000,
      availableSats: 100_000,
      canHonourMax: true,
    })

    // 5 000 confirmed clears this corridor's own 3 000 cap but NOT the global
    // 50 000, so this row is what fails if the global cap is used instead.
    expect(rows['arkade:BTC->onchain:BTC']).toMatchObject({
      payoutRail: 'onchain',
      advertisedMaxSats: 3_000,
      availableSats: 5_000,
      canHonourMax: true,
    })

    expect(rows['onchain:BTC->arkade:BTC']).toMatchObject({
      payoutRail: 'arkade',
      advertisedMaxSats: 50_000,
      canHonourMax: true,
    })
  })

  /**
   * Unconfirmed sats are not headroom.
   *
   * The cap sits between the confirmed balance and confirmed+unconfirmed, so
   * counting unconfirmed funds flips this corridor to fundable. "Can I honour
   * a quote right now" is a question about money that is actually spendable.
   */
  it('counts only confirmed sats on the onchain rail', async () => {
    const rows = await corridorsOf(
      makeDeps({
        onchainConfirmed: 5_000,
        onchainUnconfirmed: 900_000,
        corridorLimits: flatLimits(100_000),
        arkadeSats: 100_000,
      }),
    )
    expect(rows['arkade:BTC->onchain:BTC']).toMatchObject({
      payoutRail: 'onchain',
      availableSats: 5_000,
      canHonourMax: false,
    })
  })

  /**
   * ONE DEAD BACKEND MUST NOT BLANK THE PAGE — at corridor granularity.
   *
   * A dead Lightning node must take down the answer for the one corridor it
   * funds and nothing else. Sharing a single error across all four would be as
   * misleading as ignoring it: three corridors are still perfectly fundable.
   */
  it('confines an unreadable rail to the corridors that rail actually funds', async () => {
    const rows = await corridorsOf(
      makeDeps({
        lnThrows: 'lnd unreachable',
        arkadeSats: 100_000,
        onchainConfirmed: 5_000,
        corridorLimits: flatLimits(50_000),
      }),
    )

    // The casualty: unknown, reported, and NOT fundable.
    expect(rows['arkade:BTC->lightning:BTC']).toMatchObject({
      payoutRail: 'lightning',
      availableSats: null,
      canHonourMax: false,
    })
    expect(rows['arkade:BTC->lightning:BTC']?.balanceError).toContain('lnd unreachable')

    // Everything the dead rail does not fund still answers.
    for (const corridor of ['lightning:BTC->arkade:BTC', 'onchain:BTC->arkade:BTC']) {
      expect(rows[corridor]).toMatchObject({ payoutRail: 'arkade', availableSats: 100_000, canHonourMax: true })
      expect(rows[corridor]?.balanceError).toBeNull()
    }
    expect(rows['arkade:BTC->onchain:BTC']).toMatchObject({ availableSats: 5_000, balanceError: null })
  })

  /**
   * ONE DEAD BACKEND MUST NOT BLANK THE PAGE.
   *
   * The rule `probes.ts` and the `attempt` helper in `status.ts` both exist to
   * enforce, restated for this route because it is the route an operator opens
   * *because* something is wrong. A 500 here is the exact failure the console
   * was built to end.
   */
  it('still answers 200 with the damage itemised when backends and the wallet are down', async () => {
    const { response, body } = await diagnose(
      makeDeps({
        lnThrows: 'lnd unreachable',
        arkadeThrows: 'wallet locked',
        relay: { url: 'wss://relay.example', isConnected: () => false },
      }),
    )
    expect(response.status).toBe(200)

    const backends = body['backends'] as { name: string; ok: boolean; error: string | null }[]
    expect(backends.find((b) => b.name === 'lightning')?.error).toContain('lnd unreachable')
    // The backends that DID answer are still reported — the whole point of
    // catching each read on its own.
    expect(backends.find((b) => b.name === 'onchain')?.ok).toBe(true)
    // A disconnected relay reports `false`; it does not throw.
    expect(body['relay']).toEqual({ url: 'wss://relay.example', connected: false })

    const rows = body['corridors'] as CorridorRow[]
    expect(rows.find((r) => r.corridor === 'lightning:BTC->arkade:BTC')?.balanceError).toContain('wallet locked')
    // Unknown headroom is not headroom: an unreadable balance must read as
    // "cannot honour", never as the 0-sat default silently passing a check.
    expect(rows.every((r) => !r.canHonourMax)).toBe(true)
  })

  /**
   * An unreadable overrides table degrades to the environment's own limits
   * rather than 500-ing, and says so. Same reasoning as a dead rail: this page
   * is opened when things are broken.
   */
  it('falls back to environment limits when stored overrides cannot be read', async () => {
    const { response, body } = await diagnose(makeDeps({ overridesThrows: 'database is locked' }))
    expect(response.status).toBe(200)
    expect(body['overridesError']).toContain('database is locked')
    expect((body['corridors'] as CorridorRow[])[0]?.advertisedMaxSats).toBe(50_000)
  })

  /** A stored override narrows the advertised max, exactly as `/api/overview` reports it. */
  it('reflects a stored override in the advertised maximum', async () => {
    const rows = await corridorsOf(makeDeps({ overrides: { LN_SEND_MAX_SATS: '9000' } }))
    expect(rows['arkade:BTC->lightning:BTC']?.advertisedMaxSats).toBe(9_000)
    // Untouched corridors keep the environment's cap.
    expect(rows['lightning:BTC->arkade:BTC']?.advertisedMaxSats).toBe(50_000)
  })

  /**
   * Whether this solver is advertising is part of "is it healthy" — a solver
   * nobody can discover is not serving anyone, however green its rails are.
   *
   * `publish` is ALWAYS an object, never null. The absence this page has to
   * report is not "no state to show" but "nothing is wired to publish", and
   * that is one field (`publisher`) beside the mode the operator configured —
   * collapsing the two into a null, or into a synthesised `off`, throws away
   * the fact the operator most wants confirmed: that their setting took.
   */
  it('reports the configured mode and whether anything can publish', async () => {
    const ad = { v: 1 as const, type: 'solver_ad' as const, pairs: [], relays: [] }
    const publisher = new AdPublisher({
      mode: 'auto',
      buildAd: () => ad,
      publish: vi.fn(async () => {}),
      now: () => 1_800_000_000,
      heartbeatSeconds: 1800,
    })
    const { body } = await diagnose(makeDeps({ nostrAdPublish: 'auto', adPublisher: publisher }))
    expect(body['publish']).toEqual({
      mode: 'auto',
      publisher: true,
      lastPublishedAt: null,
      lastError: null,
      // Reported so the page can say when the next heartbeat is due rather
      // than leaving "last published 40 minutes ago" unreadable.
      heartbeatSeconds: 1800,
    })

    // Configured `auto`, nothing wired: the mode still reads `auto`, because
    // that IS what the operator configured. `publisher: false` carries the
    // other half, and `heartbeatSeconds` is null because no publisher holds one.
    const { body: without } = await diagnose(makeDeps({ nostrAdPublish: 'auto' }))
    expect(without['publish']).toEqual({
      mode: 'auto',
      publisher: false,
      lastPublishedAt: null,
      lastError: null,
      heartbeatSeconds: null,
    })
  })

  /**
   * The registration itself, through the real app.
   *
   * Every test above mounts the route on a bare `Hono`, so all of them stay
   * green even if `buildAdminApp` never calls `registerDiagnosticsRoutes` — the
   * route would 404 into the static catch-all in production and nothing here
   * would notice. Asserting a non-404 through the assembled app is what makes
   * the wiring, rather than just the handler, covered.
   */
  it('is reachable through the assembled admin app, not just a bare router', async () => {
    const response = await buildAdminApp(deps).fetch(new Request('http://admin/api/diagnostics'))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { corridors: unknown[]; mode: string }
    expect(body.corridors).toHaveLength(4)
    expect(body.mode).toBe('relay')
  })
})
