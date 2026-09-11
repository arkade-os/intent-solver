// Each stored change the restart banner names, with what it moves from and to.
// `pendingRestartKeys` diffs the override MAP and a market is a row, so one
// added in the console got silence. A diff against boot snapshots, not a seam.

import type { Config } from '../config.js'
import { editableKnobValues } from './settings.js'
import {
  assetMarketKey,
  type AssetMarketBounds,
  type AssetMarketConfig,
  type AssetMarketPricingView,
} from '@arkade-os/solver-core/core/assetMarketConfig.js'
import type { AssetMarketRow } from './db.js'

export interface RestartItem {
  key: string
  /** What this process runs on; `stored` is the next one. */
  loaded: string
  stored: string
}

const TRADING = 'trading'
const ABSENT = 'not trading'
const BOOTED = 'as booted'
const EDITED = 'edited'

/** That key set, not a second derivation. A key whose value did not move drops. */
export const settingsDrift = (loaded: Config, stored: Config, keys: readonly string[]): RestartItem[] => {
  const was = editableKnobValues(loaded)
  const now = editableKnobValues(stored)
  return keys.flatMap((key) =>
    was[key] === now[key] ? [] : [{ key, loaded: String(was[key]), stored: String(now[key]) }],
  )
}

const bound = (bounds: AssetMarketBounds | null | undefined): [string, string] | null =>
  bounds ? [String(bounds.min), String(bounds.max)] : null

/** Every field the offer path prices from, in a comparable form. */
const fingerprint = (market: AssetMarketPricingView | AssetMarketConfig): string =>
  JSON.stringify([
    market.baseDecimals,
    market.quoteDecimals,
    market.feedUrl,
    market.pricePath,
    market.toleranceBps,
    market.feeBps,
    String(market.sellBaseFeeFlat ?? 0n),
    String(market.buyBaseFeeFlat ?? 0n),
    bound(market.sellBase),
    bound(market.buyBase),
  ])

// Markets added, dropped or re-priced since boot. The stored ROWS and each
// row's own `marketKey`, not `assetMarketPolicy(rows).pricing` — that throws on
// a bad row, and this runs on a page that must render when something is wrong.
export const marketDrift = (
  loaded: readonly AssetMarketPricingView[],
  stored: readonly AssetMarketRow[],
): RestartItem[] => {
  const before = new Map(loaded.map((market) => [assetMarketKey(market.base, market.quote), fingerprint(market)]))
  const after = new Map(stored.filter((market) => market.enabled).map((market) => [market.marketKey, market]))

  const items: RestartItem[] = []
  for (const [key, market] of after) {
    const was = before.get(key)
    if (was === undefined) items.push({ key: `market ${key}`, loaded: ABSENT, stored: TRADING })
    else if (was !== fingerprint(market)) items.push({ key: `market ${key}`, loaded: BOOTED, stored: EDITED })
  }
  for (const key of before.keys()) {
    if (!after.has(key)) items.push({ key: `market ${key}`, loaded: TRADING, stored: ABSENT })
  }
  return items
}
