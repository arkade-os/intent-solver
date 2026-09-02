/**
 * What every refusal code MEANS, in operator English.
 *
 * The gates elsewhere in `src/core` answer yes/no with a closed code, which is
 * right for the wire — a client matches on a stable token, not on prose. It is
 * wrong for a human staring at a stuck row at two in the morning, and the admin
 * console currently shows them the raw token.
 *
 * So the prose lives here, once, keyed by that same token, and the console reads
 * it server-side. Not a lookup table in the browser: the reasons would then have
 * two homes and drift, and anything else reading the admin API would get the
 * token alone.
 *
 * Pure — no clock, no I/O — like the gates it explains.
 *
 * NOTE the typing. {@link REFUSAL_EXPLANATIONS} is a `Record` over the UNION of
 * every corridor's refusal enum, so adding a refusal anywhere fails to compile
 * until it is explained here. That is deliberate: an unexplained code is exactly
 * the state this module exists to end, and a reviewer will not catch it.
 */

import type { SendAcceptanceRefusal, SendPaymentRefusal } from './send.js'
import type { ReceiveFundingRefusal } from './receive.js'
import type { InvoiceRejection } from '../invoice/decode.js'

export interface RefusalExplanation {
  /** What the gate actually checked, and what it found. */
  meaning: string
  /** What the operator should do. Often "nothing" — and saying so is the point. */
  whatToDo: string
}

/**
 * Refusals raised by a corridor's `quote()` rather than by a core gate.
 *
 * Declared here rather than imported because the four orchestrators each export
 * their own `QuoteRefusal` under the same name; importing all four would need
 * aliases and would couple this module to the orchestrators. The union below is
 * their combined membership, and the test asserts the table stays complete.
 */
type OrchestratorRefusal =
  | 'duplicate_swap'
  | 'provider_at_capacity'
  | 'invalid_refund_address'
  | 'invalid_payout_address'
  | 'rate_limited'
  | 'coupled_deadline_unsafe'
  | 'coupled_invoice_mismatch'
  | 'recourse_window_unservable'
  | 'fee_consumes_swap'
  | 'payout_below_dust'
  | 'amount_out_of_range'

export type RefusalReason =
  SendAcceptanceRefusal | SendPaymentRefusal | ReceiveFundingRefusal | OrchestratorRefusal | InvoiceRejection

