import { hex } from '@scure/base'
import { RestArkProvider, type asset } from '@arkade-os/sdk'
import type { RecycleCarrierQuote } from '@arkade-taxi/client'
import { assertArkadeFundable, type RfqQuote, type RfqTransport } from '@arkade-os/swap'
import { carrierTermsFromJson } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'

export const receiverPaidTransport = (
  upstream: RfqTransport,
  descriptor: RecycleCarrierQuote,
  taxi: { url: string; operatorKey: string },
  wantAsset: asset.AssetId,
  arkServerUrl: string,
  now: () => number = () => Math.floor(Date.now() / 1000),
) => {
  if (
    descriptor.assetId !== wantAsset.toString() ||
    descriptor.physicalSats <= 0n ||
    descriptor.loanSats !== descriptor.physicalSats
  ) {
    throw new Error('receiver-paid descriptor differs from the requested whole-dust asset carrier')
  }
  if (
    !/^[0-9a-f]{64}$/.test(descriptor.senderKey) ||
    !/^[0-9a-f]{64}$/.test(taxi.operatorKey) ||
    !descriptor.quoteId ||
    descriptor.quoteId.length > 128 ||
    !taxi.url ||
    taxi.url.length > 512 ||
    !descriptor.receiveAddress ||
    !Number.isSafeInteger(descriptor.expiresAt) ||
    descriptor.expiresAt <= 0
  ) {
    throw new Error('receiver-paid descriptor or Taxi identity is invalid')
  }
  let dust: bigint | undefined
  const assertQuote = (quote: RfqQuote) => {
    const terms = carrierTermsFromJson(quote.profile?.carrier)
    if (
      terms.mode !== 'recycle_receiver' ||
      terms.quoteId !== descriptor.quoteId ||
      terms.taxiUrl !== taxi.url ||
      terms.taxiKey !== taxi.operatorKey
    ) {
      throw new Error('receiver-paid carrier echo differs from the requested Taxi quote')
    }
    if (
      quote.carrier_sats !== undefined ||
      terms.physicalSats !== descriptor.physicalSats ||
      terms.loanSats !== descriptor.loanSats ||
      (dust !== undefined && terms.physicalSats !== dust)
    ) {
      throw new Error('receiver-paid carrier echo changes the promised whole-dust funding')
    }
    if (
      terms.expiresAt > descriptor.expiresAt ||
      quote.valid_until > terms.expiresAt ||
      now() >= quote.valid_until ||
      now() >= terms.expiresAt
    ) {
      throw Object.assign(new Error('receiver-paid carrier terms expired or extended the authorised deadline'), {
        reason: 'quote_expired',
      })
    }
    assertArkadeFundable({ quote, now: now() })
    return terms
  }
  const transport: RfqTransport = {
    status: (rfqId) => upstream.status(rfqId),
    close: () => upstream.close(),
    requestQuote: async (payload) => {
      const profile = payload.profile as Record<string, unknown> | undefined
      const key = profile?.maker_public_key
      const encoded = typeof key === 'string' ? key : key instanceof Uint8Array ? hex.encode(key) : undefined
      if (encoded !== descriptor.senderKey) throw new Error('receiver-paid descriptor differs from the wallet signer')
      const quote = await upstream.requestQuote({
        ...payload,
        profile: {
          ...profile,
          carrier: {
            mode: 'recycle_receiver',
            quote_id: descriptor.quoteId,
            taxi_url: taxi.url,
            taxi_key: taxi.operatorKey,
          },
        },
      })
      assertQuote(quote)
      dust = (await new RestArkProvider(arkServerUrl).getInfo()).dust
      assertQuote(quote)
      return quote
    },
  }
  return { transport, assertQuote }
}
