/**
 * Where the stored rows and the config disagree about what is served.
 *
 * PURE. The rows win — they are what the runtime reads after the seed. This
 * exists so an operator whose config still says something else is TOLD rather
 * than silently overruled, and so a ROLLBACK to a binary that reads the config
 * again is visible before it happens rather than after.
 */
import type { AssetMarketRow, ServingSeed } from '../admin/db.js'
import { servingFor } from './assetRfqMarkets.js'

const label = (row: AssetMarketRow): string => row.symbol ?? row.marketKey

export const marketServingDivergence = (
  rows: readonly AssetMarketRow[],
  seed: ServingSeed,
  pathOf: ReadonlyMap<string, string> = new Map(),
): readonly string[] => {
  const lines: string[] = []
  const name = (knob: string): string => pathOf.get(knob) ?? knob

  for (const row of rows) {
    // A DISABLED row quoting nothing is what the operator asked for; an enabled
    // one looks live on the console and refuses everything.
    if (row.enabled && !row.servesOffer && !row.servesRfq) {
      lines.push(
        `${label(row)}: enabled and quoting nothing — neither offers nor RFQ. Turn one of them on for this ` +
          `market, or disable it so it stops showing as live.`,
      )
    }
    const wanted = servingFor(row, seed, new Set())
    if (wanted.servesOffer !== row.servesOffer) {
      lines.push(
        `${label(row)}: ${name('OFFER_MARKETS')} ${wanted.servesOffer ? 'names' : 'omits'} this pair, ` +
          `the stored row says serves_offer=${row.servesOffer ? 1 : 0}. The row is what this process reads.`,
      )
    }
    const assetId = row.base !== null && row.quote !== null ? null : (row.base ?? row.quote)
    const token = seed.tokens.find((candidate) => candidate.assetId === assetId)
    if (!token) continue
    const assetIsBase = row.base === assetId
    for (const [direction, open, configured] of [
      ['sell_base', row.rfqSellBase, wanted.rfqSellBase],
      ['buy_base', row.rfqBuyBase, wanted.rfqBuyBase],
    ] as const) {
      if (configured === open) continue
      // `sell_base` is the client giving the base: the asset when it is the base, BTC otherwise.
      const givesAsset = (direction === 'sell_base') === assetIsBase
      const knob = `ASSET_${token.symbol}_${givesAsset ? 'TO_BTC' : 'FROM_BTC'}_ENABLED`
      lines.push(
        `${label(row)}: ${name(knob)} says ${configured}, the stored row says ${direction} is ` +
          `${open ? 'open' : 'closed'}. The row is what this process reads.`,
      )
    }
  }

  const known = new Set(rows.flatMap((row) => (row.base === null || row.quote === null ? [row.base ?? row.quote] : [])))
  for (const token of seed.tokens) {
    if (!known.has(token.assetId)) {
      lines.push(
        `${name('ASSET_MARKETS')} names ${token.symbol}, which no stored market row carries; it is served by nothing.`,
      )
    }
  }
  return lines
}
