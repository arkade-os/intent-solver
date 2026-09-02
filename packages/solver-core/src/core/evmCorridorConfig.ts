/**
 * Which ERC20s this deployment serves, and on what terms.
 *
 * The four BTC corridors are known at compile time, so their knobs hang off a
 * fixed stem (`LN_SEND_MAX_SATS`). An EVM corridor names its token, and the set
 * of tokens is a deployment's choice — so the stems have to be derived, and the
 * token list is itself configuration.
 *
 * A SYMBOL as well as an address, because the address alone cannot be a stem:
 * `EVM_SEND_0XA0B8…_MAX_SATS` is legal shell but unreadable, and an operator
 * editing it cannot see which token they are widening. The symbol is the label;
 * the address is the identity, and it is the address that reaches the wire.
 *
 * LIMITS ARE STILL SATS. Both EVM corridors have `arkade:BTC` on one side, so
 * `minSats`/`maxSats` bound the Bitcoin leg exactly as they do for Lightning and
 * onchain — which is why one policy per corridor is coherent even though the
 * other leg's units differ per token.
 */

import { evmCorridorFor, type EvmCorridor } from './corridorPolicy.js'
import type { Fee } from './corridorPolicy.js'
import type { Limits } from './limits.js'
import { defaultPricePath, validatePricePath } from './priceFeed.js'

export interface EvmToken {
  /** Uppercase label, and the env stem fragment. */
  symbol: string
  /** Lowercase 0x address — the identity, and what reaches the wire. */
  address: string
  /**
   * The token's own declared precision, as `decimals()` reports it on chain.
   *
   * REQUIRED, with no default, and it is the one field here where a wrong value
   * is silent rather than loud. A price is quoted in WHOLE units and an ERC20
   * amount is carried in atomic ones, so this exponent is the whole of the
   * relationship between them. Defaulting it to 18 — the common case — would
   * misprice USDC, which uses 6, by a factor of a million million: every swap
   * would quote and settle, and each one would move the wrong amount of money.
   *
   * Not read from the chain either, deliberately. `decimals()` is optional in
   * ERC20 and a token may answer anything; making it configuration means an
   * operator states what they believe and a mismatch is a deployment error
   * rather than something the corridor discovers mid-swap.
   */
  decimals: number
}

export interface EvmCorridorPolicy {
  corridor: EvmCorridor
  token: EvmToken
  direction: 'send' | 'receive'
  /** The BTC side, in sats. Inherits the house bound and may only narrow it. */
  limits: Limits
  /**
   * The TOKEN side, in the token's own atomic units. Absent means unbounded.
   *
   * A second gate, not a replacement for {@link EvmCorridorPolicy.limits}. The
   * sats bound already constrains the swap and the token amount is derived from
   * it through the price, so this is redundant while the price is what the
   * operator expects — and it stops being redundant exactly when the price is
   * not. A bound in sats says nothing about how much of the token a swap moves
   * once the rate has run away, which is the case where an inventory limit
   * matters.
   *
   * The Go solver carries the same pair (`min_quote_amount`/`max_quote_amount`
   * beside `min_base_amount`/`max_base_amount`). It has no house sats bound to
   * inherit, so there they are required; here they are the extra.
   */
  tokenLimits?: { minUnits: bigint; maxUnits: bigint }
  fee: Fee
  enabled: boolean
}

/** `SYMBOL:0xaddress:decimals`, comma separated. Empty or unset means no EVM corridors. */
const SYMBOL = /^[A-Z][A-Z0-9]{0,11}$/

/**
 * The widest precision a token may declare.
 *
 * The same bound `convertAmount` enforces, and it must stay the same: a token
 * past it would be refused there instead, mid-quote, after the corridor had
 * already advertised the pair.
 */
const MAX_DECIMALS = 36

