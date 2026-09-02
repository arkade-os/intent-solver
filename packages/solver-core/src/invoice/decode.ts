/**
 * BOLT11 decoding and validation.
 *
 * Every fact the send leg's safety gates check has to come from the invoice
 * itself. Taking the client's word for the amount, the network or the expiry
 * makes those gates decorative: a client can declare 500 sats, lock up 500, and
 * hand over an invoice for a million.
 *
 * Pure — no clock, no I/O — so the gates are testable at their boundaries.
 */

import bolt11 from 'light-bolt11-decoder'

/** Longest input we will bech32-decode. Unbounded parsing is free DoS. */
export const MAX_INVOICE_LENGTH = 2048

/** BOLT11's default when the invoice carries no expiry tag. */
const DEFAULT_EXPIRY_SECONDS = 3600

/** BOLT11's default when the invoice carries no `c` tag. */
const DEFAULT_MIN_FINAL_CLTV = 18

/**
 * Parse a BOLT11 to its sections, applying only the defences that are about
 * PARSING — a length bound and decodability — and none of the send leg's
 * ceilings.
 *
 * Every reader built on it exists for the reason {@link finalCltvBlocksOf}
 * gives at length: {@link decodeInvoice} bundles parsing with the send leg's
 * CLTV defences, and a caller that wants one scalar off a string it already
 * holds is not asking for those defences to run again.
 */
const sectionReader = (raw: string): ((name: string) => unknown) => {
  if (raw.length > MAX_INVOICE_LENGTH) throw new InvalidInvoice('too_long')
  let decoded: ReturnType<typeof bolt11.decode>
  try {
    decoded = bolt11.decode(raw.toLowerCase())
  } catch {
    throw new InvalidInvoice('malformed')
  }
  return (name) => ((decoded.sections.find((s) => s.name === name) ?? {}) as { value?: unknown }).value
}

/**
 * The final CLTV delta on an invoice THIS SOLVER MINTED, read without the
 * client-invoice defences {@link decodeInvoice} applies.
 *
 * ## Why this exists rather than a call to `decodeInvoice`
 *
 * Every CLTV ceiling in this file is a SEND-leg protection, and their own
 * comments say so: a large delta "lets the payee hold our outbound HTLC well
 * past any refund deadline we would quote", and the combined bound guards the
 * double-collect window — a client whose invoice outlives their own Arkade
 * refund, so they take the lockup back AND settle the payment.
 *
 * On the RECEIVE leg every term of that inverts. We are the payee, the HTLC is
 * inbound, and a larger delta pushes `E` LATER — which every gate in
 * `core/receive.ts` wants rather than fears. There is no hostile invoice here,
 * because the invoice is ours.
 *
 * Applying those ceilings to our own invoice was not merely pointless, it was
 * fatal: the mainnet privacy wrapper mints 420 blocks against a
 * `MAX_CLIENT_CLTV_BLOCKS` of 288, so the receive corridor threw
 * `cltv_too_large` on every quote it ever made.
 *
 * ## Why not just raise the bound
 *
 * Because 288 is load-bearing where it stands. It caps what a CLIENT's invoice
 * may demand of us, and the comment below is explicit that the combined check —
 * not the `c`-only one — is the one that matters. Raising it to admit our own
 * 420 would widen the double-collect window on every client invoice, to fix a
 * leg the bound was never written about.
 *
 * So the bound stays, and stops being applied where its threat cannot arise.
 *
 * Returns BOLT11's default of 18 when there is no `c` tag, exactly as
 * {@link decodeInvoice} does: an absent tag is a real 18, not "unknown".
 */
export const finalCltvBlocksOf = (raw: string): number => {
  const value = sectionReader(raw)('min_final_cltv_expiry')
  return typeof value === 'number' ? value : DEFAULT_MIN_FINAL_CLTV
}

