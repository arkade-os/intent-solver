/**
 * Whether the client's Arkade lockup can be taken as the funding of a send swap. One set of rules for
 * every corridor that starts with such a lockup; what differs between them is passed in.
 */

/**
 * How each refusal text begins. Other code tells refusals apart by these words: the wire layer reports the
 * late ones to the client as `expired`, and the console explains each. Rows already in the database carry
 * them, so they never change.
 */
export const LOCKUP_REFUSAL = {
  overfunded: 'overfunded lockup',
  timeout: 'lockup timeout',
  invoiceExpired: 'invoice expired before funding completed',
  arrivedLate: 'lockup arrived after the funding deadline',
} as const

/** Whether `reason` is one of the refusals in `starts`. */
export const isLockupRefusal = (reason: string | null, starts: readonly string[]): boolean =>
  reason !== null && starts.some((start) => reason.startsWith(start))

export interface ClientLockup {
  /** Every output at the lockup script. */
  held: number
  /** The outputs a claim can spend: those not on an asset vtxo. */
  spendable: readonly { value: number }[]
}

export interface ClientLockupRules {
  amountSats: number
  /** One claim spends at most this many outputs; the rest would stay for the client to refund. */
  maxOutputs: number
  tooLate: boolean
  lateReason(claimable: number): string
  /** A reason to refuse a lockup that is otherwise good, or null. */
  refusal: string | null
}

export type ClientLockupVerdict =
  | { do: 'adopt_lockup' }
  | { do: 'wait' }
  /** `lockupValue` is everything the lockup holds. It is written first, for the refund sweep and the books. */
  | { do: 'fail'; reason: string; lockupValue?: number }

const refuse = (reason: string, held: number): ClientLockupVerdict =>
  held > 0 ? { do: 'fail', reason, lockupValue: held } : { do: 'fail', reason }

export const judgeClientLockup = (lockup: ClientLockup, rules: ClientLockupRules): ClientLockupVerdict => {
  const { held, spendable } = lockup
  const { amountSats } = rules
  const claimable = spendable.reduce((sum, o) => sum + o.value, 0)

  // A claim takes whole vtxos, so paying an overfunded lockup would keep the excess from the client.
  if (claimable > amountSats) return refuse(`${LOCKUP_REFUSAL.overfunded}: ${claimable} > ${amountSats} sats`, held)
  if (claimable === amountSats && spendable.length > rules.maxOutputs) {
    return refuse(`lockup funded in ${spendable.length} outputs, over ${rules.maxOutputs}`, held)
  }
  const fundedWhereAClaimCannotSpend = claimable < amountSats && held >= amountSats
  if (fundedWhereAClaimCannotSpend) {
    return refuse(`lockup funded on an asset vtxo a claim cannot spend: ${held} held, ${claimable} spendable`, held)
  }
  if (!rules.tooLate) {
    if (claimable !== amountSats) return { do: 'wait' }
    return rules.refusal === null ? { do: 'adopt_lockup' } : refuse(rules.refusal, held)
  }
  return refuse(rules.lateReason(claimable), held)
}
