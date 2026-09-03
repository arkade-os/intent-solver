/**
 * The RFQ vocabulary every corridor shares — the protocol, as distinct from any
 * one corridor's request shape.
 *
 * `wire/payloads.ts` held both: the Lightning-send corridor's own schema AND
 * these, which belong to no corridor. That mixing is what made `src/core/`
 * import the corridor layer to read an open-RFQ broadcast, and it is the last
 * `core -> corridor` edge the boundary guard records.
 *
 * What lives here is anything a corridor this build has never seen would still
 * have to speak: the id/pair/amount primitives, the status request, the
 * market-wide open-RFQ broadcast and its bid, and the CLOSED refusal set. What
 * stays in `wire/payloads.ts` is what only the Lightning-send leg means — its
 * `profile`, its quote payload, its state mapping.
 */
import { z } from 'zod'
import { WIRE_AMOUNT } from './wireAmount.js'
import { MAX_PAIR_LENGTH } from './marketKey.js'
export const RFQ_ID = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/)

// Shared between RfqRequest and RfqOpen so the wire contract for a pair
// string, an amount side and an amount cannot diverge between the two.
export const RFQ_PAIR = z.string().min(1).max(MAX_PAIR_LENGTH)
export const AMOUNT_SIDE = z.enum(['from', 'to'])
// § 2.1: a canonical decimal string of atomic units, with a JSON number
// accepted only where it is provably lossless. @see ./amount.ts
export const RFQ_AMOUNT = WIRE_AMOUNT

/**
 * Ask for the state of one negotiation by its correlation id.
 *
 * Carries no `pair`, and that is the protocol's choice rather than an omission:
 * an `rfq_id` identifies at most one negotiation anywhere, so a client that has
 * lost track of which corridor it quoted can still ask. It is why the host walks
 * corridors for a status rather than dispatching to one.
 */
export const RfqStatusRequest = z
  .object({
    v: z.literal(1),
    type: z.literal('rfq_status_request'),
    rfq_id: RFQ_ID,
  })
  .strict()

/**
 * An open-RFQ broadcast (docs/rfq-protocol.md § 4.6). Strict shape, but a
 * parse failure is answered with SILENCE, never a refusal — broadcasts are
 * the one place § 4's refusal rule inverts. Unknown fields also land on
 * silence: we do not bid on payloads we do not fully understand.
 */
export const RfqOpen = z
  .object({
    v: z.literal(1),
    type: z.literal('rfq_open'),
    open_id: RFQ_ID,
    pair: RFQ_PAIR,
    amount_side: AMOUNT_SIDE,
    amount: RFQ_AMOUNT.optional(),
    size_bucket: z.object({ min: RFQ_AMOUNT, max: RFQ_AMOUNT }).strict().optional(),
    bids_until: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((open, ctx) => {
    if ((open.amount === undefined) === (open.size_bucket === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'exactly one of amount or size_bucket' })
    }
    if (open.size_bucket && open.size_bucket.min > open.size_bucket.max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'size_bucket.min exceeds max' })
    }
  })

export type RfqOpenPayload = z.infer<typeof RfqOpen>

/**
 * A sealed bid on an open RFQ; addressed to the broadcast's author (§ 4.6).
 * `pair` is a parameter rather than the served-pair constant so the payload
 * cannot claim a market the caller did not bid on — the signature says what
 * goes on the wire, matching `decideOpenRfqBid`, which already takes the
 * pair it validated against.
 */
export const rfqBidPayload = (
  openId: string,
  pair: string,
  bid: { fee_bps: number; fee_flat: number; min: number; max: number; valid_until: number },
): Record<string, unknown> => ({
  v: 1,
  type: 'rfq_bid',
  open_id: openId,
  pair,
  fee_bps: bid.fee_bps,
  // OPTIONAL in § 4.6, where omitted means zero — so a corridor charging no
  // flat fee publishes exactly the bytes it published before the field
  // existed, and a reader that predates it is not handed a key to ignore.
  ...(bid.fee_flat > 0 ? { fee_flat: bid.fee_flat } : {}),
  min: bid.min,
  max: bid.max,
  valid_until: bid.valid_until,
})

/** The closed RFQ refusal set. Anything a client does not recognise is a generic decline. */
export type RfqRefusalReason =
  | 'unsupported_pair'
  | 'unsupported_payload'
  | 'amount_out_of_range'
  | 'exposure_cap'
  | 'invoice_expired'
  | 'quote_conflict'
  | 'pricing_unavailable'
  | 'rate_limited'

