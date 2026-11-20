import type { RfqId, SwapId } from '../shared/ids.js'
import type { UnixSeconds } from '../shared/time.js'
import { Preimage, type Hashlock } from './hashlock.js'
import { ContractKind, ReferenceKind, Leg, Side, type LegReferences, type LegState, type Reference } from './leg.js'
import type { AmountMode, Quote } from './quote.js'
import { SWAP_TOPIC, type SwapEvent, type SwapQuoted } from './swap_event.js'
import { SwapOutcome, SwapState } from './swap_state.js'
import { CorruptHistory, type DomainError, IllegalTransition, InvalidValue, RuleViolated } from '../shared/error.js'

export interface SwapProps {
  readonly id: SwapId
  readonly rfqId: RfqId | null
  readonly amountMode: AmountMode
  readonly quote: Quote
  /** Null for offers. */
  readonly hashlock: Hashlock | null
  /** Known once the `to` leg is claimed; it is what collects the `from` leg. */
  readonly preimage: Preimage | null
  readonly from: Leg
  readonly to: Leg
  readonly outcome: SwapOutcome | null
  readonly outcomeReason: string | null
}

export type NewSwap = Omit<SwapQuoted, 'topic' | 'type'>

const created = (e: SwapQuoted): SwapProps => ({
  id: e.id,
  rfqId: e.rfqId,
  amountMode: e.amountMode,
  quote: e.quote,
  hashlock: e.hashlock,
  preimage: null,
  from: Leg.open(Side.From, e.from, e.at),
  to: Leg.open(Side.To, e.to, e.at),
  outcome: null,
  outcomeReason: null,
})

const applied = (props: SwapProps, e: SwapEvent): SwapProps => {
  switch (e.type) {
    case 'SwapQuoted':
      throw new CorruptHistory(`swap ${props.id}: quoted twice`)
    case 'LegAdvanced':
      return {
        ...props,
        [e.side]: props[e.side].moveTo(e.state, e.at, e.references),
        preimage: e.preimage ?? props.preimage,
      }
    case 'LegReferenced':
      return { ...props, [e.side]: props[e.side].record(e.references) }
    case 'OfferFilled': {
      const claim = e.fill === null ? {} : { claim: e.fill }
      return { ...props, from: props.from.moveTo('claimed', e.at, claim), to: props.to.moveTo('claimed', e.at, claim) }
    }
    case 'SwapFailed':
      return { ...props, outcome: e.outcome, outcomeReason: e.reason }
    case 'SwapResumed':
      return { ...props, outcome: null, outcomeReason: null }
  }
}

const referenced = (kind: ReferenceKind, reference?: Reference): LegReferences =>
  reference === undefined ? {} : { [kind]: reference }

export class Swap {
  private readonly raised: SwapEvent[] = []

  private constructor(
    private props: SwapProps,
    /** What the store held at load; events raised since do not count. */
    private readonly _version: number,
  ) {}

  static quote(args: NewSwap): Swap {
    const offer = args.from.contract === ContractKind.Offer || args.to.contract === ContractKind.Offer
    if (offer !== (args.hashlock === null)) {
      throw new InvalidValue(`swap ${args.id}: a hashlock is required unless the swap is an offer`)
    }
    if (args.quote.expiredAt(args.at)) throw new RuleViolated(`swap ${args.id}: quote expired at creation`)
    const event: SwapQuoted = { topic: SWAP_TOPIC, type: 'SwapQuoted', ...args }
    const swap = new Swap(created(event), 0)
    swap.raised.push(event)
    return swap
  }

  static fromEvents(events: readonly SwapEvent[]): Swap {
    const [first, ...rest] = events
    if (first?.type !== 'SwapQuoted') throw new CorruptHistory('swap: history must start with SwapQuoted')
    return new Swap(rest.reduce(applied, created(first)), events.length)
  }

  /** For a store that keeps rows, not history. */
  static fromSnapshot(props: SwapProps, version: number): Swap {
    return new Swap(props, version)
  }

