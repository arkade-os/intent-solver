import type { ValueOf } from '../shared/brand.js'
import type { Preimage } from './hashlock.js'
import { ContractKind, Side, type Leg, type LegState } from './leg.js'
import { ApprovalSeen, FundingSeen, Spender, TxSeen, type Observation } from './observation.js'
import type { Swap } from './swap.js'
import { SwapOutcome } from './swap_state.js'

export const Act = {
  Wait: 'wait',
  // The rail already shows it: record it on the leg.
  Record: 'record',
  // Record the leg as `locking` / `claiming` / `refunding` FIRST, unless it already is, then ask its rail to act.
  Lock: 'lock',
  Claim: 'claim',
  Refund: 'refund',
  // The lock on `to` failed for good: record that, and the payout may be tried again.
  Unlock: 'unlock',
  // The lock on `to` failed for good and the swap ends: record that, then refuse.
  Abandon: 'abandon',
  // The offer's one transaction landed: both legs end together.
  Fill: 'fill',
  Fail: 'fail',
} as const

export type Act = ValueOf<typeof Act>

export type Decision =
  | { readonly do: typeof Act.Wait | typeof Act.Unlock | typeof Act.Fill }
  | { readonly do: typeof Act.Record; readonly side: Side; readonly state: LegState; readonly preimage?: Preimage }
  | { readonly do: typeof Act.Lock | typeof Act.Claim | typeof Act.Refund; readonly side: Side }
  | { readonly do: typeof Act.Abandon; readonly reason: string }
  | { readonly do: typeof Act.Fail; readonly outcome: SwapOutcome; readonly reason: string }

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

const WAIT: Decision = { do: Act.Wait }
const fail = (outcome: SwapOutcome, reason: string): Decision => ({ do: Act.Fail, outcome, reason })

// Never offer a record the aggregate would refuse: it would throw on every tick.
const record = (swap: Swap, side: Side, state: LegState, preimage?: Preimage): Decision | null => {
  if (!swap.accepts(side, state)) return null
  return preimage === undefined ? { do: Act.Record, side, state } : { do: Act.Record, side, state, preimage }
}

/** The invoice is our own, so this Lightning leg is settled by the peer swap, never by a payment. */
const coupled = (leg: Leg, seen: Observation): boolean => seen.ownInvoice && leg.contract === ContractKind.Lightning

const toShows = (swap: Swap, seen: Observation, policies: Policies): Decision | null => {
  const { to } = swap
  const rail = seen.to
  if (swap.isOffer) {
    if (to.state === 'locking' && rail.lock === TxSeen.Landed) return { do: Act.Fill }
  } else {
    const secret = coupled(to, seen)
      ? (seen.peer?.preimage ?? null)
      : rail.spent.by === Spender.Claim
        ? rail.spent.preimage
        : null
    const claimed = coupled(to, seen) ? secret !== null : rail.spent.by === Spender.Claim
    if (claimed && to.state !== 'claimed') {
      if (secret === null) return fail(SwapOutcome.Stuck, 'the to leg was claimed but its preimage is unknown')
      const shown = record(swap, Side.To, 'claimed', secret)
      if (shown !== null) return shown
    }
  }
  // Only a refund of ours that is known to have landed; a spend that merely looks like one is not proof.
  if (rail.refund === TxSeen.Landed && to.state !== 'refunded') {
    const shown = record(swap, Side.To, 'refunded')
    if (shown !== null) return shown
  }
  if (rail.spent.by === Spender.Unknown)
    return fail(SwapOutcome.Stuck, 'the to leg was spent by something we do not recognise')
  // Adopt a lock of ours that landed before any gate runs: after a crash it must not be paid twice.
  if ((to.state === 'pending' || to.state === 'locking') && rail.lock === TxSeen.Landed) {
    const shown = record(swap, Side.To, 'locked')
    if (shown !== null) return shown
  }
  if (to.state === 'locking' && rail.lock === TxSeen.Failed) {
    const verdict = policies.onLockFailed(swap, seen)
    if (verdict === Recovery.Retry) return { do: Act.Unlock }
    if (verdict === Recovery.Refuse) return { do: Act.Abandon, reason: 'the payout failed and nothing left our side' }
    return fail(SwapOutcome.Stuck, 'the lock on the to leg failed')
  }
  if (to.state === 'locking' && rail.lock === TxSeen.None) {
    const verdict = policies.onLockMissing(swap, seen)
    if (verdict === Recovery.Retry) return { do: Act.Lock, side: Side.To }
    if (verdict === Recovery.Refuse) return { do: Act.Abandon, reason: 'the payout was never sent' }
    if (verdict === Recovery.Stick) return fail(SwapOutcome.Stuck, 'the payout was recorded but never reached the rail')
  }
  if (to.state === 'refunding' && rail.refund === TxSeen.Failed) {
    return policies.onRefundFailed(swap, seen) === Recovery.Retry
      ? { do: Act.Refund, side: Side.To }
      : fail(SwapOutcome.Stuck, 'the refund of the to leg failed')
  }
  return null
}

