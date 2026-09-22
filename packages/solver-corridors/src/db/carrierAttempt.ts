/**
 * The PRIVATE record of one in-flight carrier fill attempt, as it is stored:
 * what lets a restarted solver tell "never submitted" from "possibly
 * submitted". Deliberately not on `AssetRfqSwapRow` and not in `carrier_terms`,
 * which are a promise to the CLIENT and emitted to it verbatim.
 *
 * The store owns the phase and the byte-stable identity; the app adapter owns
 * what a snapshot and a binding MEAN. So both payloads are opaque here beyond
 * being JSON — validated, key-sorted and deep-copied, so the same content
 * always serializes to the same TEXT and a single-statement compare-and-set can
 * match the exact previous checkpoint.
 */

export type CarrierAttemptPhase = 'prepared' | 'quoted' | 'submitting' | 'settled' | 'not_submitted'

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
export interface JsonObject {
  [key: string]: JsonValue
}

export interface CarrierAttempt {
  phase: CarrierAttemptPhase
  /** Pinned before the first quote POST, and never replaced afterwards. */
  snapshot: JsonObject
  /** The independently verified quote id and rebuilt graph, bound once. */
  binding?: JsonObject
  fillTxid?: string
}

const VERSION = 1

const PHASES: ReadonlySet<string> = new Set<CarrierAttemptPhase>([
  'prepared',
  'quoted',
  'submitting',
  'settled',
  'not_submitted',
])

/** Phases a binding MADE, so one that reached them without it is corruption. */
const BOUND: ReadonlySet<string> = new Set<CarrierAttemptPhase>(['quoted', 'submitting', 'settled'])

const ENVELOPE_KEYS: ReadonlySet<string> = new Set(['v', 'phase', 'snapshot', 'binding', 'fill_txid'])

const CANONICAL_TXID = /^[0-9a-f]{64}$/

/**
 * A deep, key-sorted copy of caller input, refusing anything JSON cannot carry
 * exactly. Both halves are load-bearing: the COPY is taken before any await, so
 * a caller still holding its object cannot change what this row records about
 * money it is about to move, and the SORT makes the serialized bytes a function
 * of content alone — which is what every CAS predicate here compares.
 */
const detachJson = (value: unknown, path: string): JsonValue => {
  if (value === null) return null
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value
    case 'number':
      // A magnitude past exact integer range comes back from JSON.parse as a
      // DIFFERENT number, so it is refused rather than silently rounded.
      if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
        throw new Error(`carrier attempt ${path} is not an exactly representable JSON number`)
      }
      return value
    case 'bigint':
      throw new Error(`carrier attempt ${path} is a bigint; amounts belong here as canonical decimal strings`)
    case 'object':
      break
    default:
      throw new Error(`carrier attempt ${path} is a ${typeof value}, which is not JSON`)
  }
  if (Array.isArray(value)) return value.map((entry, index) => detachJson(entry, `${path}[${index}]`))
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`carrier attempt ${path} is a live instance, not a plain JSON object`)
  }
  const copy: JsonObject = {}
  for (const key of Object.keys(value as object).sort()) {
    copy[key] = detachJson((value as Record<string, unknown>)[key], `${path}.${key}`)
  }
  return copy
}

export const detachJsonObject = (value: unknown, field: string): JsonObject => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`carrier attempt ${field} is not a JSON object`)
  }
  return detachJson(value, field) as JsonObject
}

const assertBinding = (phase: CarrierAttemptPhase, present: boolean): void => {
  if (BOUND.has(phase) && !present) throw new Error(`carrier attempt phase '${phase}' has no quote binding`)
  if (phase === 'prepared' && present) throw new Error('a prepared carrier attempt has nothing bound to it yet')
}

const assertFillTxid = (phase: CarrierAttemptPhase, fillTxid: unknown): void => {
  if (phase !== 'settled') {
    if (fillTxid !== undefined) throw new Error(`carrier attempt phase '${phase}' has no fill txid to carry`)
    return
  }
  if (typeof fillTxid !== 'string' || !CANONICAL_TXID.test(fillTxid)) {
    throw new Error(`carrier attempt fill txid '${String(fillTxid)}' is not canonical`)
  }
}

const carrierAttemptToJson = (attempt: CarrierAttempt): Record<string, unknown> => {
  if (!PHASES.has(attempt.phase)) throw new Error(`carrier attempt phase '${String(attempt.phase)}' is unknown`)
  const binding = attempt.binding === undefined ? undefined : detachJsonObject(attempt.binding, 'binding')
  assertBinding(attempt.phase, binding !== undefined)
  assertFillTxid(attempt.phase, attempt.fillTxid)
  return {
    v: VERSION,
    phase: attempt.phase,
    snapshot: detachJsonObject(attempt.snapshot, 'snapshot'),
    ...(binding === undefined ? {} : { binding }),
    ...(attempt.fillTxid === undefined ? {} : { fill_txid: attempt.fillTxid }),
  }
}

const carrierAttemptFromJson = (value: unknown): CarrierAttempt => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('carrier attempt is not an object')
  }
  const raw = value as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (!ENVELOPE_KEYS.has(key)) throw new Error(`carrier attempt has unknown key '${key}'`)
  }
  // Exactly this version: guessing at a shape a later build wrote would be
  // guessing about a possible submission.
  if (raw.v !== VERSION) throw new Error(`carrier attempt version '${String(raw.v)}' is not one this build wrote`)
  const phase = raw.phase
  if (typeof phase !== 'string' || !PHASES.has(phase)) {
    throw new Error(`carrier attempt phase '${String(phase)}' is unknown`)
  }
  const binding = raw.binding === undefined ? undefined : detachJsonObject(raw.binding, 'binding')
  assertBinding(phase as CarrierAttemptPhase, binding !== undefined)
  assertFillTxid(phase as CarrierAttemptPhase, raw.fill_txid)
  return {
    phase: phase as CarrierAttemptPhase,
    snapshot: detachJsonObject(raw.snapshot, 'snapshot'),
    ...(binding === undefined ? {} : { binding }),
    ...(raw.fill_txid === undefined ? {} : { fillTxid: raw.fill_txid as string }),
  }
}

export const encodeCarrierAttempt = (attempt: CarrierAttempt): string => JSON.stringify(carrierAttemptToJson(attempt))

/** A stored blob is JSON this module wrote; anything else is corruption. */
export const decodeCarrierAttempt = (value: unknown): CarrierAttempt => {
  if (typeof value !== 'string') throw new Error('carrier attempt column is not text')
  return carrierAttemptFromJson(JSON.parse(value) as unknown)
}

export const decodeCarrierAttemptOrNull = (value: unknown): CarrierAttempt | null =>
  value === null || value === undefined ? null : decodeCarrierAttempt(value)