/**
 * The same members as a value, so a runtime check can be made against the set.
 *
 * Needed because a CORRIDOR now builds its own refusal payload, and a corridor
 * is third-party code from the host's point of view — the host has to verify on
 * the way out what it used to guarantee by construction. The exhaustiveness
 * check below fails to COMPILE if a member is added to the union and not here,
 * so the guard cannot silently narrow as the vocabulary grows.
 */
export const RFQ_REFUSAL_REASON_VALUES = [
  'unsupported_pair',
  'unsupported_payload',
  'amount_out_of_range',
  'exposure_cap',
  'invoice_expired',
  'quote_conflict',
  'pricing_unavailable',
  'rate_limited',
] as const satisfies readonly RfqRefusalReason[]

const _EVERY_REASON_LISTED: Record<RfqRefusalReason, true> = {
  unsupported_pair: true,
  unsupported_payload: true,
  amount_out_of_range: true,
  exposure_cap: true,
  invoice_expired: true,
  quote_conflict: true,
  pricing_unavailable: true,
  rate_limited: true,
}

export const isRfqRefusalReason = (value: string): value is RfqRefusalReason =>
  (RFQ_REFUSAL_REASON_VALUES as readonly string[]).includes(value)

/**
 * Legacy/internal reason → the closed RFQ set. Everything the quote path can
 * emit today maps; anything unrecognised (a future internal reason) degrades to
 * `unsupported_payload` rather than leaking a non-spec string onto the wire.
 *
 * That fallback is a backstop, NOT the way a refusal is meant to reach a
 * client, and the difference is invisible at the call site: an unmapped reason
 * compiles, ships, and tells the client its payload was malformed. Two reasons
 * reached mainnet that way. `test/wire/payloads.test.ts` now fails typecheck
 * the moment a corridor's `QuoteRefusal` grows a member with no entry here,
 * which is why this is exported.
 */
