/**
 * RFQ ingress: the ONE implementation of the rfq_* request handling, shared by
 * both transports (HTTP host and relay ingress). The transport maps the outcome
 * to its own framing (HTTP status codes, relay events); it never shapes the
 * payload.
 *
 * Refusal discipline (docs/rfq-protocol.md § 10): everything leaving here is
 * from the closed RFQ set. Validation failures — schema, pair shape, amount
 * mismatch, undecodable invoice — are `invalid` outcomes; a served-but-declined
 * quote is `refused`. The split exists so HTTP can keep its 400/422 boundary.
 */

import type { CorridorReaderSet, CorridorRfqOutcome, CorridorSet } from '@arkade-os/solver-core/core/corridor.js'
// Corridor-neutral RFQ vocabulary, taken straight from core: a dispatcher that
// must not know which corridors exist cannot import one to read constants.
import {
  RfqStatusRequest,
  rfqRefusalPayload,
  isRfqRefusalReason,
  extractRfqId,
  zodDetail,
} from '@arkade-os/solver-core/core/rfqProtocol.js'

/**
 * Why a request was turned away, for the LOG only — never for the wire.
 *
 * The closed RFQ vocabulary is deliberately coarse: six distinct faults on the
 * Lightning send leg alone all reach the client as `unsupported_payload`,
 * because a client can do nothing useful with a finer answer and a solver that
 * narrated its internals would be describing its own validation to anyone who
 * asked. That is the right contract and it is not what changes here.
 *
 * What it cost is diagnosis. A refusal is not an exception, so nothing reached
 * `onError` and the service logged NOTHING at all for a rejected request —
 * leaving an operator to guess which of six checks fired, with the only other
 * copy of the answer inside someone else's wallet. That happened on mainnet on
 * 2026-08-21.
 *
 * So the reason travels beside the payload rather than inside it. Populated at
 * every non-quote exit, logged by the transports, and impossible to serialise
 * onto the wire by accident because no payload builder reads it.
 *
 * Values are FIELD NAMES and check names, never field values: an invoice, a
 * refund address and a pubkey are all either money-linkable or the client's to
 * keep, and a log line outlives the incident that justified it.
 */
export type RfqOutcome =
  /**
   * Binding terms issued (or re-emitted): the transport's success shape.
   *
   * `detail?: never` rather than omitted: it says the thing that is true —
   * terms were issued, so there is no refusal to explain — and it lets a
   * caller read `outcome.detail` off the union without narrowing first, which
   * is exactly what both transports do.
   */
  | { kind: 'quote'; payload: Record<string, unknown>; detail?: never }
  /** Valid request the solver declines — HTTP 422. */
  | { kind: 'refused'; payload: Record<string, unknown>; detail?: string }
  /** The request itself is unserviceable — HTTP 400. */
  | { kind: 'invalid'; payload: Record<string, unknown>; detail?: string }

/**
 * Best-effort correlation id off an unparseable payload, so even an
 * `unsupported_payload` refusal tells the sender WHICH negotiation it killed.
 * Bounded: an attacker-sized string must not be echoed back onto the wire.
 */
const extractPair = (payload: unknown): string | undefined => {
  const pair = (payload as { pair?: unknown } | null)?.pair
  return typeof pair === 'string' ? pair : undefined
}

const MAX_CORRIDOR_PAYLOAD_BYTES = 8_192

/**
 * The corridor owns its request schema; the host still owns the WIRE.
 *
 * Moving schema validation into the corridor is what lets a corridor this build
 * never compiled against serve traffic — but the refusal vocabulary is the
 * PROTOCOL, and this file's whole discipline is that a solver never narrates
 * its internals to anyone who asks. A corridor returning a free-text reason
 * would undo that silently, so the reason is checked against the closed set
 * here and anything else becomes `unsupported_payload`.
 *
 * The corridor's real answer travels in `detail`, which the transports LOG and
 * no payload builder reads — the same split `RfqOutcome.detail` already uses so
 * a refusal reason cannot reach the wire by accident.
 */
