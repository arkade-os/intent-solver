/**
 * Each corridor's own RFQ handling: validate a request against ITS schema, and
 * issue or refuse terms.
 *
 * Moved out of `ingress/rfq.ts` because this is the corridor's knowledge, not
 * the transport's. The ingress now does one registry lookup and one wire-contract
 * check; everything about what a request MEANS lives here, beside the corridor
 * that means it.
 *
 * These return `CorridorRfqOutcome`, core's shape, rather than the ingress's
 * `RfqOutcome`. That is what removes the last reason for a corridor to import
 * the transport that dispatches to it — and it is why a third-party corridor can
 * be written against core alone.
 *
 * Refusal discipline is unchanged and still not this file's to relax: every
 * reason here comes from the closed RFQ set, and `enforceWireContract` in the
 * ingress checks that again on the way out precisely because a corridor is
 * third-party code from the host's point of view.
 */
import { ArkAddress } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { lockupDeadlineFor } from '@arkade-os/solver-core/core/send.js'
import { decodeInvoice, InvalidInvoice } from '@arkade-os/solver-core/invoice/decode.js'
import type { CorridorRfqOutcome as RfqOutcome } from '@arkade-os/solver-core/core/corridor.js'
import type { SendSwapService } from '../send/orchestrator.js'
import type { OnchainSendSwapService } from '../send/onchainOrchestrator.js'
import type { ReceiveSwapService } from '../receive/orchestrator.js'
import type { OnchainReceiveSwapService } from '../receive/onchainOrchestrator.js'
import {
  LightningReceiveRfqRequest,
  lightningReceiveRfqQuotePayload,
  RFQ_PAIR_RECEIVE,
} from '../wire/lightningReceivePayloads.js'
import {
  OnchainReceiveRfqRequest,
  onchainReceiveRfqQuotePayload,
  RFQ_PAIR_ONCHAIN_RECEIVE,
} from '../wire/onchainReceivePayloads.js'
import type { SwapStore } from '../db/swaps.js'
import type { OnchainSendSwapStore } from '../db/onchainSwaps.js'
import { RFQ_PAIR_SEND, RfqRequest, rfqQuotePayload, rfqRefusalPayload } from '../wire/payloads.js'
import { RFQ_PAIR_ONCHAIN_SEND, OnchainRfqRequest, onchainRfqQuotePayload } from '../wire/onchainPayloads.js'

// Corridor-neutral refusal helpers live with the RFQ vocabulary in core; the
// transport reaches them through this module, so the re-export stays.
export { extractRfqId, zodDetail } from '@arkade-os/solver-core/core/rfqProtocol.js'
import { extractRfqId, zodDetail } from '@arkade-os/solver-core/core/rfqProtocol.js'

export const respondToLightningReceiveRfqRequest = async (
  service: ReceiveSwapService,
  payload: unknown,
): Promise<RfqOutcome> => {
  const parsed = LightningReceiveRfqRequest.safeParse(payload)
  if (!parsed.success) {
    return {
      kind: 'invalid',
      payload: rfqRefusalPayload(extractRfqId(payload), 'unsupported_payload'),
      detail: `schema: ${zodDetail(parsed.error)}`,
    }
  }
  const request = parsed.data
  if (request.pair !== RFQ_PAIR_RECEIVE) {
    return {
      kind: 'invalid',
      payload: rfqRefusalPayload(request.rfq_id, 'unsupported_pair'),
      detail: `pair '${request.pair}' reached the wrong profile`,
    }
  }

  const outcome = await service.quote({
    paymentHash: request.profile.payment_hash,
    amountSats: request.amount,
    amountSide: request.amount_side,
    payoutAddress: request.profile.payout_address,
    payoutPubkey: request.profile.payout_pubkey,
    claimPacket: request.profile.claim_packet,
    rfqId: request.rfq_id,
  })
  if (outcome.accepted) {
    return {
      kind: 'quote',
      payload: lightningReceiveRfqQuotePayload(outcome.swap, outcome.validUntil, request.rfq_id),
    }
  }
  return { kind: 'refused', payload: rfqRefusalPayload(request.rfq_id, outcome.reason), detail: outcome.reason }
}

