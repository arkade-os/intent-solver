/** One in-flight carrier fill: what lets a restarted solver tell never-submitted from possibly-submitted. */

export type CarrierAttemptPhase =
  'prepared' | 'quoted' | 'submitting' | 'settled' | 'not_submitted' | 'cancelling' | 'cancelled'

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
export interface JsonObject {
  [key: string]: JsonValue
}

export interface CarrierAttempt {
  phase: CarrierAttemptPhase
  snapshot: JsonObject
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
  'cancelling',
  'cancelled',
])

const BOUND: ReadonlySet<string> = new Set<CarrierAttemptPhase>([
  'quoted',
  'submitting',
  'settled',
  'cancelling',
  'cancelled',
])

const ENVELOPE_KEYS: ReadonlySet<string> = new Set(['v', 'phase', 'snapshot', 'binding', 'fill_txid'])

const CANONICAL_TXID = /^[0-9a-f]{64}$/

// Copied before any await and key-sorted, so the bytes every CAS compares depend on content alone.
const detachJson = (value: unknown, path: string): JsonValue => {
  if (value === null) return null
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value
    case 'number':
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
  // A later build's shape could describe a submission this build cannot read.
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

export const decodeCarrierAttempt = (value: unknown): CarrierAttempt => {
  if (typeof value !== 'string') throw new Error('carrier attempt column is not text')
  return carrierAttemptFromJson(JSON.parse(value) as unknown)
}

export const decodeCarrierAttemptOrNull = (value: unknown): CarrierAttempt | null =>
  value === null || value === undefined ? null : decodeCarrierAttempt(value)
