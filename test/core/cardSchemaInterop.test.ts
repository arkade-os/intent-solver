import { describe, expect, it, vi } from 'vitest'
import { lightningSendRequest, marketCorridor } from '@arkade-os/swap'
import { createCorridorSet } from '@arkade-os/solver-core/core/corridor.js'
import { respondToRfqRequest } from '@arkade-os/solver-transport/ingress/rfq.js'

const OLD_CARD_MARKET = {
  pair: 'BTC/lightning:BTC',
  base_corridor: 'arkade',
  quote_corridor: 'lightning',
  base_asset: { id: 'btc', ticker: 'BTC' },
  quote_asset: { id: 'btc', ticker: 'BTC' },
}

describe('registry card schema interoperability', () => {
  it('continues serving the RFQ produced from an old-schema Lightning market', async () => {
    expect(marketCorridor(OLD_CARD_MARKET, 'quote')).toBe('bolt11')

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