/** `onchain:BTC->arkade:BTC`. Same shape as the Lightning receive arm above. */
export const respondToOnchainReceiveRfqRequest = async (
  service: OnchainReceiveSwapService,
  payload: unknown,
): Promise<RfqOutcome> => {
  const parsed = OnchainReceiveRfqRequest.safeParse(payload)
  if (!parsed.success) {
    return {
      kind: 'invalid',
      payload: rfqRefusalPayload(extractRfqId(payload), 'unsupported_payload'),
      detail: `schema: ${zodDetail(parsed.error)}`,
    }
  }
  const request = parsed.data
  if (request.pair !== RFQ_PAIR_ONCHAIN_RECEIVE) {
    return {
      kind: 'invalid',
      payload: rfqRefusalPayload(request.rfq_id, 'unsupported_pair'),
      detail: `pair '${request.pair}' reached the wrong profile`,
    }
  }

  const outcome = await service.quote({
    paymentHash: request.profile.payment_hash,
    amountSats: request.amount,
    amountSide: request.amount_side,
    claimPacket: request.profile.claim_packet,
    refundPubkey: request.profile.refund_pubkey,
    payoutAddress: request.profile.payout_address,
    payoutPubkey: request.profile.payout_pubkey,
    rfqId: request.rfq_id,
  })
  if (outcome.accepted) {
    return {
      kind: 'quote',
      payload: onchainReceiveRfqQuotePayload(outcome.swap, outcome.lockupDeadline, request.rfq_id),
    }
  }
  return { kind: 'refused', payload: rfqRefusalPayload(request.rfq_id, outcome.reason), detail: outcome.reason }
}

export const respondToLightningRfqRequest = async (
  service: SendSwapService,
  store: SwapStore,
  payload: unknown,
  /** The transport's requester identity, for quote admission control. */
  options?: { requesterKey?: string },
): Promise<RfqOutcome> => {
  const parsed = RfqRequest.safeParse(payload)
  if (!parsed.success) {
    return {
      kind: 'invalid',
      payload: rfqRefusalPayload(extractRfqId(payload), 'unsupported_payload'),
      detail: `rfq_request schema: ${zodDetail(parsed.error)}`,
    }
  }
  const request = parsed.data

  if (request.pair !== RFQ_PAIR_SEND) {
    return {
      kind: 'invalid',
      payload: rfqRefusalPayload(request.rfq_id, 'unsupported_pair'),
      detail: `pair '${request.pair}' reached the wrong profile`,
    }
  }
  // A client-supplied BOLT11 forces exact-out (spec § 4.1).
  if (request.amount_side !== 'to') {
    return {
      kind: 'invalid',
      payload: rfqRefusalPayload(request.rfq_id, 'unsupported_payload'),
      detail: `amount_side is '${request.amount_side}', must be 'to' — a client bolt11 forces exact-out`,
    }
  }

  // Decode locally for the natural key and the amount cross-check. Decode
  // failures are payload failures — the closed enum never leaks onto the RFQ
  // wire.
  //
  // With the SERVICE's hint denylist, not a raw decode. This runs before
  // `service.quote` and refuses on what it throws, so a raw reading here would
  // refuse at the ingress exactly the invoice the denylist makes payable one
  // call later — the best-hint floor fires on the very hint we are declining to
  // price.
  let decoded
  try {
    decoded = decodeInvoice(request.profile.invoice, service.sendHintScidDenylist)
  } catch (error) {
    if (error instanceof InvalidInvoice) {
      return {
        kind: 'invalid',
        payload: rfqRefusalPayload(request.rfq_id, 'unsupported_payload'),
        detail: `profile.invoice did not decode: ${error.message}`,
      }
    }
    throw error
  }
  if (request.amount !== undefined && request.amount !== decoded.amountSats) {
    return {
      kind: 'invalid',
      payload: rfqRefusalPayload(request.rfq_id, 'unsupported_payload'),
      detail: `amount ${request.amount} does not match the invoice's ${decoded.amountSats} sats`,
    }
  }

  // An rfq_id reused with DIFFERENT content is a conflict, whatever state the
  // prior negotiation is in (spec § 4.5). Same content falls through to the
  // natural-key path below, which re-emits or conflicts as the row dictates.
  const prior = await store.findByRfqId(request.rfq_id)
  if (prior && prior.paymentHash !== decoded.paymentHash) {
    return {
      kind: 'refused',
      payload: rfqRefusalPayload(request.rfq_id, 'quote_conflict'),
      detail: 'rfq_id reused with different content',
    }
  }

  let outcome
  try {
    outcome = await service.quote(request.profile.invoice, request.profile.refund_address, {
      rfqId: request.rfq_id,
      requesterKey: options?.requesterKey,
      clientRefundPubkey: request.profile.client_refund_pubkey,
    })
  } catch (error) {
    if (error instanceof InvalidInvoice) {
      return {
        kind: 'invalid',
        payload: rfqRefusalPayload(request.rfq_id, 'unsupported_payload'),
        detail: `quote rejected the invoice: ${error.message}`,
      }
    }
    throw error
  }
  if (outcome.accepted) {
    return { kind: 'quote', payload: rfqQuotePayload(outcome.swap, outcome.lockupDeadline, request.rfq_id) }
  }

  if (outcome.reason === 'duplicate_swap') {
    // Duplicate request → re-emit the EXISTING quote, but only while it is
    // still a live, fundable quote (a funded/terminal swap must never hand the
    // client a fundable-looking payload) AND only when this request's content
    // matches what was actually quoted.
    // `client_refund_pubkey` is generated FRESH per attempt by the reference
    // trader library (examples/lib/swap-client.mjs) — a second attempt on the
    // same invoice ordinarily carries a DIFFERENT key, and re-emitting the
    // first attempt's quote regardless would hand back a lockup_address the
    // client's own (correctly, newly-derived) script can never match: spec
    // § 4.5 requires "same content" for a re-emit, "different content" is
    // `quote_conflict` — falling through to the refusal below. A row quoted
    // WITHOUT a client key (the CLI's self-test commands) is NEVER
    // compatible with an RFQ-family retry either, even though this request's
    // own key can't be compared against "no key": `rfqQuotePayload` omits
    // `receiver_pk_script` for such a row (src/wire/payloads.ts), and the
    // reference client's `deriveLockup` decodes that field unconditionally,
    // before it ever reaches address verification — re-emitting it here
    // would hand the client a payload its own code cannot parse, not a clean
    // refusal. Only an RFQ-family row's OWN key is ever binding.
    const existing = await store.findLiveByPaymentHash(decoded.paymentHash)
    if (
      existing?.state === 'quoted' &&
      existing.clientRefundPubkey === request.profile.client_refund_pubkey &&
      existing.refundPkScript === hex.encode(ArkAddress.decode(request.profile.refund_address).pkScript)
    ) {
      return {
        kind: 'quote',
        payload: rfqQuotePayload(
          existing,
          lockupDeadlineFor(existing.createdAt, existing.invoiceExpiresAt, service.lockupTimeout),
          request.rfq_id,
        ),
      }
    }
  }
  return {
    kind: 'refused',
    payload: rfqRefusalPayload(request.rfq_id, outcome.reason),
    // The reason alone no longer says which gate refused: `cltv_too_large` has
    // two, and they mean different things to an operator. Log-only, as ever.
    detail: outcome.detail ? `${outcome.reason}: ${outcome.detail}` : outcome.reason,
  }
}

