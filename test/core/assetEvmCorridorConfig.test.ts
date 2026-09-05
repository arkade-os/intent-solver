/**
 * The operator-facing surface of the one corridor with no sats on either leg.
 *
 * #22 argued this pair should be composed rather than built, because
 * `MAX_EXPOSED_SATS` has no sats figure to count here. It is built instead, on
 * an operator-declared market — so every bound it has is one of these env vars,
 * and a bound that reads as absent is a corridor with no ceiling at all. That is
 * what these guards are for.
 */

import { describe, it, expect } from 'vitest'
import {
  parseAssetEvmMarkets,
  assetEvmEnvStem,
  assetEvmCorridorPolicies,
} from '@arkade-os/solver-core/core/assetEvmCorridorConfig.js'

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const ASSET_ID = 'ab'.repeat(32) + '0100'
const TOKENS = [{ symbol: 'USDC', address: USDC, decimals: 6 }]

const market = () => {
  const parsed = parseAssetEvmMarkets(`USDA:${ASSET_ID}:6:USDC`, TOKENS)
  expect(parsed).toHaveLength(1)
  return parsed
}

const STEM = () => assetEvmEnvStem(market()[0]!.asset, market()[0]!.token)

const env = (over: Record<string, string> = {}) => {
  const stem = STEM()
  const base: Record<string, string> = {
    [`${stem}_MIN_UNITS`]: '1000',
    [`${stem}_MAX_UNITS`]: '1000000',
    [`${stem}_PRICE_FEED`]: 'https://feed.example/price',
    [`${stem}_PRICE_PATH`]: '/price',
  }
  const all = { ...base, ...over }
  return (name: string): string | undefined => all[name]
}

describe('parseAssetEvmMarkets', () => {
  it('treats unset as no such corridor rather than as a default', () => {
    expect(parseAssetEvmMarkets(undefined, TOKENS)).toEqual([])
    expect(parseAssetEvmMarkets('   ', TOKENS)).toEqual([])
  })

  it('refuses an entry that is not TICKER:assetId:decimals:TOKENSYMBOL', () => {
    expect(() => parseAssetEvmMarkets(`USDA:${ASSET_ID}:6`, TOKENS)).toThrow(/TICKER:assetId:decimals:TOKENSYMBOL/)
  })
})

describe('assetEvmCorridorPolicies', () => {
  it('requires the per-swap bounds, because nothing else bounds a swap here', () => {
    const stem = STEM()
    const neither = env({ [`${stem}_MIN_UNITS`]: '', [`${stem}_MAX_UNITS`]: '' })
    expect(() => assetEvmCorridorPolicies(market(), neither)).toThrow(/are required/)
  })

  it('refuses a lone bound, which reads as a ceiling an operator did not set', () => {
    const stem = STEM()
    expect(() => assetEvmCorridorPolicies(market(), env({ [`${stem}_MIN_UNITS`]: '' }))).toThrow(
      /must be set together or not at all/,
    )
  })

  it('requires a declared feed, so no rate is ever composed from two hops', () => {
    const stem = STEM()
    expect(() => assetEvmCorridorPolicies(market(), env({ [`${stem}_PRICE_FEED`]: '' }))).toThrow(
      /PRICE_FEED is required/,
    )
  })

  it('refuses an aggregate ceiling below the per-swap one', () => {
    // Otherwise the corridor advertises a size the aggregate refuses to fill,
    // which reads to a client as an intermittent solver rather than a bound.
    const stem = STEM()
    expect(() =>
      assetEvmCorridorPolicies(market(), env({ [`${stem}_MAX_EXPOSED_UNITS`]: '999999' })),
    ).toThrow(/MAX_EXPOSED_UNITS may not be below/)
  })

  it('leaves the aggregate ceiling absent when unset, rather than inventing one', () => {
    const [policy] = assetEvmCorridorPolicies(market(), env())
    expect(policy!.maxExposedUnits).toBeUndefined()
    expect(policy!.assetLimits).toEqual({ minUnits: 1000n, maxUnits: 1000000n })
  })

  it('carries the aggregate ceiling through when it is set', () => {
    const stem = STEM()
    const [policy] = assetEvmCorridorPolicies(market(), env({ [`${stem}_MAX_EXPOSED_UNITS`]: '5000000' }))
    expect(policy!.maxExposedUnits).toBe(5_000_000n)
  })

  it('charges no flat sats, there being no sats leg to charge it against', () => {
    const [policy] = assetEvmCorridorPolicies(market(), env())
    expect(policy!.fee.flatSats).toBe(0)
  })
})
