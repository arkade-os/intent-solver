/**
 * Arkade asset offers: what this solver filled, and what it declined.
 *
 * Its own surface rather than a `CorridorReader` on `routes/swaps.ts`, which
 * would have been cheaper. Offers are not a corridor — no HTLC, no deadline, no
 * refund — so that interface buys a `phase` with no states, a `findRecoverable`
 * empty by construction, and a `committedSats` of zero folded into the console's
 * exposure total. The decisive one is the refusal: a reader reads a STORE, and a
 * refused offer is not a row, so the corridor shape could not show one at all.
 */

import type { Hono } from 'hono'

import { OFFER_FILL_STATES, type OfferFillRow, type OfferFillState } from '@arkade-os/solver-corridors/db/offerFills.js'
import type { PageOptions } from '@arkade-os/solver-core/core/page.js'
import type { AdminDeps } from '../server.js'

/** Amounts leave as decimal STRINGS: `JSON.stringify` throws on a bigint. */
const offerJson = (row: OfferFillRow) => ({
  id: row.id,
  state: row.state,
  outpoint: `${row.offerTxid}:${row.offerVout}`,
  offerTxid: row.offerTxid,
  offerVout: row.offerVout,
  offerPkScript: row.offerPkScript,
  wantAssetId: row.wantAssetId,
  wantAmount: String(row.wantAmount),
  offerAssetId: row.offerAssetId,
  offerAmount: String(row.offerAmount),
  fillTxid: row.fillTxid,
  failureReason: row.failureReason,
  rfqId: row.rfqId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

export const registerOfferRoutes = (app: Hono, deps: AdminDeps): void => {
  app.get('/api/offers', async (c) => {
    const query = c.req.query()
    // 400 rather than a filter that matches nothing: an empty view must mean one thing.
    const state = query.state
    if (state !== undefined && !OFFER_FILL_STATES.includes(state as OfferFillState)) {
      return c.json({ error: 'unknown_state', state, known: OFFER_FILL_STATES }, 400)
    }
    const options: PageOptions = {
      states: state ? [state] : undefined,
      limit: query.limit === undefined ? undefined : Number(query.limit),
      cursor: query.cursor ?? null,
    }

    // A deployment serving no market has no store. An empty page with
    // `serving: false` rather than a 404, so the console can say which it is.
    const store = deps.services.offerStore
    let page: { rows: OfferFillRow[]; nextCursor: string | null } = { rows: [], nextCursor: null }
    if (store) {
      try {
        page = await store.page(options)
      } catch (error) {
        // A malformed limit or cursor is the caller's mistake, so 400 not 500.
        return c.json({ error: 'bad_request', message: error instanceof Error ? error.message : String(error) }, 400)
      }
    }

    return c.json({
      serving: store !== null,
      offers: page.rows.map(offerJson),
      nextCursor: page.nextCursor,
      // The other half, and it is NOT in the store. @see admin/offerRefusals.ts
      refusals: deps.services.offerRefusals.recent(),
    })
  })
}
