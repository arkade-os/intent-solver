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
 * ## Live for this process
 *
 * PUT/DELETE persist, then `replaceMarkets()` rebuilds the in-memory serve list
 * and swaps the running corridor set. Rails, mnemonic and relay URL still need
 * a restart; market CRUD does not. @see {@link MARKETS_LIVE_NOTICE}.
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
  assetMarketFrom,
  assetMarketJson,
  assetMarketKey,
  validateAssetMarket,
  type AssetMarketBody,
  type AssetMarketConfig,
} from '@arkade-os/solver-core/core/assetMarketConfig.js'
import { createPriceFeed, type FetchPrice } from '@arkade-os/solver-core/price/feed.js'
import { createGuardedFetch } from '@arkade-os/solver-core/price/guardedFetch.js'
import { messageOf } from '@arkade-os/solver-core/util/poll.js'
import type { AssetMarketRow } from '../db.js'
import { marketCapability } from '../marketCapability.js'
import type { AdminDeps } from '../server.js'
import type { FeedCache } from '../feedCache.js'

/**
 * Why a stored market is not yet in force. One string, so the UI renders the
 * same sentence everywhere — the shape `routes/settings.ts`'s `RESTART_NOTICE`
 * established, and for the same reason.
 */
export const MARKETS_LIVE_NOTICE =
  'Live on this process: the next quote uses these values. A saved change to price, tolerance or ' +
  'bounds is also re-applied to maker offers this solver has already recorded as fillable but not ' +
  'yet filled — a tightened market refuses them rather than filling at the old terms. That is ' +
  'deliberate and no money moves, but the maker is not told why their offer went unfilled. ' +
  'RFQ swaps already quoted are unaffected: they keep the amounts stored on the swap row.'

export type MarketBody = AssetMarketBody

export const marketFrom = assetMarketFrom

export const marketJson = (row: AssetMarketRow) => ({
  marketKey: row.marketKey,
  ...assetMarketJson(row),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

export const registerMarketRoutes = (app: Hono, deps: AdminDeps, feeds?: FeedCache): void => {
  // Built once per registration, not per request: `createPriceFeed` validates
  // its timeout eagerly, which is the whole point of that check.
  const fetchPrice: FetchPrice = deps.fetchPrice ?? createPriceFeed({ fetch: createGuardedFetch() })

  app.get('/api/markets', async (c) => {
    const rows = await deps.services.adminStore.listMarkets()
    return c.json({
      // A SECOND axis beside `enabled`: a market can be enabled and served by nothing. @see marketCapability.ts
      markets: rows.map((row) => ({ ...marketJson(row), ...marketCapability(row, deps.services) })),
      /**
       * Which of these the RUNNING process is actually trading against.
       */
      active: deps.services.assetMarkets.map((market) => assetMarketKey(market.base, market.quote)),
      // Deployment-wide today, read-only for that reason. Both false is the
      // shipped default, so it pays the carrier out of margin.
      carrier: {
        sats: String(deps.services.arkade.dustSats),
        rfqPriced: deps.services.policy.assetCarrierPricing,
        offerCharged: deps.services.policy.offerChargesDeliveredCarrier,
      },
      restartNotice: MARKETS_LIVE_NOTICE,
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
      const price = await fetchPrice(market.feedUrl, market.pricePath)
      // Seeds the cache with a live read, so the preview is usable right after a save.
      feeds?.prime(market.feedUrl, market.pricePath, price)
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
    await deps.services.replaceMarkets()
    return c.json({ market: marketJson(row), restartRequired: false, restartNotice: MARKETS_LIVE_NOTICE })
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
    await deps.services.replaceMarkets()
    return c.json({ deleted: key, restartRequired: false, restartNotice: MARKETS_LIVE_NOTICE })
  })
}
