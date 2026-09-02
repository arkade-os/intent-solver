/**
 * The wire contract for `arkade:BTC->onchain:BTC`, following the same rules
 * as `src/wire/payloads.ts`: binding fields at the top level, everything in
 * `profile` compare-only or informational, nothing here knows about HTTP
 * status codes or relay envelopes.
 *
 * Field names below are copied verbatim from `arkade-os/ts-sdk`'s
 * `@arkade-os/swap` package (`onchainSendRequest`/`deriveOnchainSend`,
 * `feat/arkade-swap` branch, PR #667, confirmed against its merged source) —
 * not invented. In particular: `payment_hash` (not `preimage_hash`),
 * `payout_pubkey` (the request's field — the client's onchain claim key),
 * `htlc_pubkey` (the quote's field — the solver's onchain refund key),
 * `htlc_locktime` (absolute unix seconds, not a block height), `htlc_address`
 * (the onchain HTLC's own address — kept SEPARATE from `lockup_address`, the
 * Arkade-side address), and `min_confirmations`.
 */

import { z } from 'zod'
import { WIRE_AMOUNT } from '@arkade-os/solver-core/core/wireAmount.js'
import { MAX_PAIR_LENGTH } from '@arkade-os/solver-core/core/marketKey.js'
import type { OnchainSendSwapRow } from '../db/onchainSwaps.js'
import { type RfqState, rfqRefusalPayload } from './payloads.js'

export const RFQ_PAIR_ONCHAIN_SEND = 'arkade:BTC->onchain:BTC'

const RFQ_ID = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/)
// 64 hex chars: sha256(P) for payment_hash, an x-only pubkey for payout_pubkey — same shape, kept as two named constants for readability at call sites.
const HEX32 = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/)
const XONLY_HEX = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/)

export const OnchainRfqRequest = z
  .object({
    v: z.literal(1),
    type: z.literal('rfq_request'),
    rfq_id: RFQ_ID,
    pair: z.string().min(1).max(MAX_PAIR_LENGTH),
    amount_side: z.enum(['from', 'to']),
    // Unlike the BOLT11 profile, nothing implies the amount here — always required.
    amount: WIRE_AMOUNT,
    profile: z
      .object({
        payment_hash: HEX32,
        payout_pubkey: XONLY_HEX,
        refund_address: z.string().min(1).max(200),
        client_refund_pubkey: XONLY_HEX,
      })
      .strict(),
  })
  .strict()

export const onchainRfqQuotePayload = (
  row: OnchainSendSwapRow,
  validUntil: number,
  rfqId: string,
): Record<string, unknown> => ({
  v: 1,
  type: 'rfq_quote',
  rfq_id: rfqId,
  pair: RFQ_PAIR_ONCHAIN_SEND,
  // The two sides of the spread. `from_amount` is what the client locks at
  // the Arkade covenant; `to_amount` is what the solver funds the onchain
  // HTLC with — the persisted payout, amount minus this corridor's fee.
  from_amount: row.amountSats,
  to_amount: row.payoutSats,
  solver_pubkey: row.providerPubkey,
  valid_until: validUntil,
  refund_locktime: row.refundLocktime,
  profile: {
    payment_hash: row.paymentHash,
    htlc_pubkey: row.htlcPubkey,
    htlc_locktime: row.htlcLocktime,
    min_confirmations: row.minConfirmations,
    // Compare-only, both addresses distinctly: lockup_address is the
    // Arkade-side script, htlc_address is the onchain HTLC — never collapse
    // these into one field.
    lockup_address: row.lockupAddress,
    htlc_address: row.onchainAddress,
    // Compare-only, same trust tier as lockup_address's neighbours above:
    // the solver's own claim destination — see payloads.ts's rfqQuotePayload
    // for why this is needed and why it's low-stakes if wrong.
    receiver_pk_script: row.receiverPkScript,
  },
})

const EXPIRY_REASONS = /^(lockup timeout)/

export const onchainRfqStateFromRow = (row: OnchainSendSwapRow): RfqState => {
  switch (row.state) {
    case 'quoted':
      return 'quoted'
    case 'funded':
      return 'funded'
    case 'funding_onchain':
      return 'filling'
    case 'awaiting_claim':
    case 'claiming':
      return 'filled'
    case 'claimed':
      return 'settled'
    // The client never claimed past htlc_locktime, so the solver is
    // reclaiming its own onchain funds — same in-progress-broadcast shape
    // funding_onchain already reports as 'filling', just on the failure path.
    case 'refunding_onchain':
      return 'filling'
    case 'refunded':
      return 'refunded'
    case 'stuck':
      return 'stuck'
    case 'refused':
      if (row.refundOutcome !== null) return 'refunded'
      if (row.failureReason !== null && EXPIRY_REASONS.test(row.failureReason)) return 'expired'
      return 'refused'
  }
}

export const onchainRfqStatusPayload = (row: OnchainSendSwapRow, rfqId: string): Record<string, unknown> => {
  const state = onchainRfqStateFromRow(row)
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
      receiver_pk_script: row.receiverPkScript,
      funding_txid: row.fundingTxid,
      claim_txid: row.claimArkTxid,
      refund_txid: row.refundArkTxid,
      failure_reason: row.failureReason,
      ...(state === 'settled' && row.preimage ? { preimage: row.preimage } : {}),
    },
  }
}

export { rfqRefusalPayload }
