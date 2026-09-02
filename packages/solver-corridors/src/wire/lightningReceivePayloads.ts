/**
 * The wire contract for `lightning:BTC->arkade:BTC`, following the same rules
 * as `src/wire/payloads.ts` and `src/wire/onchainPayloads.ts`: binding fields
 * at the top level, everything in `profile` compare-only or informational,
 * nothing here knows about HTTP status codes or relay envelopes.
 *
 * This profile is marked "specified" rather than "implemented today" in
 * docs/rfq-protocol.md §7.1.2 — the spec fixes `payment_hash`, the client's
 * payout destination and `claim_packet` on the request, but does not enumerate
 * exact field names. The shapes below are this repo's own design, chosen to
 * read as the natural role-inverted mirror of `onchainPayloads.ts`:
 *
 * - `payout_address` / `payout_pubkey` name the client's Arkade destination
 *   the same way the onchain-send profile's `payout_pubkey` names the
 *   client's onchain claim key — except HERE two fields are needed, not one,
 *   because an Arkade address is a taproot OUTPUT key (`ArkAddress`'s
 *   `vtxoTaprootKey`), not a raw signing key: it can supply the
 *   `nonInteractiveClaim` leaf's pinned destination, but NOT the raw x-only
 *   key the covenant's `receiver` role (the interactive-claim/unilateralClaim
 *   leaves) needs for a CHECKSIG. See `src/arkade/covenant.ts`'s role-inversion
 *   note: on this leg `receiver` is the CLIENT, not the solver.
 * - `solver_pubkey` (top-level, binding) doubles as the covenant's `client`
 *   role key on this leg — the solver's OWN funder-refund fallback — same
 *   collapse the send leg's OWN `solver_pubkey`/`receiver` already makes, so
 *   no separate profile field repeats it.
 * - `solver_refund_pk_script` is the one covenant parameter nothing else on
 *   the wire determines: the solver's own choice of where ITS refund lands,
 *   needed by anyone reconstructing the full eight-leaf tree (covclaimd
 *   verifies via the `taptree` bytes the solver sends it directly in
 *   `reveal()`, not via this field — this field is for a client or auditor
 *   who wants to derive `lockup_address` independently).
 */

import { z } from 'zod'
import { WIRE_AMOUNT } from '@arkade-os/solver-core/core/wireAmount.js'
import { MAX_PAIR_LENGTH } from '@arkade-os/solver-core/core/marketKey.js'
import type { ReceiveSwapRow } from '../db/receiveSwaps.js'
import { type RfqState, rfqRefusalPayload } from './payloads.js'

export const RFQ_PAIR_RECEIVE = 'lightning:BTC->arkade:BTC'

const RFQ_ID = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/)
const HEX32 = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/)
const XONLY_HEX = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/)

/**
 * RFQ request for the receive profile. Strict per the spec: unknown fields
 * anywhere are `unsupported_payload`.
 *
 * `claim_packet` is the client's preimage, ECIES-sealed to covclaimd
 * (`ephPub(33) || nonce(12) || ciphertext`, base64 — docs/rfq-protocol.md
 * §7.1.2) — opaque to this schema and to the solver; it is validated only by
 * shape (a bounded base64-ish string), never decoded here.
 */
export const LightningReceiveRfqRequest = z
  .object({
    v: z.literal(1),
    type: z.literal('rfq_request'),
    rfq_id: RFQ_ID,
    pair: z.string().min(1).max(MAX_PAIR_LENGTH),
    amount_side: z.enum(['from', 'to']),
    // Nothing implies the amount on this profile — the client never supplies
    // an invoice (the SOLVER mints one), so unlike the BOLT11 send profile,
    // amount is always required. Same rule the onchain-send profile applies.
    amount: WIRE_AMOUNT,
    profile: z
      .object({
        payment_hash: HEX32,
        payout_address: z.string().min(1).max(200),
        payout_pubkey: XONLY_HEX,
        claim_packet: z.string().min(1).max(2048),
      })
      .strict(),
  })
  .strict()

