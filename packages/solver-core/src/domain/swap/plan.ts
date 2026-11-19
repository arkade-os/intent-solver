import type { ValueOf } from '../shared/brand.js'
import type { Preimage } from './hashlock.js'
import { ContractKind, type Leg, type LegState, type Side } from './leg.js'
import { FundingSeen, TxSeen, type Observation } from './observation.js'
import type { Swap } from './swap.js'
import { SwapOutcome } from './swap_state.js'

export type Decision =
  | { readonly do: 'wait' }
  // The rail already shows it: record it on the leg.
  | { readonly do: 'record'; readonly side: Side; readonly state: LegState; readonly preimage?: Preimage }
  // Record the leg as `locking` / `claiming` / `refunding` FIRST, unless it already is, then ask its rail to act.
  | { readonly do: 'lock' | 'claim' | 'refund'; readonly side: Side }
  // The lock on `to` failed for good: record that, and the payout may be tried again.
  | { readonly do: 'unlock' }
  // The lock on `to` failed for good and the swap ends: record that, then refuse.
  | { readonly do: 'abandon'; readonly reason: string }
  // The offer's one transaction landed: both legs end together.
  | { readonly do: 'fill' }
  | { readonly do: 'fail'; readonly outcome: SwapOutcome; readonly reason: string }

export const Recovery = {
  Retry: 'retry',
  Refuse: 'refuse',
  Stick: 'stick',
  Wait: 'wait',
} as const

export type Recovery = ValueOf<typeof Recovery>

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/**
 * Where the routes differ. The plan knows the order of things; a route's policies know its
 * deadlines, its margins, and how patient it is with a rail that failed.
 */
export interface Policies {
  /** Every rule for paying out: quote expiry, deadlines, margins, key rotation, inventory. Asked before the approval wait. */
  canFill(swap: Swap, seen: Observation): Verdict
  /** An overfunded lock: taken as funded, or refused. */
  readonly acceptsOverfunding: boolean
  /** The lock on `to` definitely failed: pay again, end the swap, or call a human. */
  onLockFailed(swap: Swap, seen: Observation): Exclude<Recovery, 'wait'>
  /**
   * `to` is recorded as locking and the rail shows nothing: either the call is still in flight, or we
   * crashed before making it. Only the route knows how long is too long, and whether asking again is safe.
   */
  onLockMissing(swap: Swap, seen: Observation): Recovery
  /** Whether `from` may still be collected, e.g. once its own refund has opened. */
  canCollect(swap: Swap, seen: Observation): Verdict
  onClaimFailed(swap: Swap, seen: Observation): Extract<Recovery, 'retry' | 'stick'>
  onRefundFailed(swap: Swap, seen: Observation): Extract<Recovery, 'retry' | 'stick'>
  /** A swap that ended without paying out: whether the client's lock may be handed back now. */
  canRelease(swap: Swap, seen: Observation): boolean
}

const WAIT: Decision = { do: 'wait' }
const fail = (outcome: SwapOutcome, reason: string): Decision => ({ do: 'fail', outcome, reason })

// Never offer a record the aggregate would refuse: it would throw on every tick.
const record = (swap: Swap, side: Side, state: LegState, preimage?: Preimage): Decision | null => {
  if (!swap.accepts(side, state)) return null
  return preimage === undefined ? { do: 'record', side, state } : { do: 'record', side, state, preimage }
}

/** The invoice is our own, so this Lightning leg is settled by the peer swap, never by a payment. */
const coupled = (leg: Leg, seen: Observation): boolean => seen.ownInvoice && leg.contract === ContractKind.Lightning

const toShows = (swap: Swap, seen: Observation, policies: Policies): Decision | null => {
  const { to } = swap
  const rail = seen.to
  if (swap.isOffer) {
    if (to.state === 'locking' && rail.lock === 'landed') return { do: 'fill' }
  } else {
    const secret = coupled(to, seen)
      ? (seen.peer?.preimage ?? null)
      : rail.spent.by === 'claim'
        ? rail.spent.preimage
        : null
    const claimed = coupled(to, seen) ? secret !== null : rail.spent.by === 'claim'
    if (claimed && to.state !== 'claimed') {
      if (secret === null) return fail(SwapOutcome.Stuck, 'the to leg was claimed but its preimage is unknown')
      const shown = record(swap, 'to', 'claimed', secret)
      if (shown !== null) return shown
    }
  }
  // Only a refund of ours that is known to have landed; a spend that merely looks like one is not proof.
  if (rail.refund === 'landed' && to.state !== 'refunded') {
    const shown = record(swap, 'to', 'refunded')
    if (shown !== null) return shown
  }
  if (rail.spent.by === 'unknown')
    return fail(SwapOutcome.Stuck, 'the to leg was spent by something we do not recognise')
  // Adopt a lock of ours that landed before any gate runs: after a crash it must not be paid twice.
  if ((to.state === 'pending' || to.state === 'locking') && rail.lock === 'landed') {
    const shown = record(swap, 'to', 'locked')
    if (shown !== null) return shown
  }
  if (to.state === 'locking' && rail.lock === 'failed') {
    const verdict = policies.onLockFailed(swap, seen)
    if (verdict === Recovery.Retry) return { do: 'unlock' }
    if (verdict === Recovery.Refuse) return { do: 'abandon', reason: 'the payout failed and nothing left our side' }
    return fail(SwapOutcome.Stuck, 'the lock on the to leg failed')
  }
  if (to.state === 'locking' && rail.lock === TxSeen.None) {
    const verdict = policies.onLockMissing(swap, seen)
    if (verdict === Recovery.Retry) return { do: 'lock', side: 'to' }
    if (verdict === Recovery.Refuse) return { do: 'abandon', reason: 'the payout was never sent' }
    if (verdict === Recovery.Stick) return fail(SwapOutcome.Stuck, 'the payout was recorded but never reached the rail')
  }
  if (to.state === 'refunding' && rail.refund === 'failed') {
    return policies.onRefundFailed(swap, seen) === Recovery.Retry
      ? { do: 'refund', side: 'to' }
      : fail(SwapOutcome.Stuck, 'the refund of the to leg failed')
  }
  return null
}

