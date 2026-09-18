/**
 * Where the stored rows and the environment disagree about what is served.
 *
 * PURE. The rows win — they are what the runtime reads after the seed. This
 * exists so an operator whose `.env` still says something else is TOLD rather
 * than silently overruled, and so a ROLLBACK to a binary that reads the env
 * again is visible before it happens rather than after.
 */
import { assetRfqEnvStem } from '@arkade-os/solver-corridors/corridors/assetRfq.js'
import type { AssetMarketRow, ServingSeed } from '../admin/db.js'

const label = (row: AssetMarketRow): string => row.symbol ?? row.marketKey

export const marketServingDivergence = (rows: readonly AssetMarketRow[], env: ServingSeed): readonly string[] => {
  const lines: string[] = []
  const declaredForOffers = (row: AssetMarketRow): boolean =>
    env.offerMarkets.some(
      (pair) => (pair.a === row.base && pair.b === row.quote) || (pair.a === row.quote && pair.b === row.base),
    )
  const byAsset = new Map(env.tokens.map((token) => [token.assetId, token]))

  for (const row of rows) {
    // A DISABLED row quoting nothing is what the operator asked for; an enabled
    // one looks live on the console and refuses everything.
    if (row.enabled && !row.servesOffer && !row.servesRfq) {
      lines.push(
        `${label(row)}: enabled and quoting nothing — neither offers nor RFQ. Turn one of them on for this ` +
          `market, or disable it so it stops showing as live.`,
      )
    }
    if (declaredForOffers(row) !== row.servesOffer) {
      lines.push(
        `${label(row)}: OFFER_MARKETS ${declaredForOffers(row) ? 'names' : 'omits'} this pair, ` +
          `the stored row says serves_offer=${row.servesOffer ? 1 : 0}. The row is what this process reads.`,
      )
    }
    const assetId = row.base !== null && row.quote !== null ? null : (row.base ?? row.quote)
    const token = assetId === null ? undefined : byAsset.get(assetId)
    if (!token) continue
    for (const [direction, open] of [
      ['sell_base', row.rfqSellBase],
      ['buy_base', row.rfqBuyBase],
    ] as const) {
      if (token.enabled[direction] === open) continue
      lines.push(
        `${label(row)}: ${assetRfqEnvStem(token, direction)}_ENABLED says ` +
          `${token.enabled[direction]}, the stored row says ${direction} is ${open ? 'open' : 'closed'}. ` +
          `The row is what this process reads.`,
      )
    }
  }

  const known = new Set(rows.flatMap((row) => (row.base === null || row.quote === null ? [row.base ?? row.quote] : [])))
  for (const token of env.tokens) {
    if (!known.has(token.assetId)) {
      lines.push(`ASSET_MARKETS names ${token.symbol}, which no stored market row carries; it is served by nothing.`)
    }
  }
  return lines
}
