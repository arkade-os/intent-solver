/**
 * What this process LOADED versus what the store now HOLDS.
 *
 * Settings and markets are startup-only by settled decision — `createServices`
 * resolves both once and hands the result to every service, and nothing re-reads
 * them (`routes/settings.ts` derives that in full). Until now the only thing
 * closing the gap was a paragraph of prose on two tabs, so an operator could edit
 * a market, see it listed as trading, and be filling against something else.
 *
 * Nothing here is a live-reload seam and nothing here writes. It is a diff
 * between two snapshots the process already keeps:
 *
 * - `Services.policy` — the Config `applyOverrides` produced AT BOOT, which every
 *   service was constructed from.
 * - `Services.assetMarkets` — the market rows resolved at boot, in the pricing
 *   shape the offer path consumes.
 *
 * Both are compared against what `AdminStore` answers NOW. A difference names the
 * knob or the pair, never a generic "something changed": the operator has to know
 * whether a restart is worth interrupting live swaps for, and a banner that
 * cannot say what moved is one they learn to dismiss.
 */

import type { Config } from '../config.js'
import { editableKnobValues } from './settings.js'
import {
  assetMarketKey,
  type AssetMarketBounds,
  type AssetMarketConfig,
  type AssetMarketPricingView,
} from '@arkade-os/solver-core/core/assetMarketConfig.js'
import type { AssetMarketRow } from './db.js'

export interface KnobDrift {
  key: string
  /** What this process is quoting on. */
  loaded: string
  /** What the store holds — what the NEXT process will quote on. */
  stored: string
}

export interface MarketDrift {
  key: string
  change: 'added' | 'removed' | 'changed'
}

export const DRIFT_NOTICE =
  'Stored configuration differs from what this process loaded. createServices resolves overrides and markets at ' +
  'startup and nothing re-reads them, so the items below are what the NEXT process will use and not what this one ' +
  'is quoting or filling against. Restarting is what applies them.'

/**
 * Which editable knobs differ, by value.
 *
 * Both sides read `editableKnobValues`, which is the same mapping the settings
 * page renders — deriving the key-to-value pairs a second time here is how this
 * would silently stop covering a knob added to that list. Read-only knobs are
 * outside it by construction: they come from the environment on both sides and
 * cannot move without a restart having happened already.
 *
 * Takes two Configs rather than a Config and a bag of overrides, so the caller
 * hands over the BOOT snapshot explicitly and this cannot accidentally re-derive
 * the thing it is supposed to be comparing against.
 */
export const settingsDrift = (loaded: Config, stored: Config): KnobDrift[] => {
  const was = editableKnobValues(loaded)
  return Object.entries(editableKnobValues(stored)).flatMap(([key, now]) =>
    was[key] === now ? [] : [{ key, loaded: String(was[key]), stored: String(now) }],
  )
}

const bound = (bounds: AssetMarketBounds | null | undefined): [string, string] | null =>
  bounds ? [String(bounds.min), String(bounds.max)] : null

/** Every field the offer path actually prices from, in a comparable form. */
const fingerprint = (market: AssetMarketPricingView | AssetMarketConfig): string =>
  JSON.stringify([
    market.baseDecimals,
    market.quoteDecimals,
    market.feedUrl,
    market.pricePath,
    market.toleranceBps,
    market.feeBps,
    bound(market.sellBase),
    bound(market.buyBase),
  ])

/**
 * Which markets were added, dropped or re-priced since boot.
 *
 * Takes the stored ROWS rather than `assetMarketPolicy(rows).pricing`, which
 * throws on a row that has gone bad. This runs on the overview — the first page
 * an operator loads, and the one that must render when something is wrong — so it
 * may not have a failure mode of its own, and the row's own `marketKey` is read
 * rather than re-derived for the same reason.
 *
 * Disabled rows are dropped here exactly as `assetMarketPolicy` drops them: a
 * paused market is not one the next process will trade either, so it reads as
 * `removed` rather than `changed`.
 */
export const marketDrift = (
  loaded: readonly AssetMarketPricingView[],
  stored: readonly AssetMarketRow[],
): MarketDrift[] => {
  const before = new Map(loaded.map((market) => [assetMarketKey(market.base, market.quote), fingerprint(market)]))
  const after = new Map(stored.filter((market) => market.enabled).map((market) => [market.marketKey, market]))

  const drift: MarketDrift[] = []
  for (const [key, market] of after) {
    const was = before.get(key)
    if (was === undefined) drift.push({ key, change: 'added' })
    else if (was !== fingerprint(market)) drift.push({ key, change: 'changed' })
  }
  for (const key of before.keys()) if (!after.has(key)) drift.push({ key, change: 'removed' })
  return drift
}
