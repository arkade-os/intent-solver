import { type DomainError, IllegalTransition, InvalidValue, RuleViolated } from '../shared/error.js'
import type { RfqId, SwapId } from '../shared/ids.js'
import type { UnixSeconds } from '../shared/time.js'
import { Preimage, type Hashlock } from './hashlock.js'
import {
  ContractKind,
  FactKind,
  Leg,
  Side,
  type LegFacts,
  type LockedOutput,
  type LegState,
  type LegTerms,
  type Reference,
} from './leg.js'
import type { Quote } from './quote.js'
import { SwapOutcome, SwapState, type DerivedSwapState } from './swap_state.js'

export interface SwapProps {
  readonly id: SwapId
  readonly rfqId: RfqId | null
  readonly quote: Quote
  /** Null for offers. */
  readonly hashlock: Hashlock | null
  readonly preimage: Preimage | null
  readonly from: Leg
  readonly to: Leg
  readonly outcome: SwapOutcome | null
  readonly outcomeReason: string | null
}

export interface NewSwap {
  readonly id: SwapId
  readonly rfqId: RfqId | null
  readonly quote: Quote
  readonly hashlock: Hashlock | null
  readonly from: LegTerms
  readonly to: LegTerms
  readonly at: UnixSeconds
}

const noted = (fact: FactKind, reference?: Reference): LegFacts =>
  reference === undefined ? {} : { [fact]: reference }

export class Swap {
  private constructor(
    private readonly props: SwapProps,
    /** What the store held at load. */
    readonly version: number,
  ) {}

  static quote(args: NewSwap): Swap {
    const offer = args.from.contract === ContractKind.Offer || args.to.contract === ContractKind.Offer
    if (offer !== (args.hashlock === null)) {
      throw new InvalidValue(`swap ${args.id}: a hashlock is required unless the swap is an offer`)
    }
    if (args.quote.expiredAt(args.at)) throw new RuleViolated(`swap ${args.id}: quote expired at creation`)
    return new Swap(
      {
        id: args.id,
        rfqId: args.rfqId,
        quote: args.quote,
        hashlock: args.hashlock,
        preimage: null,
        from: Leg.open(Side.From, args.from, args.at),
        to: Leg.open(Side.To, args.to, args.at),
        outcome: null,
        outcomeReason: null,
      },
      0,
    )
  }

  static restore(props: SwapProps, version: number): Swap {
    return new Swap(props, version)
  }

  get id(): SwapId {
    return this.props.id
  }
  get rfqId(): RfqId | null {
    return this.props.rfqId
  }
  get quote(): Quote {
    return this.props.quote
  }
  get hashlock(): Hashlock | null {
    return this.props.hashlock
  }
  get preimage(): Preimage | null {
    return this.props.preimage
  }
  get from(): Leg {
    return this.props.from
  }
  get to(): Leg {
    return this.props.to
  }
  get outcome(): SwapOutcome | null {
    return this.props.outcome
  }
  get snapshot(): SwapProps {
    return this.props
  }
  get isOffer(): boolean {
    return this.props.hashlock === null
  }

  get outcomeReason(): string | null {
    if (this.props.outcome !== null) return this.props.outcomeReason
    return this.legsState === null ? `legs ${this.from.state}/${this.to.state} contradict each other` : null
  }

  // The fallback is only reached by a restored row whose legs disagree: no command produces one.
  get state(): SwapState {
    return this.props.outcome ?? this.legsState ?? SwapOutcome.Stuck
  }

  get exposed(): boolean {
    return SwapState.isExposed(this.state)
  }

  /** Whether a leg may be recorded in `state` now: its own moves, and the pair it would form. */
  allows(side: Side, state: LegState): boolean {
    return this.blocked(side, state) === null
  }

  /** The client's deposit is visible but not final yet. */
  markFundingSeen(at: UnixSeconds, funding?: Reference): Swap {
    return this.move(Side.From, 'locking', at, noted(FactKind.Funding, funding))
  }

  markFunded(at: UnixSeconds, funding?: Reference, expiresAt: UnixSeconds | null = null): Swap {
    return this.move(Side.From, 'locked', at, noted(FactKind.Funding, funding), expiresAt)
  }

  /** A lockup made of several outputs. The funding fact names the first, as the table does. */
  markFundedBy(at: UnixSeconds, outputs: readonly LockedOutput[], expiresAt: UnixSeconds | null = null): Swap {
    const funded = this.markFunded(at, outputs[0]?.outpoint, expiresAt)
    return funded.with({ from: funded.from.heldIn(outputs) })
  }

  /** Call this before sending on the rail, so a crash in between still leaves the payout on record. */
  startFill(at: UnixSeconds, funding?: Reference): Swap {
    return this.move(Side.To, 'locking', at, noted(FactKind.Funding, funding))
  }

  /** A Lightning payment can fail for good; a signed transaction can still land. */
  get canAbortFill(): boolean {
    const { to } = this
    return to.state === 'locking' && (to.contract === ContractKind.Lightning || to.fact(FactKind.Funding) === null)
  }

  abortFill(at: UnixSeconds): Swap {
    if (this.to.state !== 'locking') throw this.illegal(`to leg is ${this.to.state}, not locking`)
    if (!this.canAbortFill) throw this.againstRule('to leg has a transaction that may still land')
    return this.move(Side.To, 'pending', at)
  }

  markToLocked(at: UnixSeconds, funding?: Reference, expiresAt: UnixSeconds | null = null): Swap {
    return this.move(Side.To, 'locked', at, noted(FactKind.Funding, funding), expiresAt)
  }

