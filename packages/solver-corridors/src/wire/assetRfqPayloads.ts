/**
 * The wire contract for `arkade:<X>->arkade:<Y>` — the atomic class negotiated
 * over RFQ (`docs/rfq-protocol.md` § 7.2).
 *
 * Three things differ from the four HTLC-class corridors' wire modules, and all
 * three are spec text rather than local taste.
 *
 * NO `refund_locktime`. § 4.2 makes it "HTLC-class quotes only (absent for
 * atomic class)" and § 7.2 gives the reason: neither `fulfill` nor `cancel`
 * carries a timelock, so there is no such deadline to publish. Sending one
 * would describe a recourse path that does not exist — and worse, a client
 * sizing a window against it would believe its deposit expires when it does
 * not.
 *
 * AMOUNTS ARE STRINGS, CARRIED AS BIGINTS. § 2.1's canonical decimal form, via
 * `WIRE_ASSET_AMOUNT` rather than `WIRE_AMOUNT`: one leg of every pair here is
 * an Arkade asset whose atomic unit is 256-bit, and one whole unit of an
 * 18-decimal asset is a hundred times what a double represents exactly.
 *
 * TWO PROFILE FIELDS, AND THEY PIN THE COVENANT. `maker_pk_script` and
 * `maker_public_key` are the client's own position in the offer script
 * (§ 7.2's table: `makerWP` is "the client's witness program — `makerPkScript`
 * minus its 2-byte prefix", and `user` is the cancel path's signer). They come
 * from the client because they ARE the client — the covenant pins the fill's
 * output to that script, which is what makes the swap trustless for it.
 */

import { z } from 'zod'
import { WIRE_ASSET_AMOUNT } from '@arkade-os/solver-core/core/wireAmount.js'
import { MAX_PAIR_LENGTH } from '@arkade-os/solver-core/core/marketKey.js'
import type { AssetLeg } from '@arkade-os/solver-core/core/assetRfq.js'
import type { AssetRfqSwapRow } from '../db/assetRfqSwaps.js'
import { type RfqState } from './payloads.js'

const RFQ_ID = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/)

/** An x-only key: 32 bytes, hex. Never a 33-byte compressed one. */
const XONLY_HEX = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/)

/**
 * A taproot scriptPubKey: 34 bytes, hex — `OP_1 <32-byte program>`.
 *
 * Length-checked because the covenant takes the WITNESS PROGRAM, which § 7.2
 * defines as this value "minus its 2-byte prefix". A script of another length
 * would be sliced into a program of the wrong size, and the covenant would
 * then oblige a payment to an output nobody controls.
 *
 * Lowercase only, the same rule § 2 states for asset ids and `marketKey.ts`
 * repeats: hex is case-insensitive, so a spelling normalised in one layer and
 * not another derives a different script and therefore a different address.
 */
const PK_SCRIPT_HEX = z
  .string()
  .length(68)
  .regex(/^[0-9a-f]{68}$/)

/**
 * The directed request. Strict at BOTH levels per § 1 — "a directed request
 * containing unknown fields MUST be rejected with `unsupported_payload`".
 *
 * Strictness earns more here than on the other corridors. The two profile
 * fields are covenant parameters, so a client that misspells one and is quoted
 * anyway would fund an address derived from a value the solver never read, and
 * the mismatch would surface as a deposit at a script nothing watches.
 *
 * The pair is validated for SHAPE only — length, so the § 2 maximum of two full
 * asset legs is admitted. Whether it is SERVED, and whether it is even
 * expressible as an offer packet, is `core/assetRfq.ts`'s decision, so the two
 * refusals stay distinguishable.
 */
export const AssetRfqRequest = z
  .object({
    v: z.literal(1),
    type: z.literal('rfq_request'),
    rfq_id: RFQ_ID,
    pair: z.string().min(1).max(MAX_PAIR_LENGTH),
    amount_side: z.enum(['from', 'to']),
    // REQUIRED, unlike the Lightning send profile where a BOLT11 implies it.
    // Nothing here implies an amount: there is no invoice, and the offer that
    // would state one does not exist until after this quote is answered.
    amount: WIRE_ASSET_AMOUNT,
    profile: z
      .object({
        /** Where the fill must pay — the covenant's `makerWP`, minus its prefix. */
        maker_pk_script: PK_SCRIPT_HEX,
        /** The client's x-only key: the `cancel` path's `user` signer. */
        maker_public_key: XONLY_HEX,
      })
      .strict(),
  })
  .strict()