export const REFUSAL_EXPLANATIONS: Record<RefusalReason, RefusalExplanation> = {
  // --- the invoice itself, before any swap exists ---
  too_long: {
    meaning: 'The BOLT11 string was longer than we will parse at all (2048 chars), so it was rejected unread.',
    whatToDo:
      'Nothing. Bech32 decoding is unbounded work; refusing an oversized input is a DoS guard, not a judgement.',
  },
  mixed_case: {
    meaning:
      'The invoice mixed upper and lower case. BOLT11 checksums are defined over one case, so a mixed string cannot be verified.',
    whatToDo: 'Nothing on our side. The sender copied the invoice badly — ask for it again.',
  },
  malformed: {
    meaning: 'The decoder could not parse the invoice at all — bad checksum, truncated, or not a BOLT11.',
    whatToDo: 'Nothing. Ask the client for the invoice again; the string reaching us was damaged.',
  },
  missing_payment_hash: {
    meaning: 'The invoice carried no usable payment hash, which is the one field the swap script commits to.',
    whatToDo: 'Nothing. No swap can be built against it.',
  },
  missing_amount: {
    meaning:
      'The invoice named no amount, or a non-positive one. Zero-amount invoices are not supported on this corridor.',
    whatToDo: 'Ask the client for an invoice with an explicit amount.',
  },
  sub_satoshi_amount: {
    meaning: 'The invoice asked for a fraction of a satoshi, which no integer-sat Arkade lockup can back exactly.',
    whatToDo: 'Ask for an invoice denominated in whole satoshis.',
  },
  missing_network: {
    meaning: 'The invoice had no readable network prefix, so we could not confirm it belongs to the chain we serve.',
    whatToDo: 'Nothing. Never infer the network from a prefix match — lnbc is a prefix of lnbcrt.',
  },
  missing_timestamp: {
    meaning: 'The invoice carried no timestamp, so its expiry could not be computed.',
    whatToDo: 'Nothing. Ask the client for a well-formed invoice.',
  },
  cltv_too_large: {
    meaning:
      'The CLTV the invoice DICTATES — its final delta plus a route hint — exceeds MAX_CLIENT_CLTV_BLOCKS. That total is how long the payee could hold our outbound HTLC, and the refund deadline has to outlast it. Two different gates raise it: the decode-time floor, taken over the BEST hint, meaning no backend anywhere could serve this invoice; and the acceptance gate, taken over the WORST hint and only on a rail that cannot cap the route it picks, meaning THIS deployment cannot serve it though an LND one could.',
    whatToDo:
      'Read the detail line for which fired. The floor ("best-hint floor") is expected against an unusual payee and a real guard against a hostile one: unbounded route-hint CLTV is how an invoice writer forces an HTLC that outlives the client refund — ask for an invoice with ordinary timelocks. The acceptance gate ("worst-hint rule") means the invoice offers a good route among bad ones and only the backend is in the way; it is what a rail that cannot cap the route it picks gives on a Wallet of Satoshi invoice, and running LND is the fix.',
  },

  // --- quote-time gates on the send leg ---
  wrong_network: {
    meaning: 'The invoice is for a different network than this deployment serves.',
    whatToDo: 'Check SWAP_NETWORK matches the invoices you expect. Otherwise nothing — this is the gate working.',
  },
  amount_out_of_range: {
    meaning: 'The amount falls outside the configured per-swap limits for this corridor.',
    whatToDo:
      'Nothing, unless you meant to serve it — then widen the corridor limits (see MAX_SWAP_SATS and the per-corridor overrides).',
  },
  zero_amount_invoice: {
    meaning:
      'The invoice left the amount for the payer to choose. This corridor prices the swap from the invoice, so it needs one.',
    whatToDo: 'Ask the client for an invoice with an amount.',
  },
  invoice_expired: {
    meaning: 'The invoice had already lapsed. Paying it would be refused by the payee.',
    whatToDo: 'Nothing. If this appears on a FUNDED row, the client took too long — the lockup refunds itself.',
  },
  invoice_expires_too_soon: {
    meaning:
      'At quote time: no fundable window was left at all. At payment time: under MIN_INVOICE_WINDOW remained, too little to survive a payment attempt that may probe several routes.',
    whatToDo:
      'Nothing. Note this is NOT a floor on invoice life — short invoices are quoted with a correspondingly short funding window — so seeing it means the invoice was nearly dead on arrival.',
  },
  coupled_invoice_mismatch: {
    meaning:
      'A live RECEIVE swap holds this payment hash, but its invoice is not the one being paid. Same hash, different bolt11 — so this is not us paying our own hold invoice, and coupling the two would settle a receive swap against a payment nobody made to it.',
    whatToDo:
      'Nothing automatic. Two different invoices sharing a payment hash means one side reused a preimage, so treat it as a client or upstream-node bug rather than a routing hiccup, and check the receive row before letting the client retry.',
  },
  recourse_window_unservable: {
    meaning:
      "The hold invoice's expiry cannot be pushed far enough out for the solver's own unilateral recourse to open before it, because this Arkade Service's exit delay is longer than the window a Lightning invoice allows. A property of the deployment, not of the request.",
    whatToDo:
      'Every quote on this corridor gets this answer until the operator lowers the unilateral exit delay, so a burst of these is a configuration alarm rather than traffic. Nothing about the client or their invoice will change it.',
  },
  unilateral_recourse_after_htlc: {
    meaning:
      "The arriving HTLC expires before the solver's own unilateral refund leaf opens. Both sides would then be spendable with one preimage: the client can let the HTLC fail back to its payer for free and only then claim the Arkade payout, taking both legs.",
    whatToDo:
      "Nothing for this swap — declining IS the fix, and reordering the ladder would only move the theft to the other party. If it is frequent, incoming HTLCs are too short-dated for this deployment's exit delay: lower the delay, or ask senders for more CLTV.",
  },
  duplicate_swap: {
    meaning:
      'Another live swap already holds this payment hash, in this corridor or a peer one. Two lockups and one payment means whichever client loses the race is claimed with no refund.',
    whatToDo:
      'Nothing. Check the other row if the client insists they only asked once — a live RECEIVE swap on the same hash is us being asked to pay our own hold invoice.',
  },
  provider_at_capacity: {
    meaning: 'Serving this swap would push total exposure across live swaps past MAX_EXPOSED_SATS.',
    whatToDo:
      'Nothing immediately. If it is frequent, either the cap is too tight or swaps are not clearing — check for a backlog of non-terminal rows.',
  },
  invalid_refund_address: {
    meaning: 'The refund address did not decode as an Arkade address for this network.',
    whatToDo: 'Nothing. The client sent an address we could not pay a refund to, so no swap was created.',
  },
  invalid_payout_address: {
    meaning: 'The payout address the client asked to be paid at did not decode for this network.',
    whatToDo: 'Nothing. The client supplied an address we could not pay.',
  },
  rate_limited: {
    meaning: 'This requester key exceeded the quote quota for the current window.',
    whatToDo:
      'Nothing, unless a legitimate integrator is being throttled — then raise the quota. Operator CLI calls carry no key and are never metered.',
  },
  fee_consumes_swap: {
    meaning: 'This corridor’s fee would eat the whole swap, leaving the client nothing (or less than nothing).',
    whatToDo: 'Expected at small amounts. If it is blocking real traffic, lower the corridor fee or raise its minimum.',
  },
  payout_below_dust: {
    meaning: 'After fees the onchain payout would be below the dust threshold, so it could not be spent.',
    whatToDo:
      'Nothing. Raise the corridor minimum if you want to refuse these earlier, with a clearer answer to the client.',
  },
  coupled_deadline_unsafe: {
    meaning:
      'A self-payment where one client holds both legs, and the send deadline did not clear the receive deadline by a full claim window. Run in reverse that ordering lets them refund the send lockup and only then claim the receive payout — both sides, one payment.',
    whatToDo:
      'Nothing. This is the coupling guard doing its job; the client can retry once the receive leg’s deadline moves.',
  },

  // --- payment-time gates on the send leg ---
  lockup_insufficient: {
    meaning:
      'The lockup at the swap address did not cover the amount the swap requires, so paying would be paying out more than arrived.',
    whatToDo: 'Nothing. Partial funding is refunded by the sweep.',
  },
  claim_window_too_short: {
    meaning:
      'The client’s refund path opens within MIN_CLAIM_WINDOW. Paying now risks paying out over Lightning and then losing the race to claim the lockup.',
    whatToDo: 'Nothing — this is the gate that prevents a one-sided loss. The lockup refunds itself.',
  },
  cltv_budget_too_short: {
    meaning:
      'What is left before the refund deadline can no longer hold an HTLC the payee is entitled to keep alive, so there is no CLTV budget left to route within. Usually means the swap sat unfunded for a long time before being funded.',
    whatToDo:
      'Nothing. Paying here is precisely the case where the outbound HTLC could outlive the client refund and both sides get taken. If it is frequent, LOCKUP_TIMEOUT_SECONDS may be set too close to the safety margin.',
  },
  uncapped_route_deadline_too_short: {
    meaning:
      'This deployment’s Lightning rail cannot cap the CLTV of the route it picks — its pay call exposes no max-CLTV control — and the refund deadline stored on the swap cannot contain the longest HTLC such a route could build. Not the same as cltv_budget_too_short: there the deadline was sized correctly for this rail and the clock ran down; here the deadline was never sized for the rail now paying it. The ordinary cause is a deployment moved from LND to an uncapped rail with rows already quoted and funded — LND sizes the deadline off the best route hint because it can decline the worst, and an uncapped rail can decline nothing. A row funded more than REFUND_SAFETY_MARGIN before payment, typically after a crash, reaches it too.',
    whatToDo:
      'Nothing for the swap itself — it refunds, and paying it is exactly the case where the outbound HTLC outlives the client refund and both sides get taken. If it appeared right after an LN_BACKEND change, that is the cause and it clears once the rows quoted under the old rail have drained; the alternative is to move back to LND until they have. Seeing it on a settled deployment means swaps are being funded long after they were quoted — check for a stalled worker.',
  },

  // --- receive-leg funding gates ---
  htlc_not_armed: {
    meaning: 'No incoming HTLC is being held yet, so there is nothing to settle and nothing to fund against.',
    whatToDo: 'Nothing. Normal while waiting for the payer.',
  },
  settle_window_too_short: {
    meaning:
      'The incoming HTLC’s own deadline (E, read from the backend rather than assumed) leaves under MIN_SETTLE_WINDOW to settle it after we fund.',
    whatToDo: 'Nothing. Funding a short-dated HTLC risks paying out on Arkade and then failing to collect.',
  },
  refund_deadline_too_late: {
    meaning:
      'Our own recourse on the Arkade payout would open after the incoming HTLC’s deadline, so a failure would leave us unable to recover.',
    whatToDo: 'Nothing. The gate refuses rather than funding into a position with no way out.',
  },
}

