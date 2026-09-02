/**
 * The wire contract, in one place.
 *
 * The request schema and every response payload the provider produces are the
 * message-bus payloads — versioned, typed, self-contained — and both transports
 * (HTTP host and relay ingress) speak exactly these. Defining them once is what
 * makes "byte-for-byte the same over either transport" true rather than a claim
 * two copies have to be kept in sync to honour.
 *
 * Nothing here knows about HTTP status codes or relay envelopes: a transport
 * maps a payload to its own framing, it does not shape the payload.
 */

import { z } from 'zod'
import { WIRE_AMOUNT } from '@arkade-os/solver-core/core/wireAmount.js'
import { MAX_PAIR_LENGTH } from '@arkade-os/solver-core/core/marketKey.js'
import type { SendSwapRow } from '../db/swaps.js'
import { amountSatsOf } from '@arkade-os/solver-core/invoice/decode.js'

// --------------------------------------------------------------------------
// RFQ v1 — the one and only family (docs/rfq-protocol.md). The pre-RFQ
// `ln_send_*` shape was removed unserved: nothing was ever deployed against
// it, so there is no transition to honour.
// --------------------------------------------------------------------------

/** The pair this profile serves. */
export const RFQ_PAIR_SEND = 'arkade:BTC->lightning:BTC'

export {
  RFQ_ID,
  RFQ_PAIR,
  AMOUNT_SIDE,
  RFQ_AMOUNT,
  RfqStatusRequest,
  RfqOpen,
  rfqBidPayload,
  RFQ_REFUSAL_REASON_VALUES,
  isRfqRefusalReason,
  RFQ_REFUSAL_REASONS,
  toRfqReason,
  rfqRefusalPayload,
  type RfqOpenPayload,
  type RfqRefusalReason,
} from '@arkade-os/solver-core/core/rfqProtocol.js'
import { RFQ_ID, RFQ_PAIR, AMOUNT_SIDE, RFQ_AMOUNT } from '@arkade-os/solver-core/core/rfqProtocol.js'

/**
 * RFQ request for the send profile. Strict per the spec: unknown fields
 * anywhere — envelope or profile — are `unsupported_payload`. The pair is
 * validated for SHAPE here; whether it is SERVED is the ingress's decision
 * (`unsupported_pair`), so the two refusals stay distinguishable.
 */
