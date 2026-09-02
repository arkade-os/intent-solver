import { describe, it, expect } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { forgeInvoice, forgeInvoiceWithPreimage } from '@arkade-os/solver-rails-fake/ln/fake/bolt11.js'
import { decodeInvoice } from '@arkade-os/solver-core/invoice/decode.js'

const NOW = 1_800_000_000

describe('bolt11 forge', () => {
  it('produces an invoice OUR OWN strict decoder accepts, with every gated fact intact', () => {
    const forged = forgeInvoiceWithPreimage({
      network: 'bcrt',
      amountSats: 1000,
      timestamp: NOW,
      expirySeconds: 7200,
    })
    const decoded = decodeInvoice(forged.invoice)
    // The one fact the whole swap turns on: the invoice commits to sha256 of
    // the preimage the forge returned.
    expect(decoded.paymentHash).toBe(hex.encode(sha256(forged.preimage)))
    expect(decoded.amountSats).toBe(1000)
    expect(decoded.network).toBe('bcrt')
    expect(decoded.expiresAt).toBe(NOW + 7200)
    expect(decoded.minFinalCltvBlocks).toBe(18)
  })

  it('encodes arbitrary integer-sat amounts exactly', () => {
    for (const amountSats of [1, 500, 999, 1_000, 123_457]) {
      const forged = forgeInvoiceWithPreimage({ network: 'bcrt', amountSats, timestamp: NOW, expirySeconds: 3600 })
      expect(decodeInvoice(forged.invoice).amountSats).toBe(amountSats)
    }
  })

  it('carries the requested final CLTV', () => {
    const forged = forgeInvoiceWithPreimage({
      network: 'bcrt',
      amountSats: 1000,
      timestamp: NOW,
      expirySeconds: 3600,
      minFinalCltvBlocks: 144,
    })
    expect(decodeInvoice(forged.invoice).minFinalCltvBlocks).toBe(144)
  })

  it('rejects nonsense before encoding it', () => {
    const paymentHash = sha256(new Uint8Array(32))
    expect(() =>
      forgeInvoice({ network: 'bcrt', amountSats: 0, paymentHash, timestamp: NOW, expirySeconds: 60 }),
    ).toThrow(/positive/)
    expect(() =>
      forgeInvoice({
        network: 'bcrt',
        amountSats: 1,
        paymentHash: paymentHash.slice(4),
        timestamp: NOW,
        expirySeconds: 60,
      }),
    ).toThrow(/32 bytes/)
  })
})
