/**
 * Which `onchain:BTC->arkade:<asset>` markets a deployment serves, read from env.
 *
 * Env-parsed rather than console-managed, unlike `assetMarketConfig.ts`: that
 * path has both legs on Arkade and an operator retunes its spreads live. One leg
 * here is L1, so the set is a deployment shape — the same reason
 * `evmCorridorConfig.ts` reads its tokens from `EVM_TOKENS`.
 *
 * Unset serves nothing, and there is no default market: a default would be a
 * guess about an asset this service has never seen.
 */

import type { OnchainAssetMarket } from './onchainAssetReceive.js'
import { ASSET_ID_HEX_LENGTH } from './marketKey.js'

const TICKER = /^[A-Z][A-Z0-9]{0,15}$/
const ASSET_ID = new RegExp(`^[0-9a-f]{${ASSET_ID_HEX_LENGTH}}$`)

/** `SYMBOL:assetId:decimals`, comma separated. */
export const parseOnchainAssetPairs = (
  raw: string | undefined,
): readonly { symbol: string; assetId: string; decimals: number }[] => {
  const trimmed = raw?.trim()
  if (!trimmed) return []
  const seenSymbol = new Set<string>()
  const seenAsset = new Set<string>()
  return trimmed.split(',').map((entry) => {
    const [symbol, assetId, decimalsRaw, ...rest] = entry.trim().split(':')
    if (!symbol || !assetId || !decimalsRaw || rest.length > 0) {
      throw new Error(`ONCHAIN_ASSET_MARKETS entry must be SYMBOL:assetId:decimals, got ${JSON.stringify(entry)}`)
    }
    if (!TICKER.test(symbol)) {
      throw new Error(`ONCHAIN_ASSET_MARKETS symbol must be uppercase alphanumeric, got ${JSON.stringify(symbol)}`)
    }
    // § 2's identity rule: hex is case-insensitive and an asset id is not, so a
    // mixed-case id derives one registry key and is refused as unserved by the next.
    if (!ASSET_ID.test(assetId)) {
      throw new Error(
        `ONCHAIN_ASSET_MARKETS asset id must be ${ASSET_ID_HEX_LENGTH} lowercase hex, got ${JSON.stringify(assetId)}`,
      )
    }
    const decimals = Number(decimalsRaw)
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
      throw new Error(`ONCHAIN_ASSET_MARKETS decimals must be 0-38, got ${JSON.stringify(decimalsRaw)}`)
    }
    // A repeated symbol collides two markets' env stems; a repeated asset gives
    // one asset two policies. Neither throws when read, so both are caught here.
    if (seenSymbol.has(symbol)) throw new Error(`ONCHAIN_ASSET_MARKETS names ${symbol} twice`)
    if (seenAsset.has(assetId)) throw new Error(`ONCHAIN_ASSET_MARKETS names asset ${assetId} twice`)
    seenSymbol.add(symbol)
    seenAsset.add(assetId)
    return { symbol, assetId, decimals }
  })
}

export const onchainAssetEnvStem = (symbol: string): string => `ONCHAIN_ASSET_${symbol.toUpperCase()}`

const units = (name: string, read: (name: string) => string | undefined): bigint | undefined => {
  const value = read(name)?.trim()
  if (!value) return undefined
  if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be a decimal integer of atomic units, got ${value}`)
  return BigInt(value)
}

export const onchainAssetMarkets = (
  pairs: readonly { symbol: string; assetId: string; decimals: number }[],
  read: (name: string) => string | undefined,
): readonly OnchainAssetMarket[] =>
  pairs.map(({ symbol, assetId, decimals }) => {
    const stem = onchainAssetEnvStem(symbol)

    const feedUrl = read(`${stem}_PRICE_FEED`)?.trim()
    if (!feedUrl) throw new Error(`${stem}_PRICE_FEED is required: this market's rate is declared, never assumed`)
    let parsed: URL
    try {
      parsed = new URL(feedUrl)
    } catch {
      throw new Error(`${stem}_PRICE_FEED must be an absolute URL, got ${JSON.stringify(feedUrl)}`)
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`${stem}_PRICE_FEED must be http or https, got ${JSON.stringify(parsed.protocol)}`)
    }

    const minPayout = units(`${stem}_MIN_PAYOUT`, read)
    const maxPayout = units(`${stem}_MAX_PAYOUT`, read)
    // Both or neither, for `evmCorridorConfig.ts`'s reason: a lone maximum leaves
    // the floor at zero and quotes dust; a lone minimum leaves the ceiling open,
    // which is the bound the operator thought they were setting.
    if ((minPayout === undefined) !== (maxPayout === undefined)) {
      throw new Error(`${stem}_MIN_PAYOUT and ${stem}_MAX_PAYOUT must be set together or not at all`)
    }
    if (minPayout === undefined || maxPayout === undefined) {
      throw new Error(
        `${stem}_MIN_PAYOUT and ${stem}_MAX_PAYOUT are required: the sats limits bound the give, and only these ` +
          `bound what the solver pays out once the rate has moved`,
      )
    }
    if (minPayout > maxPayout) throw new Error(`${stem}_MIN_PAYOUT may not exceed ${stem}_MAX_PAYOUT`)
    if (maxPayout === 0n) throw new Error(`${stem}_MAX_PAYOUT must be above zero`)

    const feeRaw = read(`${stem}_FEE_BPS`)?.trim()
    const feeBps = feeRaw === undefined || feeRaw === '' ? 0 : Number(feeRaw)
    if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= 10_000) {
      throw new Error(`${stem}_FEE_BPS must be a whole number of basis points below 10000, got ${feeRaw}`)
    }

    return {
      symbol,
      assetId,
      decimals,
      feedUrl,
      pricePath: read(`${stem}_PRICE_PATH`)?.trim() ?? '',
      feeBps,
      minPayout,
      maxPayout,
    }
  })
