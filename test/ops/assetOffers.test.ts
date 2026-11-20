/**
 * The wiring, not the decision — `test/core/assetOffer.test.ts` covers the gate.
 *
 * What is worth pinning here is what composition can get wrong: reading the
 * deposit from the packet instead of the chain, opening two intents against one
 * outpoint, and submitting without first marking the row in flight.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  AssetOfferService,
  parseAssetMarkets,
  MAX_FILL_DEFERRALS,
  type AssetOfferDeps,
} from '@arkade-os/solver-app/ops/assetOffers.js'
import {
  DEPOSIT_SPENT_REASON,
  OfferNotSubmittedError,
  OfferSubmitRejectedError,
} from '@arkade-os/solver-arkade/arkade/offerFulfill.js'
import { approvalGateFor } from '@arkade-os/solver-app/ops/approvals.js'
import type { SwapApprovalRequest } from '@arkade-os/solver-app/admin/db.js'
import { OfferFillStore } from '@arkade-os/solver-corridors/db/offerFills.js'
import { AssetRfqSwapStore } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import { betterSqliteDriver } from '@arkade-os/solver-db/driver.js'
import { priceFrom } from '@arkade-os/solver-core/core/priceFeed.js'
import { encodeOffer, OFFER_PACKET_TYPE, offerVtxoScript, type Offer } from '@arkade-os/swap/protocol'
import { Extension, UnknownPacket, asset } from '@arkade-os/sdk'
import { Transaction } from '@scure/btc-signer'
import { base64, hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { OFFER_CONTRACT_V1, OFFER_CONTRACT_V2 } from '@arkade-os/solver-core/core/offerContract.js'

const USDT = '11'.repeat(34)
const SCRIPT = new Uint8Array(34).fill(0xab)
const SCRIPT_HEX = 'ab'.repeat(34)

const servicesSource = readFileSync(
  fileURLToPath(new URL('../../packages/solver-app/src/ops/services.ts', import.meta.url)),
  'utf8',
)

/** A maker depositing USDT and wanting sats. */
const offer = (over: Partial<Offer> = {}): Offer =>
  ({
    swapPkScript: SCRIPT,
    wantAmount: 1_000n,
    wantAsset: undefined,
    offerAsset: asset.AssetId.fromString(USDT),
    ...over,
  }) as unknown as Offer

const build = async (over: Partial<AssetOfferDeps> = {}) => {
  const store = await OfferFillStore.open(betterSqliteDriver(':memory:'))
  let n = 0
  const deps: AssetOfferDeps = {
    store,
    carrierSats: 0n,
    markets: [{ a: USDT, b: null }],
    minFillAmount: 10n,
    maxFillAmount: 100_000n,
    balance: async () => ({ available: 1_000_000, availableAssets: [{ assetId: USDT, amount: 5_000n }] }),
    outputsAt: async () => [{ script: SCRIPT_HEX, value: 500, assets: [{ assetId: USDT, amount: 900n }] }],
    newId: () => `fill-${(n += 1)}`,
    ...over,
  }
  return { store, deps, service: new AssetOfferService(deps) }
}

const found = { offer: offer(), txid: 'a'.repeat(64), vout: 0 }
// BTC/USDT: the maker deposits 900 USDT-units and wants 1000 sats. Feed is
// sats-per-USDT, so 1.12 admits the fixture and 0.5 is far out.
const pricing = [
  {
    base: USDT,
    quote: null,
    baseDecimals: 0,
    quoteDecimals: 0,
    feedUrl: 'https://feed.test/p',
    pricePath: '/price',
    toleranceBps: 100,
    feeBps: 0,
  },
]

describe('consider', () => {
  it('records an intent for an offer it can fill', async () => {
    const { store, service } = await build()
    const outcome = await service.consider(found)
    expect(outcome).toEqual({ fill: true, id: 'fill-1' })

    const row = await store.findById('fill-1')
    expect(row).toMatchObject({ state: 'fillable', offerAssetId: USDT, wantAssetId: null, wantAmount: 1_000n })
  })

  it('observes the deposit from the chain, not the packet', async () => {
    // An offer advertising a deposit it does not hold must not be filled for
    // nothing. Nothing on the packet says what was deposited; only the outputs
    // at its script do.
    const { service } = await build({ outputsAt: async () => [] })
    expect(await service.consider(found)).toEqual({ fill: false, reason: 'offer_unfunded' })
  })

  it('counts only the named asset on the deposit side', async () => {
    // A large amount of some OTHER asset holds none of what was promised —
    // otherwise minting something worthless buys a fill.
    const { service } = await build({
      outputsAt: async () => [{ script: SCRIPT_HEX, value: 500, assets: [{ assetId: '22'.repeat(34), amount: 9n }] }],
    })
    expect(await service.consider(found)).toEqual({ fill: false, reason: 'offer_unfunded' })
  })

  it('does not open a second intent against the same outpoint', async () => {
    const { store, service } = await build()
    await service.consider(found)
    const again = await service.consider(found)
    expect(again).toEqual({ fill: true, id: 'fill-1' })
    expect(await store.listNonTerminal()).toHaveLength(1)
  })

  it('refuses a market it does not serve, without recording anything', async () => {
    const { store, service } = await build({ markets: [] })
    expect(await service.consider(found)).toEqual({ fill: false, reason: 'unsupported_pair' })
    expect(await store.listNonTerminal()).toHaveLength(0)
  })

  it('reads inventory fresh, so a drained float stops filling', async () => {
    const { service } = await build({
      balance: async () => ({ available: 10, availableAssets: [] }),
    })
    expect(await service.consider(found)).toEqual({ fill: false, reason: 'insufficient_inventory' })
  })
})

describe('offer consistency — Swap Protocol V1 § 5.1', () => {
  // This fixture's keys are filler, so reconstruction throws and the guard
  // refuses through its catch. That is the right answer — a script that cannot
  // be built cannot agree — but it is NOT the script comparison. The comparison
  // itself, including a maker changing terms under an honest script, is pinned
  // with real curve keys in test/arkade/offerConsistency.test.ts. What these
  // cases pin is the SERVICE behaviour: it refuses, and it refuses first.
  const serverPubkey = new Uint8Array(32).fill(0x02)

  it('refuses an offer whose script does not encode its stated terms', async () => {
    const { store, service } = await build({ serverPubkey })
    expect(await service.consider(found)).toEqual({ fill: false, reason: 'offer_inconsistent' })
    expect(await store.listNonTerminal()).toHaveLength(0)
  })

  it('checks it BEFORE reading anything else off the packet', async () => {
    // Everything downstream — deposit, market, price — trusts fields from an
    // attacker-supplied packet. A mismatch must stop the read, not lose a race
    // with it.
    const outputsAt = vi.fn(async () => [])
    const fetchPrice = vi.fn(async () => priceFrom('1'))
    const { service } = await build({ serverPubkey, outputsAt, fetchPrice })
    expect(await service.consider(found)).toEqual({ fill: false, reason: 'offer_inconsistent' })
    expect(outputsAt).not.toHaveBeenCalled()
    expect(fetchPrice).not.toHaveBeenCalled()
  })

  it('skips the check when no signer key is configured', async () => {
    // Documented as skipping a protocol MUST rather than silently passing it.
    const { service } = await build()
    expect(await service.consider(found)).toEqual({ fill: true, id: 'fill-1' })
  })
})

