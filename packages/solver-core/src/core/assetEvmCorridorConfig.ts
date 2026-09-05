/**
 * Which `arkade:<asset>->ethereum:<token>` markets this deployment serves.
 *
 * THE OPERATOR DECLARES THE PAIR. Nothing here composes an asset->BTC feed with
 * a BTC->token one: that would invent a market nobody configured, and the
 * middle-hop rounding would belong to neither market's operator. A pair with no
 * declaration is not served, and the refusal (`unsupported_pair`) is the
 * correct answer rather than a gap. See arkade-os/intent-solver#22, whose
 * recommendation against composing the rate stands even though its
 * recommendation against the corridor was overridden.
 *
 * THE ENVIRONMENT, matching `evmCorridorConfig.ts` rather than the console CRUD
 * of `assetMarketConfig.ts`. Half of this pair is an ERC20 whose chain, contract
 * and token list already live in env; splitting one market's terms across env
 * and database would make "is this pair served" a two-source question.
 *
 * BOUNDS ARE REQUIRED HERE, unlike every other corridor's. The others narrow a
 * house-wide `maxExposedSats`; this one has no sats on either leg, so it
 * contributes nothing to that cap and inherits no ceiling from it. These bounds
 * are the ONLY bound on a swap's size, which is why an undeclared one is a
 * startup error rather than "unbounded".
 */

import { assetEvmCorridorFor, type AssetEvmCorridor, type Fee } from './corridorPolicy.js'
import { ASSET_ID_HEX_LENGTH } from './marketKey.js'
import { defaultPricePath, validatePricePath } from './priceFeed.js'
import type { EvmToken } from './evmCorridorConfig.js'

/** The same ceiling `convertAmount` enforces — @see EvmToken.decimals. */
const MAX_DECIMALS = 36

const ASSET_ID = new RegExp(`^[0-9a-f]{${ASSET_ID_HEX_LENGTH}}$`)

/** Uppercase label and env-stem fragment, as `EVM_TOKENS` spells a token's. */
const TICKER = /^[A-Z][A-Z0-9]{0,11}$/

/** The Arkade asset leg of a market: what it is, and how precise. */
export interface ArkadeAssetLeg {
  /** Uppercase label, and the env stem fragment. Never the identity. */
  ticker: string
  /** The 68-hex serialized Asset ID — the identity, and what reaches the wire. */
  assetId: string
  /**
   * The asset's own precision.
   *
   * Required with no default, for `EvmToken.decimals`' reason: a price is quoted
   * in WHOLE units and a lockup carries atomic ones, so a wrong exponent
   * misprices every swap by a power of ten while quoting and settling normally.
   */
  decimals: number
}

/** Bounds in a leg's own atomic units. */
export interface AtomicBounds {
  minUnits: bigint
  maxUnits: bigint
}

export interface AssetEvmCorridorPolicy {
  corridor: AssetEvmCorridor
  asset: ArkadeAssetLeg
  token: EvmToken
  /**
   * What the CLIENT locks, in the asset's atomic units. REQUIRED — @see the
   * module comment on why there is no house bound to fall back to.
   */
  assetLimits: AtomicBounds
  /**
   * What the SOLVER pays out, in the token's atomic units. Optional, and the
   * second gate `EvmCorridorPolicy.tokenLimits` is: the asset bound is stated in
   * the give leg and says nothing about how much of the token a swap moves once
   * the rate has run away.
   */
  tokenLimits?: AtomicBounds
  /** Where the pair's price comes from, fetched per quote. */
  priceFeed: string
  /** RFC 6901 pointer into the response. Empty means derive it. */
  pricePath: string
  fee: Fee
  enabled: boolean
}

/** `TICKER:assetId:decimals:TOKENSYMBOL`, comma separated. Unset means no such corridor. */
export const parseAssetEvmMarkets = (
  raw: string | undefined,
  tokens: readonly EvmToken[],
): readonly { asset: ArkadeAssetLeg; token: EvmToken }[] => {
  const trimmed = raw?.trim()
  if (!trimmed) return []
  const seenTicker = new Set<string>()
  const seenPair = new Set<string>()
  return trimmed.split(',').map((entry) => {
    const [ticker, assetId, decimalsRaw, symbol, ...rest] = entry.trim().split(':')
    if (!ticker || !assetId || !decimalsRaw || !symbol || rest.length > 0) {
      throw new Error(
        `ASSET_EVM_MARKETS entry must be TICKER:assetId:decimals:TOKENSYMBOL, got ${JSON.stringify(entry)}`,
      )
    }
    if (!TICKER.test(ticker)) {
      throw new Error(
        `ASSET_EVM_MARKETS ticker must be 1-12 uppercase alphanumerics starting with a letter, got ${ticker}`,
      )
    }
    if (!ASSET_ID.test(assetId)) {
      throw new Error(
        `ASSET_EVM_MARKETS asset id must be ${ASSET_ID_HEX_LENGTH} lowercase hex characters, ` +
          `got ${JSON.stringify(assetId)}`,
      )
    }
    const decimals = Number(decimalsRaw)
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
      throw new Error(`ASSET_EVM_MARKETS decimals must be an integer in 0..${MAX_DECIMALS}, got ${decimalsRaw}`)
    }
    // Resolved out of `EVM_TOKENS` rather than respelled here, so a token's
    // address and decimals have ONE definition. A market naming a token the
    // deployment does not serve is a typo an operator should hear about at
    // startup, not a corridor that quotes against an address nothing can lock.
    const token = tokens.find((candidate) => candidate.symbol === symbol)
    if (!token) {
      throw new Error(`ASSET_EVM_MARKETS names token ${symbol}, which is not in EVM_TOKENS`)
    }
    // A repeated TICKER collides the env stems, so two markets would read one
    // another's bounds and feed. A repeated PAIR gives one corridor two sets of
    // terms and the last would silently win — `evmCorridorConfig.ts` names the
    // same hazard for a token's market.
    if (seenTicker.has(ticker)) throw new Error(`ASSET_EVM_MARKETS lists ticker ${ticker} twice`)
    const pair = assetEvmCorridorFor(assetId, token.address)
    if (seenPair.has(pair)) throw new Error(`ASSET_EVM_MARKETS lists the pair ${pair} twice`)
    seenTicker.add(ticker)
    seenPair.add(pair)
    return { asset: { ticker, assetId, decimals }, token }
  })
}

