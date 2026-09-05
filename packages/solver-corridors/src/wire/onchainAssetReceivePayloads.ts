/**
 * The wire contract for `onchain:BTC->arkade:<asset>`.
 *
 * The request is the sats leg's (`wire/onchainReceivePayloads.ts`) field for
 * field, and deliberately so: the client's side of this swap is identical — it
 * funds an L1 HTLC and names an Arkade destination — so asking it for different
 * things would be describing one action two ways. Only what comes BACK differs.
 *
 * THE PAYOUT LEG IS A DECIMAL STRING, and that is the EVM family's precedent
 * rather than a new convention: `evmPayloads.ts` carries its token leg as a
 * string in the ordinary amount slot (`EvmReceiveSwapRow.evmAmount` is a
 * `string`), because a JSON number is an IEEE-754 double in every mainstream
 * parser and an 18-decimal amount is past what one holds exactly. The GIVE here
 * is sats, which is a safe integer, so it stays a number — one leg each way,
 * each in the encoding that is lossless for it.
 */

import { z } from 'zod'
import { WIRE_AMOUNT } from '@arkade-os/solver-core/core/wireAmount.js'
import { MAX_PAIR_LENGTH } from '@arkade-os/solver-core/core/marketKey.js'
import { onchainAssetReceivePairFor } from '@arkade-os/solver-core/core/onchainAssetReceive.js'
import type { OnchainAssetReceiveSwapRow } from '../db/onchainAssetReceiveSwaps.js'
import { type RfqState, rfqRefusalPayload } from './payloads.js'

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

export const OnchainAssetReceiveRfqRequest = z
  .object({
    v: z.literal(1),
    type: z.literal('rfq_request'),
    rfq_id: RFQ_ID,
    pair: z.string().min(1).max(MAX_PAIR_LENGTH),
    /**
     * EXACT-IN ONLY. Exact-out across two different assets means inverting a
     * fetched, rounded, directional rate — § 7.1.5 refuses it on the EVM
     * corridors for exactly this reason, and `resolveAssetQuote` refuses it in
     * the decision layer. Refusing it in the SCHEMA means a client gets a
     * payload error rather than a quote refusal it has to interpret.
     */
    amount_side: z.literal('from'),
    /** Sats the client will fund the L1 HTLC with. */
    amount: WIRE_AMOUNT,
    profile: z
      .object({
        payment_hash: HEX32,
        /** `P` ECIES-sealed to covclaimd, base64 — carried blindly, never decrypted here. */
        claim_packet: z.string().min(1).max(4096),
        /** The client's onchain HTLC refund pubkey. */
        refund_pubkey: XONLY_HEX,
        /** The client's Arkade payout address — where any claim must pay. */
        payout_address: z.string().min(1).max(200),
        /** The client's Arkade x-only key — the covenant's `receiver`, so it can claim without covclaimd. */
        payout_pubkey: XONLY_HEX,
      })
      .strict(),
  })
  .strict()

export const onchainAssetReceiveRfqQuotePayload = (
  row: OnchainAssetReceiveSwapRow,
  validUntil: number,
  rfqId: string,
): Record<string, unknown> => ({
  v: 1,
  type: 'rfq_quote',
  rfq_id: rfqId,
  pair: onchainAssetReceivePairFor(row.payoutAssetId),
  from_amount: row.amountSats,
  // A string, per the module header: this leg is atomic units of an asset whose
  // precision is its own, and a JSON number cannot carry it exactly.
  to_amount: row.payoutUnits.toString(),
  solver_pubkey: row.providerPubkey,
  valid_until: validUntil,
  /** The SOLVER's own Arkade refund deadline on this leg. */
  refund_locktime: row.refundLocktime,
  profile: {
    payment_hash: row.paymentHash,
    claim_pubkey: row.htlcPubkey,
    htlc_locktime: row.htlcLocktime,
    min_confirmations: row.minConfirmations,
    lockup_address: row.lockupAddress,
    htlc_address: row.onchainAddress,
    /** Compare-only: the one covenant parameter nothing else on the wire determines. */
    solver_refund_pk_script: row.refundPkScript,
    /**
     * What the lockup will be denominated in, stated rather than left to be
     * read out of `pair`. A client verifying `lockup_address` must rebuild the
     * covenant, and the asset is one of its parameters — `decimals` because
     * the payout is atomic units and nothing else on the wire says what they
     * are worth, and `lockup_sats` because the covenant commits to a Bitcoin
     * output whose value is not derivable from the asset amount.
     */
    payout_asset_id: row.payoutAssetId,
    payout_decimals: row.payoutDecimals,
    lockup_sats: row.lockupSats,
  },
})

const EXPIRY_REASONS = /^(lockup timeout)/

export const onchainAssetReceiveRfqStateFromRow = (row: OnchainAssetReceiveSwapRow): RfqState => {
  switch (row.state) {
    case 'quoted':
      return 'quoted'
    case 'awaiting_confirmations':
      return 'funded'
    case 'funding_arkade':
      return 'filling'
    case 'awaiting_claim':
    case 'claimed':
      return 'filled'
    case 'settled':
      return 'settled'
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

export const onchainAssetReceiveRfqStatusPayload = (
  row: OnchainAssetReceiveSwapRow,
  rfqId: string,
): Record<string, unknown> => {
  const state = onchainAssetReceiveRfqStateFromRow(row)
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
      // § 6: a preimage is a receipt, emitted only once settlement published it.
      // `claimed` has `P` on disk — it is how the row got there — but the swap
      // is not done until the L1 side is collected, so only `settled` leaks it.
      ...(state === 'settled' && row.preimage ? { preimage: row.preimage } : {}),
    },
  }
}

export { rfqRefusalPayload }