export const RfqRequest = z
  .object({
    v: z.literal(1),
    type: z.literal('rfq_request'),
    rfq_id: RFQ_ID,
    pair: RFQ_PAIR,
    amount_side: AMOUNT_SIDE,
    // The BOLT11 fixes the amount; when present this must match it (checked
    // against the decoded invoice at the ingress, not here).
    amount: RFQ_AMOUNT.optional(),
    profile: z
      .object({
        invoice: z.string().min(1).max(2048),
        refund_address: z.string().min(1).max(200),
        client_refund_pubkey: z
          .string()
          .length(64)
          .regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
  })
  .strict()

export const rfqQuotePayload = (row: SendSwapRow, validUntil: number, rfqId: string): Record<string, unknown> => ({
  v: 1,
  type: 'rfq_quote',
  rfq_id: rfqId,
  pair: RFQ_PAIR_SEND,
  // The two sides of the spread, and they are no longer the same number.
  // `from_amount` is what the client must lock up — THE AMOUNT TO FUND, and
  // the only one the funding gate accepts. `to_amount` is what the payee
  // receives, which is the invoice's own amount, re-decoded from the row's
  // invoice rather than stored: that string is what the quote was built from,
  // so it cannot go stale against a second copy.
  //
  // A client that funds `to_amount` underfunds by exactly the fee and gets
  // refused. That is the intended failure — loud, immediate, and refundable —
  // rather than the solver silently absorbing the difference.
  //
  // Read with `amountSatsOf`, NOT `decodeInvoice`: re-decoding is right, but
  // re-JUDGING an invoice the quote above already accepted is a second opinion
  // on a settled question. It can differ — a hint the send leg's scid denylist
  // dropped is still in the raw string — and the difference would throw while
  // building the quote, so the client is never answered at all.
  from_amount: row.amountSats,
  to_amount: amountSatsOf(row.invoice),
  solver_pubkey: row.receiverPubkey,
  valid_until: validUntil,
  refund_locktime: row.refundLocktime,
  profile: {
    payment_hash: row.paymentHash,
    lockup_address: row.lockupAddress,
    // Compare-only, same as lockup_address: the solver's own claim
    // destination, needed only so the client's local script reconstruction
    // (which must include EVERY leaf to compute a matching merkle root) can
    // fill in the nonInteractiveClaim leaf. A wrong value here only makes
    // that one leaf unusable for the solver — it pays out, not away from any
    // client-controlled destination — so it carries none of lockup_address's
    // trust weight.
    ...(row.receiverPkScript !== null ? { receiver_pk_script: row.receiverPkScript } : {}),
  },
})

/** The RFQ lifecycle vocabulary (docs/rfq-protocol.md § 8). */
export type RfqState =
  'refused' | 'quoted' | 'expired' | 'funded' | 'filling' | 'filled' | 'settled' | 'refunded' | 'stuck'

// The reasons `fail()` stamps on a quoted swap that timed out rather than being
// declined — the wire-level `expired` refinement of the legacy `refused`.
const EXPIRY_REASONS =
  /^(lockup timeout|invoice expired before funding completed|lockup arrived after the funding deadline)/

/** Map a row to the RFQ state vocabulary — the § 8 table, in code. */
export const rfqStateFromRow = (row: SendSwapRow): RfqState => {
  switch (row.state) {
    case 'quoted':
      return 'quoted'
    case 'funded':
      return 'funded'
    case 'paying':
      return 'filling'
    case 'paid':
    case 'claiming':
      return 'filled'
    case 'claimed':
      return 'settled'
    case 'stuck':
      // A refunded stuck swap is `refunded` TO THE CLIENT. The two facts are
      // about different people: `stuck` says an operator should look at why the
      // payment died, `refund_outcome` says the client's sats went back. Only
      // the second is the client's business, and reporting `stuck` to someone
      // whose money has already been returned is the answer most likely to make
      // them act on a problem they no longer have.
      if (row.refundOutcome !== null) return 'refunded'
      return 'stuck'
    case 'refused':
      if (row.refundOutcome !== null) return 'refunded'
      if (row.failureReason !== null && EXPIRY_REASONS.test(row.failureReason)) return 'expired'
      return 'refused'
  }
}

export const rfqStatusPayload = (row: SendSwapRow, rfqId: string): Record<string, unknown> => {
  const state = rfqStateFromRow(row)
  return {
    v: 1,
    type: 'rfq_status',
    rfq_id: rfqId,
    state,
    updated_at: row.updatedAt,
    profile: {
      payment_hash: row.paymentHash,
      lockup_address: row.lockupAddress,
      claim_txid: row.claimArkTxid,
      refund_txid: row.refundArkTxid,
      failure_reason: row.failureReason,
      // The backend's own word on the outbound fill (`in_flight` vs `wedged`),
      // which § 8's state cannot express: `filling`/`filled` say where the fill
      // got to, not whether it is still moving. It rides here rather than as a
      // new state because the § 8 vocabulary is shared by every corridor and
      // clients switch on it exhaustively — an older client ignores an unknown
      // profile key, but a new state would break it. Omitted entirely when the
      // backend never offered one, so absence never reads as a verdict.
      ...(row.paymentEvidence !== null ? { payment_evidence: row.paymentEvidence } : {}),
      ...(row.paymentFailureReason !== null ? { payment_failure_reason: row.paymentFailureReason } : {}),
      ...(row.receiverPkScript !== null ? { receiver_pk_script: row.receiverPkScript } : {}),
      // Receipts appear in `settled` only — same rule as the legacy family.
      ...(state === 'settled' && row.preimage ? { preimage: row.preimage } : {}),
    },
  }
}