export const parseEvmTokens = (raw: string | undefined): readonly EvmToken[] => {
  const trimmed = raw?.trim()
  if (!trimmed) return []
  const seenSymbol = new Set<string>()
  const seenAddress = new Set<string>()
  return trimmed.split(',').map((entry) => {
    const [symbol, address, decimalsRaw, ...rest] = entry.trim().split(':')
    if (!symbol || !address || !decimalsRaw || rest.length > 0) {
      throw new Error(`EVM_TOKENS entry must be SYMBOL:0xaddress:decimals, got ${JSON.stringify(entry)}`)
    }
    const decimals = Number(decimalsRaw)
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
      throw new Error(
        `EVM_TOKENS decimals must be an integer in 0..${MAX_DECIMALS}, got ${JSON.stringify(decimalsRaw)}`,
      )
    }
    if (!SYMBOL.test(symbol)) {
      throw new Error(`EVM_TOKENS symbol must be 1-12 uppercase alphanumerics starting with a letter, got ${symbol}`)
    }
    // Built through `evmCorridorFor` so the address rule lives in ONE place —
    // this cannot drift from what the corridor string will accept.
    evmCorridorFor(address, 'send')
    // Both must be unique, and for different reasons. A repeated ADDRESS would
    // give one token two sets of knobs and the last would silently win. A
    // repeated SYMBOL would collide the env stems, so two tokens would read the
    // same `EVM_SEND_<SYMBOL>_MAX_SATS` and an operator widening one would
    // widen the other without being told.
    if (seenSymbol.has(symbol)) throw new Error(`EVM_TOKENS lists symbol ${symbol} twice`)
    if (seenAddress.has(address)) throw new Error(`EVM_TOKENS lists address ${address} twice`)
    seenSymbol.add(symbol)
    seenAddress.add(address)
    return { symbol, address, decimals }
  })
}

/** The env stem for one token's direction, e.g. `EVM_SEND_USDC`. */
export const evmEnvStem = (token: EvmToken, direction: 'send' | 'receive'): string =>
  `EVM_${direction === 'send' ? 'SEND' : 'RECEIVE'}_${token.symbol}`

/**
 * Every EVM corridor this deployment serves, with its terms.
 *
 * Both directions per token, because a deployment that serves a token at all
 * serves it both ways unless a knob says otherwise — the same default the four
 * BTC corridors take.
 *
 * `narrow` is not applied here the way `corridorLimitsFromEnv` applies it: that
 * function inherits from a base and refuses to WIDEN it, and the same rule holds
 * for these, so the caller passes the already-narrowed base in.
 */
export const evmCorridorPolicies = (
  tokens: readonly EvmToken[],
  base: Limits,
  read: (name: string) => string | undefined,
): readonly EvmCorridorPolicy[] =>
  tokens.flatMap((token) =>
    (['send', 'receive'] as const).map((direction) => {
      const stem = evmEnvStem(token, direction)
      const bound = (suffix: string): number | undefined => {
        const raw = read(stem + '_' + suffix)?.trim()
        if (!raw) return undefined
        const value = Number(raw)
        if (!Number.isInteger(value) || value <= 0) {
          throw new Error(stem + '_' + suffix + ' must be a positive integer, got ' + raw)
        }
        return value
      }
      const component = (suffix: string, max: number): number => {
        const name = stem + '_' + suffix
        const raw = read(name)?.trim()
        if (!raw) return 0
        const value = Number(raw)
        if (!Number.isInteger(value) || value < 0 || value > max) {
          throw new Error(name + ' must be an integer between 0 and ' + max + ', got ' + raw)
        }
        return value
      }
      const minSats = bound('MIN_SATS')
      const maxSats = bound('MAX_SATS')
      // NARROWER ONLY, never wider. A corridor knob that could raise the house
      // limit would let one token's config quietly widen the blast radius the
      // deployment-wide bound exists to set.
      if (minSats !== undefined && minSats < base.minSats) {
        throw new Error(stem + '_MIN_SATS may not be below the deployment minimum ' + base.minSats)
      }
      if (maxSats !== undefined && maxSats > base.maxSats) {
        throw new Error(stem + '_MAX_SATS may not exceed the deployment maximum ' + base.maxSats)
      }
      // Atomic units, so a bigint: an 18-decimal token's bound does not fit a
      // double, and `Number` would silently round the operator's ceiling.
      const units = (suffix: string): bigint | undefined => {
        const name = stem + '_' + suffix
        const raw = read(name)?.trim()
        if (!raw) return undefined
        if (!/^[0-9]+$/.test(raw)) throw new Error(name + ' must be a decimal integer of atomic units, got ' + raw)
        return BigInt(raw)
      }
      const minUnits = units('MIN_UNITS')
      const maxUnits = units('MAX_UNITS')
      // BOTH OR NEITHER. One alone reads as a bound and is not one: a lone
      // maximum would leave the floor at zero, which quotes dust; a lone minimum
      // would leave the ceiling open, which is the bound an operator thought
      // they were setting.
      if ((minUnits === undefined) !== (maxUnits === undefined)) {
        throw new Error(stem + '_MIN_UNITS and ' + stem + '_MAX_UNITS must be set together or not at all')
      }
      if (minUnits !== undefined && maxUnits !== undefined && minUnits > maxUnits) {
        throw new Error(stem + '_MIN_UNITS may not exceed ' + stem + '_MAX_UNITS')
      }

      return {
        corridor: evmCorridorFor(token.address, direction),
        token,
        direction,
        limits: { minSats: minSats ?? base.minSats, maxSats: maxSats ?? base.maxSats },
        ...(minUnits !== undefined && maxUnits !== undefined ? { tokenLimits: { minUnits, maxUnits } } : {}),
        fee: { bps: component('FEE_BPS', 10_000), flatSats: component('FEE_FLAT_SATS', 1_000_000) },
        // Enabled unless explicitly switched off, matching the four BTC
        // corridors: listing a token IS the opt-in.
        enabled: (read(stem + '_ENABLED')?.trim() ?? 'true') !== 'false',
      }
    }),
  )

