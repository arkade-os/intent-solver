/**
 * Which of a unified save's two passes a single field change belongs in.
 *
 * NARROWING first, WIDENING last, so a save that dies midway has applied some
 * restrictions and no relaxations: the solver quotes LESS than the operator
 * asked for, never more. @see D7.
 *
 * PURE. The caller resolves anything that is a POINTER rather than a value
 * first — `carrierMode`'s `'inherit'`, and a nullable per-direction bps —
 * @see admin/routes/pricingApply.ts.
 */

export type SavePass = 'narrowing' | 'widening'

export type SaveField =
  | 'max'
  | 'min'
  | 'feeBps'
  | 'toleranceBps'
  | 'maxExposedSats'
  | 'lockupTimeoutSeconds'
  | 'enabled'
  | 'servesOffer'
  | 'servesRfq'
  | 'rfqSellBase'
  | 'rfqBuyBase'
  | 'corridorEnabled'
  | 'carrierPriced'

/** Anything absent is ordering-neutral and rides the narrowing pass. */
export const SAVE_FIELDS: ReadonlySet<SaveField> = new Set<SaveField>([
  'max',
  'min',
  'feeBps',
  'toleranceBps',
  'maxExposedSats',
  'lockupTimeoutSeconds',
  'enabled',
  'servesOffer',
  'servesRfq',
  'rfqSellBase',
  'rfqBuyBase',
  'corridorEnabled',
  'carrierPriced',
])

/** Fields a RISE relaxes. `lockupTimeoutSeconds` too: a longer funding window is longer exposure. */
const RAISING_WIDENS: ReadonlySet<SaveField> = new Set<SaveField>([
  'max',
  'maxExposedSats',
  'toleranceBps',
  'lockupTimeoutSeconds',
])

/** Fields `true` relaxes. `carrierPriced` is absent: charging the carrier RESTRICTS. */
const TRUE_WIDENS: ReadonlySet<SaveField> = new Set<SaveField>([
  'enabled',
  'servesOffer',
  'servesRfq',
  'rfqSellBase',
  'rfqBuyBase',
  'corridorEnabled',
])

export const savePassFor = (change: {
  field: SaveField
  before: bigint | number | boolean | null
  after: bigint | number | boolean | null
}): SavePass => {
  const { field, before, after } = change
  if (typeof after === 'boolean') {
    const widens = TRUE_WIDENS.has(field) ? after : !after
    return widens ? 'widening' : 'narrowing'
  }
  // A bound appearing narrows; one disappearing widens. Both halves.
  if (before === null) return 'narrowing'
  if (after === null) return 'widening'
  const rose = BigInt(after as bigint | number) > BigInt(before as bigint | number)
  return rose === RAISING_WIDENS.has(field) ? 'widening' : 'narrowing'
}
