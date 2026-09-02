/**
 * Guards on the token list, because every one of these failures is silent.
 *
 * A duplicate symbol collides two tokens' env stems; a duplicate address gives
 * one token two policies. Neither throws at read time — they just make an
 * operator's edit apply somewhere they did not intend.
 */

import { describe, it, expect } from 'vitest'
import {
  parseEvmTokens,
  evmEnvStem,
  evmCorridorPolicies,
  evmMarkets,
  evmMarketStem,
} from '@arkade-os/solver-core/core/evmCorridorConfig.js'

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'

describe('parseEvmTokens', () => {
  it('reads a list, and treats unset as no EVM corridors at all', () => {
    expect(parseEvmTokens(undefined)).toEqual([])
    expect(parseEvmTokens('  ')).toEqual([])
    expect(parseEvmTokens(`USDC:${USDC}:6, WETH:${WETH}:18`)).toEqual([
      { symbol: 'USDC', address: USDC, decimals: 6 },
      { symbol: 'WETH', address: WETH, decimals: 18 },
    ])
  })

  it('refuses a repeated symbol, which would collide two tokens env stems', () => {
    // The failure this prevents is silent: both tokens would read
    // `EVM_SEND_USDC_MAX_SATS`, so widening one widens the other.
    expect(() => parseEvmTokens(`USDC:${USDC}:6,USDC:${WETH}:18`)).toThrow(/symbol USDC twice/)
  })

  it('refuses a repeated address, which would give one token two policies', () => {
    expect(() => parseEvmTokens(`USDC:${USDC}:6,USDC2:${USDC}:6`)).toThrow(/address .* twice/)
  })

  it('applies the SAME address rule the corridor string will', () => {
    // Delegated to `evmCorridorFor` rather than re-implemented, so the two
    // cannot drift — a token accepted here that the corridor rejects would fail
    // later, at a point with no operator context.
    expect(() => parseEvmTokens(`USDC:0x${USDC.slice(2).toUpperCase()}:6`)).toThrow(/LOWERCASE/)
    expect(() => parseEvmTokens('USDC:0xabc:6')).toThrow(/40/)
  })

  it('refuses a symbol that is not a legal, readable stem fragment', () => {
    expect(() => parseEvmTokens(`usdc:${USDC}:6`)).toThrow(/uppercase/)
    expect(() => parseEvmTokens(`US-DC:${USDC}:6`)).toThrow(/uppercase/)
    expect(() => parseEvmTokens(`1USDC:${USDC}:6`)).toThrow(/starting with a letter/)
  })

  it('refuses a precision it cannot use, rather than defaulting one', () => {
    // The one field here whose wrong value is SILENT. A price is quoted in whole
    // units and an ERC20 amount is carried in atomic ones, so this exponent is
    // the whole relationship between them: defaulting it to the common 18 would
    // misprice USDC, which uses 6, by a factor of a million million.
    expect(() => parseEvmTokens(`USDC:${USDC}:`)).toThrow(/SYMBOL:0xaddress:decimals/)
    expect(() => parseEvmTokens(`USDC:${USDC}:six`)).toThrow(/decimals must be an integer/)
    expect(() => parseEvmTokens(`USDC:${USDC}:-1`)).toThrow(/decimals must be an integer/)
    expect(() => parseEvmTokens(`USDC:${USDC}:6.5`)).toThrow(/decimals must be an integer/)
    // Bounded at the same 36 `convertAmount` enforces, so a token past it is
    // refused HERE rather than mid-quote, after the pair was advertised.
    expect(() => parseEvmTokens(`USDC:${USDC}:37`)).toThrow(/0\.\.36/)
    expect(parseEvmTokens(`USDC:${USDC}:0`)[0]!.decimals).toBe(0)
    expect(parseEvmTokens(`USDC:${USDC}:36`)[0]!.decimals).toBe(36)
  })

  it('refuses a malformed entry rather than guessing at it', () => {
    expect(() => parseEvmTokens('USDC')).toThrow(/SYMBOL:0xaddress:decimals/)
    expect(() => parseEvmTokens(`USDC:${USDC}`)).toThrow(/SYMBOL:0xaddress:decimals/)
    expect(() => parseEvmTokens(`USDC:${USDC}:6:extra`)).toThrow(/SYMBOL:0xaddress:decimals/)
  })
})

describe('evmEnvStem', () => {
  it('names the token, so an operator can see what they are editing', () => {
    const [usdc] = parseEvmTokens(`USDC:${USDC}:6`)
    expect(evmEnvStem(usdc!, 'send')).toBe('EVM_SEND_USDC')
    expect(evmEnvStem(usdc!, 'receive')).toBe('EVM_RECEIVE_USDC')
  })
})