/**
 * The market behind one token: where its price comes from, and where in the
 * response it sits.
 *
 * PER TOKEN, NOT PER DIRECTION, unlike every other knob in this module. A market
 * is the PAIR - BTC against the token - and the feed quotes it one way
 * regardless of which direction a given swap runs. The Go solver models it the
 * same way: `solver-init` registers ONE market per pair and enables both
 * directions with their own bounds. Two feeds for one pair would let the send
 * and receive legs disagree about the price, which is an arbitrage against the
 * solver by whoever noticed first.
 */
export interface EvmMarket {
  token: EvmToken
  /** The feed URL, fetched at quote time. */
  priceFeed: string
  /**
   * RFC 6901 pointer to the price in the response.
   *
   * May be empty ONLY when it is derivable from the feed URL - see below. Stored
   * as given rather than pre-derived, so the value an operator set is the value
   * that shows in a diagnostic.
   */
  pricePath: string
}

/** The env stem for one token's market, e.g. `EVM_USDC`. No direction: see {@link EvmMarket}. */
export const evmMarketStem = (token: EvmToken): string => `EVM_${token.symbol}`

/**
 * Every served token's market, or a startup failure.
 *
 * REQUIRED for each token, because a token with no feed cannot be priced and a
 * corridor that cannot price is one that advertises a pair and then refuses
 * every request against it.
 *
 * THE POINTER IS RESOLVED AT STARTUP, not at the first quote, and that is a
 * deliberate improvement on the Go implementation. There, an empty `price_path`
 * against a feed whose shape is not known fails inside `Fetch` - so the market
 * registers, the pair is advertised, and the failure arrives on a client's
 * request. Checking it here means a deployment either serves the pair or does
 * not start.
 */
export const evmMarkets = (
  tokens: readonly EvmToken[],
  read: (name: string) => string | undefined,
): readonly EvmMarket[] =>
  tokens.map((token) => {
    const stem = evmMarketStem(token)
    const priceFeed = read(stem + '_PRICE_FEED')?.trim()
    if (!priceFeed) {
      throw new Error(stem + '_PRICE_FEED is not set, and a token that cannot be priced cannot be quoted')
    }
    const pricePath = read(stem + '_PRICE_PATH')?.trim() ?? ''
    // Shape first, so a pointer missing its leading slash is named as such
    // rather than reported as an undecidable feed.
    validatePricePath(pricePath)
    if (pricePath === '' && defaultPricePath(priceFeed) === null) {
      throw new Error(stem + '_PRICE_PATH is required: it cannot be derived from ' + JSON.stringify(priceFeed))
    }
    return { token, priceFeed, pricePath }
  })
