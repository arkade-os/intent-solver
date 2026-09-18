/**
 * `POST /api/pricing/preview` — READ-ONLY. No write, no audit row, no
 * `replaceMarkets`. Every figure comes back from a production resolver, so a
 * preview can never disagree with a real quote through separate arithmetic.
 */
import type { Hono } from 'hono'
import { isCorridor, payoutSatsFor } from '@arkade-os/solver-core/core/corridorPolicy.js'
import {
  assetMarketKey,
  validateAssetMarket,
  type AssetMarketConfig,
} from '@arkade-os/solver-core/core/assetMarketConfig.js'
import {
  assetFeeBpsFor,
  assetFlatFeeFor,
  assetQuoteGivesBase,
  carrierLegs,
  resolveAssetQuote,
  type AssetPair,
  type AssetQuoteMarket,
} from '@arkade-os/solver-core/core/assetRfq.js'
import {
  carrierBreakEven,
  decomposeAssetQuote,
  decomposeCorridorQuote,
  offerAcceptanceCeiling,
  type BreakEven,
} from '@arkade-os/solver-core/core/pricingPreview.js'
import type { Price } from '@arkade-os/solver-core/core/priceFeed.js'
import type { AdminDeps } from '../server.js'
import type { AssetMarketRow } from '../db.js'
import type { FeedCache } from '../feedCache.js'
import { resolveDraftPolicy, type DraftRefusal } from '../draftPolicy.js'
import { marketFrom, type MarketBody } from './markets.js'

const MAX_SAMPLES = 6

/** `lo`, `hi`, and the powers of ten between them. Ascending, capped. */
const decades = (lo: bigint, hi: bigint): bigint[] => {
  const points = new Set([lo, hi])
  for (let decade = 10n; decade < hi && points.size < 32; decade *= 10n) if (decade > lo) points.add(decade)
  const sorted = [...points].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  if (sorted.length <= MAX_SAMPLES) return sorted
  const middle = sorted.slice(1, -1)
  const step = Math.ceil(middle.length / (MAX_SAMPLES - 2))
  return [sorted[0]!, ...middle.filter((_, index) => index % step === 0).slice(0, MAX_SAMPLES - 2), sorted.at(-1)!]
}

const FIELDS = new Set([
  'base',
  'quote',
  'baseDecimals',
  'quoteDecimals',
  'feedUrl',
  'pricePath',
  'toleranceBps',
  'feeBps',
  'sellBaseFeeBps',
  'buyBaseFeeBps',
  'sellBaseFeeFlat',
  'buyBaseFeeFlat',
  'sellBase',
  'buyBase',
])

/** `price_path`'s own errors spell it with an underscore; every other message matches a wire field name. */
const ALIASES: Record<string, string> = { price_path: 'pricePath' }

/** The refusal's first word if it names a field, else the pair as a whole. */
const refusalFor = (error: unknown): DraftRefusal => {
  const reason = error instanceof Error ? error.message : String(error)
  const token = reason.split(/[\s.:]/)[0] ?? ''
  const first = ALIASES[token] ?? token
  return { key: FIELDS.has(first) ? first : 'market', reason }
}

const str = (value: bigint): string => value.toString()

export const registerPricingRoutes = (app: Hono, deps: AdminDeps, feeds: FeedCache): void => {
  app.post('/api/pricing/preview', async (c) => {
    let body: Record<string, unknown>
    try {
      body = ((await c.req.json()) ?? {}) as Record<string, unknown>
    } catch {
      return c.json({ error: 'bad_request', message: 'body must be JSON' }, 400)
    }
    const side = body.side === 'to' ? 'to' : 'from'
    return body.target === 'corridor'
      ? c.json(corridorPreview(deps, body, side))
      : c.json(await marketPreview(deps, feeds, body, side))
  })
}