const fromShows = (swap: Swap, seen: Observation, policies: Policies): Decision | null => {
  const { from, to } = swap
  const rail = seen.from

  if (from.state === 'pending' || from.state === 'locking') {
    if (coupled(from, seen)) {
      if (seen.peer?.state === 'funded') return record(swap, 'from', 'locked')
    } else if (rail.funding === 'unusable' || (rail.funding === 'over' && !policies.acceptsOverfunding)) {
      return fail(
        'refused',
        rail.funding === 'over' ? 'the client overfunded the lock' : 'the client lock cannot be used',
      )
    } else if (rail.funding === 'exact' || rail.funding === 'over') {
      if (rail.matured) return record(swap, 'from', 'locked')
      if (from.state === 'pending') return record(swap, 'from', 'locking')
    }
  }
  if (rail.spent.by === 'refund' && (from.state === 'locked' || from.state === 'claiming')) {
    if (to.state === 'claimed')
      return fail(SwapOutcome.Lost, 'the client refunded the from leg after claiming the to leg')
    if (to.state === 'pending')
      return fail(SwapOutcome.Refused, 'the client refunded the from leg before it was filled')
  }
  if (from.state === 'claiming') {
    if (rail.claim === 'landed') return record(swap, 'from', 'claimed')
    // `none` is a claim that never reached the rail, e.g. a crash after the intent was recorded.
    if (rail.claim === 'failed' || rail.claim === 'none') {
      return rail.claim === 'none' || policies.onClaimFailed(swap, seen) === Recovery.Retry
        ? { do: 'claim', side: 'from' }
        : fail(SwapOutcome.Stuck, 'the claim of the from leg failed')
    }
  }
  return null
}

const whenFunded = (swap: Swap, seen: Observation, policies: Policies): Decision => {
  // Rules before approval: a swap held for an operator must still be refused once it cannot be filled.
  const verdict = policies.canFill(swap, seen)
  if (!verdict.ok) return fail(SwapOutcome.Refused, verdict.reason)
  if (seen.approval === 'pending' || coupled(swap.to, seen)) return WAIT
  return { do: 'lock', side: 'to' }
}

const whenFilled = (swap: Swap, seen: Observation, policies: Policies): Decision => {
  // No Lightning settle exists when the payer was our own client: the peer swap carries the collateral.
  if (coupled(swap.from, seen)) return record(swap, 'from', 'claimed') ?? WAIT
  const verdict = policies.canCollect(swap, seen)
  return verdict.ok ? { do: 'claim', side: 'from' } : fail(SwapOutcome.Stuck, verdict.reason)
}

/** A swap that ended without paying out still holds the client's lock: hand it back. */
const whenOver = (swap: Swap, seen: Observation, policies: Policies): Decision => {
  const { from } = swap
  const unpaid = swap.outcome === SwapOutcome.Refused || (swap.outcome === null && swap.to.state === 'refunded')
  if (!unpaid) return WAIT
  // A deposit that arrives, or confirms, after the swap ended is still the client's: adopt it so it can go back.
  if ((from.state === 'pending' || from.state === 'locking') && seen.from.funding !== FundingSeen.None) {
    return record(swap, 'from', seen.from.matured ? 'locked' : 'locking') ?? WAIT
  }
  if (from.state === 'refunding' && seen.from.refund === 'landed') return record(swap, 'from', 'refunded') ?? WAIT
  if (from.state === 'locked' && from.canMoveTo('refunding') && policies.canRelease(swap, seen)) {
    return { do: 'refund', side: 'from' }
  }
  return WAIT
}

/** One decision per call; the caller applies it and asks again until it gets `wait`. */
export const plan = (swap: Swap, seen: Observation, policies: Policies): Decision => {
  const state = swap.state
  if (state === SwapOutcome.Refused || state === 'refunded') return whenOver(swap, seen, policies)
  if (state === 'settled' || state === SwapOutcome.Lost || state === SwapOutcome.Stuck) return WAIT

  const shown = toShows(swap, seen, policies) ?? fromShows(swap, seen, policies)
  if (shown !== null) return shown

  switch (state) {
    case 'quoted':
      return swap.quote.expiredAt(seen.now) ? fail(SwapOutcome.Refused, 'quote expired before the client funded') : WAIT
    case 'funded':
      return whenFunded(swap, seen, policies)
    case 'filled':
      return whenFilled(swap, seen, policies)
    case 'filling':
    case 'awaiting_claim':
      return seen.to.refundOpen && swap.to.canMoveTo('refunding') ? { do: 'refund', side: 'to' } : WAIT
    case 'refunding':
      // Either `to` is still locked while `from` unwinds, or our refund never reached the rail.
      if (swap.to.state === 'locked') return seen.to.refundOpen ? { do: 'refund', side: 'to' } : WAIT
      return seen.to.refund === 'none' ? { do: 'refund', side: 'to' } : WAIT
    case 'settling':
      return WAIT
  }
}
