/**
 * The wire contract for `onchain:BTC->arkade:BTC` — the mirror of
 * `src/wire/onchainPayloads.ts` (send).
 *
 * Field names mirror the send leg's actual shipped shape (`payout_pubkey`/
 * `htlc_pubkey`/`htlc_locktime`/`htlc_address`/`lockup_address`), not the
 * design doc's more generic `client_pubkey`/`solver_pubkey` sketch — the doc
 * itself says to follow the code's precedent (see
 * `docs/superpowers/specs/2026-08-06-onchain-send-receive-design.md`), and
 * the send leg's own header comment explains why: those names are copied
 * verbatim from `arkade-os/ts-sdk`'s `@arkade-os/swap` package, not invented.
 * Role reversal, spelled out because the send leg's names describe roles,
 * not directions: `payout_pubkey` (send request) was the client's ONCHAIN
 * CLAIM key; here the client instead holds the onchain HTLC's REFUND role,
 * so the analogous request field is `refund_pubkey`. `htlc_pubkey` (send
 * quote) was the solver's onchain REFUND key; here the solver holds the
 * onchain HTLC's CLAIM role, so the analogous quote field is `claim_pubkey`.
 *
 * One field the send leg has NO analogue for: `refund_address` (send) is
 * where the CLIENT gets refunded on the ARKADE side if the swap fails —
 * there is no such field here, because on this leg the client never funds
 * the Arkade side at all, so it has nothing to be refunded FROM there.
 *
 * The client's Arkade-side fields are `payout_address` and `payout_pubkey`,
 * named and meaning exactly what they do on the Lightning receive profile
 * (`wire/lightningReceivePayloads.ts`) — the two receive corridors carry the
 * SAME Arkade covenant, so they ask the client for the same two things.
 * `payout_address` is the destination `nonInteractiveClaim` is pinned to;
 * `payout_pubkey` is the covenant's `receiver` SIGNING key, which is what
 * lets the client spend the collaborative claim leaf itself.
 *
 * An earlier revision omitted `payout_pubkey`, reasoning that the client
 * never signs anything on the Arkade side because covclaimd claims for it.
 * That made covclaimd a hard dependency of the corridor — and
 * `covclaimd:v0.0.1-rc.1` accepts a reveal against this covenant and then
 * silently never claims (observed on regtest 2026-08-07), which would have
 * left the corridor with no working claim path at all.
 */

import { z } from 'zod'
import { WIRE_AMOUNT } from '@arkade-os/solver-core/core/wireAmount.js'
import { MAX_PAIR_LENGTH } from '@arkade-os/solver-core/core/marketKey.js'
import type { OnchainReceiveSwapRow } from '../db/onchainReceiveSwaps.js'
import { type RfqState, rfqRefusalPayload } from './payloads.js'

export const RFQ_PAIR_ONCHAIN_RECEIVE = 'onchain:BTC->arkade:BTC'

const RFQ_ID = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/)
// 64 hex chars: sha256(P) for payment_hash, an x-only pubkey for refund_pubkey — same shape, kept as two named constants for readability at call sites, same convention as onchainPayloads.ts.
const HEX32 = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/)
const XONLY_HEX = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/)

export const OnchainReceiveRfqRequest = z
  .object({
    v: z.literal(1),
    type: z.literal('rfq_request'),
    rfq_id: RFQ_ID,
    pair: z.string().min(1).max(MAX_PAIR_LENGTH),
    amount_side: z.enum(['from', 'to']),
    amount: WIRE_AMOUNT,
    profile: z
      .object({
        payment_hash: HEX32,
        /** `P` ECIES-sealed to covclaimd, base64 — see `receive/covclaimd.ts`'s `RevealParams.ciphertext`. Carried blindly; never decrypted here. */
        claim_packet: z.string().min(1).max(4096),
        /** The client's onchain HTLC refund pubkey (role-reversed from send's `payout_pubkey`). */
        refund_pubkey: XONLY_HEX,
        /** The client's Arkade payout address — where any claim must pay. */
        payout_address: z.string().min(1).max(200),
        /** The client's Arkade x-only key — the covenant's `receiver` role, so the client can claim without covclaimd. */
        payout_pubkey: XONLY_HEX,
      })
      .strict(),
  })
  .strict()