const corridorPreview = (deps: AdminDeps, body: Record<string, unknown>, side: 'from' | 'to') => {
  const corridor = String(body.corridor ?? '')
  if (!isCorridor(corridor)) {
    return {
      invalid: [{ key: 'corridor', reason: `${JSON.stringify(corridor)} is not one of the four BTC corridors` }],
      samples: [],
    }
  }
  const draft = (body.overrides ?? {}) as Record<string, string>
  const resolved = resolveDraftPolicy(deps.services.config, draft)
  if (!resolved.ok) return { invalid: resolved.invalid, samples: [] }

  const fee = resolved.config.corridorFees[corridor]
  const limits = resolved.config.corridorLimits[corridor]
  const at = (amountSats: number) => ({
    amountSats,
    ...decomposeCorridorQuote({ amountSats, amountSide: side, fee, limits }),
  })
  // Bounds are on the give leg; both ends of an exact-out ladder go through
  // `payoutSatsFor` rather than being shifted here, floored at 1 so a flat fee
  // past the minimum can't render as a negative sample amount.
  const lo = side === 'from' ? limits.minSats : Math.max(1, payoutSatsFor(limits.minSats, fee))
  const hi = side === 'from' ? limits.maxSats : payoutSatsFor(limits.maxSats, fee)
  if (hi < lo || hi <= 0) {
    return {
      invalid: [{ key: 'corridor', reason: `${corridor} admits no amount at this fee and these limits` }],
      samples: [],
      breakEven: { kind: 'none' } as BreakEven,
    }
  }
  const points = decades(BigInt(lo), BigInt(hi)).map(Number)
  return {
    invalid: [],
    enabled: resolved.config.corridorEnabled[corridor],
    fee,
    limits,
    samples: [...(lo > 1 ? [lo - 1] : []), ...points, hi + 1].map(at),
    // `Fee` carries no cost basis to recover here; the corridor's real one is a
    // separately-sampled network estimate, not this screen's subject.
    breakEven: { kind: 'none' } as BreakEven,
  }
}

const marketPreview = async (deps: AdminDeps, feeds: FeedCache, body: Record<string, unknown>, side: 'from' | 'to') => {
  let market: AssetMarketConfig
  try {
    market = marketFrom((body.market ?? {}) as MarketBody)
  } catch (error) {
    return { invalid: [refusalFor(error)], samples: [] }
  }

  // Looked up before validating: grandfathering covers a row already saved
  // under the old rule, not a brand-new draft the write would still refuse.
  let lookup: AssetMarketRow | null = null
  try {
    lookup = await deps.services.adminStore.getMarket(assetMarketKey(market.base, market.quote))
  } catch {
    lookup = null
  }
  const saved = lookup

  try {
    validateAssetMarket(market, { allowPrivateFeedHost: saved !== null })
  } catch (error) {
    return { invalid: [refusalFor(error)], samples: [] }
  }

  const resolvable = saved !== null && saved.feedUrl === market.feedUrl && saved.pricePath === market.pricePath
  const read = resolvable ? await feeds.read(saved.feedUrl, saved.pricePath) : null
  if (!read) {
    return {
      invalid: [],
      samples: [],
      feed: {
        state: 'unresolved',
        reason: resolvable ? 'the saved feed did not answer' : 'save this market to price against its feed',
      },
    }
  }
  return priceLadder(
    deps,
    market,
    read.price,
    read.readAt,
    body.direction === 'buy_base' ? 'buy_base' : 'sell_base',
    side,
  )
}

