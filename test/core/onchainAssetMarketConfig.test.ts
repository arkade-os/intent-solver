/**
 * The env surface of `onchain:BTC->arkade:<asset>`.
 *
 * Every failure here is silent unless caught at startup: a mixed-case asset id
 * derives one registry key and is refused as unserved by the next, a wrong
 * `decimals` misprices every swap by a power of ten while each still quotes and
 * settles, and an absent payout bound leaves the rate as the only thing between
 * the float and a runaway feed.
 */

import { describe, it, expect } from 'vitest'
import {
  parseOnchainAssetPairs,
  onchainAssetEnvStem,
  onchainAssetMarkets,
} from '@arkade-os/solver-core/core/onchainAssetMarketConfig.js'

const ASSET = 'ab'.repeat(32) + '0100'
const OTHER = 'cd'.repeat(32) + '0100'
const PAIRS = () => parseOnchainAssetPairs(`USDA:${ASSET}:6`)
const STEM = onchainAssetEnvStem('USDA')

const env = (over: Record<string, string> = {}) => {
  const all: Record<string, string> = {
    [`${STEM}_PRICE_FEED`]: 'https://feed.example/rate',
    [`${STEM}_MIN_PAYOUT`]: '1',
    [`${STEM}_MAX_PAYOUT`]: '1000000000',
    ...over,
  }
  return (name: string): string | undefined => all[name]
}

describe('parseOnchainAssetPairs', () => {
  it('treats unset as serving no such market, not as a default', () => {
    expect(parseOnchainAssetPairs(undefined)).toEqual([])
    expect(parseOnchainAssetPairs('  ')).toEqual([])
  })

  it('reads a list', () => {
    expect(parseOnchainAssetPairs(`USDA:${ASSET}:6, EURA:${OTHER}:2`)).toEqual([
      { symbol: 'USDA', assetId: ASSET, decimals: 6 },
      { symbol: 'EURA', assetId: OTHER, decimals: 2 },
    ])
  })

  it('refuses a mixed-case asset id, which would derive a key nothing else serves', () => {
    expect(() => parseOnchainAssetPairs(`USDA:${ASSET.toUpperCase()}:6`)).toThrow(/lowercase hex/)
  })

  it('refuses a repeated symbol, which would collide two markets on one env stem', () => {
    expect(() => parseOnchainAssetPairs(`USDA:${ASSET}:6,USDA:${OTHER}:6`)).toThrow(/names USDA twice/)
  })

  it('refuses a repeated asset, which would give one asset two policies', () => {
    expect(() => parseOnchainAssetPairs(`USDA:${ASSET}:6,USDB:${ASSET}:6`)).toThrow(/names asset .* twice/)
  })

  it('refuses a malformed entry rather than guessing which field is missing', () => {
    expect(() => parseOnchainAssetPairs(`USDA:${ASSET}`)).toThrow(/SYMBOL:assetId:decimals/)
  })
})

describe('onchainAssetMarkets', () => {
  it('requires a declared feed', () => {
    expect(() => onchainAssetMarkets(PAIRS(), env({ [`${STEM}_PRICE_FEED`]: '' }))).toThrow(/PRICE_FEED is required/)
  })

  it('refuses a feed that is not an absolute http(s) URL', () => {
    expect(() => onchainAssetMarkets(PAIRS(), env({ [`${STEM}_PRICE_FEED`]: 'feed.example' }))).toThrow(
      /must be an absolute URL/,
    )
    expect(() => onchainAssetMarkets(PAIRS(), env({ [`${STEM}_PRICE_FEED`]: 'ftp://feed.example' }))).toThrow(
      /must be http or https/,
    )
  })

  it('requires the payout bounds, the sats limits bounding only the give', () => {
    expect(() => onchainAssetMarkets(PAIRS(), env({ [`${STEM}_MIN_PAYOUT`]: '', [`${STEM}_MAX_PAYOUT`]: '' }))).toThrow(
      /are required/,
    )
  })

  it('refuses a lone payout bound', () => {
    expect(() => onchainAssetMarkets(PAIRS(), env({ [`${STEM}_MAX_PAYOUT`]: '' }))).toThrow(
      /must be set together or not at all/,
    )
  })

  it('refuses a maximum below the minimum', () => {
    expect(() =>
      onchainAssetMarkets(PAIRS(), env({ [`${STEM}_MIN_PAYOUT`]: '10', [`${STEM}_MAX_PAYOUT`]: '9' })),
    ).toThrow(/may not exceed/)
  })

  it('refuses a fee that would consume the whole payout', () => {
    expect(() => onchainAssetMarkets(PAIRS(), env({ [`${STEM}_FEE_BPS`]: '10000' }))).toThrow(/below 10000/)
  })

  it('defaults the fee to zero rather than inventing a margin', () => {
    const [market] = onchainAssetMarkets(PAIRS(), env())
    expect(market!.feeBps).toBe(0)
    expect(market!.minPayout).toBe(1n)
    expect(market!.maxPayout).toBe(1_000_000_000n)
    expect(market!.decimals).toBe(6)
  })
})
