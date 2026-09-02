/**
 * Pricing one asset against another, from an operator-configured HTTP feed.
 *
 * Every corridor this repo served until now was BTC->BTC, so a payout was the
 * amount minus a fee and no rate existed anywhere.
 *
 * The same contract as the Go solver (`arkade-os/solver`,
 * `pkg/swap/pricefeed/pricefeed.go`): a feed URL plus an RFC 6901 JSON pointer to
 * the price inside the response, the pointer derivable for known providers, and the
 * price read as quote-per-base. An operator running both solvers points them at ONE
 * feed, and a rate that differed between them would be an arbitrage against
 * whichever quoted lower.
 *
 * It diverges on precision. The Go implementation resolves the price to a `float64`,
 * which is safe for Arkade assets whose amounts are small integers but NOT for an
 * ERC20: a token with 18 decimals carries a 256-bit amount. This repo already made
 * that call once — `evm_amount` is a TEXT column for the same reason. So the price
 * is an exact decimal (bigint mantissa plus scale) and every conversion below is
 * integer arithmetic. Nothing here goes near a float.
 *
 * Pure: no HTTP, no clock. The fetch lives with the caller.
 */

/** A price as an exact decimal: `mantissa / 10 ** scale`. Never a float. */
export interface Price {
  mantissa: bigint
  scale: number
}

/**
 * Which way to round when the conversion is not exact.
 *
 * REQUIRED at every call site, never defaulted: the safe direction depends on which
 * side of the trade the solver is on, so a default is wrong for half of them. Down
 * when the solver PAYS the quote asset, up when it RECEIVES. The wrong way gives away
 * a sub-unit on every swap in the same direction — a leak, not a rounding error.
 */
export type Rounding = 'down' | 'up'

const DECIMAL = /^(\d+)(?:\.(\d+))?$/

/**
 * Read a price from a feed value, exactly.
 *
 * Accepts a JSON number or a numeric string. A STRING preserves every digit; a JSON
 * number has already been through IEEE-754 by the time `JSON.parse` hands it over, so
 * a feed that cares should quote its price as a string.
 *
 * Rejects zero, negatives, exponent notation and NaN. Exponent form is refused rather
 * than guessed at, because `1e-8`, `1E-8` and `1e+8` are three spellings and
 * mis-parsing one prices a swap wrong by eight orders of magnitude.
 */
export const priceFrom = (value: unknown): Price => {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : null
  if (text === null) throw new Error(`price must be a number or a numeric string, got ${JSON.stringify(value)}`)
  const match = DECIMAL.exec(text)
  if (!match) throw new Error(`price must be a plain decimal, got ${JSON.stringify(text)}`)
  const [, whole = '', fraction = ''] = match
  const mantissa = BigInt(whole + fraction)
  if (mantissa <= 0n) throw new Error(`price must be positive, got ${JSON.stringify(text)}`)
  return { mantissa, scale: fraction.length }
}

const TEN = 10n

/**
 * Convert an amount of the BASE asset into the QUOTE asset, exactly.
 *
 * `quote = base * price * 10**quoteDecimals / 10**baseDecimals`, as one integer
 * expression: every multiplication before the single division, so no intermediate is
 * truncated and the only rounding is the explicit one at the end.
 *
 * Both amounts are in ATOMIC UNITS of their own asset. Passing whole units, or the
 * wrong decimals, misprices by a power of ten rather than failing — which is why both
 * are named rather than assumed.
 */
export const convertAmount = (args: {
  /** Amount of the base asset, in its own atomic units. */
  baseAmount: bigint
  /** Quote asset per ONE WHOLE unit of the base asset. */
  price: Price
  baseDecimals: number
  quoteDecimals: number
  rounding: Rounding
}): bigint => {
  const { baseAmount, price, baseDecimals, quoteDecimals, rounding } = args
  if (baseAmount < 0n) throw new Error(`baseAmount must not be negative, got ${baseAmount}`)
  for (const [name, value] of [
    ['baseDecimals', baseDecimals],
    ['quoteDecimals', quoteDecimals],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 36) {
      throw new Error(`${name} must be an integer in 0..36, got ${value}`)
    }
  }

  const numerator = baseAmount * price.mantissa * TEN ** BigInt(quoteDecimals)
  const denominator = TEN ** BigInt(price.scale) * TEN ** BigInt(baseDecimals)
  const quotient = numerator / denominator
  // Exact division needs no rounding either way; only a remainder does.
  return rounding === 'up' && numerator % denominator !== 0n ? quotient + 1n : quotient
}

