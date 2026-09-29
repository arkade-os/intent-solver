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
  isRfqRefusalErrorCode,
  isRfqRefusalReason,
  isRfqRefusalUnit,
  extractRfqId,
  zodDetail,
} from '@arkade-os/solver-core/core/rfqProtocol.js'

/**
 * `detail` says why a request was turned away, for the LOG only: the closed refusal vocabulary is deliberately
 * coarse, and no payload builder reads `detail`, so it cannot reach the wire by accident. Values are FIELD and
 * check NAMES, never field values — invoices, addresses and pubkeys are money-linkable or the client's to keep.
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
  let payload = outcome.payload
  const reason = (payload as { reason?: unknown }).reason
  // ABSENCE is rejected as firmly as a non-member: `rfqRefusalPayload` always names a reason, so a reasonless
  // refusal means the corridor bypassed it. A `quote` carries no reason and is not asked for one.
  if ((outcome.kind === 'refused' || outcome.kind === 'invalid') && reason === undefined) {
    return reject(`a ${outcome.kind} outcome must name a refusal reason`)
  }
  if (reason !== undefined && !(typeof reason === 'string' && isRfqRefusalReason(reason))) {
    return reject(`refusal reason ${JSON.stringify(reason)} is not in the closed set`)
  }
  if (outcome.kind !== 'quote') {
    const { error_code: errorCode, field, actual, expected, limit, unit, ...base } = payload
    if (!(typeof errorCode === 'string' && isRfqRefusalErrorCode(errorCode))) {
      payload = base
    } else {
      payload = {
        ...base,
        error_code: errorCode,
        ...(typeof field === 'string' ? { field } : {}),
        ...(Number.isSafeInteger(actual) ? { actual } : {}),
        ...(Number.isSafeInteger(expected) ? { expected } : {}),
        ...(Number.isSafeInteger(limit) ? { limit } : {}),
        ...(typeof unit === 'string' && isRfqRefusalUnit(unit) ? { unit } : {}),
      }
    }
  }
  const encoded = JSON.stringify(payload)
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
  return (payload === outcome.payload ? outcome : { ...outcome, payload }) as RfqOutcome
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

  // A NAMED pair this solver does not serve is `unsupported_pair`, never another corridor's schema failure
  // (`unsupported_payload`): an operator can switch a corridor off, so this is a routine answer, not bad input.
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
 * Handle one `rfq_status_request`. It carries no `pair`, so corridors are asked in registration order until one
 * claims the `rfq_id` (the order is latency, not correctness). READERS, not the quoting registry: readers are built
 * from the STORES, so a corridor switched off still answers for swaps it quoted, where a `CorridorSet` would report
 * "no negotiation" for a live swap.
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
  // A throw ends the fall-through exactly as the refusal `statusFor`'s contract forbids does:
  // the first store's driver fault would hide a live swap in the fourth. Stepped over, not obeyed.
  let fault: unknown
  let faulted = false
  for (const corridor of readers) {
    let status: Record<string, unknown> | null
    try {
      status = await corridor.statusFor(rfqId)
    } catch (error) {
      if (!faulted) fault = error
      faulted = true
      continue
    }
    if (status) return { kind: 'status', payload: status }
  }
  // `unknown` is "no negotiation with this rfq_id" — a store that could not be read has not said that.
  if (faulted) throw fault
  return {
    kind: 'unknown',
    payload: rfqRefusalPayload(rfqId, 'unsupported_payload'),
    detail: 'no negotiation with this rfq_id in any corridor',
  }
}