const enforceWireContract = (pair: string, rfqId: string | undefined, outcome: CorridorRfqOutcome): RfqOutcome => {
  const reject = (why: string): RfqOutcome => ({
    kind: 'invalid',
    payload: rfqRefusalPayload(rfqId, 'unsupported_payload'),
    detail: `corridor ${pair}: ${why}`,
  })

  if (outcome.kind !== 'quote' && outcome.kind !== 'refused' && outcome.kind !== 'invalid') {
    return reject(`unknown outcome kind ${JSON.stringify(outcome.kind)}`)
  }
  const reason = (outcome.payload as { reason?: unknown }).reason
  // ABSENCE IS REJECTED AS FIRMLY AS A NON-MEMBER. The earlier check only fired
  // when a reason was PRESENT, so a corridor returning
  // `{ kind: 'refused', payload: { v: 1, type: 'rfq_refusal' } }` — no `reason`
  // field at all — passed enforcement and put a reasonless refusal on the wire.
  //
  // That is the one thing this gate exists to stop for third-party corridor
  // code. A client receiving a refusal with no reason cannot tell "we do not
  // serve this pair" from "try again in a minute", which is the whole point of
  // the closed set. Both refusing kinds build their payload through
  // `rfqRefusalPayload`, which always names one, so an absent reason means the
  // corridor bypassed it.
  //
  // A `quote` carries no reason and is not asked for one.
  if ((outcome.kind === 'refused' || outcome.kind === 'invalid') && reason === undefined) {
    return reject(`a ${outcome.kind} outcome must name a refusal reason`)
  }
  if (reason !== undefined && !(typeof reason === 'string' && isRfqRefusalReason(reason))) {
    return reject(`refusal reason ${JSON.stringify(reason)} is not in the closed set`)
  }
  const encoded = JSON.stringify(outcome.payload)
  // byteLength, not .length: the cap is a WIRE budget, and `String.length`
  // counts UTF-16 code units. Any non-ASCII character the corridor puts in a
  // detail field is two or three bytes on the wire and one unit here, so the
  // string measure lets an oversized payload through the check that exists to
  // stop it — and the message would have reported the wrong number while doing
  // so, since it already says "bytes".
  const bytes = Buffer.byteLength(encoded, 'utf8')
  if (bytes > MAX_CORRIDOR_PAYLOAD_BYTES) {
    return reject(`payload is ${bytes} bytes, over the ${MAX_CORRIDOR_PAYLOAD_BYTES} cap`)
  }
  return outcome as RfqOutcome
}

/** Handle one `rfq_request`, dispatched to the corridor that serves its `pair`. */
export const respondToRfqRequest = async (
  corridors: CorridorSet,
  payload: unknown,
  /** The transport's requester identity, for quote admission control. */
  options?: { requesterKey?: string },
): Promise<RfqOutcome> => {
  const pair = extractPair(payload)

  // `pair` is REQUIRED, so its absence is a payload fault — not
  // `unsupported_pair`, which would call a malformed request an unserved
  // corridor. Answered here rather than routed to a corridor's schema, which
  // would mean naming a specific corridor in a corridor-agnostic file.
  if (pair === undefined) {
    return {
      kind: 'invalid',
      payload: rfqRefusalPayload(extractRfqId(payload), 'unsupported_payload'),
      detail: 'no pair on the request',
    }
  }

  // A NAMED pair this solver does not serve is a corridor fact, and it has to
  // say so whatever else is configured. Before this check the lightning-send
  // handler was a catch-all, so an unknown pair reached a schema built for a
  // BOLT11 profile, failed it, and came back `unsupported_payload` — telling a
  // client its message was malformed when the message was fine and the corridor
  // was the problem. Worse, the answer depended on unrelated configuration: a
  // deployment WITHOUT a send service answered `unsupported_pair` correctly,
  // and every normal one answered wrongly.
  //
  // Refusing by NAME also beats falling through to another handler and being
  // refused as unsupported by accident (or, worse, throwing a TypeError into
  // the transport): "this solver does not serve that corridor" is a different
  // fact to a client than "that pair does not exist", and since an operator can
  // switch a corridor off (`<CORRIDOR>_ENABLED=false`) the first is a routine
  // answer rather than a sign of a misconfigured deployment.
  const target = corridors.get(pair)
  if (!target) {
    return {
      kind: 'invalid',
      payload: rfqRefusalPayload(extractRfqId(payload), 'unsupported_pair'),
      detail: `pair '${pair}' is not served here`,
    }
  }
  return enforceWireContract(target.descriptor.pair, extractRfqId(payload), await target.quote(payload, options))
}

