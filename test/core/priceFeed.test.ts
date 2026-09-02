/**
 * Pricing one asset against another.
 *
 * Two properties carry money here. The conversion must be EXACT - an ERC20 with
 * 18 decimals produces numbers a float64 cannot hold, and the repo already
 * stores `evm_amount` as TEXT for that reason. And the rounding direction must
 * be chosen by the caller, because rounding the wrong way gives away a sub-unit
 * on every swap, in the same direction, forever.
 *
 * The feed shape is pinned against the one the arkade regtest stack actually
 * serves, so this cannot drift from what an operator is already running.
 */

import { describe, it, expect } from 'vitest'
import {
  convertAmount,
  convertQuoteToBase,
  defaultPricePath,
  priceFrom,
  resolvePrice,
  validatePricePath,
  type Price,
} from '@arkade-os/solver-core/core/priceFeed.js'

/** What `http://pricefeed/btc-asset` serves in the arkade regtest stack, verbatim. */
const REGTEST_FEED = { btc: { asset: 100000000 } }

const price = (mantissa: bigint, scale: number): Price => ({ mantissa, scale })

describe('reading a price', () => {
  it('takes a JSON number', () => {
    expect(priceFrom(100000000)).toEqual({ mantissa: 100000000n, scale: 0 })
  })

  it('takes a numeric string, keeping every digit', () => {
    // The precise form: a string has not been through IEEE-754 on the way in.
    expect(priceFrom('123456789.123456789')).toEqual({ mantissa: 123456789123456789n, scale: 9 })
  })

  it('trims surrounding whitespace rather than refusing the price', () => {
    expect(priceFrom(' 42 ')).toEqual({ mantissa: 42n, scale: 0 })
  })

  it.each([
    ['zero, which would make every swap free', '0'],
    ['zero with decimals', '0.000'],
    ['a negative, which is not a price', '-1'],
    ['exponent form, which has three spellings and one wrong guess is 8 orders out', '1e-8'],
    ['not a number at all', 'free'],
    ['an empty string', ''],
    ['a trailing dot', '1.'],
  ])('refuses %s', (_why, value) => {
    expect(() => priceFrom(value)).toThrow()
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an object', { price: 1 }],
    ['a boolean', true],
  ])('refuses %s rather than coercing it', (_why, value) => {
    expect(() => priceFrom(value)).toThrow(/must be a number or a numeric string/)
  })

  it('refuses NaN and Infinity, which stringify to non-decimals', () => {
    expect(() => priceFrom(Number.NaN)).toThrow()
    expect(() => priceFrom(Number.POSITIVE_INFINITY)).toThrow()
  })
})

describe('converting between assets', () => {
  it('prices one whole BTC at the regtest feed rate', () => {
    // 1 BTC = 100_000_000 sats; the feed says 100_000_000 asset per BTC; the
    // asset has no decimals. So one BTC buys 100_000_000 whole asset units.
    expect(
      convertAmount({
        baseAmount: 100_000_000n,
        price: priceFrom(REGTEST_FEED.btc.asset),
        baseDecimals: 8,
        quoteDecimals: 0,
        rounding: 'down',
      }),
    ).toBe(100_000_000n)
  })

  it('is EXACT where a float64 provably is not', () => {
    // 1 BTC at 123456.789 into an 18-decimal token is ~1.2e23 - eight orders of
    // magnitude past the 2^53 where float64 stops representing integers. This is
    // the assertion the TEXT column and the bigint arithmetic exist for.
    const exact = convertAmount({
      baseAmount: 100_000_000n,
      price: priceFrom('123456.789'),
      baseDecimals: 8,
      quoteDecimals: 18,
      rounding: 'down',
    })
    expect(exact).toBe(123_456_789n * 10n ** 15n)
    // And the same figure routed through a double comes back different, which is
    // what makes the claim above a measurement rather than an assertion.
    expect(BigInt(Number(exact))).not.toBe(exact)
  })

  it('rounds DOWN when the solver pays, so it never gives away a sub-unit', () => {
    // One sat priced 1:1 into a zero-decimal asset is a hundred-millionth of a
    // unit. Paying out means paying nothing, not paying one.
    expect(
      convertAmount({ baseAmount: 1n, price: price(1n, 0), baseDecimals: 8, quoteDecimals: 0, rounding: 'down' }),
    ).toBe(0n)
  })

  it('rounds UP when the solver receives, so it is never short', () => {
    expect(
      convertAmount({ baseAmount: 1n, price: price(1n, 0), baseDecimals: 8, quoteDecimals: 0, rounding: 'up' }),
    ).toBe(1n)
  })

  it('does not round an exact division in either direction', () => {
    const args = { baseAmount: 100_000_000n, price: price(2n, 0), baseDecimals: 8, quoteDecimals: 0 } as const
    expect(convertAmount({ ...args, rounding: 'down' })).toBe(2n)
    expect(convertAmount({ ...args, rounding: 'up' })).toBe(2n)
  })

  it('multiplies before it divides, so no intermediate is truncated', () => {
    // Dividing first would floor 1 sat to 0 BTC and answer 0 for every amount
    // below a whole unit - a corridor that pays nothing for small swaps.
    expect(
      convertAmount({
        baseAmount: 1n,
        price: price(100_000n, 0),
        baseDecimals: 8,
        quoteDecimals: 18,
        rounding: 'down',
      }),
    ).toBe(10n ** 15n)
  })

  it('applies the price scale, so a fractional rate is not read as a whole one', () => {
    // 0.5 quote per base, not 5.
    expect(
      convertAmount({
        baseAmount: 100_000_000n,
        price: priceFrom('0.5'),
        baseDecimals: 8,
        quoteDecimals: 8,
        rounding: 'down',
      }),
    ).toBe(50_000_000n)
  })

  it('is zero for a zero amount, without rounding it up to one', () => {
    expect(
      convertAmount({ baseAmount: 0n, price: price(1n, 0), baseDecimals: 8, quoteDecimals: 18, rounding: 'up' }),
    ).toBe(0n)
  })

  it('refuses a negative amount and out-of-range decimals rather than mispricing', () => {
    const base = { price: price(1n, 0), baseDecimals: 8, quoteDecimals: 18, rounding: 'down' } as const
    expect(() => convertAmount({ ...base, baseAmount: -1n })).toThrow(/must not be negative/)
    expect(() => convertAmount({ ...base, baseAmount: 1n, baseDecimals: -1 })).toThrow(/baseDecimals/)
    expect(() => convertAmount({ ...base, baseAmount: 1n, quoteDecimals: 37 })).toThrow(/quoteDecimals/)
    expect(() => convertAmount({ ...base, baseAmount: 1n, quoteDecimals: 1.5 })).toThrow(/quoteDecimals/)
  })
})