/**
 * The payment hash of an invoice THIS SOLVER HAS ALREADY ACCEPTED, read without
 * the send leg's CLTV defences.
 *
 * The precondition is the whole point. Both callers — the LND adapter and the
 * fake backend — are handed `row.invoice`, a string {@link decodeInvoice}
 * accepted at quote time, and they want the hash to key a payment by. Running
 * the ceilings again there is not defence in depth, it is a SECOND opinion on a
 * question already answered, and the two opinions can differ: a hint filtered
 * out by {@link decodeInvoice}'s scid denylist is still in the raw string, so a
 * row whose every hint was dropped decodes to `best = 0` on the path that
 * accepted it and to the raw hint's total here. That disagreement would throw
 * `cltv_too_large` from inside `payInvoice` — on a row already funded and
 * committed to `paying`, which is a stuck swap, not a refusal.
 *
 * Deliberately narrow: it answers one field and validates only that field, so
 * it cannot become a second decoder with its own idea of what an invoice is.
 */
export const paymentHashOf = (raw: string): string => {
  const value = sectionReader(raw)('payment_hash')
  if (typeof value !== 'string' || value.length !== 64) throw new InvalidInvoice('missing_payment_hash')
  return value
}

/**
 * The amount of an invoice this solver has already accepted, in sats — the same
 * already-answered-question reading as {@link paymentHashOf}, for the RFQ quote
 * payload's `to_amount`.
 *
 * That field re-decodes `row.invoice` rather than storing a second copy, so it
 * cannot go stale against the row. Re-decoding is right; re-JUDGING is what
 * this avoids, and there it would be worse than a stuck row — the throw lands
 * while building the quote we just accepted, so the client is never answered at
 * all.
 */
export const amountSatsOf = (raw: string): number => {
  const millisats = sectionReader(raw)('amount')
  const msat = Number(millisats)
  if (millisats === undefined || millisats === null || millisats === '' || !Number.isFinite(msat) || msat <= 0) {
    throw new InvalidInvoice('missing_amount')
  }
  return msat / 1000
}

/**
 * Ceiling we accept on a CLIENT's invoice final CLTV delta, in blocks.
 *
 * This bounds how long the payee can keep our outbound HTLC alive, which is the
 * quantity the Arkade refund deadline has to outlast. ~2 days at 10 min/block.
 *
 * `CLIENT` is in the name because `core/receive.ts` exports a ceiling of its own,
 * and until this rename both were called `MAX_FINAL_CLTV_BLOCKS`. They are
 * different quantities in opposite directions, which is exactly the pair you do
 * not want sharing a name:
 *
 * | | this one | `core/receive.ts`'s |
 * |---|---|---|
 * | value | 288 | 2016 |
 * | whose invoice | the client's, which we PAY | ours, which a client pays |
 * | what it protects | the solver, from an HTLC outliving our refund | the corridor, from minting an invoice no stock payer will route |
 *
 * The confusion is not hypothetical. Reading `2016` and applying it here made a
 * 420-block invoice look acceptable when this file refuses anything over 288 —
 * a wrong answer about which bound was in the way, on a corridor that was down.
 */
export const MAX_CLIENT_FINAL_CLTV_BLOCKS = 288

/**
 * Ceiling on ALL the CLTV an invoice's writer can dictate: the final delta plus
 * a route hint.
 *
 * `MAX_CLIENT_FINAL_CLTV_BLOCKS` bounds only the `c` field, which is half the story. A
 * BOLT11 `r` field carries a `cltv_expiry_delta` per hop — a u16, any number of
 * hops, any number of hints — and a payer is bound by every hop of whichever
 * hint it routes through. So an invoice's writer can demand CLTV far past the
 * final delta without touching `c` at all.
 *
 * That total is what the refund deadline has to outlast, so that total is what
 * has to be bounded. ~2 days at 10 min/block, which no honest payee needs.
 *
 * WHICH hint the total is taken over is a two-tier question, and only the first
 * tier lives in this file:
 *
 * - Here, against the BEST hint — a floor. Hints are alternatives, so an
 *   invoice failing even its most favourable reading is unservable on any rail,
 *   which is a fact about the invoice and needs no backend knowledge. Being
 *   unconditional, it is also what stops "no bound at all" from happening by
 *   omission if the gate below is ever left unwired.
 * - In `evaluateSendAcceptance`, against the WORST hint, and only on a rail
 *   that cannot cap the route it picks. That one is a fact about the
 *   DEPLOYMENT: on LND the ceiling is enforced (`max_timeout_height`), so a bad
 *   hint among several costs a refused payment rather than an HTLC outliving
 *   the refund deadline; on a rail where nothing enforces, the worst hint is
 *   the only honest reading and the double-collect window is what is at stake.
 */