/** The env stem for one market, e.g. `ASSET_EVM_USDA_USDC`. */
export const assetEvmEnvStem = (asset: ArkadeAssetLeg, token: EvmToken): string =>
  `ASSET_EVM_${asset.ticker}_${token.symbol}`

const atomicBounds = (
  stem: string,
  prefix: string,
  read: (name: string) => string | undefined,
): AtomicBounds | undefined => {
  const units = (suffix: string): bigint | undefined => {
    const name = `${stem}_${prefix}${suffix}`
    const value = read(name)?.trim()
    if (!value) return undefined
    if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be a decimal integer of atomic units, got ${value}`)
    return BigInt(value)
  }
  const minUnits = units('MIN_UNITS')
  const maxUnits = units('MAX_UNITS')
  // BOTH OR NEITHER, for `evmCorridorConfig.ts`'s reason: a lone maximum leaves
  // the floor at zero, which quotes dust, and a lone minimum leaves the ceiling
  // open, which is the bound the operator thought they were setting.
  if ((minUnits === undefined) !== (maxUnits === undefined)) {
    throw new Error(`${stem}_${prefix}MIN_UNITS and ${stem}_${prefix}MAX_UNITS must be set together or not at all`)
  }
  if (minUnits === undefined || maxUnits === undefined) return undefined
  if (minUnits > maxUnits) throw new Error(`${stem}_${prefix}MIN_UNITS may not exceed ${stem}_${prefix}MAX_UNITS`)
  // Zero admits a payout of nothing, which is a fill that moves the client's
  // asset and returns no token.
  if (maxUnits === 0n) throw new Error(`${stem}_${prefix}MAX_UNITS must be above zero`)
  return { minUnits, maxUnits }
}

/** Every asset-EVM corridor this deployment serves, with its terms. */
export const assetEvmCorridorPolicies = (
  markets: readonly { asset: ArkadeAssetLeg; token: EvmToken }[],
  read: (name: string) => string | undefined,
): readonly AssetEvmCorridorPolicy[] =>
  markets.map(({ asset, token }) => {
    const stem = assetEvmEnvStem(asset, token)
    const assetLimits = atomicBounds(stem, '', read)
    // The one bound with no fallback. Refused at startup, where an operator can
    // still fix it, rather than at quote time on a corridor already advertised.
    if (assetLimits === undefined) {
      throw new Error(
        `${stem}_MIN_UNITS and ${stem}_MAX_UNITS are required: this corridor has no sats on either leg, so it ` +
          `contributes nothing to MAX_EXPOSED_SATS and these are the only bound on a swap's size`,
      )
    }
    const tokenLimits = atomicBounds(stem, 'TOKEN_', read)

    const priceFeed = read(`${stem}_PRICE_FEED`)?.trim()
    if (!priceFeed) {
      throw new Error(
        `${stem}_PRICE_FEED is required: this pair's rate is declared, never composed from an asset/BTC and a ` +
          `BTC/token feed`,
      )
    }
    let parsed: URL
    try {
      parsed = new URL(priceFeed)
    } catch {
      throw new Error(`${stem}_PRICE_FEED must be an absolute URL, got ${JSON.stringify(priceFeed)}`)
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`${stem}_PRICE_FEED must be http or https, got ${JSON.stringify(parsed.protocol)}`)
    }
    const pricePath = read(`${stem}_PRICE_PATH`)?.trim() ?? ''
    validatePricePath(pricePath)
    if (pricePath === '' && defaultPricePath(priceFeed) === null) {
      throw new Error(`${stem}_PRICE_PATH is required: it cannot be derived from ${JSON.stringify(priceFeed)}`)
    }

    const component = (suffix: string, max: number): number => {
      const name = `${stem}_${suffix}`
      const value = read(name)?.trim()
      if (!value) return 0
      const parsedValue = Number(value)
      if (!Number.isInteger(parsedValue) || parsedValue < 0 || parsedValue > max) {
        throw new Error(`${name} must be an integer between 0 and ${max}, got ${value}`)
      }
      return parsedValue
    }

    return {
      corridor: assetEvmCorridorFor(asset.assetId, token.address),
      asset,
      token,
      assetLimits,
      ...(tokenLimits === undefined ? {} : { tokenLimits }),
      priceFeed,
      pricePath,
      // `flatSats` is structurally meaningless here — there is no sats leg to
      // charge it against — so this corridor's fee is proportional only.
      fee: { bps: component('FEE_BPS', 10_000), flatSats: 0 },
      enabled: (read(`${stem}_ENABLED`)?.trim() ?? 'true') !== 'false',
    }
  })
