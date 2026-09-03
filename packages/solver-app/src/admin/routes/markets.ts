/**
 * CRUD for the asset markets this solver trades.
 *
 * ## Why this is a resource and the settings page is not
 *
 * `routes/settings.ts` edits a fixed list of scalars whose keys are compiled in.
 * A market is a record an operator ADDS and DROPS: the set is not knowable at
 * build time, so there is no `editableKeys()` it could ever appear in, and
 * `PATCH {key, value}` has no spelling for "delete the third one". Hence a
 * collection, keyed by the canonical § 2 market key.
 *
 * ## The same restart honesty, for the same reason
 *
 * Nothing here reaches a running solver. `createServices` reads the markets once
 * and hands the offer path the two lists it derives; `AssetOfferService.deps` is
 * `private readonly` and is never revisited, exactly as
 * `routes/settings.ts` documents for every other knob. So every mutating
 * response carries `restartRequired: true` and says so in words. A console that
 * claimed a new market was live when it was not would have an operator watching
 * for fills that cannot happen.
 *
 * ## Validated before it is stored, and again at startup
 *
 * Both, doing different jobs — see `core/assetMarketConfig.ts`. Here the
 * operator is standing in front of the console, so a refusal is a sentence they
 * can act on; at startup the same rules run against whatever is on disk, which
 * can have outlived them.
 *
 * The FEED PROBE only happens here. A write fetches the feed and resolves the
 * pointer before the row is persisted, because "the URL is well-formed" and "the
 * URL answers with a price at that pointer" are different claims and only the
 * second one is worth anything. Startup deliberately does not: making a solver's
 * boot depend on a third party's uptime would take four unrelated BTC corridors
 * down with a price API, and the runtime already fails closed there —
 * `AssetOfferService.withinTolerance` catches a fetch failure and refuses the
 * offer.
 */

import type { Hono } from 'hono'
import {
  assetMarketKey,
  validateAssetMarket,
  type AssetMarketBounds,
  type AssetMarketConfig,
} from '@arkade-os/solver-core/core/assetMarketConfig.js'
import { createPriceFeed, type FetchPrice } from '@arkade-os/solver-core/price/feed.js'
import type { AssetMarketRow } from '../db.js'
import type { AdminDeps } from '../server.js'

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Why a stored market is not yet in force. One string, so the UI renders the
 * same sentence everywhere — the shape `routes/settings.ts`'s `RESTART_NOTICE`
 * established, and for the same reason.
 */
export const MARKETS_RESTART_NOTICE =
  'Stored. It takes effect when the solver restarts: createServices reads the markets at startup and hands the ' +
  'offer path the lists it derives, and nothing re-reads them afterwards. The markets shown here are what the ' +
  'NEXT process will trade; a market added since boot is not one this process is filling against.'

/**
 * The wire shape. `null` is the BTC leg, matching the packet and the store.
 *
 * Bounds arrive as DECIMAL STRINGS, never JSON numbers: an atomic-unit bound is
 * a bigint and `JSON.parse` has already destroyed anything past 2^53 by the time
 * a handler sees it — silently, and in the direction that widens a ceiling.
 */
interface MarketBody {
  base?: unknown
  quote?: unknown
  baseDecimals?: unknown
  quoteDecimals?: unknown
  feedUrl?: unknown
  pricePath?: unknown
  toleranceBps?: unknown
  feeBps?: unknown
  sellBase?: unknown
  buyBase?: unknown
  enabled?: unknown
}

class BadRequest extends Error {}

const leg = (label: string, value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new BadRequest(`${label} must be an asset id string or null for BTC`)
  const trimmed = value.trim()
  // `"BTC"` is what the operator types and what the market key prints, but the
  // stored identity of the sats leg is null everywhere else in this codebase.
  // Normalised here rather than admitted as a second spelling, which would let
  // one pair be stored twice.
  if (trimmed === '' || trimmed.toUpperCase() === 'BTC') return null
  return trimmed
}

const int = (label: string, value: unknown): number => {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new BadRequest(`${label} must be an integer`)
  return value
}

const bounds = (label: string, value: unknown): AssetMarketBounds | null => {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') throw new BadRequest(`${label} must be an object with min and max, or null`)
  const { min, max } = value as { min?: unknown; max?: unknown }
  // BOTH OR NEITHER, the rule `evmCorridorConfig.ts` states for a token's unit
  // bounds: one alone reads as a bound and is not one. A lone maximum leaves the
  // floor at zero, which fills dust; a lone minimum leaves the ceiling open,
  // which is the bound the operator thought they were setting.
  if (typeof min !== 'string' || typeof max !== 'string') {
    throw new BadRequest(`${label}.min and ${label}.max must both be decimal strings of atomic units`)
  }
  if (!/^[0-9]+$/.test(min) || !/^[0-9]+$/.test(max)) {
    throw new BadRequest(`${label}.min and ${label}.max must be decimal integers of atomic units`)
  }
  return { min: BigInt(min), max: BigInt(max) }
}

