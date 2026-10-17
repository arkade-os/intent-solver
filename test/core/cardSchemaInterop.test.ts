import { describe, expect, it, vi } from 'vitest'
import { createSwapClient } from '@arkade-os/swap'
import { lightningSendRequest } from '@arkade-os/swap/protocol'
import { admissionWallet, legacyLightningCard, TIMING_INVOICE } from '../interop/clientAdmission.js'
import { createCorridorSet } from '@arkade-os/solver-core/core/corridor.js'
import { respondToRfqRequest } from '@arkade-os/solver-transport/ingress/rfq.js'

const OLD_CARD_MARKET = {
  pair: 'BTC/lightning:BTC',
  base_corridor: 'arkade' as const,
  quote_corridor: 'lightning' as const,
  base_asset: { id: 'btc', ticker: 'BTC' },
  quote_asset: { id: 'btc', ticker: 'BTC' },
}

describe('registry card schema interoperability', () => {
  it('continues serving the RFQ produced from an old-schema Lightning market', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    try {
      const client = createSwapClient({
        wallet: admissionWallet,
        discovery: {
          snapshot: [
            {
              ...legacyLightningCard,
              ...OLD_CARD_MARKET,
              base_asset: { ...legacyLightningCard.base_asset, ...OLD_CARD_MARKET.base_asset },
              quote_asset: { ...legacyLightningCard.quote_asset, ...OLD_CARD_MARKET.quote_asset },
            },
          ],
        },
        corridors: {
          lightning: {
            decode: (raw) => ({ raw, paymentHash: 'b'.repeat(64), amountSats: 2100, expiresAt: 1_800_000_900 }),
          },
        },
      })
      const route = await client.resolve({ to: TIMING_INVOICE })
      expect(route.take.asset).toBe('bolt11:regtest/slip44:1')
      expect(route.eligible).toBe(1)
    } finally {
      vi.useRealTimers()
    }

    const request = lightningSendRequest({
      rfqId: 'a'.repeat(64),
      invoice: 'lnbcrt1legacyclient',
      refundAddress: 'tark1qlegacyclient',
      senderPubkey: new Uint8Array(32).fill(2),
    })
    expect(request.pair).toBe('arkade:BTC->lightning:BTC')

    const quote = vi.fn(async () => ({ kind: 'quote', payload: { type: 'rfq_quote' } }))
    const corridor = {
      descriptor: { pair: request.pair, envStem: 'LN_SEND' },
      quote,
    }
    const outcome = await respondToRfqRequest(createCorridorSet([corridor as never]), request)

    expect(outcome.kind).toBe('quote')
    expect(quote).toHaveBeenCalledWith(request, undefined)
  })
})
