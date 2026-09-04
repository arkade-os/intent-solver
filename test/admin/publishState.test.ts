/**
 * The two discovery views must not disagree.
 *
 * `/api/card` and `/api/diagnostics` both report whether this solver is
 * advertising, from separate handlers in separate files. Nothing structural
 * stops one from being corrected and the other left behind, and a console
 * showing `auto` on the discovery panel while the health readout says `off` is
 * worse than either answer alone: the operator cannot tell which is stale, and
 * the honest one is indistinguishable from the bug.
 *
 * Its own file, with its own double, because it is the only test needing a
 * `Services` complete for BOTH routes at once — the card route signs with the
 * wallet identity, the diagnostics route reads three balances and the overrides
 * table. Folding it into either sibling suite would mean carrying the other
 * route's members in a double that never exercises them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { buildAdminApp } from '@arkade-os/solver-app/admin/server.js'
import { AdPublisher, type AdPublishMode } from '@arkade-os/solver-transport/relay/adPublisher.js'

const SECRET = hexToBytes('B7E151628AED2A6ABF7158809CF4F3C762E7160F38B4DA56A784D9045190CFEF'.toLowerCase())
const PUBKEY = 'dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659'
const EMULATOR_PUBKEY = bytesToHex(schnorr.getPublicKey(hexToBytes('11'.repeat(32))))

const allCorridors = <T>(value: T) => ({
  'arkade:BTC->lightning:BTC': value,
  'lightning:BTC->arkade:BTC': value,
  'arkade:BTC->onchain:BTC': value,
  'onchain:BTC->arkade:BTC': value,
})

const ad = { v: 1 as const, type: 'solver_ad' as const, pairs: [], relays: ['wss://relay.example'] }

const publisherWith = (mode: AdPublishMode, publish = vi.fn(async () => {})) =>
  new AdPublisher({ mode, buildAd: () => ad, publish, now: () => 1_800_000_000, heartbeatSeconds: 1800 })

/**
 * A double complete for BOTH routes — every member either handler reaches.
 *
 * `as never` means the compiler checks none of this, so the completeness guard
 * is the assertion in the first test that neither route reported an error: a
 * missing member surfaces there as a `cardError` or a failed probe rather than
 * as two routes cheerfully agreeing on nothing.
 */
const makeDeps = (over: { nostrAdPublish?: AdPublishMode; adPublisher?: AdPublisher } = {}) =>
  ({
    services: {
      config: {
        lnBackend: 'lnd',
        arkade: { arkServerUrl: 'http://ark' },
        emulatorUrl: 'http://emu',
        relayUrl: 'wss://relay.example',
        limits: { minSats: 1_000, maxSats: 50_000 },
        corridorLimits: allCorridors({ minSats: 1_000, maxSats: 50_000 }),
        corridorFees: allCorridors({ bps: 0, flatSats: 0 }),
        corridorEnabled: allCorridors(true),
        maxExposedSats: 100_000,
        nostrAdPublish: over.nostrAdPublish ?? 'off',
      },
      policy: {
        corridorLimits: allCorridors({ minSats: 1_000, maxSats: 50_000 }),
        corridorFees: allCorridors({ bps: 0, flatSats: 0 }),
        corridorEnabled: allCorridors(true),
        maxExposedSats: 100_000,
        evmCorridors: [],
        offerMinFillAmount: 0n,
        offerMaxFillAmount: 0n,
      },
      assetMarkets: [],
      ln: { getBalance: async () => ({ availableSats: 100_000, incomingSats: 0 }) },
      arkade: {
        wallet: {
          getAddress: async () => 'tark1x',
          getBalance: async () => ({ available: 100_000 }),
        },
        identity: {
          signMessage: async (digest: Uint8Array): Promise<Uint8Array> => schnorr.sign(digest, SECRET),
        },
      },
      providerPubkey: PUBKEY,
      emulatorPubkey: EMULATOR_PUBKEY,
      onchain: {
        estimateFeeRate: async () => 7,
        getBalance: async () => ({ confirmedSats: 100_000, unconfirmedSats: 0 }),
      },
      adminStore: { getOverrides: async () => ({}) },
    },
    startedAt: 1_800_000_000,
    mode: 'relay',
    now: () => 1_800_000_060,
    ...(over.adPublisher ? { adPublisher: over.adPublisher } : {}),
  }) as never

interface PublishBlock {
  mode: string
  publisher: boolean
  lastPublishedAt: number | null
  lastError: string | null
  heartbeatSeconds?: number | null
}

/** Both answers from ONE deps object, through the assembled app. */
const bothViews = async (deps: ReturnType<typeof makeDeps>) => {
  const app = buildAdminApp(deps)
  const card = (await (await app.fetch(new Request('http://admin/api/card'))).json()) as {
    cardError: string | null
    publish: PublishBlock
  }
  const diagnostics = (await (await app.fetch(new Request('http://admin/api/diagnostics'))).json()) as {
    backends: { name: string; ok: boolean; error: string | null }[]
    publish: PublishBlock
  }
  return { card, diagnostics }
}

let savedName: string | undefined

beforeEach(() => {
  savedName = process.env.SOLVER_NAME
  process.env.SOLVER_NAME = 'test-solver'
})

afterEach(() => {
  if (savedName === undefined) delete process.env.SOLVER_NAME
  else process.env.SOLVER_NAME = savedName
})

describe('publish state across /api/card and /api/diagnostics', () => {
  it('reports the same state on both routes, for every configured mode', async () => {
    for (const mode of ['off', 'manual', 'auto'] as const) {
      const { card, diagnostics } = await bothViews(makeDeps({ nostrAdPublish: mode }))

      // Guards the DOUBLE: if either route degraded to an error path, the two
      // could "agree" on a state neither actually derived.
      expect(card.cardError).toBeNull()
      expect(diagnostics.backends.filter((b) => !b.ok)).toEqual([])

      // `heartbeatSeconds` is the health readout's own addition; every shared
      // field has to be identical.
      const { heartbeatSeconds: _ignored, ...shared } = diagnostics.publish
      expect(shared).toEqual(card.publish)
      expect(card.publish.mode).toBe(mode)
      expect(card.publish.publisher).toBe(false)
    }
  })

  it('still agrees once a publisher is wired', async () => {
    const { card, diagnostics } = await bothViews(
      makeDeps({ nostrAdPublish: 'auto', adPublisher: publisherWith('auto') }),
    )
    const { heartbeatSeconds, ...shared } = diagnostics.publish
    expect(shared).toEqual(card.publish)
    expect(card.publish).toEqual({ mode: 'auto', publisher: true, lastPublishedAt: null, lastError: null })
    expect(heartbeatSeconds).toBe(1800)
  })

  /**
   * The case where drift would actually cost something: a relay outage. One
   * panel reporting the failure while the other still reads clean is how an
   * operator concludes the error is stale and ignores it.
   */
  it('agrees on the failure after a publish attempt fails', async () => {
    const publisher = publisherWith(
      'auto',
      vi.fn(async () => {
        throw new Error('relay down')
      }),
    )
    await publisher.publishNow().catch(() => {})

    const { card, diagnostics } = await bothViews(makeDeps({ nostrAdPublish: 'auto', adPublisher: publisher }))
    const { heartbeatSeconds: _ignored, ...shared } = diagnostics.publish
    expect(shared).toEqual(card.publish)
    expect(card.publish.lastError).toContain('relay down')
    // A failed publish is not a publish: nothing may claim otherwise on either
    // page, or the next reader believes the relay holds a copy it does not.
    expect(card.publish.lastPublishedAt).toBeNull()
  })
})