describe('offer contract versions', () => {
  const xonly = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
  const serverPubkey = xonly(2)
  const terms = {
    wantAmount: 1_000n,
    wantAsset: undefined,
    offerAsset: asset.AssetId.fromString(USDT),
    makerPkScript: new Uint8Array([0x51, 0x20, ...xonly(3)]),
    makerPublicKey: xonly(4),
    emulatorPubkey: xonly(5),
  }
  const honest = (exit: boolean): Offer => {
    const withoutScript = {
      ...terms,
      ...(exit ? { exitDelay: { type: 'seconds' as const, value: 4096n } } : {}),
    }
    return {
      ...withoutScript,
      swapPkScript: offerVtxoScript(withoutScript, serverPubkey).pkScript,
    } as Offer
  }
  const at = (offer: Offer): typeof found => ({ ...found, offer })
  const funded = (offer: Offer) => ({
    ...found,
    get offer() {
      return offer
    },
    outputsAt: async () => [
      { script: hex.encode(offer.swapPkScript), value: 500, assets: [{ assetId: USDT, amount: 900n }] },
    ],
  })

  it('accepts both versions by default and records which one was priced', async () => {
    const legacy = honest(false)
    const current = honest(true)
    const legacyRun = await build({ serverPubkey, outputsAt: funded(legacy).outputsAt })
    const currentRun = await build({ serverPubkey, outputsAt: funded(current).outputsAt })

    expect(await legacyRun.service.consider(at(legacy))).toEqual({ fill: true, id: 'fill-1' })
    expect(await currentRun.service.consider(at(current))).toEqual({ fill: true, id: 'fill-1' })
    expect(await legacyRun.store.findById('fill-1')).toMatchObject({ contractVersion: OFFER_CONTRACT_V1 })
    expect(await currentRun.store.findById('fill-1')).toMatchObject({ contractVersion: OFFER_CONTRACT_V2 })
  })

  it('refuses a version the operator switched off', async () => {
    const legacy = honest(false)
    const { store, service } = await build({
      serverPubkey,
      contractVersions: new Set([OFFER_CONTRACT_V2]),
      outputsAt: funded(legacy).outputsAt,
    })

    expect(await service.consider(at(legacy))).toEqual({
      fill: false,
      reason: 'offer_version_disabled',
    })
    expect(await store.listNonTerminal()).toHaveLength(0)
  })

  it('refuses an already-recorded intent when its version is no longer enabled', async () => {
    const settle = vi.fn(async () => 'fill-txid')
    const { store, service } = await build({
      contractVersions: new Set([OFFER_CONTRACT_V2]),
      settle,
    })
    await store.insertIntent({
      id: 'legacy-intent',
      offerTxid: found.txid,
      offerVout: found.vout,
      offerPkScript: SCRIPT_HEX,
      contractVersion: OFFER_CONTRACT_V1,
      wantAssetId: null,
      wantAmount: 1_000n,
      offerAssetId: USDT,
      offerAmount: 900n,
    })

    expect(await service.tickAll()).toBe(0)
    expect(settle).not.toHaveBeenCalled()
    expect(await store.findById('legacy-intent')).toMatchObject({
      state: 'refused',
      failureReason: expect.stringContaining('offer_version_disabled'),
    })
  })

  it('refuses an unversioned fillable row while still fillable when the rollout is narrowed', async () => {
    const settle = vi.fn(async () => 'fill-txid')
    const { store, service } = await build({
      contractVersions: new Set([OFFER_CONTRACT_V2]),
      settle,
    })
    await store.insertIntent({
      id: 'unversioned-intent',
      offerTxid: found.txid,
      offerVout: found.vout,
      offerPkScript: SCRIPT_HEX,
      contractVersion: null as never,
      wantAssetId: null,
      wantAmount: 1_000n,
      offerAssetId: USDT,
      offerAmount: 900n,
    })

    expect(await service.tickAll()).toBe(0)
    expect(settle).not.toHaveBeenCalled()
    expect(await store.findById('unversioned-intent')).toMatchObject({
      state: 'refused',
      failureReason: expect.stringContaining('offer_version_unverified'),
    })
  })

  it('refuses a narrowed rollout when script identity cannot be verified', async () => {
    const withExit = honest(true)
    const { service } = await build({
      contractVersions: new Set([OFFER_CONTRACT_V2]),
      outputsAt: funded(withExit).outputsAt,
    })

    expect(await service.consider(at(withExit))).toEqual({
      fill: false,
      reason: 'offer_version_unverified',
    })
  })
})

describe('the price gate', () => {
  it('takes an offer inside tolerance', async () => {
    const { service } = await build({ pricing, fetchPrice: async () => priceFrom('1.12') })
    expect(await service.consider(found)).toEqual({ fill: true, id: 'fill-1' })
  })

  it('refuses one outside tolerance, recording nothing', async () => {
    // 1000/900 = 1.111…; a feed of 0.5 puts the ask far above tolerance.
    const { store, service } = await build({ pricing, fetchPrice: async () => priceFrom('0.5') })
    expect(await service.consider(found)).toEqual({ fill: false, reason: 'price_out_of_tolerance' })
    expect(await store.listNonTerminal()).toHaveLength(0)
  })

  /** Charging this leg refuses an ALREADY-FUNDED offer, so it stays opt-in. */
  describe('the carrier we deliver on an asset-want offer', () => {
    const wantsAsset = {
      offer: {
        swapPkScript: SCRIPT,
        wantAmount: 900n,
        wantAsset: { toString: () => USDT },
        offerAsset: undefined,
      } as unknown as Offer,
      txid: 'b'.repeat(64),
      vout: 0,
    }
    const satsDeposit = async () => [{ script: SCRIPT_HEX, value: 1000 }]

    it('is NOT charged by default, so a maker pricing off the card still fills', async () => {
      const { service } = await build({
        pricing,
        fetchPrice: async () => priceFrom('1.12'),
        carrierSats: 330n,
        outputsAt: satsDeposit,
      })
      expect(await service.consider(wantsAsset)).toMatchObject({ fill: true })
    })

    it('is charged when the operator opts in', async () => {
      const { service } = await build({
        pricing,
        fetchPrice: async () => priceFrom('1.12'),
        carrierSats: 330n,
        chargesDeliveredCarrier: true,
        outputsAt: satsDeposit,
      })
      expect(await service.consider(wantsAsset)).toEqual({ fill: false, reason: 'price_out_of_tolerance' })
    })
  })

  it('FAILS CLOSED when the feed cannot be read', async () => {
    // An unreadable feed must not become a free fill at whatever was asked.
    const errors: unknown[] = []
    const { service } = await build({
      pricing,
      fetchPrice: async () => {
        throw new Error('feed down')
      },
      onError: (_id, error) => void errors.push(error),
    })
    expect(await service.consider(found)).toEqual({ fill: false, reason: 'price_out_of_tolerance' })
    expect(errors).toHaveLength(1)
  })

  it('fails closed for a market that is priced nowhere', async () => {
    const { service } = await build({
      pricing: [{ ...pricing[0]!, base: '99'.repeat(34) }],
      fetchPrice: async () => priceFrom('1.12'),
    })
    expect(await service.consider(found)).toEqual({ fill: false, reason: 'price_out_of_tolerance' })
  })

  it('leaves an unpriced deployment unchanged', async () => {
    // Opting out entirely is allowed; opting in halfway is not.
    const { service } = await build()
    expect(await service.consider(found)).toEqual({ fill: true, id: 'fill-1' })
  })

  it('FAILS CLOSED when configured pricing is empty', async () => {
    const { service } = await build({ pricing: [] })
    expect(await service.consider(found)).toEqual({ fill: false, reason: 'price_out_of_tolerance' })
  })

  it('does not read the feed for an offer the cheap gates already refused', async () => {
    const fetchPrice = vi.fn(async () => priceFrom('1.12'))
    const { service } = await build({ pricing, fetchPrice, markets: [] })
    expect(await service.consider(found)).toEqual({ fill: false, reason: 'unsupported_pair' })
    expect(fetchPrice).not.toHaveBeenCalled()
  })
})