export const onchainReceiveRfqQuotePayload = (
  row: OnchainReceiveSwapRow,
  validUntil: number,
  rfqId: string,
): Record<string, unknown> => ({
  v: 1,
  type: 'rfq_quote',
  rfq_id: rfqId,
  pair: RFQ_PAIR_ONCHAIN_RECEIVE,
  // The two sides of the spread. `from_amount` is what the client funds the
  // onchain HTLC with; `to_amount` is what the solver funds the Arkade lockup
  // with — the persisted payout, amount minus this corridor's fee.
  from_amount: row.amountSats,
  to_amount: row.payoutSats,
  solver_pubkey: row.providerPubkey,
  valid_until: validUntil,
  // The SOLVER's own Arkade refund deadline on this leg — see
  // `db/onchainReceiveSwaps.ts`'s `refundLocktime` doc comment for the
  // role-reversal from the send leg's meaning of this same top-level field.
  refund_locktime: row.refundLocktime,
  profile: {
    payment_hash: row.paymentHash,
    claim_pubkey: row.htlcPubkey,
    htlc_locktime: row.htlcLocktime,
    min_confirmations: row.minConfirmations,
    // Compare-only, both addresses distinctly, same convention as the send
    // leg: lockup_address is the Arkade-side script, htlc_address is the
    // ONE the client actually verifies and funds on this leg.
    lockup_address: row.lockupAddress,
    htlc_address: row.onchainAddress,
    // Compare-only, same trust tier as its Lightning-receive analogue: the
    // solver's OWN covenant refund destination on this leg — the one
    // covenant parameter nothing else on the wire determines, needed by a
    // client (or auditor) reconstructing the full eight-leaf tree to check
    // `lockup_address` against its own derivation.
    solver_refund_pk_script: row.refundPkScript,
  },
})

const EXPIRY_REASONS = /^(lockup timeout)/

export const onchainReceiveRfqStateFromRow = (row: OnchainReceiveSwapRow): RfqState => {
  switch (row.state) {
    case 'quoted':
      return 'quoted'
    // The client's onchain HTLC has a matching output — the contract is
    // funded — even before min_confirmations is met; that threshold is our
    // own confirmation policy, not a fact about whether the contract holds
    // funds. Mirrors the send leg's own funded (Arkade lockup "seen") -> funded.
    case 'awaiting_confirmations':
      return 'funded'
    case 'funding_arkade':
      return 'filling'
    // Both collapse to filled, mirroring the send leg's own SendSwapState
    // mapping table collapsing paid+claiming into one RFQ state: the fill
    // (funding Arkade) has already succeeded in both, and the solver is
    // mid-collection (waiting on P, then using it) either way.
    case 'awaiting_claim':
    case 'claimed':
      return 'filled'
    case 'settled':
      return 'settled'
    // The solver reclaiming its own Arkade lockup is the same in-progress
    // broadcast shape funding_arkade already reports as filling, just on
    // the failure path — same reasoning the send leg's onchain mapper uses
    // for refunding_onchain.
    case 'refunding_arkade':
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

export const onchainReceiveRfqStatusPayload = (row: OnchainReceiveSwapRow, rfqId: string): Record<string, unknown> => {
  const state = onchainReceiveRfqStateFromRow(row)
  return {
    v: 1,
    type: 'rfq_status',
    rfq_id: rfqId,
    state,
    updated_at: row.updatedAt,
    profile: {
      payment_hash: row.paymentHash,
      lockup_address: row.lockupAddress,
      htlc_address: row.onchainAddress,
      funding_txid: row.fundingTxid,
      arkade_claim_txid: row.arkadeClaimTxid,
      settle_txid: row.onchainClaimTxid,
      refund_txid: row.arkadeRefundTxid,
      failure_reason: row.failureReason,
      // Preimages are receipts, emitted only once settlement itself
      // published them — rfq-protocol.md §6. `claimed` already has `P` on
      // disk (it is how the row got there) but the swap is NOT done yet
      // (the onchain side is still unclaimed), so it must not leak here
      // either — only `settled` does.
      ...(state === 'settled' && row.preimage ? { preimage: row.preimage } : {}),
    },
  }
}

export { rfqRefusalPayload }