export const respondToOnchainRfqRequest = async (
  service: OnchainSendSwapService,
  store: OnchainSendSwapStore,
  payload: unknown,
): Promise<RfqOutcome> => {
  const parsed = OnchainRfqRequest.safeParse(payload)
  if (!parsed.success) {
    return {
      kind: 'invalid',
      payload: rfqRefusalPayload(extractRfqId(payload), 'unsupported_payload'),
      detail: `schema: ${zodDetail(parsed.error)}`,
    }
  }
  const request = parsed.data
  if (request.pair !== RFQ_PAIR_ONCHAIN_SEND) {
    return {
      kind: 'invalid',
      payload: rfqRefusalPayload(request.rfq_id, 'unsupported_pair'),
      detail: `pair '${request.pair}' reached the wrong profile`,
    }
  }
  // Unlike the BOLT11 profile, nothing implies the amount here: `amount` is
  // required by the zod schema, and `amount_side` decides what it names — the
  // corridor resolves exact-out into the give against its own fee.

  const prior = await store.findByRfqId(request.rfq_id)
  if (prior && prior.paymentHash !== request.profile.payment_hash) {
    return {
      kind: 'refused',
      payload: rfqRefusalPayload(request.rfq_id, 'quote_conflict'),
      detail: 'rfq_id reused with different content',
    }
  }

  const outcome = await service.quote({
    paymentHash: request.profile.payment_hash,
    amountSats: request.amount,
    amountSide: request.amount_side,
    payoutPubkey: request.profile.payout_pubkey,
    refundAddress: request.profile.refund_address,
    clientRefundPubkey: request.profile.client_refund_pubkey,
    rfqId: request.rfq_id,
  })
  if (outcome.accepted) {
    return { kind: 'quote', payload: onchainRfqQuotePayload(outcome.swap, outcome.lockupDeadline, request.rfq_id) }
  }
  return { kind: 'refused', payload: rfqRefusalPayload(request.rfq_id, outcome.reason), detail: outcome.reason }
}
