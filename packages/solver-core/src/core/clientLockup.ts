/**
 * Whether the client's Arkade lockup can be taken as the funding of a send swap. One set of rules for
 * every corridor that starts with such a lockup; what differs between them is passed in.
 */

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
  /** Which total the refund sweep is told about when an overfunded lockup is refused. */
  recordOnOverfund: 'claimable' | 'held'
  recordOnTooManyOutputs: boolean
}

export type ClientLockupVerdict =
  | { do: 'adopt_lockup' }
  | { do: 'wait' }
  /** `lockupValue`, when given, is written first so the refund sweep returns all of it. */
  | { do: 'fail'; reason: string; lockupValue?: number }

const fail = (reason: string, lockupValue?: number): ClientLockupVerdict =>
  lockupValue === undefined ? { do: 'fail', reason } : { do: 'fail', reason, lockupValue }

export const judgeClientLockup = (lockup: ClientLockup, rules: ClientLockupRules): ClientLockupVerdict => {
  const { held, spendable } = lockup
  const { amountSats } = rules
  const claimable = spendable.reduce((sum, o) => sum + o.value, 0)

  // A claim takes whole vtxos, so paying an overfunded lockup would keep the excess from the client.
  if (claimable > amountSats) {
    const recorded = rules.recordOnOverfund === 'held' ? held : claimable
    return fail(`overfunded lockup: ${claimable} > ${amountSats} sats`, recorded)
  }
  if (claimable === amountSats && spendable.length > rules.maxOutputs) {
    const reason = `lockup funded in ${spendable.length} outputs, over ${rules.maxOutputs}`
    return rules.recordOnTooManyOutputs ? fail(reason, claimable) : fail(reason)
  }
  const fundedWhereAClaimCannotSpend = claimable < amountSats && held >= amountSats
  if (fundedWhereAClaimCannotSpend) {
    return fail(`lockup funded on an asset vtxo a claim cannot spend: ${held} held, ${claimable} spendable`, held)
  }
  if (!rules.tooLate) {
    if (claimable !== amountSats) return { do: 'wait' }
    return rules.refusal === null ? { do: 'adopt_lockup' } : fail(rules.refusal)
  }
  const reason = rules.lateReason(claimable)
  return held > 0 ? fail(reason, held) : fail(reason)
}