const priceLadder = (
  deps: AdminDeps,
  market: AssetMarketConfig,
  feed: Price,
  readAt: number,
  direction: 'sell_base' | 'buy_base',
  side: 'from' | 'to',
) => {
  const pair: AssetPair =
    direction === 'sell_base' ? { from: market.base, to: market.quote } : { from: market.quote, to: market.base }
  const bounds = (direction === 'sell_base' ? market.sellBase : market.buyBase) ?? { min: 0n, max: 0n }
  const priced: AssetQuoteMarket = { ...market, minPayout: bounds.min, maxPayout: bounds.max }
  const carrierSats = deps.services.policy.assetCarrierPricing ? deps.services.arkade.dustSats : 0n
  const dustSats = deps.services.arkade.dustSats
  const { charged, returned } = carrierLegs(pair, carrierSats)
  const shared = { pair, market: priced, feed, carrierSats, dustSats }

  // Seeded on the PAYOUT leg (where the bounds live), then mapped to the
  // deposit leg via an exact-out quote, so the FROM amount is one
  // `resolveAssetQuote` returned rather than re-derived here. `+ returned`
  // matters: exact-out checks `amount - returnedCarrier` (assetRfq.ts:168), so
  // seeding at exactly `minPayout` would refuse on the asset->BTC direction.
  const fromAt = (payout: bigint) => resolveAssetQuote({ ...shared, amount: payout + returned, amountSide: 'to' })
  const loOutcome = fromAt(bounds.min)
  const hiOutcome = fromAt(bounds.max)

  const lo = side === 'to' ? bounds.min + returned : loOutcome.ok ? loOutcome.fromAmount : null
  const hi = side === 'to' ? bounds.max + returned : hiOutcome.ok ? hiOutcome.fromAmount : null
  const at = (amount: bigint) => ({
    amount: str(amount),
    ...toWire(decomposeAssetQuote({ ...shared, amount, amountSide: side })),
  })
  const points =
    lo === null || hi === null || lo > hi
      ? []
      : [...(lo > 1n ? [lo > 10n ? lo / 10n : 1n] : []), ...decades(lo, hi), hi * 10n].map(at)

  // Distinguishes a direction an operator closed from one that failed to
  // price — `offerCeiling` below goes silently null for the same two reasons.
  const samplesReason: string | null =
    points.length > 0
      ? null
      : bounds.max === 0n
        ? 'this direction is closed'
        : !loOutcome.ok
          ? loOutcome.reason
          : !hiOutcome.ok
            ? hiOutcome.reason
            : 'the bounds admit no amount at this feed'

  const givesBase = assetQuoteGivesBase(pair, priced)!
  const flat = assetFlatFeeFor(givesBase, priced)
  const feeBps = assetFeeBpsFor(givesBase, priced)
  return {
    invalid: [],
    direction,
    side,
    legs: {
      from: pair.from === null ? 'BTC' : pair.from,
      to: pair.to === null ? 'BTC' : pair.to,
      fromDecimals: pair.from === market.base ? market.baseDecimals : market.quoteDecimals,
      toDecimals: pair.to === market.base ? market.baseDecimals : market.quoteDecimals,
    },
    carrier: { sats: str(dustSats), charged: str(charged), returned: str(returned), priced: carrierSats > 0n },
    feed: { state: 'resolved', mantissa: str(feed.mantissa), scale: feed.scale, readAt },
    samples: points,
    samplesReason,
    // The other path's question, and only where this deployment serves it —
    // found by searching the production gate rather than inverting it.
    offerCeiling: offerCeilingFor(deps, market, pair, direction, feed, side === 'from' ? hi : null),
    // Only where the solver delivers the asset and the carrier is unpriced;
    // anywhere else there is no cost to recover.
    breakEven: breakEvenJson(
      charged === 0n && returned === 0n && pair.to !== null
        ? carrierBreakEven({ carrierSats: dustSats, flatSats: flat, feeBps })
        : { kind: 'none' },
    ),
  }
}

const breakEvenJson = (value: BreakEven) =>
  value.kind === 'at' ? { kind: 'at', amountSats: str(value.amountSats) } : value

const offerCeilingFor = (
  deps: AdminDeps,
  market: AssetMarketConfig,
  pair: AssetPair,
  direction: 'sell_base' | 'buy_base',
  feed: Price,
  deposit: bigint | null,
): { deposit: string; wantAmount: string } | null => {
  if (deposit === null) return null
  const serves = deps.services.policy.offerMarkets.some(
    (served) =>
      (served.a === market.base && served.b === market.quote) ||
      (served.a === market.quote && served.b === market.base),
  )
  if (!serves) return null
  // The offer path's carrier flag is separate from the RFQ one, and applies to the delivered leg only.
  const carrier = deps.services.policy.offerChargesDeliveredCarrier ? deps.services.arkade.dustSats : 0n
  const { charged, returned } = carrierLegs(pair, carrier)
  const wantAmount = offerAcceptanceCeiling({
    depositAmount: deposit,
    direction,
    market,
    feed,
    carrierCharged: charged,
    carrierReturned: returned,
  })
  return wantAmount === null ? null : { deposit: str(deposit), wantAmount: str(wantAmount) }
}

const toWire = (preview: ReturnType<typeof decomposeAssetQuote>) =>
  preview.ok
    ? {
        ok: true as const,
        fromAmount: str(preview.fromAmount),
        toAmount: str(preview.toAmount),
        midPayout: str(preview.midPayout),
        spreadFee: str(preview.spreadFee),
        flatFee: str(preview.flatFee),
        carrierCharged: str(preview.carrierCharged),
        carrierReturned: str(preview.carrierReturned),
        marginBps: preview.marginBps,
      }
    : { ok: false as const, reason: preview.reason }