/**
 * Walk an RFC 6901 JSON pointer into a parsed response and read the price.
 *
 * Mirrors the Go implementation's `resolve`, including descending through
 * arrays by index and unescaping `~1` to `/` and `~0` to `~`. Every failure
 * names the pointer AND the token that failed, because a feed changing shape is
 * the ordinary cause and "no key" without saying which key sends the reader to
 * the wrong part of the document.
 */
export const resolvePrice = (body: unknown, pointer: string): Price => {
  // RFC 6901 § 4: the EMPTY pointer names the whole document, not a key called "".
  // Without this the loop splits `''` into `['']` and a feed answering a bare number
  // fails with "no key" naming a key nobody wrote.
  if (pointer === '') return priceFrom(body)

  let node: unknown = body
  for (const raw of pointer.replace(/^\//, '').split('/')) {
    const token = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    if (Array.isArray(node)) {
      const index = Number(token)
      if (!Number.isInteger(index) || index < 0 || index >= node.length) {
        throw new Error(`price path ${pointer}: out of range index ${JSON.stringify(token)}`)
      }
      node = node[index]
      continue
    }
    if (typeof node === 'object' && node !== null) {
      if (!(token in node)) {
        throw new Error(`price path ${pointer}: no key ${JSON.stringify(token)} in response`)
      }
      node = (node as Record<string, unknown>)[token]
      continue
    }
    throw new Error(`price path ${pointer}: cannot descend into ${JSON.stringify(token)}`)
  }
  return priceFrom(node)
}

/**
 * Refuse a pointer that is not RFC 6901 shaped, before it reaches a feed.
 *
 * An empty pointer is allowed and means "derive it" - see {@link defaultPricePath}.
 */
export const validatePricePath = (pointer: string): void => {
  if (pointer === '') return
  if (!pointer.startsWith('/')) throw new Error('price_path must be a JSON pointer starting with "/"')
  if (pointer.replaceAll('~0', '').replaceAll('~1', '').includes('~')) {
    throw new Error('price_path: "~" must be escaped as "~0" or "~1"')
  }
}

/**
 * The pointer for a provider whose response shape is known, so an operator
 * naming a Binance or CoinGecko URL need not also work out the pointer.
 *
 * Returns null when it cannot be derived, which the caller reports as
 * "price_path is required for this feed" rather than guessing. The two
 * providers and their shapes are the Go implementation's, so the same feed URL
 * configured against either solver resolves identically.
 */
export const defaultPricePath = (feedUrl: string): string | null => {
  if (feedUrl.includes('binance')) return '/price'
  let query: URLSearchParams
  try {
    query = new URL(feedUrl).searchParams
  } catch {
    return null
  }
  const ids = query.get('ids')
  const currencies = query.get('vs_currencies')
  if (!ids || !currencies) return null
  return `/${ids.split(',')[0]}/${currencies.split(',')[0]}`
}

/**
 * Convert an amount of the QUOTE asset back into the BASE asset, exactly.
 *
 * The mirror of {@link convertAmount}, and needed because a corridor runs both
 * ways: `arkade:BTC->ethereum:<token>` prices base into quote, and
 * `ethereum:<token>->arkade:BTC` prices quote into base.
 *
 * `base = quote * 10**scale * 10**baseDecimals / (mantissa * 10**quoteDecimals)`
 *
 * NOT done by inverting the price first. `mantissa / 10**scale` inverted is
 * generally non-terminating — a rate of 3 quote per base has a reciprocal no decimal
 * can hold — so turning it into a `Price` and reusing the forward path would round
 * before the conversion rather than after it. The reciprocal stays implicit: every
 * multiplication first, then one division, and the only rounding is the explicit one
 * at the end.
 *
 * The safe rounding direction is the same question as in {@link convertAmount}: down
 * when the solver pays out the base asset, up when it receives.
 */
export const convertQuoteToBase = (args: {
  /** Amount of the quote asset, in its own atomic units. */
  quoteAmount: bigint
  /** Quote asset per ONE WHOLE unit of the base asset — the same price, unflipped. */
  price: Price
  baseDecimals: number
  quoteDecimals: number
  rounding: Rounding
}): bigint => {
  const { quoteAmount, price, baseDecimals, quoteDecimals, rounding } = args
  if (quoteAmount < 0n) throw new Error(`quoteAmount must not be negative, got ${quoteAmount}`)
  for (const [name, value] of [
    ['baseDecimals', baseDecimals],
    ['quoteDecimals', quoteDecimals],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 36) {
      throw new Error(`${name} must be an integer in 0..36, got ${value}`)
    }
  }

  const numerator = quoteAmount * TEN ** BigInt(price.scale) * TEN ** BigInt(baseDecimals)
  const denominator = price.mantissa * TEN ** BigInt(quoteDecimals)
  const quotient = numerator / denominator
  return rounding === 'up' && numerator % denominator !== 0n ? quotient + 1n : quotient
}