export const MAX_CLIENT_CLTV_BLOCKS = 288

export interface DecodedInvoice {
  /** The exact string to hand to the backend. Never re-encoded. */
  invoice: string
  paymentHash: string
  amountSats: number
  /** Absolute expiry, unix seconds. */
  expiresAt: number
  /** bech32 prefix: 'bc' | 'tb' | 'tbs' | 'bcrt'. */
  network: string
  /** Final CLTV delta the payee requires, in blocks. */
  minFinalCltvBlocks: number
  /**
   * Worst route hint's total CLTV delta, in blocks — the MAX across hints of the
   * SUM within one, because the payer follows every hop of the one hint it picks
   * and may pick any of them. Zero when the invoice carries none.
   *
   * Named for the quantity it holds. It was `routeHintCltvBlocks`, which meant
   * the worst without saying so — the same shape as the `MAX_FINAL_CLTV_BLOCKS`
   * collision documented above, and now that a best exists too, the shape that
   * would let a caller take the wrong bound and compile.
   */
  worstRouteHintCltvBlocks: number
  /**
   * Best route hint's total, in blocks — the MIN across hints of that same sum.
   * Zero when the invoice carries none.
   *
   * The most favourable honest reading: the hints are ALTERNATIVES, so a payer
   * that can steer its route is bound by this one and no more. Which of the two
   * a given deployment is actually bound by is `core/send.ts`'s call — see
   * `hintCltvBlocks`.
   */
  bestRouteHintCltvBlocks: number
  /**
   * Hints the scid denylist removed before either total above was taken, for
   * the operator's log. Absent when nothing was dropped — which is every
   * decode on a deployment that sets no denylist.
   *
   * Not a gate input and never on the wire. It exists because narrowing what we
   * price without saying so is how a denylist becomes invisible: the entry
   * lives in an env var, the effect is a number inside a refund deadline, and
   * without this nothing records that the two met. `InvalidInvoice.detail`'s
   * rule applies — operator-facing only.
   */
  droppedHints?: readonly DroppedHint[]
}

/** One hint the denylist removed: the scid that named it, and what it cost. */
export interface DroppedHint {
  /** The denylisted scid found in the hint, lowercase hex. */
  scid: string
  /** The hint's own total CLTV, in blocks — the number that is no longer priced. */
  cltv: number
}

export type InvoiceRejection =
  | 'too_long'
  | 'mixed_case'
  | 'malformed'
  | 'missing_payment_hash'
  | 'missing_amount'
  | 'sub_satoshi_amount'
  | 'missing_network'
  | 'missing_timestamp'
  | 'cltv_too_large'

export class InvalidInvoice extends Error {
  constructor(
    readonly reason: InvoiceRejection,
    /**
     * The numbers behind the reason, for the operator's log.
     *
     * Deliberately NOT part of {@link reason}, which is a closed enum the wire
     * mapping and `src/core/refusalReasons.ts` both switch on. This rides in
     * the message instead, and every catch site puts the message in a log
     * `detail` while answering the client from the enum — so a bound and the
     * value that broke it never reach a client, and adding one here cannot
     * change what any client is told.
     *
     * Worth having because a reason alone can be ambiguous about WHICH check
     * fired: two separate ceilings raise `cltv_too_large`, and telling them
     * apart is the difference between "an unusual payee, refuse it" and "our
     * bound is too tight for ordinary invoices".
     */
    detail?: string,
  ) {
    super(detail ? `invoice rejected: ${reason} (${detail})` : `invoice rejected: ${reason}`)
    this.name = 'InvalidInvoice'
  }
}

/**
 * One hop of a BOLT11 `r` field, as the decoder hands it over.
 *
 * Both fields are `unknown` rather than their nominal types: this is a client's
 * string, parsed by a library whose section union does not narrow, so every
 * read below is guarded at its use site.
 */
interface RouteHintHop {
  cltv_expiry_delta?: unknown
  short_channel_id?: unknown
}

/** A hop's channel id, lowercased to compare; '' when the decoder gave none. */
const scidOf = (hop: RouteHintHop): string =>
  typeof hop.short_channel_id === 'string' ? hop.short_channel_id.toLowerCase() : ''

/**
 * The default `denylist`: no scid is denied, so every hint is priced. Shared
 * rather than allocated per call — this is the value on every deployment that
 * sets no `LN_SEND_HINT_SCID_DENYLIST`.
 */