/** The § 2 pair string for two legs, `null` being BTC as everywhere else. */
export const assetRfqPairFor = (from: AssetLeg, to: AssetLeg): string =>
  `arkade:${from ?? 'BTC'}->arkade:${to ?? 'BTC'}`

/**
 * The quote. Its binding fields are § 4.2's, minus the one this class has no
 * meaning for.
 *
 * `offer_address` and `offer_pk_script` are COMPARE-ONLY, the § 6 tier: the
 * client derives the same covenant from this quote's own `to_amount` plus the
 * two parameters it supplied itself, and funds only its own derivation. A
 * solver that sent a different address gets a client that refuses to fund —
 * never one whose funds are trapped.
 *
 * Both are published rather than just the address, because they are what the
 * client checks against two different things: the address is what its wallet
 * sends to, and the script is what its own `offerVtxoScript` compiles to.
 */
export const assetRfqQuotePayload = (row: AssetRfqSwapRow, rfqId: string): Record<string, unknown> => ({
  v: 1,
  type: 'rfq_quote',
  rfq_id: rfqId,
  pair: row.pair,
  // The two sides of the spread, § 2.1 strings. The fee lives between them and
  // there is no separate fee field (§ 4.2). They are denominated in DIFFERENT
  // assets — this pair is cross-asset by construction — so they are not
  // comparable as numbers.
  from_amount: row.fromAmount.toString(),
  to_amount: row.toAmount.toString(),
  solver_pubkey: row.solverPubkey,
  valid_until: row.validUntil,
  // Deliberately NO `refund_locktime`. See this module's header.
  profile: {
    offer_address: row.offerAddress,
    offer_pk_script: row.offerPkScript,
  },
})

/**
 * This corridor's states in § 8's shared vocabulary.
 *
 * `filled` maps to `settled` rather than to `filled`, and that is the one
 * mapping worth arguing. § 8 reserves `filled` for "the outbound fill is no
 * longer in flight; solver collecting" — an interval this class does not have.
 * § 7.2's `fulfill` pays the client and takes the deposit in ONE transaction,
 * so when it lands both sides are done, which is `settled`.
 */
export const assetRfqStateFromRow = (row: AssetRfqSwapRow): RfqState => {
  switch (row.state) {
    case 'quoted':
      return 'quoted'
    // The client's offer covenant holds a deposit matching the quoted terms.
    // That IS the settlement contract being funded, so `funded` is exact — even
    // though § 8 glosses the word as HTLC-class, because on this class funding
    // is still how a client accepts (§ 4).
    case 'funded':
      return 'funded'
    case 'filling':
      return 'filling'
    case 'filled':
      return 'settled'
    case 'stuck':
      return 'stuck'
    // Both a declined quote and one that lapsed unfunded. § 8 folds expiry into
    // `refused` for the send leg the same way, distinguished by the reason —
    // and here nothing was ever exposed in either case.
    case 'refused':
      return 'refused'
  }
}

/**
 * The status payload. § 4.4's shape, with this class's own receipt.
 *
 * The receipt is `fill_txid` rather than a preimage: there is no hash lock
 * anywhere in this class, so the thing that proves settlement is the
 * transaction that spent the offer — which is also what the client's own
 * `classifySpend` reads without asking anyone (§ 7.2).
 *
 * Omitted rather than null while absent, matching the sibling corridors: a
 * client that must distinguish "no txid yet" from "txid is null" is one field
 * away from a bug, and § 4.4 already says receipts appear only once they exist.
 */
export const assetRfqStatusPayload = (row: AssetRfqSwapRow, rfqId: string): Record<string, unknown> => ({
  v: 1,
  type: 'rfq_status',
  rfq_id: rfqId,
  state: assetRfqStateFromRow(row),
  updated_at: row.updatedAt,
  profile: {
    offer_address: row.offerAddress,
    ...(row.fillTxid !== null ? { fill_txid: row.fillTxid } : {}),
    ...(row.failureReason !== null ? { failure_reason: row.failureReason } : {}),
  },
})
