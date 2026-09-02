/**
 * `src/wire/payloads.ts` — what this service actually puts on the wire, and
 * what it deliberately leaves off.
 *
 * Both suites here exist for the same reason: the wire is the one surface a
 * client reads, and on both of these the type system has nothing to say. An
 * optional field is absent or present, and a `Record<string, …>` lookup misses
 * silently — neither fails to compile when it drifts.
 */

import { describe, it, expect } from 'vitest'
import {
  rfqBidPayload,
  RFQ_PAIR_SEND,
  RFQ_REFUSAL_REASONS,
  toRfqReason,
} from '@arkade-os/solver-corridors/wire/payloads.js'
import type { QuoteRefusal as SendQuoteRefusal } from '@arkade-os/solver-corridors/send/orchestrator.js'
import type { QuoteRefusal as ReceiveQuoteRefusal } from '@arkade-os/solver-corridors/receive/orchestrator.js'
import type { QuoteRefusal as OnchainSendQuoteRefusal } from '@arkade-os/solver-corridors/send/onchainOrchestrator.js'
import type { QuoteRefusal as OnchainReceiveQuoteRefusal } from '@arkade-os/solver-corridors/receive/onchainOrchestrator.js'

const OPEN_ID = 'b'.repeat(64)

/**
 * Every refusal a corridor's `quote()` can hand the ingress, listed once.
 *
 * The drift guard for `RFQ_REFUSAL_REASONS`, built the same way
 * `test/core/refusalReasons.test.ts` guards `REFUSAL_EXPLANATIONS` and for the
 * same reason: the map is `Record<string, …>` on purpose — it also accepts
 * legacy and core-gate names that belong to no corridor union — so the compiler
 * cannot check it against what the orchestrators return. An unmapped reason
 * takes the fallback and silently blames the client's payload.
 *
 * The aliases below are what keep this list honest. They are type-only, so they
 * cost nothing at runtime and fail `pnpm typecheck` the moment any corridor's
 * `QuoteRefusal` grows a member missing from the array — which is precisely how
 * `recourse_window_unservable` and `invalid_payout_address` went unnoticed.
 */
const QUOTE_REFUSALS = [
  'amount_out_of_range',
  'cltv_too_large',
  'coupled_deadline_unsafe',
  'coupled_invoice_mismatch',
  'duplicate_swap',
  'fee_consumes_swap',
  'invalid_payout_address',
  'invalid_refund_address',
  'invoice_expired',
  'invoice_expires_too_soon',
  'payout_below_dust',
  'provider_at_capacity',
  'rate_limited',
  'recourse_window_unservable',
  'unsupported_payload',
  'wrong_network',
  'zero_amount_invoice',
] as const

type Mapped<T extends (typeof QUOTE_REFUSALS)[number]> = T
type _SendMapped = Mapped<SendQuoteRefusal>
type _ReceiveMapped = Mapped<ReceiveQuoteRefusal>
type _OnchainSendMapped = Mapped<OnchainSendQuoteRefusal>
type _OnchainReceiveMapped = Mapped<OnchainReceiveQuoteRefusal>

const bid = (overrides: Partial<Parameters<typeof rfqBidPayload>[2]> = {}) => ({
  fee_bps: 25,
  fee_flat: 0,
  min: 1000,
  max: 25_000,
  valid_until: 1_800_000_900,
  ...overrides,
})

/**
 * The bid had no direct test before `fee_flat` existed — it was covered
 * incidentally by the modules that import it. It earns one now because the new
 * field is OPTIONAL in the protocol with omitted meaning zero, so "absent" and
 * "present as 0" are different bytes carrying the same meaning, and only one of
 * them leaves a pre-flat-fee deployment's bids unchanged.
 */