const NO_DENIED_SCIDS: ReadonlySet<string> = new Set()

/**
 * Decode and validate an untrusted BOLT11.
 *
 * Throws {@link InvalidInvoice} with a closed reason rather than letting the
 * decoder's own error text reach a client.
 *
 * `denylist` names channels (lowercase hex scids) whose hints are not priced —
 * see the filter below. Optional and empty by default, so a caller that has no
 * opinion gets exactly the pre-denylist reading. Callers that decode a swap
 * ROW's invoice must all pass the same set: the totals are what the refund
 * deadline is priced from, and quote, funding and payment disagreeing about
 * them is the stale-second-copy failure this decode is pure to avoid.
 */
export const decodeInvoice = (raw: string, denylist: ReadonlySet<string> = NO_DENIED_SCIDS): DecodedInvoice => {
  if (raw.length > MAX_INVOICE_LENGTH) throw new InvalidInvoice('too_long')

  // BOLT11 is case-insensitive but must not be mixed; bech32 checksums are
  // defined over a single case.
  const hasLower = /[a-z]/.test(raw)
  const hasUpper = /[A-Z]/.test(raw)
  if (hasLower && hasUpper) throw new InvalidInvoice('mixed_case')

  const invoice = raw.toLowerCase()

  let decoded: ReturnType<typeof bolt11.decode>
  try {
    decoded = bolt11.decode(invoice)
  } catch {
    throw new InvalidInvoice('malformed')
  }

  // The decoder's Section union includes variants with no `value`, so narrow.
  const section = (name: string): { value?: unknown } =>
    (decoded.sections.find((s) => s.name === name) ?? {}) as { value?: unknown }

  const paymentHash = section('payment_hash').value
  if (typeof paymentHash !== 'string' || paymentHash.length !== 64) {
    throw new InvalidInvoice('missing_payment_hash')
  }

  // Read the network from the parsed HRP, never from startsWith: 'lnbc' is a
  // prefix of 'lnbcrt', so a naive check accepts a regtest invoice on mainnet.
  const networkValue = section('coin_network').value as { bech32?: string } | undefined
  const network = networkValue?.bech32 ?? ''
  if (!network) throw new InvalidInvoice('missing_network')

  const timestamp = section('timestamp').value
  if (typeof timestamp !== 'number' || timestamp <= 0) throw new InvalidInvoice('missing_timestamp')

  const millisats = section('amount').value
  if (millisats === undefined || millisats === null || millisats === '') throw new InvalidInvoice('missing_amount')
  const msat = Number(millisats)
  if (!Number.isFinite(msat) || msat <= 0) throw new InvalidInvoice('missing_amount')
  // A sub-satoshi amount cannot be backed by an integer-sat lockup, so the
  // lockup comparison would be against mismatched units.
  if (msat % 1000 !== 0) throw new InvalidInvoice('sub_satoshi_amount')

  const cltvValue = section('min_final_cltv_expiry').value
  const minFinalCltvBlocks = typeof cltvValue === 'number' ? cltvValue : DEFAULT_MIN_FINAL_CLTV
  // A large delta lets the payee hold our outbound HTLC well past any refund
  // deadline we would quote.
  //
  // STRICTLY REDUNDANT against the combined check below, and kept deliberately.
  // `bestRouteHintCltvBlocks >= 0`, so anything failing here fails there too — this
  // is a fast path that refuses the commonest bad invoice before walking every
  // route hint, not a second rule. Do not "simplify" by deleting the combined
  // check on the grounds that this one already covers `c`: it is the combined
  // one that is load-bearing, because an invoice can demand unbounded CLTV
  // through `r` fields without touching `c` at all. If either goes, this is the
  // one that goes.
  if (minFinalCltvBlocks > MAX_CLIENT_FINAL_CLTV_BLOCKS) {
    throw new InvalidInvoice('cltv_too_large', `final delta ${minFinalCltvBlocks} > ${MAX_CLIENT_FINAL_CLTV_BLOCKS}`)
  }

  // Every `r` field, not just the first: each is one alternative hint, and the
  // payer may route through whichever it likes.
  const hints = decoded.sections
    .filter((s) => s.name === 'route_hint')
    .map((hint) => {
      const hops = ((hint as { value?: unknown }).value ?? []) as RouteHintHop[]
      return {
        cltv: hops.reduce(
          (sum, hop) => sum + (typeof hop.cltv_expiry_delta === 'number' ? hop.cltv_expiry_delta : 0),
          0,
        ),
        deniedScid: hops.map(scidOf).find((scid) => denylist.has(scid)),
      }
    })

  // A denylisted scid is one an OPERATOR has authoritative grounds to say cannot
  // route — see `LN_SEND_HINT_SCID_DENYLIST` in `src/config.ts`. No payer can
  // take such a hint, so pricing our refund deadline against it prices a route
  // that does not exist; dropping it is not lifting a bound, it is declining to
  // bound against a fiction.
  //
  // Nothing here verifies that premise, and nothing could: a hint's scid may be
  // an `option_scid_alias`, which BOLT #2 requires to be unrelated to the real
  // `short_channel_id` and permits in `r` fields, so the string carries no
  // evidence either way. A WRONG entry is a fund-risk rather than a lost swap —
  // a routable channel listed here is priced out of a deadline a route can
  // still take, which on a rail that caps nothing is the double-collect window.
  // The standard for adding one lives in docs/runbook.md.
  //
  // The WHOLE hint goes when ANY of its hops is denylisted. A hint is a path,
  // and a path with a hop cut out of the middle is a path that does not exist —
  // per-hop dropping would leave us pricing a route as fictional as the one it
  // was meant to remove.
  //
  // Both totals are taken over the survivors, and an all-dropped invoice reads
  // 0/0 — the no-hints case, which the gates below and in `core/send.ts` already
  // answer correctly, since an invoice whose only hints are unroutable is one a
  // payer routes to without hints.
  const dropped: DroppedHint[] = []
  const hintTotals: number[] = []
  for (const hint of hints) {
    if (hint.deniedScid === undefined) hintTotals.push(hint.cltv)
    else dropped.push({ scid: hint.deniedScid, cltv: hint.cltv })
  }
  const worstRouteHintCltvBlocks = hintTotals.reduce((worst, total) => Math.max(worst, total), 0)
  // The length guard, not a seeded reduce, and that asymmetry with the line
  // above is the point. `Math.max` tolerates a 0 seed because no hints really
  // does mean 0. Seeding a min at 0 returns 0 for EVERY invoice — 0 is <= any
  // hop sum — which reads as correct twice over: the no-hints case still
  // answers the documented 0, and the floor below silently degrades to the
  // final-delta fast path, so an all-bad-hint invoice is quoted against a
  // ten-month deadline and declines at pay time instead of here.
  const bestRouteHintCltvBlocks = hintTotals.length === 0 ? 0 : Math.min(...hintTotals)
  // The floor: what this invoice demands under its most favourable honest
  // routing, which no backend has any business serving however capable it is.
  // Bounding the WORST here instead is what refused a Wallet of Satoshi invoice
  // carrying hints of [40] and [40000] — payable by every real payer, since the
  // 40000 is one alternative among several. Whether THIS deployment's rail can
  // steer around it is `evaluateSendAcceptance`'s question; decode knows no
  // backend, which is why the bound that lives here is the backend-blind one.
  if (minFinalCltvBlocks + bestRouteHintCltvBlocks > MAX_CLIENT_CLTV_BLOCKS) {
    throw new InvalidInvoice(
      'cltv_too_large',
      `final delta ${minFinalCltvBlocks} + best route hint ${bestRouteHintCltvBlocks} = ` +
        `${minFinalCltvBlocks + bestRouteHintCltvBlocks} > ${MAX_CLIENT_CLTV_BLOCKS} (best-hint floor)`,
    )
  }

  const expiry = decoded.expiry ?? DEFAULT_EXPIRY_SECONDS

  return {
    invoice,
    paymentHash,
    amountSats: msat / 1000,
    expiresAt: timestamp + expiry,
    network,
    minFinalCltvBlocks,
    worstRouteHintCltvBlocks,
    bestRouteHintCltvBlocks,
    // Omitted rather than empty when nothing was dropped, so the shape a
    // deployment without a denylist sees is byte-for-byte the one it saw
    // before the filter existed.
    ...(dropped.length > 0 ? { droppedHints: dropped } : {}),
  }
}
