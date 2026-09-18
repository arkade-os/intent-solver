/**
 * `POST /api/pricing/apply` — one save across markets and settings.
 *
 * ORDERED, not atomic: atomicity across the two stores is unavailable under the
 * split database layout, so what is promised instead is that a save which dies
 * midway has applied restrictions and no relaxations. @see core/saveOrder.ts
 *
 * TWO writes per existing market, because `putMarket` is a whole-record upsert
 * and there is no other way to get a restriction in force before its
 * relaxations. A market with NO stored row is written in the widening pass
 * only: creating one opens quoting that did not exist.
 */

import type { Hono } from 'hono'
import {
  assetMarketKey,
  validateAssetMarket,
  type AssetMarketBounds,
  type AssetMarketConfig,
  type CarrierMode,
} from '@arkade-os/solver-core/core/assetMarketConfig.js'
import { savePassFor, type SaveField, type SavePass } from '@arkade-os/solver-core/core/saveOrder.js'
import { createPriceFeed, type FetchPrice } from '@arkade-os/solver-core/price/feed.js'
import { carrierSatsFor } from '../../ops/assetRfqMarkets.js'
import { applyOverrides, editableKnobValues, validateOverride, LIVE_KEYS } from '../settings.js'
import { marketFrom, marketJson, type MarketBody } from './markets.js'
import type { AdminDeps } from '../server.js'