  markFilled(at: UnixSeconds, preimage: Preimage, claim?: Reference): Swap {
    const claimed = this.move(Side.To, 'claimed', at, noted(FactKind.Claim, claim))
    if (this.hashlock === null) throw this.againstRule('an offer has no preimage')
    if (!Preimage.opens(preimage, this.hashlock)) throw this.againstRule('the preimage does not open the hashlock')
    return claimed.with({ preimage })
  }

  startSettle(at: UnixSeconds, claim?: Reference): Swap {
    return this.move(Side.From, 'claiming', at, noted(FactKind.Claim, claim))
  }

  markSettled(at: UnixSeconds, claim?: Reference): Swap {
    return this.move(Side.From, 'claimed', at, noted(FactKind.Claim, claim))
  }

  startRefund(at: UnixSeconds, refund?: Reference): Swap {
    return this.move(Side.To, 'refunding', at, noted(FactKind.Refund, refund))
  }

  markRefunded(at: UnixSeconds, refund?: Reference): Swap {
    return this.move(Side.To, 'refunded', at, noted(FactKind.Refund, refund))
  }

  startClientRefund(at: UnixSeconds, refund?: Reference): Swap {
    return this.move(Side.From, 'refunding', at, noted(FactKind.Refund, refund))
  }

  markClientRefunded(at: UnixSeconds, refund?: Reference): Swap {
    return this.move(Side.From, 'refunded', at, noted(FactKind.Refund, refund))
  }

  /** The one transaction of an offer takes the client's deposit and pays them, so both legs end at once. */
  markOfferFilled(at: UnixSeconds, fill?: Reference): Swap {
    if (!this.isOffer) throw this.againstRule('only an offer is filled in one transaction')
    if (this.outcome !== null || this.legsState !== 'filling') throw this.illegal(`cannot fill while ${this.state}`)
    const claim = noted(FactKind.Claim, fill)
    return this.with({ from: this.from.moveTo('claimed', at, claim), to: this.to.moveTo('claimed', at, claim) })
  }

  /** A fact learned later, or a replacement for one. The leg stays where it is. */
  recordFact(side: Side, facts: LegFacts): Swap {
    const leg = this[side]
    return leg.knows(facts) ? this : this.with({ [side]: leg.record(facts) })
  }

  /** Nothing of ours went out. Asked of the leg: a stuck swap can hold legs that name no swap state. */
  refuse(reason: string): Swap {
    const refused = this.fail(SwapOutcome.Refused, reason)
    const nothingOut = this.to.state === 'pending' || this.to.state === 'refunded'
    if (refused !== this && !nothingOut) throw this.againstRule('our payout may be out, so it cannot be refused')
    return refused
  }

  markLost(reason: string): Swap {
    return this.fail(SwapOutcome.Lost, reason)
  }

  stick(reason: string): Swap {
    return this.fail(SwapOutcome.Stuck, reason)
  }

  get canRearm(): boolean {
    return this.rearmBlocked() === null
  }

  /** A stuck swap goes back to being driven: it can be collected, or nothing is out any more. */
  rearm(): Swap {
    const blocked = this.rearmBlocked()
    if (blocked !== null) throw blocked
    return this.with({ outcome: null, outcomeReason: null })
  }

  // `refused` and `lost` are final. A stuck swap may be judged again. The same outcome twice changes nothing.
  private fail(outcome: SwapOutcome, reason: string): Swap {
    const current = this.outcome
    if (current === outcome) return this
    if (current !== null && current !== SwapOutcome.Stuck) throw this.illegal(`already ${current}`)
    const legs = this.legsState
    if (current === null && legs !== null && SwapState.isTerminal(legs)) throw this.illegal(`already ${legs}`)
    return this.with({ outcome, outcomeReason: reason })
  }

  private rearmBlocked(): DomainError | null {
    if (this.outcome !== SwapOutcome.Stuck)
      return this.illegal(`only a stuck swap is rearmed, this one is ${this.state}`)
    const resolved = this.preimage !== null || this.to.state === 'refunded'
    if (!resolved) return this.againstRule('no preimage is known and our payout is not back')
    return this.legsState === null ? this.againstRule(`legs ${this.from.state}/${this.to.state} make no sense`) : null
  }

  private move(
    side: Side,
    state: LegState,
    at: UnixSeconds,
    facts: LegFacts = {},
    expiresAt: UnixSeconds | null = null,
  ): Swap {
    const blocked = this.blocked(side, state)
    if (blocked !== null) throw blocked
    return this.with({ [side]: this[side].moveTo(state, at, facts, expiresAt) })
  }

  private blocked(side: Side, state: LegState): DomainError | null {
    const leg = this[side]
    if (!leg.canMoveTo(state)) return this.illegal(`${side} leg cannot go ${leg.state} -> ${state}`)
    const collects = side === Side.From && (state === 'claiming' || state === 'claimed')
    if (collects && !this.isOffer && this.preimage === null) {
      return this.againstRule('the from leg cannot be collected before the preimage is known')
    }
    // A failed swap still records what the rails do; only a live one must keep its legs coherent.
    const [from, to] = side === Side.From ? [state, this.to.state] : [this.from.state, state]
    const makesSense = this.outcome !== null || SwapState.derive(from, to) !== null
    return makesSense ? null : this.againstRule(`legs ${from}/${to} make no sense; fail the swap`)
  }

  private with(changes: Partial<SwapProps>): Swap {
    return new Swap({ ...this.props, ...changes }, this.version)
  }

  private illegal(why: string): DomainError {
    return new IllegalTransition(`swap ${this.id}: ${why}`)
  }

  private againstRule(why: string): DomainError {
    return new RuleViolated(`swap ${this.id}: ${why}`)
  }

  private get legsState(): DerivedSwapState | null {
    return SwapState.derive(this.from.state, this.to.state)
  }
}
