import { describe, expect, it } from 'vitest'
import { assetMarketKey } from '@arkade-os/solver-core/core/assetMarketConfig.js'
import { defaultPricePath } from '@arkade-os/solver-core/core/priceFeed.js'
import {
  carrierCharged,
  carrierModeFor,
  configSymbol,
  derivedPricePath,
  directions,
  issuerDecimals,
  limitDefaults,
  pairKey,
  tickerSymbol,
  toAtomic,
  toHuman,
  unboundedOpenDirections,
} from '../../packages/solver-app/src/admin/static/simpleMarket.js'

const USDA = 'aa'.repeat(34)
const USDB = 'cd'.repeat(34)

describe('whole units and atomic units', () => {
  it('converts both ways at 8 and at 6 decimals', () => {
    expect(toAtomic('0.0001', 8)).toBe('10000')
    expect(toAtomic('1', 8)).toBe('100000000')
    expect(toAtomic('0.00000001', 8)).toBe('1')
    expect(toAtomic('10.5', 6)).toBe('10500000')
    expect(toAtomic('.25', 6)).toBe('250000')
    expect(toAtomic('1.500000000', 6)).toBe('1500000')
    expect(toHuman('10000', 8)).toBe('0.0001')
    expect(toHuman('100000000', 8)).toBe('1')
    expect(toHuman('10500000', 6)).toBe('10.5')
    expect(toHuman('0', 6)).toBe('0')
  })

  it('stays exact past 2^53', () => {
    const atomic = '123456789012345678901234567890'
    expect(toHuman(atomic, 6)).toBe('123456789012345678901234.56789')
    expect(toAtomic(toHuman(atomic, 6), 6)).toBe(atomic)
  })

  it('refuses what is not an amount at these decimals instead of guessing', () => {
    for (const text of ['abc', '-1', '1e5', '1,000', '.', '0.000000001']) expect(toAtomic(text, 8), text).toBeNull()
    expect(toAtomic('1', '')).toBeNull()
    expect(toAtomic('  ', 8)).toBe('')
    expect(toHuman('1.5', 8)).toBe('1.5')
  })
})

describe('symbol and decimals', () => {
  const knobs = [{ key: 'ASSET_MARKETS', value: `USDA:${USDA}, USDB:${USDB}` }]

  it('takes the symbol the ASSET_MARKETS knob names for this asset', () => {
    expect(configSymbol(knobs, USDB)).toBe('USDB')
    expect(configSymbol(knobs, 'ef'.repeat(34))).toBeNull()
    expect(configSymbol([{ key: 'ASSET_MARKETS', value: '(empty)' }], USDA)).toBeNull()
    expect(configSymbol(undefined, USDA)).toBeNull()
  })

  it('uppercases an issuer ticker only when it is already a valid symbol', () => {
    expect(tickerSymbol({ ticker: 'usda' })).toBe('USDA')
    for (const ticker of ['US D', '1USD', 'TOOLONGSYMBOL', '']) expect(tickerSymbol({ ticker }), ticker).toBeNull()
    expect(tickerSymbol(null)).toBeNull()
  })

  it('takes decimals from the lookup only as an integer the server accepts', () => {
    expect(issuerDecimals({ decimals: 6 })).toBe(6)
    expect(issuerDecimals({ decimals: 0 })).toBe(0)
    for (const decimals of [6.5, 37, -1, '6'])
      expect(issuerDecimals({ decimals } as never), String(decimals)).toBeNull()
    expect(issuerDecimals({})).toBeNull()
  })
})

describe('the carrier switch', () => {
  it('writes priced when on and off when off, never inherit', () => {
    expect(carrierModeFor(true)).toBe('priced')
    expect(carrierModeFor(false)).toBe('off')
  })

  it('reads inherit through the deployment default', () => {
    expect(carrierCharged('inherit', true)).toBe(true)
    expect(carrierCharged('inherit', false)).toBe(false)
    expect(carrierCharged('priced', false)).toBe(true)
    expect(carrierCharged('off', true)).toBe(false)
  })
})

describe('which columns a direction writes', () => {
  it('maps BTC → asset to sell_base when BTC is the base', () => {
    const [btcIn, assetIn] = directions({ base: null, quote: USDA })
    expect(btcIn).toMatchObject({ wire: 'sell_base', receives: 'quote', open: 'rfqSellBase', min: 'sellBaseMin' })
    expect(btcIn.flat).toBe('sellBaseFeeFlat')
    expect(assetIn).toMatchObject({ wire: 'buy_base', receives: 'base', open: 'rfqBuyBase', flat: 'buyBaseFeeFlat' })
  })

  it('maps BTC → asset to buy_base when the asset is the base', () => {
    const [btcIn, assetIn] = directions({ base: USDA, quote: 'BTC' })
    expect(btcIn).toMatchObject({ wire: 'buy_base', gives: 'quote', receives: 'base', open: 'rfqBuyBase' })
    expect(assetIn).toMatchObject({ wire: 'sell_base', gives: 'base', receives: 'quote', max: 'sellBaseMax' })
  })
})

describe('a direction open to RFQ without limits', () => {
  const body = {
    base: null,
    quote: USDA,
    sellBase: { min: '1', max: '2' },
    buyBase: null,
    rfqSellBase: true,
    rfqBuyBase: true,
  }

  it('is named, since RFQ reads a missing bound as closed', () => {
    expect(unboundedOpenDirections(body).map((side) => side.wire)).toEqual(['buy_base'])
  })

  it('is no fault once switched off, disabled, or not serving RFQ', () => {
    expect(unboundedOpenDirections({ ...body, rfqBuyBase: false })).toEqual([])
    expect(unboundedOpenDirections({ ...body, enabled: false })).toEqual([])
    expect(unboundedOpenDirections({ ...body, servesRfq: false })).toEqual([])
  })
})

describe('agreement with the server', () => {
  it('derives the price path exactly as defaultPricePath does', () => {
    for (const url of [
      'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ether&vs_currencies=usd,eur',
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=USD',
      'https://api.coinbase.com/v2/prices/BTC-USD/spot',
      'https://feed.test/price?ids=bitcoin',
      'not a url',
      '',
    ]) {
      expect(derivedPricePath(url), url).toBe(defaultPricePath(url))
    }
  })

  it('keys a pair as assetMarketKey does, whichever leg the asset is on', () => {
    expect(pairKey('BTC', USDA)).toBe(assetMarketKey(null, USDA))
    expect(pairKey(USDB, '')).toBe(assetMarketKey(USDB, null))
    expect(pairKey(USDB, 'btc')).toBe(pairKey('BTC', USDB))
  })
})

describe('limit defaults for a new market', () => {
  it('converts 0.0001–0.01 BTC at the feed price and floors to two significant figures', () => {
    expect(limitDefaults({ mantissa: '10421850', scale: 2 }, '6')).toEqual({
      btc: { min: '10000', max: '1000000' },
      asset: { min: '10000000', max: '1000000000' },
    })
    expect(limitDefaults({ mantissa: '37297200000000', scale: 8 }, 8)?.asset).toEqual({
      min: '3700000000',
      max: '370000000000',
    })
  })

  it('offers nothing until the decimals and the price are both known', () => {
    expect(limitDefaults({ mantissa: '10421850', scale: 2 }, '')).toBeNull()
    expect(limitDefaults(null, '6')).toBeNull()
    expect(limitDefaults({ mantissa: '1', scale: 8 }, 0)).toBeNull()
  })
})