/**
 * Failures the orchestrators write as SENTENCES rather than codes.
 *
 * `whenQuoted` records prose — "lockup timeout", "overfunded lockup: 5000 > 2100
 * sats" — because those outcomes never had a wire code to reuse. They are also
 * the rows an operator sees most, so leaving them unexplained would leave the
 * commonest failures the least legible. Matched by substring, in order.
 */
const FREE_TEXT_FAILURES: readonly (readonly [string, RefusalExplanation])[] = [
  [
    'overfunded lockup',
    {
      meaning:
        'More arrived at the swap address than the swap asked for. The claim leaf sweeps WHOLE vtxos, so paying this would hand us the excess with no path for the client to recover it.',
      whatToDo: 'Nothing. Refusing routes the ENTIRE lockup to the refund path, so the client gets all of it back.',
    },
  ],
  [
    'invoice expired before funding completed',
    {
      meaning: 'The client funded, or part-funded, but the invoice lapsed before we could pay it.',
      whatToDo: 'Nothing. The sweep refunds whatever arrived.',
    },
  ],
  [
    'lockup arrived after the funding deadline',
    {
      meaning:
        'A full lockup was first seen after the quote’s funding window closed. The refund deadline is anchored at quote time, so paying a late lockup eats the claim window we quoted against.',
      whatToDo: 'Nothing. This is the drive-later and crash-recovery guard; the lockup refunds itself.',
    },
  ],
  [
    'lockup timeout',
    {
      meaning: 'The quote was never funded (or only partly) before its funding window closed, so it was abandoned.',
      whatToDo:
        'Nothing — the ordinary fate of a quote nobody funded. Any partial amount is recorded for the refund sweep.',
    },
  ],
]