describe('evmCorridorPolicies', () => {
  const BASE = { minSats: 1_000, maxSats: 1_000_000 }
  const tokens = parseEvmTokens(`USDC:${USDC}:6`)
  const env = (vars: Record<string, string>) => (name: string) => vars[name]

  it('serves both directions per token, enabled by default', () => {
    // Listing a token IS the opt-in, same as the four BTC corridors.
    const policies = evmCorridorPolicies(tokens, BASE, env({}))
    expect(policies.map((p) => p.direction)).toEqual(['send', 'receive'])
    expect(policies.every((p) => p.enabled)).toBe(true)
    expect(policies[0]!.corridor).toBe(`arkade:BTC->ethereum:${USDC}`)
    expect(policies[1]!.corridor).toBe(`ethereum:${USDC}->arkade:BTC`)
  })

  it('inherits the deployment limits when a corridor sets none', () => {
    const [send] = evmCorridorPolicies(tokens, BASE, env({}))
    expect(send!.limits).toEqual(BASE)
    expect(send!.fee).toEqual({ bps: 0, flatSats: 0 })
  })

  it('reads per-direction knobs off the token stem', () => {
    const policies = evmCorridorPolicies(
      tokens,
      BASE,
      env({ EVM_SEND_USDC_MAX_SATS: '500000', EVM_RECEIVE_USDC_FEE_BPS: '25' }),
    )
    expect(policies[0]!.limits.maxSats).toBe(500_000)
    expect(policies[1]!.limits.maxSats).toBe(1_000_000)
    expect(policies[1]!.fee.bps).toBe(25)
    expect(policies[0]!.fee.bps).toBe(0)
  })

  it('refuses a corridor knob that would WIDEN the deployment bound', () => {
    // One token's config must not be able to raise the house limit — that bound
    // exists to set the blast radius for the whole deployment.
    expect(() => evmCorridorPolicies(tokens, BASE, env({ EVM_SEND_USDC_MAX_SATS: '2000000' }))).toThrow(
      /may not exceed/,
    )
    expect(() => evmCorridorPolicies(tokens, BASE, env({ EVM_RECEIVE_USDC_MIN_SATS: '500' }))).toThrow(
      /may not be below/,
    )
  })

  it('switches one direction off without touching the other', () => {
    const policies = evmCorridorPolicies(tokens, BASE, env({ EVM_SEND_USDC_ENABLED: 'false' }))
    expect(policies[0]!.enabled).toBe(false)
    expect(policies[1]!.enabled).toBe(true)
  })

  it('refuses nonsense rather than defaulting past it', () => {
    expect(() => evmCorridorPolicies(tokens, BASE, env({ EVM_SEND_USDC_MAX_SATS: 'lots' }))).toThrow(/positive integer/)
    expect(() => evmCorridorPolicies(tokens, BASE, env({ EVM_SEND_USDC_FEE_BPS: '20000' }))).toThrow(
      /between 0 and 10000/,
    )
  })

  it('has nothing to say when no tokens are configured', () => {
    expect(evmCorridorPolicies([], BASE, env({}))).toEqual([])
  })
})

describe('evmCorridorPolicies — the token side', () => {
  const BASE_ = { minSats: 1_000, maxSats: 1_000_000 }
  const tokens_ = parseEvmTokens(`USDC:${USDC}:6`)
  const env_ = (vars: Record<string, string>) => (name: string) => vars[name]

  it('is absent by default, leaving the sats bound to do the work', () => {
    // Redundant while the price is what the operator expects, and it stops
    // being redundant exactly when the price is not.
    const policies = evmCorridorPolicies(tokens_, BASE_, env_({}))
    expect(policies.every((p) => p.tokenLimits === undefined)).toBe(true)
  })

  it('reads a bound in ATOMIC units, as a bigint', () => {
    // The ceiling is chosen so a double CANNOT hold it. Magnitude alone is not
    // enough: 5e21 looks too big but is exactly representable, because
    // 5e21 = 5**22 * 2**21 and 5**22 fits in 53 bits. A round decimal has a
    // short binary mantissa; this one has digits all the way down.
    const CEILING = '123456789012345678901'
    const [send] = evmCorridorPolicies(
      tokens_,
      BASE_,
      env_({ EVM_SEND_USDC_MIN_UNITS: '1000000', EVM_SEND_USDC_MAX_UNITS: CEILING }),
    )
    expect(send!.tokenLimits).toEqual({ minUnits: 1_000_000n, maxUnits: BigInt(CEILING) })
    // Measured, not asserted: routing the operator's ceiling through a double
    // silently returns a DIFFERENT bound, so this is what makes the line above
    // a proof rather than a restatement.
    expect(BigInt(Number(CEILING))).not.toBe(BigInt(CEILING))
  })

  it('bounds one direction without touching the other', () => {
    const policies = evmCorridorPolicies(
      tokens_,
      BASE_,
      env_({ EVM_SEND_USDC_MIN_UNITS: '1', EVM_SEND_USDC_MAX_UNITS: '2' }),
    )
    expect(policies.find((p) => p.direction === 'send')!.tokenLimits).toEqual({ minUnits: 1n, maxUnits: 2n })
    expect(policies.find((p) => p.direction === 'receive')!.tokenLimits).toBeUndefined()
  })

  it('requires BOTH bounds or neither, because one alone is not a bound', () => {
    // A lone maximum leaves the floor at zero, which quotes dust. A lone minimum
    // leaves the ceiling open, which is the bound the operator thought they set.
    expect(() => evmCorridorPolicies(tokens_, BASE_, env_({ EVM_SEND_USDC_MAX_UNITS: '5' }))).toThrow(
      /together or not at all/,
    )
    expect(() => evmCorridorPolicies(tokens_, BASE_, env_({ EVM_SEND_USDC_MIN_UNITS: '5' }))).toThrow(
      /together or not at all/,
    )
  })

  it('refuses an inverted bound', () => {
    expect(() =>
      evmCorridorPolicies(tokens_, BASE_, env_({ EVM_SEND_USDC_MIN_UNITS: '9', EVM_SEND_USDC_MAX_UNITS: '8' })),
    ).toThrow(/may not exceed/)
  })

  it('refuses anything that is not a decimal integer of atomic units', () => {
    for (const raw of ['1.5', '-1', '1e18', '0x10', 'lots']) {
      expect(() =>
        evmCorridorPolicies(tokens_, BASE_, env_({ EVM_SEND_USDC_MIN_UNITS: '1', EVM_SEND_USDC_MAX_UNITS: raw })),
      ).toThrow(/atomic units/)
    }
  })
})