const fromShows = (swap: Swap, seen: Observation, policies: Policies): Decision | null => {
  const { from, to } = swap
  const rail = seen.from

  if (from.state === 'pending' || from.state === 'locking') {
    if (coupled(from, seen)) {
      if (seen.peer?.state === 'funded') return record(swap, Side.From, 'locked')
    } else if (
      rail.funding === FundingSeen.Unusable ||
      (rail.funding === FundingSeen.Over && !policies.acceptsOverfunding)
    ) {
      return fail(
        SwapOutcome.Refused,
        rail.funding === FundingSeen.Over ? 'the client overfunded the lock' : 'the client lock cannot be used',
      )
    } else if (rail.funding === FundingSeen.Exact || rail.funding === FundingSeen.Over) {
      if (rail.matured) return record(swap, Side.From, 'locked')
      if (from.state === 'pending') return record(swap, Side.From, 'locking')
    }
  }
  if (rail.spent.by === Spender.Refund && (from.state === 'locked' || from.state === 'claiming')) {
    if (to.state === 'claimed')
      return fail(SwapOutcome.Lost, 'the client refunded the from leg after claiming the to leg')
    if (to.state === 'pending')
      return fail(SwapOutcome.Refused, 'the client refunded the from leg before it was filled')
  }
  if (from.state === 'claiming') {
    if (rail.claim === TxSeen.Landed) return record(swap, Side.From, 'claimed')
    // `none` is a claim that never reached the rail, e.g. a crash after the intent was recorded.
    if (rail.claim === TxSeen.Failed || rail.claim === TxSeen.None) {
      return rail.claim === TxSeen.None || policies.onClaimFailed(swap, seen) === Recovery.Retry
        ? { do: Act.Claim, side: Side.From }
        : fail(SwapOutcome.Stuck, 'the claim of the from leg failed')
    }
  }
  return null
}

const whenFunded = (swap: Swap, seen: Observation, policies: Policies): Decision => {
  // Rules before approval: a swap held for an operator must still be refused once it cannot be filled.
  const verdict = policies.canFill(swap, seen)
  if (!verdict.ok) return fail(SwapOutcome.Refused, verdict.reason)
  if (seen.approval === ApprovalSeen.Pending || coupled(swap.to, seen)) return WAIT
  return { do: Act.Lock, side: Side.To }
}

const whenFilled = (swap: Swap, seen: Observation, policies: Policies): Decision => {
  // No Lightning settle exists when the payer was our own client: the peer swap carries the collateral.
  if (coupled(swap.from, seen)) return record(swap, Side.From, 'claimed') ?? WAIT
  const verdict = policies.canCollect(swap, seen)
  return verdict.ok ? { do: Act.Claim, side: Side.From } : fail(SwapOutcome.Stuck, verdict.reason)
}

/** A swap that ended without paying out still holds the client's lock: hand it back. */
const whenOver = (swap: Swap, seen: Observation, policies: Policies): Decision => {
  const { from } = swap
  const unpaid = swap.outcome === SwapOutcome.Refused || (swap.outcome === null && swap.to.state === 'refunded')
  if (!unpaid) return WAIT
  // A deposit that arrives, or confirms, after the swap ended is still the client's: adopt it so it can go back.
  if ((from.state === 'pending' || from.state === 'locking') && seen.from.funding !== FundingSeen.None) {
    return record(swap, Side.From, seen.from.matured ? 'locked' : 'locking') ?? WAIT
  }
  if (from.state === 'refunding' && seen.from.refund === TxSeen.Landed)
    return record(swap, Side.From, 'refunded') ?? WAIT
  if (from.state === 'locked' && from.canMoveTo('refunding') && policies.canRelease(swap, seen)) {
    return { do: Act.Refund, side: Side.From }
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
      return seen.to.refundOpen && swap.to.canMoveTo('refunding') ? { do: Act.Refund, side: Side.To } : WAIT
    case 'refunding':
      // Either `to` is still locked while `from` unwinds, or our refund never reached the rail.
      if (swap.to.state === 'locked') return seen.to.refundOpen ? { do: Act.Refund, side: Side.To } : WAIT
      return seen.to.refund === TxSeen.None ? { do: Act.Refund, side: Side.To } : WAIT
    case 'settling':
      return WAIT
  }
}