describe('per-direction bounds', () => {
  // The fixture deposits USDT (the base) and wants sats (the quote), so it
  // lands on this market's `sell_base` side.
  const priced = (over: Record<string, unknown>) => [
    {
      base: USDT,
      quote: null,
      baseDecimals: 0,
      quoteDecimals: 0,
      feedUrl: 'https://feed.test/p',
      pricePath: '/price',
      // As permissive as the gate allows, so these cases isolate the BOUNDS
      // logic rather than re-testing pricing. Not 10_000: at BPS the buy_base
      // comparison degenerates and every offer passes at any price, so
      // `offerWithinTolerance` refuses it outright.
      toleranceBps: 9_999,
      feeBps: 0,
      ...over,
    },
  ]
  const fetchPrice = async () => priceFrom('1')

  it('applies the direction`s own bounds over the deployment-wide pair', async () => {
    const { service } = await build({
      pricing: priced({ sellBase: { min: 5_000n, max: 10_000n } }),
      fetchPrice,
    })
    // 1000 sats is inside the global 10..100_000 but under this direction's min.
    expect(await service.consider(found)).toEqual({ fill: false, reason: 'amount_out_of_range' })
  })

  it('takes one inside the direction`s bounds', async () => {
    const { service } = await build({
      pricing: priced({ sellBase: { min: 100n, max: 10_000n } }),
      fetchPrice,
    })
    expect(await service.consider(found)).toEqual({ fill: true, id: 'fill-1' })
  })

  it('treats a max of 0 as DISABLING that direction', async () => {
    // Not "unbounded" — the reference uses the same convention, so a market can
    // be one-way without being two entries.
    const { service } = await build({
      pricing: priced({ sellBase: { min: 0n, max: 0n } }),
      fetchPrice,
    })
    expect(await service.consider(found)).toEqual({ fill: false, reason: 'amount_out_of_range' })
  })

  it('leaves the other direction alone', async () => {
    // buyBase bounds must not gate a buy_base offer.
    const { service } = await build({
      pricing: priced({ buyBase: { min: 0n, max: 0n } }),
      fetchPrice,
    })
    expect(await service.consider(found)).toEqual({ fill: true, id: 'fill-1' })
  })
})