describe('resolving the pointer into a response', () => {
  it('reads the price the regtest feed actually serves', () => {
    expect(resolvePrice(REGTEST_FEED, '/btc/asset')).toEqual({ mantissa: 100000000n, scale: 0 })
  })

  it('descends into arrays by index', () => {
    expect(resolvePrice({ prices: [{ usd: '7' }] }, '/prices/0/usd')).toEqual({ mantissa: 7n, scale: 0 })
  })

  it('unescapes ~1 as / and ~0 as ~, per RFC 6901', () => {
    expect(resolvePrice({ 'a/b': 3 }, '/a~1b')).toEqual({ mantissa: 3n, scale: 0 })
    expect(resolvePrice({ 'c~d': 4 }, '/c~0d')).toEqual({ mantissa: 4n, scale: 0 })
  })

  it('names the missing key, not just the pointer', () => {
    // A feed changing shape is the ordinary cause; "no key" without saying which
    // sends the reader to the wrong part of the document.
    expect(() => resolvePrice(REGTEST_FEED, '/btc/usd')).toThrow(/no key "usd"/)
  })

  it('refuses an out-of-range index and a descent into a scalar', () => {
    expect(() => resolvePrice({ prices: [] }, '/prices/0')).toThrow(/out of range/)
    expect(() => resolvePrice({ btc: 1 }, '/btc/asset')).toThrow(/cannot descend/)
  })

  it('refuses a value that is not a price, rather than reading it as one', () => {
    expect(() => resolvePrice({ btc: { asset: null } }, '/btc/asset')).toThrow()
    expect(() => resolvePrice({ btc: { asset: {} } }, '/btc/asset')).toThrow()
  })
})

describe('the pointer contract', () => {
  it('accepts an empty pointer, which means derive it', () => {
    expect(() => validatePricePath('')).not.toThrow()
  })

  it('requires a leading slash', () => {
    expect(() => validatePricePath('btc/asset')).toThrow(/starting with/)
  })

  it('requires ~ to be escaped', () => {
    expect(() => validatePricePath('/a~b')).toThrow(/~0/)
    expect(() => validatePricePath('/a~1b')).not.toThrow()
    expect(() => validatePricePath('/a~0b')).not.toThrow()
  })
})

describe('deriving the pointer for a known provider', () => {
  it('is /price for binance', () => {
    expect(defaultPricePath('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT')).toBe('/price')
  })

  it('is built from coingecko query parameters', () => {
    expect(defaultPricePath('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd')).toBe(
      '/bitcoin/usd',
    )
  })

  it('takes the FIRST of a comma-separated list, matching the go solver', () => {
    expect(
      defaultPricePath('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ether&vs_currencies=usd,eur'),
    ).toBe('/bitcoin/usd')
  })

  it('is null for a feed it cannot derive, so the caller demands one', () => {
    // Guessing here would price a swap against whatever number happened to sit
    // at the guessed pointer.
    expect(defaultPricePath('http://pricefeed/btc-asset')).toBeNull()
    expect(defaultPricePath('not a url')).toBeNull()
  })
})