export type RfqStatusOutcome =
  | { kind: 'status'; payload: Record<string, unknown>; detail?: never }
  /** No negotiation under this rfq_id — HTTP 404. */
  | { kind: 'unknown'; payload: Record<string, unknown>; detail?: string }
  | { kind: 'invalid'; payload: Record<string, unknown>; detail?: string }

/**
 * `RfqStores` used to sit here: four named stores this fell through by hand.
 *
 * It is gone because `CorridorReaderSet` does the same job for any corridor,
 * including one this build has never compiled against. The properties it
 * carried are preserved rather than dropped — see `respondToRfqStatus`.
 */

/**
 * Handle one `rfq_status_request`. Carries no `pair`, so every registered
 * corridor is asked in turn until one claims the `rfq_id`. Registration order
 * is the fall-through order — the two send legs first (the busier profiles, and
 * the order this had before the receive legs existed), then Lightning-receive,
 * then onchain-receive. `rfq_id` identifies at most one negotiation, so the
 * chain is pure fall-through and the order is a latency choice, not a
 * correctness one.
 *
 * READERS, NOT THE QUOTING REGISTRY, and the distinction is the whole reason
 * `CorridorReader` exists as a separate interface.
 *
 * A corridor is quotable iff its SERVICE exists, and `createServices` builds a
 * service only for an ENABLED corridor while opening every store regardless.
 * Status must therefore reach WIDER than quoting: it answers for swaps a
 * corridor quoted before it was switched off. Handing this a `CorridorSet`
 * would silently narrow that — a disabled corridor's in-flight swaps would
 * start reporting "no negotiation with this rfq_id", a lie an operator would
 * act on. A `CorridorReaderSet` is built from the STORES, so a disabled
 * corridor still answers.
 *
 * This previously fell through four hardcoded stores, with a comment saying
 * unifying it "needs a corridor that can be registered read-only, which is a
 * design this plan does not have". That design landed in this same change and
 * the comment went stale: raised in review of #215, where the consequence was
 * that a corridor registered through `CorridorSet` could be QUOTED but its
 * in-flight swaps could never be retrieved — `rfq_status_request` would answer
 * "no negotiation with this rfq_id" for a swap that plainly exists.
 */
export const respondToRfqStatus = async (readers: CorridorReaderSet, payload: unknown): Promise<RfqStatusOutcome> => {
  const parsed = RfqStatusRequest.safeParse(payload)
  if (!parsed.success) {
    return {
      kind: 'invalid',
      payload: rfqRefusalPayload(extractRfqId(payload), 'unsupported_payload'),
      detail: `schema: ${zodDetail(parsed.error)}`,
    }
  }
  const rfqId = parsed.data.rfq_id
  for (const corridor of readers) {
    const status = await corridor.statusFor(rfqId)
    if (status) return { kind: 'status', payload: status }
  }
  return {
    kind: 'unknown',
    payload: rfqRefusalPayload(rfqId, 'unsupported_payload'),
    detail: 'no negotiation with this rfq_id in any corridor',
  }
}
