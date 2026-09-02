/**
 * The RFQ ingress decodes the client's invoice ITSELF, before `quote` is ever
 * called — for the natural key and the amount cross-check — and that decode has
 * to see the hints the quote will see.
 *
 * The two can disagree in exactly one direction, and it is the one that matters:
 * an invoice whose ONLY route hint is denylisted reads as hintless to the
 * service (0 blocks, the honest reading — a payer routes to it without hints)
 * and as a 40000-block demand to a raw decode, which the best-hint floor
 * refuses. A raw reading here would therefore answer `unsupported_payload` at
 * the ingress for precisely the invoice the denylist exists to make payable,
 * and the quote it was protecting would never be asked.
 */

import { describe, it, expect } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { respondToRfqRequest } from '@arkade-os/solver-transport/ingress/rfq.js'
import { setFrom, type RfqServices } from '../support/corridorSet.js'
import { forgeInvoiceWithPreimage } from '@arkade-os/solver-rails-fake/ln/fake/bolt11.js'
import type { SendSwapService } from '@arkade-os/solver-corridors/send/orchestrator.js'
import type { SwapStore } from '@arkade-os/solver-corridors/db/swaps.js'

const DENIED = 'aaaaaaaaaaaaaaaa'
const CLIENT_REFUND_PUBKEY = hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(20)))
const RFQ_ID = 'b2'.repeat(32)

/** An invoice carrying nothing but a hint the operator has denylisted. */
const DENIED_ONLY = forgeInvoiceWithPreimage({
  network: 'bc',
  amountSats: 2100,
  timestamp: 1_734_606_755,
  expirySeconds: 6 * 3600,
  minFinalCltvBlocks: 60,
  routeHints: [[{ cltv: 40_000, scid: DENIED }]],
}).invoice

/**
 * A service that answers a refusal of its own. The point of the test is which
 * layer refuses, so `quote` returning something distinguishable is enough —
 * reaching it at all is the assertion.
 */
const serviceWith = (denylist: ReadonlySet<string>) =>
  ({
    send: {
      sendHintScidDenylist: denylist,
      quote: async () => ({ accepted: false, reason: 'pricing_unavailable' }),
    } as unknown as SendSwapService,
  }) as RfqServices

const store = { findByRfqId: async () => null } as unknown as SwapStore

const request = {
  v: 1,
  type: 'rfq_request',
  rfq_id: RFQ_ID,
  pair: 'arkade:BTC->lightning:BTC',
  amount_side: 'to',
  profile: {
    invoice: DENIED_ONLY,
    refund_address: 'ark1refundaddress',
    client_refund_pubkey: CLIENT_REFUND_PUBKEY,
  },
}

describe('the RFQ ingress decodes with the send service hint denylist', () => {
  it('refuses at its own decode when nothing is denylisted', async () => {
    // Non-vacuous: the floor really does fire on this invoice, and the ingress
    // really is where it fires — before the quote.
    const outcome = await respondToRfqRequest(setFrom(serviceWith(new Set()), { store }), request)
    expect(outcome.kind).toBe('invalid')
    expect(outcome.detail).toContain('profile.invoice did not decode')
    expect(outcome.detail).toContain('cltv_too_large')
  })

  it('reaches the quote once the hint is denylisted', async () => {
    const outcome = await respondToRfqRequest(setFrom(serviceWith(new Set([DENIED])), { store }), request)
    expect(outcome.kind).toBe('refused')
    expect(outcome.detail).toBe('pricing_unavailable')
  })
})