describe('converting the other way — quote back into base', () => {
  it('round-trips a value the rate divides evenly', () => {
    // 1 BTC at 50_000 quote per BTC into a 6-decimal token, and back.
    const price = priceFrom(50_000)
    const quote = convertAmount({
      baseAmount: 100_000_000n,
      price,
      baseDecimals: 8,
      quoteDecimals: 6,
      rounding: 'down',
    })
    expect(quote).toBe(50_000_000_000n)
    expect(convertQuoteToBase({ quoteAmount: quote, price, baseDecimals: 8, quoteDecimals: 6, rounding: 'down' })).toBe(
      100_000_000n,
    )
  })

  it('does NOT invert the price into a decimal first', () => {
    // A rate of 3 quote per base has a non-terminating reciprocal. Turning the
    // price into 0.333… and reusing the forward path would round BEFORE the
    // conversion; keeping the reciprocal implicit rounds only after it.
    // 3 units of a 0-decimal quote at 3-per-BTC is exactly 1 BTC.
    expect(
      convertQuoteToBase({
        quoteAmount: 3n,
        price: priceFrom(3),
        baseDecimals: 8,
        quoteDecimals: 0,
        rounding: 'down',
      }),
    ).toBe(100_000_000n)
  })

  it('rounds DOWN when the solver pays out the base asset', () => {
    // One quote unit at 3-per-BTC is a third of a BTC and change; paying the
    // floor keeps the remainder with the solver.
    const down = convertQuoteToBase({
      quoteAmount: 1n,
      price: priceFrom(3),
      baseDecimals: 8,
      quoteDecimals: 0,
      rounding: 'down',
    })
    expect(down).toBe(33_333_333n)
  })

  it('rounds UP when the solver receives the base asset', () => {
    const up = convertQuoteToBase({
      quoteAmount: 1n,
      price: priceFrom(3),
      baseDecimals: 8,
      quoteDecimals: 0,
      rounding: 'up',
    })
    expect(up).toBe(33_333_334n)
  })

  it('does not round an exact division in either direction', () => {
    const args = { quoteAmount: 50_000_000_000n, price: priceFrom(50_000), baseDecimals: 8, quoteDecimals: 6 } as const
    expect(convertQuoteToBase({ ...args, rounding: 'down' })).toBe(100_000_000n)
    expect(convertQuoteToBase({ ...args, rounding: 'up' })).toBe(100_000_000n)
  })

  it('applies the price scale', () => {
    // 0.5 quote per base: one quote unit buys two whole base units.
    expect(
      convertQuoteToBase({
        quoteAmount: 1n,
        price: priceFrom('0.5'),
        baseDecimals: 8,
        quoteDecimals: 0,
        rounding: 'down',
      }),
    ).toBe(200_000_000n)
  })

  it('is exact where a float is not', () => {
    const exact = convertQuoteToBase({
      quoteAmount: 123_456_789_012_345_678_901n,
      price: priceFrom('1.7'),
      baseDecimals: 18,
      quoteDecimals: 6,
      rounding: 'down',
    })
    expect(BigInt(Number(exact))).not.toBe(exact)
  })

  it('is zero for a zero amount, without rounding up to one', () => {
    expect(
      convertQuoteToBase({ quoteAmount: 0n, price: priceFrom(3), baseDecimals: 8, quoteDecimals: 0, rounding: 'up' }),
    ).toBe(0n)
  })

  it('refuses a negative amount and out-of-range decimals', () => {
    const base = { price: priceFrom(1), baseDecimals: 8, quoteDecimals: 6, rounding: 'down' } as const
    expect(() => convertQuoteToBase({ ...base, quoteAmount: -1n })).toThrow(/must not be negative/)
    expect(() => convertQuoteToBase({ ...base, quoteAmount: 1n, baseDecimals: 37 })).toThrow(/baseDecimals/)
    expect(() => convertQuoteToBase({ ...base, quoteAmount: 1n, quoteDecimals: -1 })).toThrow(/quoteDecimals/)
  })
})

/**
 * RFC 6901 § 4: the empty pointer names the whole document.
 *
 * `createPriceFeed` cannot reach this — `defaultPricePath` resolves an empty
 * path to a derived one first — so the only route in is a direct call. That is
 * exactly why it went unnoticed: `resolvePrice` is exported, and a caller
 * relying on the RFC's documented semantics got "no key" naming a key they
 * never wrote.
 */
describe('resolvePrice and the empty pointer', () => {
  it('reads a bare numeric body as the price itself', () => {
    expect(resolvePrice(42, '')).toEqual(priceFrom(42))
    expect(resolvePrice('1.25', '')).toEqual(priceFrom('1.25'))
  })

  it('still refuses a root that is not a price', () => {
    // The empty pointer changes WHERE to look, not what counts as a price.
    expect(() => resolvePrice({ price: 1 }, '')).toThrow(/must be a number or a numeric string/)
  })

  it('is not the same as a pointer to a zero-length key', () => {
    // "/" is a pointer to the key "", which is a real and different thing in
    // RFC 6901. Conflating them is the bug this closes, in reverse.
    expect(resolvePrice({ '': 7 }, '/')).toEqual(priceFrom(7))
  })
})