interface ApplyBody {
  markets?: unknown
  overrides?: unknown
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const asScalar = (value: unknown): bigint | number | boolean | null =>
  typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean' ? value : null

/** `null` is ordering-neutral and rides the narrowing pass, the conservative default. */
const fieldForOverride = (key: string): SaveField | null => {
  if (key === 'MAX_EXPOSED_SATS') return 'maxExposedSats'
  if (key === 'ASSET_CARRIER_PRICING') return 'carrierPriced'
  if (key.endsWith('_FEE_BPS') || key.endsWith('_FEE_FLAT_SATS')) return 'feeBps'
  if (key.endsWith('_MIN_SATS')) return 'min'
  if (key.endsWith('_MAX_SATS')) return 'max'
  if (key.endsWith('_ENABLED')) return 'corridorEnabled'
  return null
}

/**
 * `null` is INHERIT, not absence, so it resolves rather than taking
 * `savePassFor`'s appearing/disappearing arms. Each side resolves against ITS
 * OWN `feeBps`, because this save may be moving `feeBps` too.
 */
const effectiveBps = (own: number | undefined, feeBps: number): number => own ?? feeBps

const keptBps = (
  stored: number | undefined,
  target: number | undefined,
  storedFee: number,
  targetFee: number,
): number | undefined =>
  savePassFor({
    field: 'feeBps',
    before: effectiveBps(stored, storedFee),
    after: effectiveBps(target, targetFee),
  }) === 'widening'
    ? stored
    : target

/** Each half on its own pass, never the pair as one decision. */
const narrowedBounds = (
  stored: AssetMarketBounds | null,
  target: AssetMarketBounds | null,
): AssetMarketBounds | null => {
  if (stored === null || target === null) {
    return savePassFor({ field: 'max', before: stored?.max ?? null, after: target?.max ?? null }) === 'widening'
      ? stored
      : target
  }
  return {
    min: savePassFor({ field: 'min', before: stored.min, after: target.min }) === 'widening' ? stored.min : target.min,
    max: savePassFor({ field: 'max', before: stored.max, after: target.max }) === 'widening' ? stored.max : target.max,
  }
}

/**
 * The stored row with ONLY its narrowing deltas moved. `symbol`, the legs, the
 * decimals and the feed ride pass 1 with `...target`: none widens what the
 * solver quotes on its own, and splitting a feed URL across two passes would
 * price pass 1 against a feed the operator is replacing.
 */
const narrowedMarket = (
  stored: AssetMarketConfig,
  target: AssetMarketConfig,
  carrierPriced: (mode: CarrierMode) => boolean,
): AssetMarketConfig => {
  const keep = <K extends keyof AssetMarketConfig>(key: K, field: SaveField): AssetMarketConfig[K] =>
    savePassFor({ field, before: asScalar(stored[key]), after: asScalar(target[key]) }) === 'widening'
      ? stored[key]
      : target[key]
  return {
    ...target,
    enabled: keep('enabled', 'enabled'),
    servesOffer: keep('servesOffer', 'servesOffer'),
    servesRfq: keep('servesRfq', 'servesRfq'),
    rfqSellBase: keep('rfqSellBase', 'rfqSellBase'),
    rfqBuyBase: keep('rfqBuyBase', 'rfqBuyBase'),
    feeBps: keep('feeBps', 'feeBps'),
    toleranceBps: keep('toleranceBps', 'toleranceBps'),
    sellBaseFeeFlat: keep('sellBaseFeeFlat', 'feeBps'),
    buyBaseFeeFlat: keep('buyBaseFeeFlat', 'feeBps'),
    sellBaseFeeBps: keptBps(stored.sellBaseFeeBps, target.sellBaseFeeBps, stored.feeBps, target.feeBps),
    buyBaseFeeBps: keptBps(stored.buyBaseFeeBps, target.buyBaseFeeBps, stored.feeBps, target.feeBps),
    carrierMode:
      savePassFor({
        field: 'carrierPriced',
        before: carrierPriced(stored.carrierMode),
        after: carrierPriced(target.carrierMode),
      }) === 'widening'
        ? stored.carrierMode
        : target.carrierMode,
    sellBase: narrowedBounds(stored.sellBase, target.sellBase),
    buyBase: narrowedBounds(stored.buyBase, target.buyBase),
  }
}

/**
 * The interim record, or the stored one when mixing the halves yields a row no
 * validator admits — a floor raised past the current ceiling intersects to
 * `min > max`, and a swapped RFQ direction closes both at once. Either would
 * throw out of `assetMarketPolicy` on every later `rebuild()`, so the narrowing
 * is deferred to pass 2 instead.
 */
const interimMarket = (
  stored: AssetMarketConfig,
  target: AssetMarketConfig,
  carrierPriced: (mode: CarrierMode) => boolean,
): AssetMarketConfig => {
  const interim = narrowedMarket(stored, target, carrierPriced)
  try {
    validateAssetMarket(interim)
    return interim
  } catch {
    return stored
  }
}

export const registerPricingApplyRoutes = (app: Hono, deps: AdminDeps): void => {
  const fetchPrice: FetchPrice = deps.fetchPrice ?? createPriceFeed()

  app.post('/api/pricing/apply', async (c) => {
    let body: ApplyBody
    try {
      body = ((await c.req.json()) ?? {}) as ApplyBody
    } catch {
      return c.json({ error: 'bad_request', message: 'body must be JSON' }, 400)
    }
    if (body.markets !== undefined && !Array.isArray(body.markets)) {
      return c.json({ error: 'bad_request', message: 'markets must be an array' }, 400)
    }
    if (body.overrides !== undefined && (typeof body.overrides !== 'object' || body.overrides === null)) {
      return c.json({ error: 'bad_request', message: 'overrides must be an object' }, 400)
    }

    const store = deps.services.adminStore
    const revision = crypto.randomUUID()
    const applied: string[] = []
    const unapplied: { key: string; reason: string }[] = []

    const requested = (body.overrides ?? {}) as Record<string, string | null>
    const storedOverrides = await store.getOverrides()
    const merged = { ...storedOverrides }
    for (const [key, value] of Object.entries(requested)) {
      if (value === null) delete merged[key]
      else merged[key] = value
    }
    const live = applyOverrides(deps.services.config, storedOverrides)
    const asked = applyOverrides(deps.services.config, merged)

    // The default in force DURING PASS 1: turning it on is narrowing and has
    // landed by then, turning it off is widening and has not. NOT `mode !== 'off'`
    // — `'inherit'` is a POINTER at ASSET_CARRIER_PRICING, and where that is false
    // `'priced' -> 'inherit'` is a relaxation the cheap spelling calls narrowing.
    const pricedByDefault = live.assetCarrierPricing || asked.assetCarrierPricing
    const carrierPriced = (mode: CarrierMode): boolean =>
      carrierSatsFor(mode, { dustSats: deps.services.arkade.dustSats, pricedByDefault }) > 0n

    const overridePass = (key: string): SavePass => {
      const field = fieldForOverride(key)
      if (field === null) return 'narrowing'
      return savePassFor({
        field,
        before: asScalar(editableKnobValues(live)[key]),
        after: asScalar(editableKnobValues(asked)[key]),
      })
    }

    const overrides: { key: string; value: string | null; pass: SavePass }[] = []
    for (const [key, value] of Object.entries(requested)) {
      if (value !== null && typeof value !== 'string') {
        unapplied.push({ key, reason: 'value must be a string or null' })
        continue
      }
      try {
        if (value !== null) validateOverride(deps.services.config, key, value)
      } catch (error) {
        unapplied.push({ key, reason: messageOf(error) })
        continue
      }
      overrides.push({ key, value, pass: overridePass(key) })
    }

    const targets: { key: string; target: AssetMarketConfig; stored: AssetMarketConfig | null }[] = []
    for (const raw of (body.markets ?? []) as MarketBody[]) {
      let target: AssetMarketConfig
      let key = 'market'
      try {
        target = marketFrom((raw ?? {}) as MarketBody)
        key = assetMarketKey(target.base, target.quote)
        validateAssetMarket(target)
      } catch (error) {
        unapplied.push({ key, reason: messageOf(error) })
        continue
      }
      // The same probe `PUT /api/markets` runs: an unreadable feed refuses every offer.
      try {
        await fetchPrice(target.feedUrl, target.pricePath)
      } catch (error) {
        unapplied.push({ key, reason: `the feed did not answer with a price at that pointer: ${messageOf(error)}` })
        continue
      }
      targets.push({ key, target, stored: await store.getMarket(key) })
    }

    const writeOverrides = async (pass: SavePass): Promise<void> => {
      let touchedLive = false
      for (const entry of overrides.filter((o) => o.pass === pass)) {
        try {
          await store.setOverrideWithAudit(entry.key, entry.value, {
            action: entry.value === null ? 'setting-clear' : 'setting-set',
            target: entry.key,
            params: entry.value === null ? '{}' : JSON.stringify({ value: entry.value }),
            outcome: 'ok',
            detail: null,
            revision,
          })
          applied.push(entry.key)
          touchedLive ||= LIVE_KEYS.has(entry.key)
        } catch (error) {
          unapplied.push({ key: entry.key, reason: messageOf(error) })
        }
      }
      if (touchedLive) {
        await deps.services.replacePolicy(applyOverrides(deps.services.config, await store.getOverrides()))
      }
    }

    const writeMarket = async (market: AssetMarketConfig): Promise<void> => {
      const row = await store.putMarket(market)
      await store.recordAction({
        action: 'market-put',
        target: row.marketKey,
        params: JSON.stringify(marketJson(row)),
        outcome: 'ok',
        detail: null,
        revision,
      })
    }

    await writeOverrides('narrowing')
    const survived: typeof targets = []
    for (const entry of targets) {
      if (entry.stored === null) {
        survived.push(entry)
        continue
      }
      try {
        await writeMarket(interimMarket(entry.stored, entry.target, carrierPriced))
        survived.push(entry)
      } catch (error) {
        // Excluded from pass 2: its relaxations must not land without its restrictions.
        unapplied.push({ key: entry.key, reason: messageOf(error) })
      }
    }
    try {
      await deps.services.replaceMarkets()
    } catch (error) {
      // Pass 1's restrictions are not in force, so pass 2 must not run.
      for (const entry of survived) unapplied.push({ key: entry.key, reason: messageOf(error) })
      return c.json({ revision, applied, unapplied })
    }

    await writeOverrides('widening')
    for (const entry of survived) {
      try {
        await writeMarket(entry.target)
        applied.push(entry.key)
      } catch (error) {
        unapplied.push({ key: entry.key, reason: messageOf(error) })
      }
    }
    await deps.services.replaceMarkets()

    return c.json({ revision, applied, unapplied })
  })
}