/** The request body as a market, or a `BadRequest` naming the field that was wrong. */
const marketFrom = (body: MarketBody): AssetMarketConfig => ({
  base: leg('base', body.base),
  quote: leg('quote', body.quote),
  baseDecimals: int('baseDecimals', body.baseDecimals),
  quoteDecimals: int('quoteDecimals', body.quoteDecimals),
  feedUrl: typeof body.feedUrl === 'string' ? body.feedUrl.trim() : '',
  // Absent means "derive it from the feed URL", which `validateAssetMarket`
  // then refuses for a provider whose shape is not known. An absent pointer must
  // not become the string "undefined" and reach a feed as a JSON pointer.
  pricePath: body.pricePath === undefined || body.pricePath === null ? '' : String(body.pricePath).trim(),
  toleranceBps: int('toleranceBps', body.toleranceBps),
  feeBps: int('feeBps', body.feeBps),
  sellBase: bounds('sellBase', body.sellBase),
  buyBase: bounds('buyBase', body.buyBase),
  // Enabled unless explicitly switched off, matching the corridors: configuring
  // a market IS the opt-in.
  enabled: body.enabled === undefined ? true : body.enabled === true,
})

/**
 * Bigints do not survive `JSON.stringify`, which throws on them rather than
 * quietly narrowing — so every bound leaves as the decimal string it arrived as.
 */
const marketJson = (row: AssetMarketRow) => ({
  marketKey: row.marketKey,
  base: row.base,
  quote: row.quote,
  baseDecimals: row.baseDecimals,
  quoteDecimals: row.quoteDecimals,
  feedUrl: row.feedUrl,
  pricePath: row.pricePath,
  toleranceBps: row.toleranceBps,
  feeBps: row.feeBps,
  sellBase: row.sellBase === null ? null : { min: String(row.sellBase.min), max: String(row.sellBase.max) },
  buyBase: row.buyBase === null ? null : { min: String(row.buyBase.min), max: String(row.buyBase.max) },
  enabled: row.enabled,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

export const registerMarketRoutes = (app: Hono, deps: AdminDeps): void => {
  // Built once per registration, not per request: `createPriceFeed` validates
  // its timeout eagerly, which is the whole point of that check.
  const fetchPrice: FetchPrice = deps.fetchPrice ?? createPriceFeed()

  app.get('/api/markets', async (c) => {
    const rows = await deps.services.adminStore.listMarkets()
    return c.json({
      markets: rows.map(marketJson),
      /**
       * Which of these the RUNNING process is actually trading against — not the
       * same set as `markets`, and the difference is the point. A market added
       * or disabled since boot shows here as pending, so the console can badge
       * it rather than implying the solver is already acting on it.
       */
      active: deps.services.assetMarkets.map((market) => assetMarketKey(market.base, market.quote)),
      restartNotice: MARKETS_RESTART_NOTICE,
    })
  })

  /**
   * Add or edit one market. The key is DERIVED from the legs, so there is no id
   * in the path: submitting a pair that already exists is editing it, which is
   * the only thing it could mean.
   */
  app.put('/api/markets', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'bad_request', message: 'body must be JSON' }, 400)
    }

    let market: AssetMarketConfig
    try {
      market = marketFrom((body ?? {}) as MarketBody)
      // Structure BEFORE the network, so a nonsense spread costs no request and
      // is reported as itself rather than as a feed that would not answer.
      validateAssetMarket(market)
    } catch (error) {
      // A malformed body and a refused market are one status deliberately: from
      // where the operator sits both are "the console would not take this", and
      // the message names which field.
      return c.json({ error: 'rejected', message: messageOf(error) }, 400)
    }

    // The probe. A market whose feed cannot be read is one that refuses every
    // offer at run time, so storing it would be storing a pair this solver
    // advertises and never fills — discovered days later, by its absence.
    try {
      await fetchPrice(market.feedUrl, market.pricePath)
    } catch (error) {
      return c.json(
        {
          error: 'feed_unreadable',
          message:
            `the feed did not answer with a price at that pointer, so this market would refuse every offer: ` +
            messageOf(error),
        },
        400,
      )
    }

    const row = await deps.services.adminStore.putMarket(market)
    // Audited like an operator action, in the same log: adding a market is a
    // pricing decision with money behind it, and "who widened the spread on
    // Tuesday" is a question the audit page has to be able to answer.
    await deps.services.adminStore.recordAction({
      action: 'market-put',
      target: row.marketKey,
      params: JSON.stringify(marketJson(row)),
      outcome: 'ok',
      detail: null,
    })
    return c.json({ market: marketJson(row), restartRequired: true, restartNotice: MARKETS_RESTART_NOTICE })
  })

  app.delete('/api/markets/:key', async (c) => {
    const key = c.req.param('key')
    const removed = await deps.services.adminStore.deleteMarket(key)
    if (!removed) return c.json({ error: 'not_found', message: `no market is configured as ${key}` }, 404)
    await deps.services.adminStore.recordAction({
      action: 'market-delete',
      target: key,
      params: '{}',
      outcome: 'ok',
      detail: null,
    })
    return c.json({ deleted: key, restartRequired: true, restartNotice: MARKETS_RESTART_NOTICE })
  })
}