describe('rfqBidPayload', () => {
  it('omits fee_flat entirely when the corridor charges none', () => {
    // Omitted means zero, so a deployment that sets no flat fee must publish
    // exactly the bytes it published before the field existed.
    const payload = rfqBidPayload(OPEN_ID, RFQ_PAIR_SEND, bid())
    expect('fee_flat' in payload).toBe(false)
  })

  it('carries a nonzero fee_flat', () => {
    const payload = rfqBidPayload(OPEN_ID, RFQ_PAIR_SEND, bid({ fee_flat: 50 }))
    expect(payload.fee_flat).toBe(50)
  })

  it('puts the two price components next to each other', () => {
    // Cosmetic on the wire, but it matches the protocol's own example and is
    // the shape a reader compares against when debugging a bid.
    const keys = Object.keys(rfqBidPayload(OPEN_ID, RFQ_PAIR_SEND, bid({ fee_flat: 50 })))
    expect(keys.indexOf('fee_flat')).toBe(keys.indexOf('fee_bps') + 1)
  })

  it('carries the rest of the bid through unchanged', () => {
    expect(rfqBidPayload(OPEN_ID, RFQ_PAIR_SEND, bid())).toEqual({
      v: 1,
      type: 'rfq_bid',
      open_id: OPEN_ID,
      pair: RFQ_PAIR_SEND,
      fee_bps: 25,
      min: 1000,
      max: 25_000,
      valid_until: 1_800_000_900,
    })
  })
})

/**
 * `toRfqReason`, and specifically the claim that internal coupling reasons are
 * free to multiply.
 *
 * The send corridor refuses a coupling three different ways and names each one
 * separately, so a log says which gate fired. That is only harmless while all
 * three still leave the client with the answer they had before the names
 * existed. `RFQ_REFUSAL_REASONS` is a `Record<string, …>` with no
 * exhaustiveness check behind it, and an unmapped reason does not fail to
 * compile — it degrades to `unsupported_payload`, quietly telling the client
 * their payload was malformed when the truth is that the hash is taken.
 *
 * So the mapping is asserted rather than assumed.
 */
describe('toRfqReason', () => {
  it('folds every coupling refusal to the same answer as a plain duplicate', () => {
    // The internal names are ours. On the wire all three are one conflict:
    // the hash is spoken for, or the two legs cannot be served together.
    expect(toRfqReason('coupled_invoice_mismatch')).toBe('quote_conflict')
    expect(toRfqReason('coupled_deadline_unsafe')).toBe('quote_conflict')
    expect(toRfqReason('duplicate_swap')).toBe('quote_conflict')
  })

  it('degrades an unmapped reason rather than leaking it', () => {
    // The reason a missing entry is worth a test: this is silent, and it is
    // wrong in a direction that blames the client.
    expect(toRfqReason('some_future_internal_reason')).toBe('unsupported_payload')
  })

  it('does not blame the client for a corridor the deployment cannot serve', () => {
    // `recourse_window_unservable` is a property of the operator's Arkade exit
    // delay: no invoice can carry a final CLTV delta a stock payer will route.
    // Through the fallback it answered `unsupported_payload`, telling a client
    // with a perfectly good request to go fix its payload — and since the gate
    // fires before the hold invoice is minted, EVERY quote on the corridor got
    // that answer. `pricing_unavailable` is the closed set's nearest true
    // statement: no quote available, and the reason is ours.
    expect(toRfqReason('recourse_window_unservable')).toBe('pricing_unavailable')
  })

  it('answers an undecodable payout address exactly like an undecodable refund address', () => {
    // Same fault on the mirrored leg — the client named a destination we cannot
    // pay — so the two must not diverge just because one was mapped and the
    // other reached the same answer by falling through.
    expect(toRfqReason('invalid_payout_address')).toBe('unsupported_payload')
    expect(toRfqReason('invalid_refund_address')).toBe('unsupported_payload')
  })

  it('says nothing new to a client about an invoice this rail cannot contain', () => {
    // The refusal moved from `decodeInvoice` (where it reached clients as
    // `unsupported_payload` through the `InvalidInvoice` catch in
    // `ingress/rfq.ts`) onto the acceptance path. Nothing about the request
    // changed, the closed set has no better token, and growing that set is a
    // ts-sdk change — so the bytes a client sees must be identical.
    expect(toRfqReason('cltv_too_large')).toBe('unsupported_payload')
  })

  it('maps every corridor refusal explicitly, never through the fallback', () => {
    // The fallback makes a missing entry indistinguishable from a deliberate
    // `unsupported_payload` at the call site, so behaviour alone cannot prove
    // the wiring. Assert the ENTRY exists; `QUOTE_REFUSALS` above is held
    // complete by the type aliases below.
    for (const reason of QUOTE_REFUSALS) {
      expect(Object.hasOwn(RFQ_REFUSAL_REASONS, reason), `${reason} has no explicit mapping`).toBe(true)
    }
  })
})