  get id(): SwapId {
    return this.props.id
  }
  get version(): number {
    return this._version
  }
  get snapshot(): SwapProps {
    return this.props
  }
  get from(): Leg {
    return this.props.from
  }
  get to(): Leg {
    return this.props.to
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
  get outcome(): SwapOutcome | null {
    return this.props.outcome
  }
  /** Raised since the load and not stored yet: what a repository appends. */
  get changes(): readonly SwapEvent[] {
    return this.raised
  }
  /** One transaction takes the client's deposit and pays them: no hashlock, no preimage. */
  get isOffer(): boolean {
    return this.props.hashlock === null
  }

  get state(): SwapState {
    // The fallback only fires for a stored row whose legs disagree; a command never produces one.
    return this.props.outcome ?? this.legsState ?? SwapOutcome.Stuck
  }

  /** As the exposure cap counts it: a failed swap is not exposed, whatever its legs say. */
  get exposed(): boolean {
    return SwapState.isExposed(this.state)
  }

  /** What the legs alone say, outcome aside: our payout is out and neither collected nor back. */
  get capitalOut(): boolean {
    const legs = this.legsState
    return legs !== null && SwapState.isExposed(legs)
  }

  /** The float still has to cover the payout. An in-flight Lightning payment with a known id has left it already. */
  get owesPayout(): boolean {
    if (SwapState.isTerminal(this.state)) return false
    const { to } = this
    if (to.state === 'pending') return true
    return (
      to.state === 'locking' &&
      !(to.contract === ContractKind.Lightning && to.reference(ReferenceKind.Funding) !== null)
    )
  }

  /** Whether a leg may be recorded in `state` right now: its own edges, and the pair it would form. */
  accepts(side: Side, state: LegState): boolean {
    return this[side].canMoveTo(state) && this.coherentWith(side, state)
  }

  /** Call this before sending on the rail, so a crash in between still leaves the payout recorded. */
  locking(side: Side, at: UnixSeconds, funding?: Reference): SwapEvent {
    return this.advance(side, 'locking', at, referenced(ReferenceKind.Funding, funding))
  }

  lock(side: Side, at: UnixSeconds, funding?: Reference): SwapEvent {
    return this.advance(side, 'locked', at, referenced(ReferenceKind.Funding, funding))
  }

  /**
   * The lock provably did not and will not take effect. A Lightning payment can fail for good;
   * a signed transaction can still land, so once one is referenced this is refused.
   */
  lockFailed(side: Side, at: UnixSeconds): SwapEvent {
    const leg = this[side]
    if (leg.state !== 'locking') throw this.error(IllegalTransition, `${side} leg is ${leg.state}, not locking`)
    if (!this.canCancelLock(side)) throw this.error(RuleViolated, `${side} leg has a transaction that may still land`)
    return this.advance(side, 'pending', at, {})
  }

  canCancelLock(side: Side): boolean {
    const leg = this[side]
    return leg.contract === ContractKind.Lightning || leg.reference(ReferenceKind.Funding) === null
  }

  claiming(side: Side, at: UnixSeconds, claim?: Reference): SwapEvent {
    return this.advance(side, 'claiming', at, referenced(ReferenceKind.Claim, claim))
  }

  claim(
    side: Side,
    at: UnixSeconds,
    proof: { readonly claim?: Reference; readonly preimage?: Preimage } = {},
  ): SwapEvent {
    return this.advance(side, 'claimed', at, referenced(ReferenceKind.Claim, proof.claim), proof.preimage)
  }

  refunding(side: Side, at: UnixSeconds, refund?: Reference): SwapEvent {
    return this.advance(side, 'refunding', at, referenced(ReferenceKind.Refund, refund))
  }

  refund(side: Side, at: UnixSeconds, refund?: Reference): SwapEvent {
    return this.advance(side, 'refunded', at, referenced(ReferenceKind.Refund, refund))
  }

  /** A reference learned later, or a replacement for one: the leg stays where it is. */
  reference(side: Side, references: LegReferences, at: UnixSeconds): SwapEvent {
    return this.raise({ topic: SWAP_TOPIC, type: 'LegReferenced', id: this.id, at, side, references })
  }

  /** The one transaction of an offer: it takes the client's deposit and pays them, so both legs end at once. */
  fillOffer(at: UnixSeconds, fill?: Reference): SwapEvent {
    if (!this.isOffer) throw this.error(RuleViolated, 'only an offer is filled in one transaction')
    if (this.props.outcome !== null || this.legsState !== 'filling')
      throw this.error(IllegalTransition, `cannot fill while ${this.state}`)
    return this.raise({ topic: SWAP_TOPIC, type: 'OfferFilled', id: this.id, at, fill: fill ?? null })
  }

  /**
   * Null when the swap already has this outcome, so a retried handler is harmless.
   * `refused` means nothing of ours went out; a swap with capital out can only be `stuck` or `lost`.
   * A stuck swap may be re-judged; `refused` and `lost` are final.
   */
  fail(outcome: SwapOutcome, reason: string, at: UnixSeconds): SwapEvent | null {
    const current = this.props.outcome
    if (current === outcome) return null
    if (current !== null && current !== SwapOutcome.Stuck) throw this.error(IllegalTransition, `already ${current}`)
    if (current === null && SwapState.isTerminal(this.state))
      throw this.error(IllegalTransition, `already ${this.state}`)
    if (outcome === SwapOutcome.Refused && this.capitalOut)
      throw this.error(RuleViolated, 'our payout is out, so it cannot be refused')
    return this.raise({ topic: SWAP_TOPIC, type: 'SwapFailed', id: this.id, at, outcome, reason })
  }

  /** Operator recovery: a stuck swap goes back to being driven, but only to collect with a preimage in hand. */
  resume(at: UnixSeconds): SwapEvent {
    if (this.props.outcome !== SwapOutcome.Stuck)
      throw this.error(IllegalTransition, `only a stuck swap resumes, this one is ${this.state}`)
    if (this.preimage === null) throw this.error(RuleViolated, 'nothing to resume for: the preimage is not known')
    if (this.legsState === null)
      throw this.error(RuleViolated, `legs ${this.from.state}/${this.to.state} make no sense`)
    return this.raise({ topic: SWAP_TOPIC, type: 'SwapResumed', id: this.id, at })
  }

  private get legsState(): ReturnType<typeof SwapState.derive> {
    return SwapState.derive(this.from.state, this.to.state)
  }

  // A failed swap still records what the rails do; only a live one must keep its legs coherent.
  private coherentWith(side: Side, state: LegState): boolean {
    return this.props.outcome !== null || SwapState.derive(...this.pairWith(side, state)) !== null
  }

  private pairWith(side: Side, state: LegState): [from: LegState, to: LegState] {
    return side === Side.From ? [state, this.to.state] : [this.from.state, state]
  }

  private advance(
    side: Side,
    state: LegState,
    at: UnixSeconds,
    references: LegReferences,
    preimage?: Preimage,
  ): SwapEvent {
    if (!this[side].canMoveTo(state))
      throw this.error(IllegalTransition, `${side} leg cannot go ${this[side].state} -> ${state}`)
    const revealed = this.secretFor(side, state, preimage)
    if (!this.coherentWith(side, state)) {
      throw this.error(RuleViolated, `legs ${this.pairWith(side, state).join('/')} make no sense; fail the swap`)
    }
    return this.raise({
      topic: SWAP_TOPIC,
      type: 'LegAdvanced',
      id: this.id,
      at,
      side,
      state,
      references,
      preimage: revealed,
    })
  }

  private secretFor(side: Side, state: LegState, preimage?: Preimage): Preimage | null {
    const { hashlock } = this
    if (hashlock === null) {
      if (preimage !== undefined) throw this.error(RuleViolated, 'an offer has no preimage')
      return null
    }
    if (side === Side.To && state === 'claimed') {
      if (preimage === undefined || !Preimage.opens(preimage, hashlock)) {
        throw this.error(RuleViolated, 'claiming the to leg needs the preimage of the hashlock')
      }
      return preimage
    }
    if (preimage !== undefined) throw this.error(RuleViolated, 'only the claim of the to leg reveals the preimage')
    if (side === Side.From && (state === 'claiming' || state === 'claimed') && this.preimage === null) {
      throw this.error(RuleViolated, 'the from leg cannot be collected before the preimage is known')
    }
    return null
  }

  private error(Kind: new (message: string) => DomainError, message: string): DomainError {
    return new Kind(`swap ${this.id}: ${message}`)
  }

  private raise(event: SwapEvent): SwapEvent {
    this.props = applied(this.props, event)
    this.raised.push(event)
    return event
  }
}