describe('evmMarkets', () => {
  const tokens = parseEvmTokens(`USDC:${USDC}:6`)
  const env = (vars: Record<string, string>) => (name: string) => vars[name]
  const FEED = 'http://pricefeed/btc-usdc'
  const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd'

  it('names the token but NOT the direction, because a market is the pair', () => {
    // Two feeds for one pair would let the send and receive legs disagree about
    // the price - an arbitrage against the solver by whoever noticed first.
    expect(evmMarketStem(tokens[0]!)).toBe('EVM_USDC')
  })

  it('reads the feed and the pointer as the operator set them', () => {
    const markets = evmMarkets(tokens, env({ EVM_USDC_PRICE_FEED: FEED, EVM_USDC_PRICE_PATH: '/btc/usdc' }))
    expect(markets).toEqual([{ token: tokens[0], priceFeed: FEED, pricePath: '/btc/usdc' }])
  })

  it('requires a feed, since a token that cannot be priced cannot be quoted', () => {
    expect(() => evmMarkets(tokens, env({}))).toThrow(/EVM_USDC_PRICE_FEED is not set/)
    expect(() => evmMarkets(tokens, env({ EVM_USDC_PRICE_FEED: '   ' }))).toThrow(/is not set/)
  })

  it('allows an empty pointer when the provider is one whose shape is known', () => {
    const markets = evmMarkets(tokens, env({ EVM_USDC_PRICE_FEED: COINGECKO }))
    expect(markets[0]!.pricePath).toBe('')
  })

  it('REFUSES AT STARTUP a feed whose pointer cannot be derived', () => {
    // The deliberate improvement on the go implementation: there, this fails
    // inside Fetch, so the market registers, the pair is advertised, and the
    // failure arrives on a client request. Here the deployment does not start.
    expect(() => evmMarkets(tokens, env({ EVM_USDC_PRICE_FEED: FEED }))).toThrow(/EVM_USDC_PRICE_PATH is required/)
  })

  it('refuses a pointer that is not RFC 6901 shaped, naming the shape', () => {
    // Checked before derivability, so a missing leading slash is reported as
    // such rather than as an undecidable feed.
    expect(() => evmMarkets(tokens, env({ EVM_USDC_PRICE_FEED: FEED, EVM_USDC_PRICE_PATH: 'btc/usdc' }))).toThrow(
      /starting with/,
    )
  })

  it('gives each token its own market', () => {
    const two = parseEvmTokens(`USDC:${USDC}:6,WETH:${WETH}:18`)
    const markets = evmMarkets(
      two,
      env({
        EVM_USDC_PRICE_FEED: FEED,
        EVM_USDC_PRICE_PATH: '/btc/usdc',
        EVM_WETH_PRICE_FEED: 'http://pricefeed/btc-weth',
        EVM_WETH_PRICE_PATH: '/btc/weth',
      }),
    )
    expect(markets.map((m) => m.token.symbol)).toEqual(['USDC', 'WETH'])
    expect(markets.map((m) => m.pricePath)).toEqual(['/btc/usdc', '/btc/weth'])
  })
})
