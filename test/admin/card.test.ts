import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { buildAdminApp } from '../../src/admin/server.js'
import { verifyCardSig, type SolverCard } from '@arkade-os/solver-core/core/registryCard.js'
import { AdPublisher, type AdPublishMode } from '@arkade-os/solver-transport/relay/adPublisher.js'
// `AdPublishMode` is imported for the double's `nostrAdPublish`, which is now
// the only source of the reported mode.
import { buildSolverAd } from '@arkade-os/solver-core/core/solverAd.js'

// BIP340 test vector 1, as `test/core/registryCard.test.ts` uses it. The
// console signs with the WALLET identity, so `providerPubkey` below must be
// this key's x-only pubkey or `signSolverCard` refuses the card outright —
// which is what makes the round-trip assertion below a real one.
const SECRET = hexToBytes('B7E151628AED2A6ABF7158809CF4F3C762E7160F38B4DA56A784D9045190CFEF'.toLowerCase())
const PUBKEY = 'dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659'
const EMULATOR_PUBKEY = bytesToHex(schnorr.getPublicKey(hexToBytes('11'.repeat(32))))

const allCorridors = <T>(value: T) => ({
  'arkade:BTC->lightning:BTC': value,
  'lightning:BTC->arkade:BTC': value,
  'arkade:BTC->onchain:BTC': value,
  'onchain:BTC->arkade:BTC': value,
})

const ad = buildSolverAd({
  pairs: [
    {
      pair: 'arkade:BTC->lightning:BTC',
      min: 1_000,
      max: 50_000,
      feeBpsIndicative: 0,
      feeFlatIndicative: 0,
      quoteValiditySeconds: 900,
    },
  ],
  relays: ['wss://relay.example'],
})

const publisher = (mode: AdPublishMode, publish = vi.fn(async () => {})) =>
  new AdPublisher({ mode, buildAd: () => ad, publish, now: () => 1_800_000_000, heartbeatSeconds: 1800 })

/**
 * A publisher whose `buildAd` throws.
 *
 * Not contrived: in any real wiring `buildAd` closes over live policy and
 * corridor limits, so it is exactly as capable of throwing as the card builder
 * beside it.
 */
const publisherWithUnbuildableAd = (mode: AdPublishMode) =>
  new AdPublisher({
    mode,
    buildAd: () => {
      throw new Error('corridor policy unreadable')
    },
    publish: vi.fn(async () => {}),
    now: () => 1_800_000_000,
    heartbeatSeconds: 1800,
  })

/**
 * A COMPLETE service double — every member the card route actually reaches,
 * including the identity it signs with.
 *
 * `as never` means `tsc` cannot catch a missing member, so completeness is held
 * in place by the round-trip assertion in the first test: a double missing
 * `arkade.identity` would surface there as a reported `cardError` rather than
 * as a green run over a card that was never built. That failure mode is not
 * hypothetical on this branch — a double missing `onchain.getBalance` once let
 * three diagnostics tests run a FAILING probe and pass anyway.
 */
const makeDeps = (
  over: {
    lnSendEnabled?: boolean
    allDisabled?: boolean
    lnSendFlatSats?: number
    relayUrl?: string | null
    nostrAdPublish?: AdPublishMode
    adPublisher?: AdPublisher
    /** Collects the audit rows the route writes, so they can be asserted. */
    audit?: Record<string, unknown>[]
  } = {},
) =>
  ({
    services: {
      config: {
        relayUrl: over.relayUrl === undefined ? 'wss://relay.example' : over.relayUrl,
        limits: { minSats: 1_000, maxSats: 50_000 },
        // What the OPERATOR configured, which is the only source for the
        // reported mode — see the `publish` tests below.
        nostrAdPublish: over.nostrAdPublish ?? 'off',
      },
      // The EFFECTIVE policy, which is what the card must state — deliberately
      // the object the route reads fees and corridor toggles from.
      policy: {
        corridorEnabled: over.allDisabled
          ? allCorridors(false)
          : { ...allCorridors(true), 'arkade:BTC->lightning:BTC': over.lnSendEnabled ?? true },
        // Per-corridor bounds now reach the card, so an admin override that
        // narrows a corridor shows up in the listing.
        corridorLimits: allCorridors({ minSats: 1_000, maxSats: 50_000 }),
        corridorFees: {
          ...allCorridors({ bps: 0, flatSats: 0 }),
          'arkade:BTC->lightning:BTC': { bps: 30, flatSats: over.lnSendFlatSats ?? 0 },
          'lightning:BTC->arkade:BTC': { bps: 10, flatSats: 0 },
        },
      },
      providerPubkey: PUBKEY,
      emulatorPubkey: EMULATOR_PUBKEY,
      arkade: {
        identity: {
          signMessage: async (digest: Uint8Array): Promise<Uint8Array> => schnorr.sign(digest, SECRET),
        },
      },
      adminStore: {
        recordAction: async (entry: Record<string, unknown>): Promise<void> => {
          over.audit?.push(entry)
        },
      },
    },
    startedAt: 1_800_000_000,
    mode: 'relay',
    now: () => 1_800_000_060,
    ...(over.adPublisher ? { adPublisher: over.adPublisher } : {}),
  }) as never

