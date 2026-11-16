import { describe, it, expect } from 'vitest'
import { parseAssetRfqTokens, servingFor, type AssetRfqToken } from '@arkade-os/solver-app/ops/assetRfqMarkets.js'
import { rfqSymbolFor } from '@arkade-os/solver-core/core/assetMarketConfig.js'
import type { AssetMarketRow } from '@arkade-os/solver-app/admin/db.js'

const USDA = 'aa'.repeat(34)

const row = (base: string | null, quote: string | null): AssetMarketRow =>
  ({ marketKey: `${base ?? 'BTC'}/${quote ?? 'BTC'}`, base, quote }) as AssetMarketRow

// The client may sell USDA for BTC but not buy it.
const token: AssetRfqToken = {
  symbol: 'USDA',
  assetId: USDA,
  enabled: { clientGivesAsset: true, clientGetsAsset: false },
  approvalThresholdUnits: null,
}

describe('servingFor', () => {
  it('opens sell_base when the asset is the base and the client may give it', () => {
    expect(servingFor(row(USDA, null), { offerMarkets: [], tokens: [token] }, new Set())).toEqual({
      symbol: 'USDA',
      servesOffer: false,
      servesRfq: true,
      rfqSellBase: true,
      rfqBuyBase: false,
    })
  })

  it('opens buy_base instead when BTC is the base: giving the asset is buying the base', () => {
    expect(servingFor(row(null, USDA), { offerMarkets: [], tokens: [token] }, new Set())).toMatchObject({
      rfqSellBase: false,
      rfqBuyBase: true,
    })
  })

  it('serves both directions under the derived symbol when no token names the asset', () => {
    expect(servingFor(row(null, USDA), { offerMarkets: [], tokens: [] }, new Set())).toEqual({
      symbol: rfqSymbolFor(USDA),
      servesOffer: false,
      servesRfq: true,
      rfqSellBase: true,
      rfqBuyBase: true,
    })
  })

  it('fails closed on a symbol another row already carries', () => {
    expect(servingFor(row(null, USDA), { offerMarkets: [], tokens: [token] }, new Set(['USDA']))).toMatchObject({
      symbol: null,
      servesRfq: false,
      rfqSellBase: false,
      rfqBuyBase: false,
    })
  })

  it('serves offers exactly where an offer market names the pair, in either order', () => {
    const seed = { offerMarkets: [{ a: USDA, b: null }], tokens: [] }
    expect(servingFor(row(null, USDA), seed, new Set()).servesOffer).toBe(true)
  })
})

describe('parseAssetRfqTokens directions', () => {
  it('reads each direction from the leg the client gives', () => {
    const knobs: Record<string, string> = { ASSET_USDA_TO_BTC_ENABLED: 'false' }
    const [parsed] = parseAssetRfqTokens(`USDA:${USDA}`, (name) => knobs[name])
    expect(parsed!.enabled).toEqual({ clientGivesAsset: false, clientGetsAsset: true })
  })
})