describe('refusals an operator can read', () => {
  // Every refusal below is CORRECT; what is pinned is that it leaves a trace.
  const priced = (over: Record<string, unknown>) => [
    {
      base: USDT,
      quote: null,
      baseDecimals: 0,
      quoteDecimals: 0,
      feedUrl: 'https://feed.test/p',
      pricePath: '/price',
      toleranceBps: 9_999,
      feeBps: 0,
      ...over,
    },
  ]
  const fetchPrice = async () => priceFrom('1')

  const reported = async (over: Partial<AssetOfferDeps> = {}) => {
    const seen: { outpoint: string; reason: string; detail: string }[] = []
    const { service } = await build({
      ...over,
      onRefused: (outpoint, reason, detail) => void seen.push({ outpoint, reason, detail }),
    })
    return { outcome: await service.consider(found), seen }
  }

  it('names the offer, the bound and which bound it was', async () => {
    const { outcome, seen } = await reported({
      pricing: priced({ sellBase: { min: 5_000n, max: 10_000n } }),
      fetchPrice,
    })
    expect(outcome).toEqual({ fill: false, reason: 'amount_out_of_range' })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.outpoint).toBe(`${found.txid}:${found.vout}`)
    expect(seen[0]!.reason).toBe('amount_out_of_range')
    expect(seen[0]!.detail).toContain('1000')
    expect(seen[0]!.detail).toContain('5000..10000')
  })

  it('names the bound for an offer over the maximum too', async () => {
    const { outcome, seen } = await reported({ pricing: priced({ sellBase: { min: 1n, max: 100n } }), fetchPrice })
    expect(outcome).toEqual({ fill: false, reason: 'amount_out_of_range' })
    expect(seen[0]!.detail).toContain('1..100')
  })

  it('says WHICH bound is in force — the market row, not the deployment pair', async () => {
    // A market row that states bounds silently overrides OFFER_MIN/MAX_FILL_AMOUNT.
    const onMarket = await reported({ pricing: priced({ sellBase: { min: 5_000n, max: 10_000n } }), fetchPrice })
    expect(onMarket.seen[0]!.detail).toContain('market bounds')

    const onDeployment = await reported({ minFillAmount: 5_000n })
    expect(onDeployment.outcome).toEqual({ fill: false, reason: 'amount_out_of_range' })
    expect(onDeployment.seen[0]!.detail).toContain('deployment bounds 5000..100000')
  })

  it('reports every refusal, not only the bounded ones', async () => {
    expect((await reported({ markets: [] })).seen[0]).toMatchObject({ reason: 'unsupported_pair' })
    expect((await reported({ outputsAt: async () => [] })).seen[0]).toMatchObject({ reason: 'offer_unfunded' })
    const drained = await reported({ balance: async () => ({ available: 10, availableAssets: [] }) })
    expect(drained.seen[0]).toMatchObject({ reason: 'insufficient_inventory' })
    const outOfBand = await reported({ pricing: priced({}), fetchPrice: async () => priceFrom('0.5') })
    expect(outOfBand.seen[0]).toMatchObject({ reason: 'price_out_of_tolerance' })
  })

  it('names bounds ONLY when a bound is what refused', async () => {
    // Otherwise the line points at config that was never the problem.
    const drained = await reported({ balance: async () => ({ available: 10, availableAssets: [] }) })
    expect(drained.seen[0]!.reason).toBe('insufficient_inventory')
    expect(drained.seen[0]!.detail).toContain('wants 1000')
    expect(drained.seen[0]!.detail).not.toContain('bounds')

    const outOfBand = await reported({ pricing: priced({}), fetchPrice: async () => priceFrom('0.5') })
    expect(outOfBand.seen[0]!.detail).not.toContain('bounds')

    const unserved = await reported({ markets: [] })
    expect(unserved.seen[0]!.detail).not.toContain('bounds')
  })

  it('ACCEPTS exactly the minimum', async () => {
    const { outcome, seen } = await reported({
      pricing: priced({ sellBase: { min: 1_000n, max: 5_000n } }),
      fetchPrice,
    })
    expect(outcome).toEqual({ fill: true, id: 'fill-1' })
    expect(seen).toEqual([])
  })

  it('ACCEPTS exactly the maximum', async () => {
    const { outcome, seen } = await reported({ pricing: priced({ sellBase: { min: 100n, max: 1_000n } }), fetchPrice })
    expect(outcome).toEqual({ fill: true, id: 'fill-1' })
    expect(seen).toEqual([])
  })

  // ONE coupled fragment, not substrings that could match apart; `\s*` survives a re-wrap.
  it('is WIRED to the log on the shipped daemon', () => {
    expect(servicesSource).toMatch(/onRefused:\s*\([^)]*\)\s*=>\s*\{\s*log\(`offer \$\{\w+\} refused: \$\{\w+\}/)
  })

  // Coupled to the SAME handler: a tail fed from elsewhere is not these refusals.
  it('is WIRED to the console tail too, from that same handler', () => {
    expect(servicesSource).toMatch(
      /onRefused:\s*\([^)]*\)\s*=>\s*\{[\s\S]{0,200}?offerRefusals\.record\(\{\s*at:[^}]*outpoint,\s*reason,\s*detail/,
    )
  })

  it('serves offers only when OFFER_MARKETS names a market', () => {
    // The second silence, driven for real in test/e2e/assetOffer.e2e.test.ts.
    expect(servicesSource).toMatch(/servesOffers\s*=\s*policy\.offerMarkets\.length > 0/)
    expect(servicesSource).toMatch(/servesOffers\s*\?\s*await OfferFillStore\.open/)
    expect(servicesSource).toContain('replaceMarkets:')
  })
})

describe('tickAll', () => {
  it('marks the row in flight BEFORE submitting', async () => {
    // A crash mid-submission must leave a row that says something may be out,
    // not one that still reads fillable and invites a second submission.
    let stateAtSettle: string | undefined
    const { store, service } = await build({
      settle: async (row) => {
        stateAtSettle = (await store.findById(row.id))?.state
        return '0xfill'
      },
    })
    await service.consider(found)
    expect(await service.tickAll()).toBe(1)
    expect(stateAtSettle).toBe('filling')
    expect(await store.findById('fill-1')).toMatchObject({ state: 'filled', fillTxid: '0xfill' })
  })

  it('hands the settle a latch for its own row, and leaves the row latched', async () => {
    let atSettle: Record<string, unknown> = {}
    const { store, service } = await build({
      settle: async (row, options) => {
        const before = await store.findById(row.id)
        atSettle = { state: before?.state, phase: before?.fillPhase }
        expect(await options?.markSubmitting?.()).toBe(true)
        return '0xfill'
      },
    })
    await service.consider(found)
    expect(await service.tickAll()).toBe(1)
    expect(atSettle).toEqual({ state: 'filling', phase: 'selecting' })
    expect(await store.findById('fill-1')).toMatchObject({ state: 'filled', fillPhase: 'submitting' })
  })

  it('leaves a failed submission stuck, never refused', async () => {
    // `filling` means something may have been submitted; only a human can tell.
    const errors: unknown[] = []
    const { store, service } = await build({
      settle: async () => {
        throw new Error('relay refused')
      },
      onError: (_id, error) => void errors.push(error),
    })
    await service.consider(found)
    expect(await service.tickAll()).toBe(0)
    expect(await store.findById('fill-1')).toMatchObject({ state: 'stuck', failureReason: 'relay refused' })
    expect(errors).toHaveLength(1)
  })

  it('does nothing without a settle port, leaving the row fillable', async () => {
    // A deployment that decides but cannot fill must not lose the intent.
    const { store, service } = await build()
    await service.consider(found)
    expect(await service.tickAll()).toBe(0)
    expect(await store.findById('fill-1')).toMatchObject({ state: 'fillable' })
  })
})

describe('tickAll recovers a row a restart left filling', () => {
  const crashed = async (phase: 'selecting' | 'submitting' | null) => {
    const settle = vi.fn(async () => '0xfill')
    const errors: { id: string; error: unknown }[] = []
    const built = await build({ settle, onError: (id, error) => void errors.push({ id, error }) })
    await built.service.consider(found)
    // What a crash between the claim and the walk-back leaves; NULL predates the column.
    await built.store.transition('fill-1', 'fillable', 'filling', phase === null ? {} : { fill_phase: phase })
    return { ...built, settle, errors }
  }

  it('walks a selecting row back, then fills it on the next sweep exactly once', async () => {
    const { store, service, settle, errors } = await crashed('selecting')
    expect(await service.tickAll()).toBe(0)
    expect(settle).not.toHaveBeenCalled()
    expect(await store.findById('fill-1')).toMatchObject({ state: 'fillable', fillPhase: null })

    expect(await service.tickAll()).toBe(1)
    expect(settle).toHaveBeenCalledTimes(1)
    expect(await store.findById('fill-1')).toMatchObject({ state: 'filled', fillTxid: '0xfill' })
    expect(errors).toEqual([])
  })

  it.each(['submitting', null] as const)('parks a %s row stuck — its fill may have landed', async (phase) => {
    const { store, service, settle, errors } = await crashed(phase)
    expect(await service.tickAll()).toBe(0)
    expect(settle).not.toHaveBeenCalled()
    const row = await store.findById('fill-1')
    expect(row).toMatchObject({ state: 'stuck', fillTxid: null })
    expect(row!.failureReason).toMatch(/fill outcome unknown after restart/)
    expect(errors).toHaveLength(1)
  })
})

describe('tickAll defers a fill the float cannot fund yet', () => {
  const pinned = async (over: Partial<AssetOfferDeps> = {}) => {
    let busy = true
    let submitted = 0
    const settle = vi.fn(async () => {
      if (busy) throw new OfferNotSubmittedError('no spendable coins to pay the maker 1000 sats')
      submitted += 1
      return '0xfill'
    })
    const errors: { id: string; error: unknown }[] = []
    const deferred: { id: string; error: unknown }[] = []
    const built = await build({
      settle,
      onError: (id, error) => void errors.push({ id, error }),
      onDeferred: (id, error) => void deferred.push({ id, error }),
      ...over,
    })
    await built.service.consider(found)
    return {
      ...built,
      settle,
      errors,
      deferred,
      freeTheFloat: () => void (busy = false),
      submissions: () => submitted,
    }
  }

  it('walks the row back to fillable without reporting it stuck', async () => {
    const { store, service, settle, errors } = await pinned()
    expect(await service.tickAll()).toBe(0)
    expect(settle).toHaveBeenCalledTimes(1)
    expect(await store.findById('fill-1')).toMatchObject({ state: 'fillable', fillTxid: null, failureReason: null })
    expect(errors).toEqual([])
  })

  it('fills it on a later sweep, submitting exactly once in total', async () => {
    const { store, service, settle, freeTheFloat, submissions } = await pinned()
    await service.tickAll()
    await service.tickAll()
    freeTheFloat()
    expect(await service.tickAll()).toBe(1)
    expect(settle).toHaveBeenCalledTimes(3)
    expect(submissions()).toBe(1)
    expect(await store.findById('fill-1')).toMatchObject({ state: 'filled', fillTxid: '0xfill' })
  })

  it('reports the first deferral once, not every sweep', async () => {
    const { service, deferred } = await pinned()
    await service.tickAll()
    await service.tickAll()
    await service.tickAll()
    expect(deferred).toHaveLength(1)
    expect(deferred[0]).toMatchObject({ id: 'fill-1', error: expect.any(OfferNotSubmittedError) })
  })

  it('escalates to stuck once the retry budget runs out', async () => {
    const { store, service, settle, errors } = await pinned()
    for (let sweep = 0; sweep < MAX_FILL_DEFERRALS; sweep += 1) await service.tickAll()
    expect(await store.findById('fill-1')).toMatchObject({ state: 'fillable' })

    expect(await service.tickAll()).toBe(0)
    const row = await store.findById('fill-1')
    expect(row).toMatchObject({ state: 'stuck', fillTxid: null })
    expect(row!.failureReason).toMatch(/retries exhausted/)
    expect(settle).toHaveBeenCalledTimes(MAX_FILL_DEFERRALS + 1)
    expect(errors).toHaveLength(1)
  })

  it('budgets each row on its own, so one exhausting does not spend another`s', async () => {
    const { store, service } = await pinned()
    for (let sweep = 0; sweep < MAX_FILL_DEFERRALS; sweep += 1) await service.tickAll()
    await service.consider({ ...found, txid: 'b'.repeat(64) })
    await service.tickAll()
    expect(await store.findById('fill-1')).toMatchObject({ state: 'stuck' })
    expect(await store.findById('fill-2')).toMatchObject({ state: 'fillable' })
  })

  it('gates on the TYPE, not the message — a plain error reading the same way still sticks', async () => {
    const { store, service } = await build({
      settle: async () => {
        throw new Error('no spendable coins to pay the maker 1000 sats')
      },
      onError: () => {},
    })
    await service.consider(found)
    expect(await service.tickAll()).toBe(0)
    expect(await store.findById('fill-1')).toMatchObject({ state: 'stuck' })
  })

  it('leaves the row alone when another worker moved it inside the settle, and logs no deferral', async () => {
    const deferred: string[] = []
    const { store, service } = await build({
      settle: async (row) => {
        await store.transition(row.id, 'filling', 'stuck', { failure_reason: 'another worker' })
        throw new OfferNotSubmittedError('no spendable coins to pay the maker 1000 sats')
      },
      onDeferred: (id) => void deferred.push(id),
    })
    await service.consider(found)
    expect(await service.tickAll()).toBe(0)
    expect(await store.findById('fill-1')).toMatchObject({ state: 'stuck', failureReason: 'another worker' })
    expect(deferred).toEqual([])
  })

  it('is WIRED to the log on the shipped daemon', () => {
    expect(servicesSource).toMatch(/onDeferred:\s*\([^)]*\)\s*=>\s*log\(`offer \$\{\w+\} deferred/)
  })
})

describe('replaceMarkets', () => {
  it('starts refusing new offers once the serve list is emptied', async () => {
    const { service } = await build()
    expect(await service.consider(found)).toEqual({ fill: true, id: 'fill-1' })
    await service.replaceMarkets({ markets: [] })
    expect(await service.consider({ ...found, txid: 'b'.repeat(64) })).toEqual({
      fill: false,
      reason: 'unsupported_pair',
    })
  })

  it('refuses an already-recorded intent when configured pricing disappears', async () => {
    const settle = vi.fn(async () => '0xfill')
    const { store, service } = await build({
      pricing,
      fetchPrice: async () => priceFrom('1.12'),
      settle,
    })
    expect(await service.consider(found)).toEqual({ fill: true, id: 'fill-1' })
    await service.replaceMarkets({ markets: [], pricing: [] })
    expect(await service.tickAll()).toBe(0)
    expect(settle).not.toHaveBeenCalled()
    expect(await store.findById('fill-1')).toMatchObject({ state: 'refused', fillTxid: null })
  })

  // The console save, as `rebuild()` performs it (`ops/services.ts:1228`): the row is
  // re-judged BEFORE the CAS, so it fails to `refused` and never reaches `filling`.
  const edited = (toleranceBps: number) => [{ ...pricing[0]!, toleranceBps }]
  const admittedUnder = async (toleranceBps: number) => {
    const settle = vi.fn(async () => '0xfill')
    const built = await build({ pricing: edited(toleranceBps), fetchPrice: async () => priceFrom('1'), settle })
    expect(await built.service.consider(found)).toEqual({ fill: true, id: 'fill-1' })
    expect(await built.store.findById('fill-1')).toMatchObject({ state: 'fillable' })
    return { ...built, settle }
  }

  it('refuses an already-fillable row after a market edit moves the tolerance', async () => {
    const { store, service, settle } = await admittedUnder(9_999)
    await service.replaceMarkets({ markets: [{ a: USDT, b: null }], pricing: edited(0) })
    expect(await service.tickAll()).toBe(0)
    expect(settle).not.toHaveBeenCalled()
    const row = await store.findById('fill-1')
    expect(row).toMatchObject({ state: 'refused', fillTxid: null })
    expect(row!.failureReason).toMatch(/price_out_of_tolerance/)
  })

  it('fills that same row when the save leaves the tolerance alone — the control', async () => {
    const { store, service, settle } = await admittedUnder(9_999)
    await service.replaceMarkets({ markets: [{ a: USDT, b: null }], pricing: edited(9_999) })
    expect(await service.tickAll()).toBe(1)
    expect(settle).toHaveBeenCalledTimes(1)
    expect(await store.findById('fill-1')).toMatchObject({ state: 'filled', fillTxid: '0xfill' })
  })

  it('waits for an in-flight consider before swapping the list', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const { service } = await build({
      outputsAt: async () => {
        await blocked
        return [{ script: SCRIPT_HEX, value: 500, assets: [{ assetId: USDT, amount: 900n }] }]
      },
    })
    const considering = service.consider(found)
    let replaced = false
    const replacing = service.replaceMarkets({ markets: [] }).then(() => {
      replaced = true
    })
    await Promise.resolve()
    expect(replaced).toBe(false)
    release()
    expect(await considering).toEqual({ fill: true, id: 'fill-1' })
    await replacing
    expect(replaced).toBe(true)
    expect(await service.consider({ ...found, txid: 'b'.repeat(64) })).toEqual({
      fill: false,
      reason: 'unsupported_pair',
    })
  })
})

// `consider` admits a price; `tickAll` spends at it on a worker loop and at
// startup recovery, arbitrary wall time later. Nothing between them re-asks.
describe('tickAll re-runs price admission', () => {
  let duringPriceRead: (() => Promise<void>) | null = null
  beforeEach(() => void (duringPriceRead = null))

  const admitted = async (over: Partial<AssetOfferDeps> = {}) => {
    let price = '1.12'
    const settle = vi.fn(async () => '0xfill')
    const refused: { outpoint: string; reason: string; detail: string }[] = []
    const errors: { id: string; error: unknown }[] = []
    const built = await build({
      pricing,
      fetchPrice: async () => {
        await duringPriceRead?.()
        return priceFrom(price)
      },
      settle,
      onRefused: (outpoint, reason, detail) => void refused.push({ outpoint, reason, detail }),
      onError: (id, error) => void errors.push({ id, error }),
      ...over,
    })
    expect(await built.service.consider(found)).toEqual({ fill: true, id: 'fill-1' })
    return { ...built, settle, refused, errors, moveFeed: (to: string) => void (price = to) }
  }

  it('does not spend at a price the feed has left since admission', async () => {
    const { store, service, settle, moveFeed } = await admitted()
    moveFeed('0.5')
    expect(await service.tickAll()).toBe(0)
    expect(settle).not.toHaveBeenCalled()
    expect((await store.findById('fill-1'))!.fillTxid).toBeNull()
  })

  it('records that as REFUSED, never stuck — nothing was submitted', async () => {
    const { store, service, moveFeed } = await admitted()
    moveFeed('0.5')
    await service.tickAll()
    const row = await store.findById('fill-1')
    expect(row!.state).toBe('refused')
    expect(row!.fillTxid).toBeNull()
    expect(row!.failureReason).toMatch(/price_out_of_tolerance/)
  })

  it('reports it against the offer`s outpoint, like every other refusal', async () => {
    const { service, refused, moveFeed } = await admitted()
    moveFeed('0.5')
    await service.tickAll()
    expect(refused).toHaveLength(1)
    expect(refused[0]).toMatchObject({ outpoint: `${found.txid}:${found.vout}`, reason: 'price_out_of_tolerance' })
    expect(refused[0]!.detail).toContain('1000')
  })

  it('re-prices the terms the ROW records, not a fresh read of the deposit', async () => {
    const outputsAt = vi.fn(async () => [{ script: SCRIPT_HEX, value: 500, assets: [{ assetId: USDT, amount: 900n }] }])
    const { service, settle } = await admitted({ outputsAt })
    outputsAt.mockClear()
    expect(await service.tickAll()).toBe(1)
    expect(settle).toHaveBeenCalledTimes(1)
    expect(outputsAt).not.toHaveBeenCalled()
  })

  it('still fills when the price has not moved', async () => {
    const { store, service, settle, refused } = await admitted()
    expect(await service.tickAll()).toBe(1)
    expect(settle).toHaveBeenCalledTimes(1)
    expect(refused).toEqual([])
    expect(await store.findById('fill-1')).toMatchObject({ state: 'filled', fillTxid: '0xfill' })
  })

  it('leaves a deployment with no price gating exactly as it was', async () => {
    const settle = vi.fn(async () => '0xfill')
    const { store, service } = await build({ settle })
    await service.consider(found)
    expect(await service.tickAll()).toBe(1)
    expect(settle).toHaveBeenCalledTimes(1)
    expect(await store.findById('fill-1')).toMatchObject({ state: 'filled' })
  })

  it('FAILS CLOSED when the feed cannot be read at tick time', async () => {
    const { store, service, settle, errors, moveFeed } = await admitted()
    moveFeed('unreadable')
    expect(await service.tickAll()).toBe(0)
    expect(settle).not.toHaveBeenCalled()
    expect(await store.findById('fill-1')).toMatchObject({ state: 'refused' })
    // The ROW's id, not the `price` sentinel: an operator joins log to row on it.
    expect(errors).toEqual([{ id: 'fill-1', error: expect.any(Error) }])
  })

  it('leaves a stuck row stuck', async () => {
    const { store, service, settle } = await admitted()
    await store.transition('fill-1', 'fillable', 'filling')
    await store.fail('fill-1', 'filling', 'relay refused')
    expect(await service.tickAll()).toBe(0)
    expect(settle).not.toHaveBeenCalled()
    expect(await store.findById('fill-1')).toMatchObject({ state: 'stuck', failureReason: 'relay refused' })
  })

  it('cannot unwind a row another tick already has in flight', async () => {
    // A second tick can win the CAS inside the price read's await; the refusal
    // is compare-and-swap on `fillable` too, so it no-ops rather than unwinding.
    const { store, service, settle, moveFeed } = await admitted()
    moveFeed('0.5')
    duringPriceRead = async () => void (await store.transition('fill-1', 'fillable', 'filling'))
    expect(await service.tickAll()).toBe(0)
    expect(settle).not.toHaveBeenCalled()
    expect(await store.findById('fill-1')).toMatchObject({ state: 'filling' })
  })
})

describe('consumeOfferTxs — the discovery intake', () => {
  /**
   * A real funding transaction, encoded the way the maker's wallet encodes one
   * and the way arkd hands it back. Nothing here is hand-rolled TLV: `encodeOffer`
   * is the same function that produced the packet solverd would emit, so a change
   * to the wire format breaks this rather than passing against our own dialect.
   */
  const fundingTx = (over: Partial<Offer> = {}): string => {
    const published = {
      swapPkScript: SCRIPT,
      wantAmount: 1_000n,
      offerAsset: asset.AssetId.fromString(USDT),
      makerPkScript: new Uint8Array(34).fill(0xcd),
      makerPublicKey: new Uint8Array(32).fill(0x11),
      emulatorPubkey: new Uint8Array(32).fill(0x22),
      ...over,
    } as Offer
    const tx = new Transaction({ allowUnknownOutputs: true, disableScriptCheck: true })
    tx.addOutput({ script: published.swapPkScript, amount: 500n })
    const out = Extension.create([new UnknownPacket(OFFER_PACKET_TYPE, encodeOffer(published))]).txOut()
    tx.addOutput({ script: out.script, amount: out.amount })
    return base64.encode(tx.toPSBT())
  }

  const stream = async function* (txs: readonly string[]): AsyncGenerator<{ txid: string; tx: string }> {
    for (const tx of txs) yield { txid: 'announced', tx }
  }

  it('decides an offer decoded off the stream, keyed to the outpoint it funds', async () => {
    const { store, service } = await build()
    const raw = fundingTx()
    await service.consumeOfferTxs(stream([raw]))

    const row = await store.findById('fill-1')
    expect(row).toMatchObject({ state: 'fillable', wantAmount: 1_000n, offerAssetId: USDT })
    // The txid comes from the transaction, not from the `txid` the stream
    // announced beside it: the row must name the outpoint settlement will spend.
    expect(row!.offerTxid).toBe(Transaction.fromPSBT(base64.decode(raw)).id)
    expect(row!.offerVout).toBe(0)
    expect(row!.offerPkScript).toBe(SCRIPT_HEX)
  })

  it('does not let one undecodable transaction end the stream', async () => {
    // Anyone can put a transaction on this stream. A malformed packet is normal
    // traffic, and a loop that dies on it goes deaf to every offer after it.
    const { store, service } = await build()
    await service.consumeOfferTxs(stream(['not a transaction at all', fundingTx()]))
    expect(await store.listNonTerminal()).toHaveLength(1)
  })

  it('keeps going when deciding one offer throws, and reports it', async () => {
    const errors: unknown[] = []
    const { store, service } = await build({
      outputsAt: vi
        .fn()
        .mockRejectedValueOnce(new Error('indexer down'))
        .mockResolvedValue([{ script: SCRIPT_HEX, value: 500, assets: [{ assetId: USDT, amount: 900n }] }]),
      onError: (_id, error) => void errors.push(error),
    })
    // Two DIFFERENT offers: one outpoint would be deduplicated by the store.
    await service.consumeOfferTxs(stream([fundingTx(), fundingTx({ wantAmount: 1_100n })]))
    expect(errors).toHaveLength(1)
    expect(await store.listNonTerminal()).toHaveLength(1)
  })

  it('ignores a transaction carrying no offer packet without recording anything', async () => {
    const bare = new Transaction({ allowUnknownOutputs: true, disableScriptCheck: true })
    bare.addOutput({ script: SCRIPT, amount: 500n })
    const { store, service } = await build()
    await service.consumeOfferTxs(stream([base64.encode(bare.toPSBT())]))
    expect(await store.listNonTerminal()).toHaveLength(0)
  })

  it('observes the deposit at the script rather than trusting the funding output', async () => {
    // The transaction says 500 sats landed. What decides is what the chain still
    // holds there, which is the read `outputsAt` performs — an offer whose
    // deposit has since been spent must not be recorded as fillable.
    const { store, service } = await build({ outputsAt: async () => [] })
    await service.consumeOfferTxs(stream([fundingTx()]))
    expect(await store.listNonTerminal()).toHaveLength(0)
  })
})

describe('parseAssetMarkets', () => {
  it('reads BTC as the null leg', () => {
    expect(parseAssetMarkets(`BTC/${USDT}`)).toEqual([{ a: null, b: USDT }])
  })

  it('reads asset-for-asset', () => {
    const other = '22'.repeat(34)
    expect(parseAssetMarkets(`${USDT}/${other}`)).toEqual([{ a: USDT, b: other }])
  })

  it('serves nothing when unset', () => {
    expect(parseAssetMarkets(undefined)).toEqual([])
    expect(parseAssetMarkets('')).toEqual([])
  })

  it('refuses a market naming one thing twice', () => {
    expect(() => parseAssetMarkets(`${USDT}/${USDT}`)).toThrow(/one thing twice/)
    expect(() => parseAssetMarkets('BTC/BTC')).toThrow(/one thing twice/)
  })

  it('refuses a malformed entry rather than silently serving fewer markets', () => {
    expect(() => parseAssetMarkets('BTC')).toThrow(/not A\/B/)
    expect(() => parseAssetMarkets('a/b/c')).toThrow(/not A\/B/)
  })
})

describe('the approval gate on offer fills', () => {
  const gateWith = (thresholdSats: number | null, assetThresholds?: ReadonlyMap<string, bigint>) => {
    const requests: SwapApprovalRequest[] = []
    return {
      requests,
      gate: approvalGateFor({
        thresholdSats,
        assetThresholds,
        corridor: 'arkade offer fill',
        store: {
          isSwapApproved: async () => false,
          recordApprovalRequest: async (request) => {
            requests.push(request)
            return true
          },
        },
      }),
    }
  }

  it('submits nothing at the threshold, and leaves the row FILLABLE rather than filling', async () => {
    const { requests, gate } = gateWith(1_000)
    const settle = vi.fn(async () => '0xfill')
    const { store, service } = await build({ settle, approvalGate: gate })
    await service.consider(found)

    expect(await service.tickAll()).toBe(0)
    expect(settle).not.toHaveBeenCalled()
    expect(await store.findById('fill-1')).toMatchObject({ state: 'fillable' })
    expect(requests).toEqual([{ swapId: 'fill-1', corridor: 'arkade offer fill', assetId: null, amount: 1_000n }])
  })

  it('fills ONE SAT below the threshold, recording nothing and asking nobody', async () => {
    const { requests, gate } = gateWith(1_001)
    const settle = vi.fn(async () => '0xfill')
    const { store, service } = await build({ settle, approvalGate: gate })
    await service.consider(found)

    expect(await service.tickAll()).toBe(1)
    expect(settle).toHaveBeenCalledTimes(1)
    expect(await store.findById('fill-1')).toMatchObject({ state: 'filled', fillTxid: '0xfill' })
    expect(requests).toEqual([])
  })

  it('fills as before when no gate is wired at all', async () => {
    const settle = vi.fn(async () => '0xfill')
    const { service } = await build({ settle })
    await service.consider(found)
    expect(await service.tickAll()).toBe(1)
    expect(settle).toHaveBeenCalledTimes(1)
  })
})

/** The fake `settle` latches before it throws, or the walk-backs no-op. */
describe('tickAll classifies a fill arkd rejected as already spent', () => {
  const rejecting = async (error: () => Error, over: Partial<AssetOfferDeps> = {}) => {
    const errors: { id: string; error: unknown }[] = []
    const deferred: { id: string; error: unknown }[] = []
    const settle = vi.fn(async (_row: unknown, options?: { markSubmitting?: () => Promise<boolean> }) => {
      await options?.markSubmitting?.()
      throw error()
    })
    const built = await build({
      settle: settle as unknown as AssetOfferDeps['settle'],
      onError: (id, e) => void errors.push({ id, error: e }),
      onDeferred: (id, e) => void deferred.push({ id, error: e }),
      ...over,
    })
    await built.service.consider(found)
    return { ...built, settle, errors, deferred }
  }

  const spent = (outpoints: string[], depositSpent: boolean) =>
    new OfferSubmitRejectedError(
      `arkd refused the fill: ${outpoints.join(', ')} already spent`,
      outpoints,
      depositSpent,
    )

  it('marks the row lost — not stuck — when the offer deposit was spent elsewhere', async () => {
    const { store, service, errors } = await rejecting(() => spent([`${'a'.repeat(64)}:0`], true))
    expect(await service.tickAll()).toBe(0)
    expect(await store.findById('fill-1')).toMatchObject({
      state: 'lost',
      fillTxid: null,
      failureReason: DEPOSIT_SPENT_REASON,
    })
    expect(errors).toEqual([])
  })

  it('stays silent when another writer moved the row before the exit lands', async () => {
    const errors: unknown[] = []
    let store!: Awaited<ReturnType<typeof build>>['store']
    const built = await build({
      settle: async (_row, options) => {
        await options?.markSubmitting?.()
        await store.fail('fill-1', 'filling', 'parked by recovery')
        throw spent([`${'a'.repeat(64)}:0`], true)
      },
      onError: (_id, e) => void errors.push(e),
    })
    store = built.store
    await built.service.consider(found)
    expect(await built.service.tickAll()).toBe(0)
    expect(await store.findById('fill-1')).toMatchObject({ state: 'stuck', failureReason: 'parked by recovery' })
    expect(errors).toEqual([])
  })

  it('walks the row back to fillable when one of OUR coins was the one spent', async () => {
    const { store, service, deferred, errors } = await rejecting(() => spent([`${'9'.repeat(64)}:1`], false))
    expect(await service.tickAll()).toBe(0)
    expect(await store.findById('fill-1')).toMatchObject({ state: 'fillable', fillTxid: null, failureReason: null })
    expect(deferred).toHaveLength(1)
    expect(errors).toEqual([])
  })

  it('fills it on a later sweep once the coin race is over', async () => {
    let racing = true
    const { store, service } = await build({
      settle: async (_row, options) => {
        await options?.markSubmitting?.()
        if (racing) throw spent([`${'9'.repeat(64)}:1`], false)
        return '0xfill'
      },
    })
    await service.consider(found)
    await service.tickAll()
    racing = false
    expect(await service.tickAll()).toBe(1)
    expect(await store.findById('fill-1')).toMatchObject({ state: 'filled', fillTxid: '0xfill' })
  })

  it('spends the same retry budget, so a coin race cannot loop forever', async () => {
    const { store, service } = await rejecting(() => spent([`${'9'.repeat(64)}:1`], false))
    for (let sweep = 0; sweep < MAX_FILL_DEFERRALS; sweep += 1) await service.tickAll()
    expect(await store.findById('fill-1')).toMatchObject({ state: 'fillable' })
    await service.tickAll()
    const row = await store.findById('fill-1')
    expect(row).toMatchObject({ state: 'stuck' })
    expect(row!.failureReason).toMatch(/retries exhausted/)
  })

  it('still sticks every other submission failure', async () => {
    const { store, service } = await rejecting(
      () => new Error('Failed to submit tx to emulator: something else entirely'),
    )
    await service.tickAll()
    expect(await store.findById('fill-1')).toMatchObject({ state: 'stuck' })
  })
})

describe('an offer an RFQ negotiation already holds', () => {
  it('is skipped silently, with no row and no refusal recorded', async () => {
    const refused: unknown[] = []
    const { store, service } = await build({
      rfqHolds: async () => true,
      onRefused: (outpoint, reason, detail) => void refused.push({ outpoint, reason, detail }),
    })
    expect(await service.consider(found)).toEqual({ fill: false, reason: 'offer_held_by_rfq' })
    expect(await store.findById('fill-1')).toBeUndefined()
    expect(refused).toEqual([])
  })

  it('asks about the offer script the packet names', async () => {
    const asked: string[] = []
    const { service } = await build({
      rfqHolds: async (pkScript) => {
        asked.push(pkScript)
        return true
      },
    })
    await service.consider(found)
    expect(asked).toEqual([SCRIPT_HEX])
  })

  it('is considered normally once the negotiation is no longer live', async () => {
    const { store, service } = await build({ rfqHolds: async () => false })
    expect(await service.consider(found)).toEqual({ fill: true, id: 'fill-1' })
    expect(await store.findById('fill-1')).toMatchObject({ state: 'fillable' })
  })

  it('is considered normally when nothing was wired at all', async () => {
    const { service } = await build()
    expect(await service.consider(found)).toEqual({ fill: true, id: 'fill-1' })
  })

  it('reads liveness from the RFQ machine, so a filled negotiation releases the script', async () => {
    const rfq = await AssetRfqSwapStore.open(betterSqliteDriver(':memory:'))
    await rfq.insertQuote({
      id: 'rfq-1',
      rfqId: 'a'.repeat(64),
      pair: `arkade:${USDT}->arkade:BTC`,
      fromAssetId: USDT,
      fromAmount: 900n,
      toAssetId: null,
      toAmount: 1_000n,
      makerPkScript: `5120${'c'.repeat(64)}`,
      makerPublicKey: 'b'.repeat(64),
      offerPkScript: SCRIPT_HEX,
      offerAddress: 'ark1qoffer',
      solverPubkey: 'e'.repeat(64),
      validUntil: 2_000,
    })
    const { service } = await build({ rfqHolds: (pkScript) => rfq.heldByLiveNegotiation(pkScript) })
    expect(await service.consider(found)).toEqual({ fill: false, reason: 'offer_held_by_rfq' })

    await rfq.transition('rfq-1', 'quoted', 'funded')
    await rfq.transition('rfq-1', 'funded', 'filling', { fill_phase: 'selecting' })
    await rfq.transition('rfq-1', 'filling', 'filled')
    expect(await rfq.findLiveByOfferScript(SCRIPT_HEX)).toBeDefined()
    expect(await service.consider(found)).toEqual({ fill: true, id: 'fill-1' })
    await rfq.close()
  })
})

/** Both remaining timings rejoin the deferral budget: this loop has no
 * action-time deposit gate, and `lost` here cannot be undone. */
describe('tickAll on a lost race caught before the submission', () => {
  const INCIDENT_DEPOSIT = '7da3508518eb5fec43370d26fb85e2fe105796f1869d183e16a38dbe41e05730:0'

  const throwing = async (error: () => Error, latch = false) => {
    const errors: { id: string; error: unknown }[] = []
    const deferred: { id: string; error: unknown }[] = []
    const settle = vi.fn(async (_row: unknown, options?: { markSubmitting?: () => Promise<boolean> }) => {
      if (latch) await options?.markSubmitting?.()
      throw error()
    })
    const built = await build({
      settle: settle as unknown as AssetOfferDeps['settle'],
      onError: (id, e) => void errors.push({ id, error: e }),
      onDeferred: (id, e) => void deferred.push({ id, error: e }),
    })
    await built.service.consider(found)
    return { ...built, settle, errors, deferred }
  }

  it('defers the adapter liveness refusal instead of parking it stuck', async () => {
    const { store, service, deferred, errors } = await throwing(
      () => new OfferNotSubmittedError(`${INCIDENT_DEPOSIT} is no longer live at ${SCRIPT_HEX}; nothing was submitted`),
    )
    expect(await service.tickAll()).toBe(0)
    expect(await store.findById('fill-1')).toMatchObject({ state: 'fillable', failureReason: null })
    expect(deferred).toHaveLength(1)
    expect(errors).toEqual([])
  })

  it('defers the SDK pre-send refusal from under the latch', async () => {
    const { store, service, deferred } = await throwing(
      () => new OfferSubmitRejectedError('the deposit was not spendable when the fill was built', [], false),
      true,
    )
    expect(await service.tickAll()).toBe(0)
    expect(await store.findById('fill-1')).toMatchObject({ state: 'fillable', fillPhase: null })
    expect(deferred).toHaveLength(1)
  })

  it('still ends lost — not stuck — when arkd named the incident outpoint as spent', async () => {
    const { store, service, errors } = await throwing(
      () =>
        new OfferSubmitRejectedError(
          `arkd refused the fill: ${INCIDENT_DEPOSIT} already spent`,
          [INCIDENT_DEPOSIT],
          true,
        ),
      true,
    )
    expect(await service.tickAll()).toBe(0)
    expect(await store.findById('fill-1')).toMatchObject({ state: 'lost', failureReason: DEPOSIT_SPENT_REASON })
    expect(errors).toEqual([])
  })

  it('exhausts the budget into stuck, since absence from a list never proves the deposit gone', async () => {
    const { store, service } = await throwing(
      () => new OfferNotSubmittedError(`${INCIDENT_DEPOSIT} is no longer live; nothing was submitted`),
    )
    for (let sweep = 0; sweep < MAX_FILL_DEFERRALS; sweep += 1) await service.tickAll()
    expect(await store.findById('fill-1')).toMatchObject({ state: 'fillable' })
    await service.tickAll()
    expect(await store.findById('fill-1')).toMatchObject({ state: 'stuck' })
  })
})

/** The payoff: an offer another taker took ends `lost` on the first sweep. */
describe('tickAll on a deposit the indexer proves spent', () => {
  const SPENDER = 'f1'.repeat(32)

  const settling = async (error: () => Error, latch: boolean) => {
    const errors: { id: string; error: unknown }[] = []
    const settle = vi.fn(async (_row: unknown, options?: { markSubmitting?: () => Promise<boolean> }) => {
      if (latch) await options?.markSubmitting?.()
      throw error()
    })
    const built = await build({
      settle: settle as unknown as AssetOfferDeps['settle'],
      onError: (id, e) => void errors.push({ id, error: e }),
    })
    await built.service.consider(found)
    return { ...built, errors }
  }

  const proven = () =>
    new OfferSubmitRejectedError(
      `${'a'.repeat(64)}:0 was spent by ${SPENDER}; nothing was submitted`,
      [`${'a'.repeat(64)}:0`],
      true,
      {
        spentBy: SPENDER,
      },
    )

  it.each([
    ['above the latch, at selecting', false],
    ['under the latch, at submitting', true],
  ] as const)('ends lost on the first sweep %s', async (_where, latch) => {
    const { store, service, errors } = await settling(proven, latch)
    expect(await service.tickAll()).toBe(0)
    expect(await store.findById('fill-1')).toMatchObject({ state: 'lost', failureReason: DEPOSIT_SPENT_REASON })
    expect(errors).toEqual([])
  })

  /** A spender that IS our fill means a filled row would be misread as lost. */
  it('refuses to call it lost when the named spender is our own fill', async () => {
    const { store, service } = await build({
      settle: async (_row, options) => {
        await options?.markSubmitting?.()
        throw new OfferSubmitRejectedError('spent by us', [`${'a'.repeat(64)}:0`], true, { spentBy: '0xfill' })
      },
    })
    await service.consider(found)
    await store.transition('fill-1', 'fillable', 'filling', { fill_phase: 'selecting', fill_txid: '0xfill' })
    await store.revertUnsubmitted('fill-1')
    await service.tickAll()
    expect((await store.findById('fill-1'))?.state).not.toBe('lost')
  })
})

/** The exhausted tail is the last place a lost CAS could still alert. */
describe('tickAll at the end of the retry budget', () => {
  it('stays silent when another writer parked the row before the tail lands', async () => {
    const errors: unknown[] = []
    let store!: Awaited<ReturnType<typeof build>>['store']
    let sweeps = 0
    const built = await build({
      settle: async () => {
        sweeps += 1
        // On the sweep that spends the budget, recovery gets there first.
        if (sweeps > MAX_FILL_DEFERRALS) await store.fail('fill-1', 'filling', 'parked by recovery')
        throw new OfferNotSubmittedError('no spendable coins to pay the maker 1000 sats')
      },
      onError: (_id, e) => void errors.push(e),
    })
    store = built.store
    await built.service.consider(found)
    for (let sweep = 0; sweep <= MAX_FILL_DEFERRALS; sweep += 1) await built.service.tickAll()

    expect(await store.findById('fill-1')).toMatchObject({ state: 'stuck', failureReason: 'parked by recovery' })
    expect(errors).toEqual([])
  })

  it('still alerts when this attempt is the one that parks it', async () => {
    const errors: unknown[] = []
    const { store, service } = await build({
      settle: async () => {
        throw new OfferNotSubmittedError('no spendable coins to pay the maker 1000 sats')
      },
      onError: (_id, e) => void errors.push(e),
    })
    await service.consider(found)
    for (let sweep = 0; sweep <= MAX_FILL_DEFERRALS; sweep += 1) await service.tickAll()

    expect((await store.findById('fill-1'))?.failureReason).toMatch(/retries exhausted/)
    expect(errors).toHaveLength(1)
  })
})