interface CardBody {
  card: SolverCard | null
  cardError: string | null
  ad: unknown
  adError: string | null
  publish: { mode: string; publisher: boolean; lastPublishedAt: number | null; lastError: string | null }
}

/**
 * Through the ASSEMBLED app, never a bare `Hono`.
 *
 * Every route on this console has been mountable on a bare router, and a suite
 * that only did that stayed green while the route 404'd in production. For
 * `/api/actions/post-ad` it is worse than a missed registration: the actions
 * route claims `/api/actions/:name`, which matches this path too, so mounting
 * the card routes in isolation tests a router the console does not have.
 */
const getCard = async (deps: ReturnType<typeof makeDeps>): Promise<{ status: number; body: CardBody }> => {
  const response = await buildAdminApp(deps).fetch(new Request('http://admin/api/card'))
  return { status: response.status, body: (await response.json()) as CardBody }
}

const postAd = async (deps: ReturnType<typeof makeDeps>) => {
  const response = await buildAdminApp(deps).fetch(new Request('http://admin/api/actions/post-ad', { method: 'POST' }))
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

let savedName: string | undefined
let savedRelays: string | undefined

beforeEach(() => {
  savedName = process.env.SOLVER_NAME
  savedRelays = process.env.SOLVER_CARD_RELAYS
  process.env.SOLVER_NAME = 'test-solver'
  delete process.env.SOLVER_CARD_RELAYS
})

afterEach(() => {
  if (savedName === undefined) delete process.env.SOLVER_NAME
  else process.env.SOLVER_NAME = savedName
  if (savedRelays === undefined) delete process.env.SOLVER_CARD_RELAYS
  else process.env.SOLVER_CARD_RELAYS = savedRelays
})

describe('GET /api/card', () => {
  /**
   * The whole point of the route: an operator can copy a card out of the
   * console that the registry will accept. A card that does not verify is a
   * card that gets bounced, so verification — not merely presence — is the
   * assertion.
   */
  it('hands out a card signed by the wallet identity, and it verifies', async () => {
    const { status, body } = await getCard(makeDeps())
    expect(status).toBe(200)
    expect(body.cardError).toBeNull()
    expect(body.card).not.toBeNull()
    expect(verifyCardSig(body.card!)).toBe(true)
    expect(body.card!.discovery_pubkey).toBe(PUBKEY)
    expect(body.card!.transports.nostr.relays).toEqual(['wss://relay.example'])
    // The HIGHER of the two Lightning spreads, as `cli card` publishes it:
    // overstating a fee is the safe direction, understating one is a lie.
    expect(body.card!.markets[0]).toMatchObject({ fee_bps: 30 })
  })

  it('adds SOLVER_CARD_RELAYS beyond RELAY_URL, exactly as `cli card` does', async () => {
    process.env.SOLVER_CARD_RELAYS = 'wss://second.example, wss://third.example'
    const { body } = await getCard(makeDeps())
    expect(body.card?.transports.nostr.relays).toEqual([
      'wss://relay.example',
      'wss://second.example',
      'wss://third.example',
    ])
  })

  /**
   * AN UNBUILDABLE CARD MUST NOT BLANK THE PAGE.
   *
   * The same rule the rest of this console runs on. The ad half of the answer
   * is still worth showing, and 500-ing over an unset environment variable is
   * the failure the console exists to end.
   */
  it('reports why a card could not be built instead of failing the request', async () => {
    delete process.env.SOLVER_NAME
    const { status, body } = await getCard(makeDeps())
    expect(status).toBe(200)
    expect(body.card).toBeNull()
    expect(body.cardError).toContain('SOLVER_NAME')
  })

  // An unset SOLVER_NAME reaches the card's own /^[a-z0-9-]+$/ rule as the
  // string "undefined", which matches — so without an explicit guard this
  // route would hand out a perfectly valid card named `undefined`.
  it('never files a card called `undefined`', async () => {
    delete process.env.SOLVER_NAME
    const { body } = await getCard(makeDeps())
    expect(body.card?.name).not.toBe('undefined')
  })

  // This used to assert a refusal, because the card hardcoded the Lightning
  // SEND market and had nothing else to say. Now the card describes whatever
  // is served, so disabling one direction narrows the listing instead of
  // withdrawing it — a deployment doing onchain work was previously invisible
  // to discovery for a reason that had nothing to do with onchain.
  it('narrows the listing rather than withdrawing it when a direction is disabled', async () => {
    const { body } = await getCard(makeDeps({ lnSendEnabled: false }))
    expect(body.cardError).toBeNull()
    const markets = body.card!.markets as Record<string, unknown>[]
    const lightning = markets.find((m) => m.pair === 'BTC/lightning:BTC')!
    // The arkade-SENDING direction is off, so the quote side is disabled...
    expect(lightning).toMatchObject({ min_quote_amount: '0', max_quote_amount: '0' })
    // ...while the receiving direction it still serves keeps its bounds.
    expect(lightning).toMatchObject({ min_base_amount: '1000', max_base_amount: '50000' })
    // And the onchain market it also serves is now listed at all.
    expect(markets.map((m) => m.pair)).toContain('BTC/onchain:BTC')
  })

  it('still refuses when the deployment serves nothing at all', async () => {
    // The honest refusal survives: silence beats a card promising markets that
    // will refuse every request.
    const { body } = await getCard(makeDeps({ allDisabled: true }))
    expect(body.card).toBeNull()
    expect(body.cardError).toContain('no corridor is enabled')
  })

  // This used to assert a refusal, on the premise that the card could carry
  // `fee_bps` and nothing else. The schema has carried an optional `fee_flat`
  // per market since solver-registry#20, so refusing was declining to publish
  // over a limitation that did not exist — and it cost the deployment its
  // corridor listing, silently, for the whole time a flat fee was configured.
  it('publishes a card for a corridor charging a flat fee', async () => {
    const { body } = await getCard(makeDeps({ lnSendFlatSats: 50 }))
    expect(body.cardError).toBeNull()
    expect(body.card).not.toBeNull()
    expect(body.card!.markets[0]!.fee_flat).toBe('50')
  })

  it('reports no publisher as off, with no ad, rather than as a fault', async () => {
    const { body } = await getCard(makeDeps())
    expect(body.ad).toBeNull()
    expect(body.publish).toEqual({ mode: 'off', publisher: false, lastPublishedAt: null, lastError: null })
  })

  it('reports the ad and the publish mode when a publisher is present', async () => {
    const { body } = await getCard(makeDeps({ nostrAdPublish: 'manual', adPublisher: publisher('manual') }))
    expect(body.publish.mode).toBe('manual')
    expect(body.ad).toEqual(ad)
  })

  /**
   * THE MODE IS WHAT THE OPERATOR CONFIGURED, not what happens to be wired.
   *
   * `mode` was previously hardcoded to `off` whenever no publisher existed —
   * which is every mode today, since nothing constructs one yet. So an operator
   * who set `NOSTR_AD_PUBLISH=auto`, restarted, and opened the discovery panel
   * read "off" and would reasonably conclude the setting had not taken. That is
   * worse than reporting nothing: it looks like a bug in the very thing they
   * just configured.
   */
  it('reports the mode the operator configured, with nothing wired to publish', async () => {
    for (const mode of ['off', 'manual', 'auto'] as const) {
      const { body } = await getCard(makeDeps({ nostrAdPublish: mode }))
      expect(body.publish.mode).toBe(mode)
    }
  })

  /**
   * Two different facts, two different fields.
   *
   * "What did I configure" and "can anything actually publish right now" were
   * collapsed into one string, which is why reporting either one honestly was
   * impossible. Separated, both are true at once.
   */
  it('separates the configured mode from whether anything can publish', async () => {
    const { body } = await getCard(makeDeps({ nostrAdPublish: 'auto' }))
    expect(body.publish).toEqual({ mode: 'auto', publisher: false, lastPublishedAt: null, lastError: null })

    const { body: wired } = await getCard(makeDeps({ nostrAdPublish: 'auto', adPublisher: publisher('auto') }))
    expect(wired.publish).toEqual({ mode: 'auto', publisher: true, lastPublishedAt: null, lastError: null })
  })

  /**
   * `publisher` and the `no_publisher` refusal are the same fact, so they must
   * never disagree — a panel saying a publisher exists while the button it
   * enables answers 409 `no_publisher` is the same class of lie this fix is
   * removing, one layer down.
   */
  it('agrees with what post-ad actually does about a missing publisher', async () => {
    const missing = makeDeps({ nostrAdPublish: 'auto' })
    expect((await getCard(missing)).body.publish.publisher).toBe(false)
    expect((await postAd(missing)).body['error']).toBe('no_publisher')

    const wired = makeDeps({ nostrAdPublish: 'auto', adPublisher: publisher('auto') })
    expect((await getCard(wired)).body.publish.publisher).toBe(true)
    expect((await postAd(wired)).body['error']).toBeUndefined()
  })

  /**
   * THE AD HALF IS GUARDED TOO, which the surrounding comment already promises.
   *
   * `currentAd()` calls `buildAd()`, which in a real wiring closes over live
   * policy — as capable of throwing as the card builder beside it. Unwrapped, it
   * would escape to `app.onError` as a 500 and take down the CARD, which built
   * perfectly, along with the whole panel. That is "one dead backend must not
   * blank the page" inverted: the half that failed silences the half that did
   * not.
   */
  it('reports an unbuildable ad beside a card that built fine', async () => {
    const { status, body } = await getCard(
      makeDeps({ nostrAdPublish: 'auto', adPublisher: publisherWithUnbuildableAd('auto') }),
    )
    expect(status).toBe(200)
    expect(body.ad).toBeNull()
    expect(body.adError).toContain('corridor policy unreadable')
    // The half that worked is still delivered, and still valid.
    expect(body.cardError).toBeNull()
    expect(verifyCardSig(body.card!)).toBe(true)
  })

  it('reports a null adError when the ad builds, and when there is no publisher', async () => {
    expect(
      (await getCard(makeDeps({ nostrAdPublish: 'auto', adPublisher: publisher('auto') }))).body.adError,
    ).toBeNull()
    expect((await getCard(makeDeps())).body.adError).toBeNull()
  })
})

describe('POST /api/actions/post-ad', () => {
  /**
   * The route the `/api/actions/:name` wildcard would swallow.
   *
   * Registered before the actions route for exactly this reason. A 404 here
   * with `unknown_action` means the ordering in `buildAdminApp` was changed and
   * every post-ad request is now being handed to the ACTIONS table.
   */
  it('is not swallowed by the /api/actions/:name wildcard', async () => {
    const publish = vi.fn(async () => {})
    const { status, body } = await postAd(
      makeDeps({ nostrAdPublish: 'manual', adPublisher: publisher('manual', publish) }),
    )
    expect(body['error']).not.toBe('unknown_action')
    expect(status).toBe(200)
    expect(body['ok']).toBe(true)
    expect(publish).toHaveBeenCalledTimes(1)
  })

  /**
   * `off` REFUSES `post now`.
   *
   * The setting would otherwise be advisory: an operator who configured this
   * solver not to touch Nostr would have no guarantee, because one button in a
   * console anyone behind the proxy can reach would undo it. 409 rather than
   * 500 — refusing a request that conflicts with policy is a correct answer,
   * not a fault.
   */
  it('refuses to post when the operator configured off, and publishes nothing', async () => {
    const publish = vi.fn(async () => {})
    const { status, body } = await postAd(makeDeps({ adPublisher: publisher('off', publish) }))
    expect(status).toBe(409)
    expect(body['error']).toBe('refused')
    expect(String(body['detail'])).toMatch(/off/i)
    expect(publish).not.toHaveBeenCalled()
  })

  it('answers 409 rather than 500 when this mode has no publisher at all', async () => {
    // `auto`, not the default `off`: the policy refusal now answers first, so a
    // deployment configured off would never reach the missing-publisher case.
    const { status, body } = await postAd(makeDeps({ nostrAdPublish: 'auto' }))
    expect(status).toBe(409)
    expect(body['error']).toBe('no_publisher')
  })

  /** A relay outage is reported, never fatal — advertising is not on the money path. */
  it('reports a failed publish as a refusal and keeps the reason', async () => {
    const publish = vi.fn(async () => {
      throw new Error('relay down')
    })
    const p = publisher('auto', publish)
    const { status, body } = await postAd(makeDeps({ nostrAdPublish: 'auto', adPublisher: p }))
    expect(status).toBe(409)
    expect(String(body['detail'])).toContain('relay down')
    expect(p.state().lastError).toContain('relay down')
    expect(p.state().lastPublishedAt).toBeNull()
  })

  /**
   * THE `off` REFUSAL IS THE ROUTE'S OWN, not a courtesy the publisher extends.
   *
   * Before this, what the console REPORTED came from config while what the route
   * REFUSED on came from `AdPublisher.opts.mode`. The two agree only because
   * nothing constructs a publisher yet; the first wiring that passes anything
   * else makes `NOSTR_AD_PUBLISH=off` advisory again — the same class of bug as
   * reporting a mode nobody configured, one level down. So the route checks the
   * configured value itself, and this test makes that load-bearing by handing it
   * a publisher that would happily have published.
   */
  it('refuses on the CONFIGURED mode even when the publisher would allow it', async () => {
    const publish = vi.fn(async () => {})
    const { status, body } = await postAd(
      makeDeps({ nostrAdPublish: 'off', adPublisher: publisher('manual', publish) }),
    )
    expect(status).toBe(409)
    expect(body['error']).toBe('refused')
    expect(String(body['detail'])).toMatch(/off/i)
    // The decisive assertion: a `manual` publisher would have published, so
    // nothing but the route's own config check can have stopped this.
    expect(publish).not.toHaveBeenCalled()
  })

  /**
   * Policy is answered BEFORE wiring: `off` with no publisher is a refusal on
   * the operator's own terms, not a report that the plumbing is missing. An
   * absence must never mask a policy the operator set.
   */
  it('answers the policy refusal ahead of the missing-publisher one', async () => {
    const { body } = await postAd(makeDeps({ nostrAdPublish: 'off' }))
    expect(body['error']).toBe('refused')
  })
})

/**
 * `actions.ts` states the rule — "Everything is audited, including failures" —
 * and this is the only outward-facing, network-touching action on the port. An
 * operator who clicks `post now` and is refused must be able to find that in
 * the console's own audit view, exactly as they can find a refund that threw.
 */
describe('POST /api/actions/post-ad — audit', () => {
  it('records a successful publish', async () => {
    const audit: Record<string, unknown>[] = []
    await postAd(makeDeps({ nostrAdPublish: 'manual', adPublisher: publisher('manual'), audit }))
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ action: 'post-ad', outcome: 'ok', target: null })
  })

  it('records a policy refusal, which is the row an operator most needs', async () => {
    const audit: Record<string, unknown>[] = []
    await postAd(makeDeps({ nostrAdPublish: 'off', adPublisher: publisher('manual'), audit }))
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ action: 'post-ad', outcome: 'error' })
    expect(String(audit[0]?.['detail'])).toMatch(/off/i)
  })

  it('records a failed publish, with the relay error as the detail', async () => {
    const audit: Record<string, unknown>[] = []
    const publish = vi.fn(async () => {
      throw new Error('relay down')
    })
    await postAd(makeDeps({ nostrAdPublish: 'auto', adPublisher: publisher('auto', publish), audit }))
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ action: 'post-ad', outcome: 'error' })
    expect(String(audit[0]?.['detail'])).toContain('relay down')
  })

  it('records an attempt that found no publisher wired', async () => {
    const audit: Record<string, unknown>[] = []
    await postAd(makeDeps({ nostrAdPublish: 'auto', audit }))
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ action: 'post-ad', outcome: 'error' })
  })
})