export const RFQ_REFUSAL_REASONS: Record<string, RfqRefusalReason> = {
  wrong_network: 'unsupported_pair',
  zero_amount_invoice: 'unsupported_payload',
  invalid_refund_address: 'unsupported_payload',
  // The receive legs' mirror of `invalid_refund_address`: an address WE cannot
  // pay, supplied by the client, so it is a payload fault by the same reasoning.
  // Mapped explicitly even though the fallback already answers this — an
  // accidental right answer is indistinguishable from a missing entry at the
  // moment someone changes the fallback.
  invalid_payout_address: 'unsupported_payload',
  unsupported_payload: 'unsupported_payload',
  invoice_expired: 'invoice_expired',
  invoice_expires_too_soon: 'invoice_expired',
  amount_out_of_range: 'amount_out_of_range',
  // "The fee ate the swap" and "below the dust floor" are priced-out quotes,
  // not out-of-range amounts: the corridor serves this size at a zero fee,
  // it just cannot serve it at ITS fee. `pricing_unavailable` is the closed
  // set's name for exactly that.
  fee_consumes_swap: 'pricing_unavailable',
  payout_below_dust: 'pricing_unavailable',
  // Nothing about the request is wrong: this deployment's Arkade exit delay is
  // too long for any invoice to carry a final CLTV delta a stock payer would
  // route (`minFinalCltvBlocksFor` vs `MAX_FINAL_CLTV_BLOCKS`). The closed set
  // has no name for "the corridor is unservable as configured", so this is a
  // choice between imperfect fits, and the two rejected ones are worse:
  // `unsupported_payload` blames a payload that was fine, and `unsupported_pair`
  // contradicts the registry card still advertising the pair — a client would
  // reasonably stop asking this solver entirely. `pricing_unavailable` says the
  // true thing the set can express: no quote is available right now, and it is
  // ours, not yours. The operator still sees the precise name in the logs.
  recourse_window_unservable: 'pricing_unavailable',
  // Nothing about the request is malformed, but the closed set has no name for
  // "this deployment's rail cannot contain the CLTV your invoice's worst route
  // hint permits". `unsupported_payload` is what the same refusal already
  // answered when it fired inside `decodeInvoice` and reached clients through
  // the `InvalidInvoice` catch in `ingress/rfq.ts`, so mapping it here keeps
  // client-visible behaviour byte-identical while the refusal moves onto the
  // acceptance path. Explicit rather than via the fallback, for the reason the
  // comment above this map gives: an accidental right answer and a missing
  // entry look the same at the call site.
  cltv_too_large: 'unsupported_payload',
  duplicate_swap: 'quote_conflict',
  // Also a conflict, though a subtler one: the two legs of a coupled
  // self-payment CAN be served, just not with refund deadlines this close
  // together. The closed set has no finer name for it.
  coupled_deadline_unsafe: 'quote_conflict',
  // Same bucket again: the hash IS spoken for by a live row of ours, so this
  // is the plain conflict `duplicate_swap` above already names. Kept distinct
  // internally only so the logs say which coupling gate refused.
  coupled_invoice_mismatch: 'quote_conflict',
  provider_at_capacity: 'exposure_cap',
  unsupported_pair: 'unsupported_pair',
  quote_conflict: 'quote_conflict',
  pricing_unavailable: 'pricing_unavailable',
  exposure_cap: 'exposure_cap',
  rate_limited: 'rate_limited',

  // ---- the atomic class, `arkade:<X>->arkade:<Y>` ----------------------------
  // The solver pays the client out of its own float in the leg being bought, so
  // "I do not hold enough of that asset right now" is a capacity answer rather
  // than a pricing one: the corridor serves this pair at this size and would
  // quote it again once the float recovers. § 10's gloss on `exposure_cap` -
  // "solver at aggregate capacity right now" - is what tells a client to back
  // off and retry instead of dropping the pair.
  insufficient_inventory: 'exposure_cap',

  // ---- the EVM corridors ----------------------------------------------------
  // A token this deployment does not serve is a PAIR it does not serve: the
  // token is what distinguishes one EVM pair from another, so the client should
  // hear the same thing it would for `arkade:BTC->somewhere-else`.
  unsupported_token: 'unsupported_pair',
  // The feed is down or answered something unusable. The corridor serves this
  // size and this token; it just cannot put a number on it right now, which is
  // exactly what the closed set's `pricing_unavailable` names.
  price_unavailable: 'pricing_unavailable',
  // Malformed input: a token amount that is not a canonical decimal, and an
  // exact-out request on a corridor whose two legs are different assets.
  invalid_evm_amount: 'unsupported_payload',
  exact_out_unsupported: 'unsupported_payload',
  // The deadline refusals, from both legs. The payload was well formed, so
  // `unsupported_payload` would be a lie; what failed is that no safe pair of
  // deadlines exists for these terms, which is the same shape of answer as a
  // fee that eats the swap - the corridor cannot quote it, not that the client
  // asked wrongly.
  evm_timeout_in_past: 'pricing_unavailable',
  claim_window_too_short: 'pricing_unavailable',
  recourse_after_refund_deadline: 'pricing_unavailable',
  deadlines_cannot_be_ordered: 'pricing_unavailable',
  evm_lock_expired: 'pricing_unavailable',
  client_claim_window_too_short: 'pricing_unavailable',
  recourse_after_evm_timeout: 'pricing_unavailable',
  // Same family, the horizon end: a client deadline beyond what the corridor
  // serves is a terms problem, not a payload problem.
  evm_timeout_too_far_out: 'pricing_unavailable',
}

export const toRfqReason = (reason: string): RfqRefusalReason => RFQ_REFUSAL_REASONS[reason] ?? 'unsupported_payload'

export const rfqRefusalPayload = (rfqId: string | undefined, reason: string): Record<string, unknown> => ({
  v: 1,
  type: 'rfq_refusal',
  ...(rfqId !== undefined ? { rfq_id: rfqId } : {}),
  reason: toRfqReason(reason),
})

export const extractRfqId = (payload: unknown): string | undefined => {
  const id = (payload as { rfq_id?: unknown } | null)?.rfq_id
  return typeof id === 'string' && id.length <= 128 ? id : undefined
}

/**
 * A zod failure as field names and check codes — never values.
 *
 * `unrecognized_keys` carries the offending key names, and those are worth
 * printing: both schemas are `.strict()`, so a client that renames a field or
 * adds one has every request refused, and the key name IS the whole diagnosis.
 * It is also the client's own choice of name rather than any data of theirs.
 *
 * Capped at four issues because zod reports one per failing field and the
 * first few identify the fault; a client sending the wrong shape entirely
 * should not be able to choose how many lines that costs us.
 */
export const zodDetail = (error: { issues: readonly { path: PropertyKey[]; code: string }[] }): string =>
  error.issues
    .slice(0, 4)
    .map((issue) => {
      const at = issue.path.length > 0 ? issue.path.join('.') : '(root)'
      const keys = (issue as { keys?: unknown }).keys
      return Array.isArray(keys) ? `${at}: ${issue.code} [${keys.join(', ')}]` : `${at}: ${issue.code}`
    })
    .join('; ')