/**
 * Every reason code paired with the pattern that finds it in a sentence,
 * longest first so a code is never shadowed by a shorter one it contains.
 *
 * Compiled once at module load rather than per call. The inputs are this
 * file's own object keys, so nothing a caller supplies ever reaches the
 * `RegExp` constructor — the cost being avoided is allocation, not injection.
 */
const REASON_PATTERNS: readonly (readonly [RefusalReason, RegExp])[] = Object.keys(REFUSAL_EXPLANATIONS)
  .sort((a, b) => b.length - a.length)
  // Word-bounded so a code is not matched inside a longer identifier.
  .map((code) => [code as RefusalReason, new RegExp(`(^|[^a-z_])${code}($|[^a-z_])`)] as const)

/**
 * Explain a row's `failureReason`, or an RFQ refusal code.
 *
 * Takes the stored TEXT rather than a code, because rows do not carry bare
 * codes: `whenFunded` writes `refused to pay: <reason>`, and `whenQuoted` writes
 * sentences. A resolver that only matched exact strings would explain nothing on
 * the rows most in need of explaining.
 *
 * Codes win over the free-text patterns, since a code is the precise answer and
 * a message may contain both. Returns null rather than guessing — a wrong
 * explanation on a money path is worse than none.
 */
export const explainFailure = (failureText: string | null | undefined): RefusalExplanation | null => {
  if (!failureText) return null
  const matched = REASON_PATTERNS.find(([, pattern]) => pattern.test(failureText))
  if (matched) return REFUSAL_EXPLANATIONS[matched[0]]
  const freeText = FREE_TEXT_FAILURES.find(([pattern]) => failureText.includes(pattern))
  return freeText ? freeText[1] : null
}

/**
 * What a terminal STATE means, as opposed to why a gate refused.
 *
 * `stuck` is the one that matters, and the reason this exists: it is not a
 * refusal, it is "we were exposed and a human has to look". That fact currently
 * lives only in an orchestrator comment, where no operator will find it.
 */
export const STATE_NOTES: Record<string, RefusalExplanation | undefined> = {
  stuck: {
    meaning:
      'The payment was ALREADY EXPOSED when it failed — we may or may not have paid out over Lightning, and the row cannot tell on its own. This is not an ordinary refusal; it parks here precisely so a human looks.',
    whatToDo:
      'Recheck first: a tick re-polls the backend and resolves the row by itself in most cases, because the payment usually did settle or die and only the poll was missing. Only if it stays stuck should you read the payment on the backend by hand — and do NOT push a refund until you know the payment did not settle, because refunding a swap we paid is a double payout.',
  },
  refused: {
    meaning:
      'The swap was declined before any money moved. Nothing was paid out, and any lockup that arrived is queued for the refund sweep.',
    whatToDo: 'Read the reason below. Most refusals are gates working as intended rather than faults.',
  },
}