export const lightningReceiveRfqQuotePayload = (
  row: ReceiveSwapRow,
  validUntil: number,
  rfqId: string,
): Record<string, unknown> => ({
  v: 1,
  type: 'rfq_quote',
  rfq_id: rfqId,
  pair: RFQ_PAIR_RECEIVE,
  // The two sides of the spread. `from_amount` is what the client pays — the
  // hold invoice's own amount. `to_amount` is what the solver funds the
  // lockup with: the persisted payout, amount minus this corridor's fee.
  from_amount: row.amountSats,
  to_amount: row.payoutSats,
  solver_pubkey: row.solverPubkey,
  valid_until: validUntil,
  refund_locktime: row.refundLocktime,
  profile: {
    payment_hash: row.paymentHash,
    invoice: row.invoice,
    // Compare-only, same trust tier as every other leg's lockup_address: the
    // solver's own derivation of the funding contract, for a client (or
    // covclaimd) that wants to check it against its own reconstruction.
    lockup_address: row.lockupAddress,
    solver_refund_pk_script: row.solverRefundPkScript,
  },
})

// The reasons `fail()` stamps on a quoted-or-armed swap that timed out rather
// than being declined outright — the wire-level `expired` refinement of the
// legacy `refused`, same pattern `payloads.ts`'s own EXPIRY_REASONS applies.
const EXPIRY_REASONS = /^(invoice expired|hold lapsed|settle window too short)/

/**
 * Map a row to the RFQ state vocabulary (docs/rfq-protocol.md §8), in code.
 *
 * The mapping is not a 1:1 rename of `ReceiveSwapState`'s own names, because
 * this leg's maker/taker roles are INVERTED from the send legs': the CLIENT's
 * own committed action (holding the invoice) is what "funded" describes here
 * — `armed` — while the SOLVER's own action (broadcasting its Arkade lockup,
 * then covclaimd's autonomous claim) is what "filling"/"filled" describe —
 * `funded`/`claimed` on this row. See this file's own top comment and
 * `src/arkade/covenant.ts`'s role-inversion note for the same inversion
 * playing out in the covenant's `receiver`/`client` roles.
 */
export const lightningReceiveRfqStateFromRow = (row: ReceiveSwapRow): RfqState => {
  switch (row.state) {
    case 'quoted':
      return 'quoted'
    case 'armed':
      return 'funded'
    case 'funded':
      return 'filling'
    case 'claimed':
      return 'filled'
    case 'settled':
      return 'settled'
    // The client never claimed (or covclaimd never landed one) before
    // refund_locktime, so the solver is reclaiming its OWN Arkade lockup —
    // same in-progress-broadcast shape `funded` already reports as 'filling',
    // just on the failure path. Mirrors onchainRfqStateFromRow's identical
    // choice for `refunding_onchain`.
    case 'refunding':
      return 'filling'
    case 'refunded':
      return 'refunded'
    case 'stuck':
      return 'stuck'
    case 'refused':
      if (row.failureReason !== null && EXPIRY_REASONS.test(row.failureReason)) return 'expired'
      return 'refused'
  }
}

export const lightningReceiveRfqStatusPayload = (row: ReceiveSwapRow, rfqId: string): Record<string, unknown> => {
  const state = lightningReceiveRfqStateFromRow(row)
  return {
    v: 1,
    type: 'rfq_status',
    rfq_id: rfqId,
    state,
    updated_at: row.updatedAt,
    profile: {
      payment_hash: row.paymentHash,
      lockup_address: row.lockupAddress,
      refund_txid: row.refundArkTxid,
      failure_reason: row.failureReason,
      // Receipts appear in `settled` only — same rule every other leg applies.
      // In particular NOT at `claimed`: P is already public on Arkade by
      // then, but the provider has not yet been paid, so `claimed` still
      // carries no receipt on the wire.
      ...(state === 'settled' && row.preimage ? { preimage: row.preimage } : {}),
    },
  }
}

export { rfqRefusalPayload }
