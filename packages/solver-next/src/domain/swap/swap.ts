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
  type LegState,
  type LegTerms,
  type Reference,
} from './leg.js'
import type { Quote } from './quote.js'
import { SwapOutcome, SwapState, type DerivedSwapState } from './swap_state.js'

const LEG_COMMANDS = {
  mark_funding_seen: { side: Side.From, state: 'locking', fact: FactKind.Funding },
  mark_funded: { side: Side.From, state: 'locked', fact: FactKind.Funding },
  start_fill: { side: Side.To, state: 'locking', fact: FactKind.Funding },
  mark_to_locked: { side: Side.To, state: 'locked', fact: FactKind.Funding },
  mark_filled: { side: Side.To, state: 'claimed', fact: FactKind.Claim },
  start_settle: { side: Side.From, state: 'claiming', fact: FactKind.Claim },
  mark_settled: { side: Side.From, state: 'claimed', fact: FactKind.Claim },
  start_refund: { side: Side.To, state: 'refunding', fact: FactKind.Refund },
  mark_refunded: { side: Side.To, state: 'refunded', fact: FactKind.Refund },
  start_client_refund: { side: Side.From, state: 'refunding', fact: FactKind.Refund },
  mark_client_refunded: { side: Side.From, state: 'refunded', fact: FactKind.Refund },
} as const satisfies Record<string, { side: Side; state: LegState; fact: FactKind }>

type LegCommand = keyof typeof LEG_COMMANDS
type LockCommand = 'mark_funded' | 'mark_to_locked'

const FAILURES = {
  refuse: SwapOutcome.Refused,
  mark_lost: SwapOutcome.Lost,
  stick: SwapOutcome.Stuck,
} as const

export type Command =
  | { readonly do: Exclude<LegCommand, LockCommand | 'mark_filled'>; readonly reference?: Reference }
  | { readonly do: LockCommand; readonly reference?: Reference; readonly expiresAt?: UnixSeconds }
  | { readonly do: 'mark_filled'; readonly preimage: Preimage; readonly reference?: Reference }
  | { readonly do: 'abort_fill' }
  | { readonly do: 'mark_offer_filled'; readonly reference?: Reference }
  | { readonly do: keyof typeof FAILURES; readonly reason: string }
  | { readonly do: 'rearm' }
  | { readonly do: 'record_fact'; readonly side: Side; readonly facts: LegFacts }

export interface Transition {
  readonly swapId: SwapId
  readonly at: UnixSeconds
  readonly from: SwapState
  readonly to: SwapState
  readonly command: Command['do']
  readonly reason: string | null
}

/** `transition` is null when the command changed nothing, so a repeated one is harmless. */
export interface Applied {
  readonly swap: Swap
  readonly transition: Transition | null
}

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

interface Refusal {
  readonly Kind: new (message: string) => DomainError
  readonly why: string
}

const illegal = (why: string): Refusal => ({ Kind: IllegalTransition, why })
const againstRule = (why: string): Refusal => ({ Kind: RuleViolated, why })

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

  /** A Lightning payment can fail for good; a signed transaction can still land. */
  get canAbortFill(): boolean {
    const { to } = this
    return to.state === 'locking' && (to.contract === ContractKind.Lightning || to.fact(FactKind.Funding) === null)
  }

  accepts(command: Command): boolean {
    return this.refusal(command) === null
  }

  apply(command: Command, at: UnixSeconds): Applied {
    const refusal = this.refusal(command)
    if (refusal !== null) throw new refusal.Kind(`swap ${this.id}: ${command.do}: ${refusal.why}`)
    const next = this.after(command, at)
    if (next === this.props) return { swap: this, transition: null }
    const swap = new Swap(next, this.version)
    const reason = 'reason' in command ? command.reason : null
    return {
      swap,
      transition: { swapId: this.id, at, from: this.state, to: swap.state, command: command.do, reason },
    }
  }

  private after(command: Command, at: UnixSeconds): SwapProps {
    const { props } = this
    switch (command.do) {
      case 'record_fact': {
        const leg = props[command.side]
        return leg.knows(command.facts) ? props : { ...props, [command.side]: leg.record(command.facts) }
      }
      case 'abort_fill':
        return { ...props, to: props.to.moveTo('pending', at) }
      case 'mark_offer_filled': {
        const claim = noted(FactKind.Claim, command.reference)
        return { ...props, from: props.from.moveTo('claimed', at, claim), to: props.to.moveTo('claimed', at, claim) }
      }
      case 'refuse':
      case 'mark_lost':
      case 'stick':
        if (props.outcome === FAILURES[command.do]) return props
        return { ...props, outcome: FAILURES[command.do], outcomeReason: command.reason }
      case 'rearm':
        return { ...props, outcome: null, outcomeReason: null }
      case 'mark_filled': {
        const to = props.to.moveTo('claimed', at, noted(FactKind.Claim, command.reference))
        return { ...props, to, preimage: command.preimage }
      }
      default: {
        const { side, state, fact } = LEG_COMMANDS[command.do]
        const expiresAt = 'expiresAt' in command ? (command.expiresAt ?? null) : null
        const leg = props[side].moveTo(state, at, noted(fact, command.reference), expiresAt)
        return { ...props, [side]: leg }
      }
    }
  }

  private refusal(command: Command): Refusal | null {
    switch (command.do) {
      case 'record_fact':
        return null
      case 'abort_fill':
        return this.abortRefusal()
      case 'mark_offer_filled':
        return this.offerFillRefusal()
      case 'refuse':
      case 'mark_lost':
      case 'stick':
        return this.failureRefusal(FAILURES[command.do])
      case 'rearm':
        return this.rearmRefusal()
      default:
        return this.moveRefusal(command.do, command.do === 'mark_filled' ? command.preimage : null)
    }
  }

  private moveRefusal(name: LegCommand, preimage: Preimage | null): Refusal | null {
    const { side, state } = LEG_COMMANDS[name]
    const leg = this[side]
    if (!leg.canMoveTo(state)) return illegal(`${side} leg cannot go ${leg.state} -> ${state}`)
    if (preimage !== null) {
      if (this.hashlock === null) return againstRule('an offer has no preimage')
      if (!Preimage.opens(preimage, this.hashlock)) return againstRule('the preimage does not open the hashlock')
    }
    const collects = side === Side.From && (state === 'claiming' || state === 'claimed')
    if (collects && !this.isOffer && this.preimage === null) {
      return againstRule('the from leg cannot be collected before the preimage is known')
    }
    return side === Side.From ? this.incoherent(state, this.to.state) : this.incoherent(this.from.state, state)
  }

  // A failed swap still records what the rails do; only a live one must keep its legs coherent.
  private incoherent(from: LegState, to: LegState): Refusal | null {
    const makesSense = this.outcome !== null || SwapState.derive(from, to) !== null
    return makesSense ? null : againstRule(`legs ${from}/${to} make no sense; fail the swap`)
  }

  private abortRefusal(): Refusal | null {
    if (this.to.state !== 'locking') return illegal(`to leg is ${this.to.state}, not locking`)
    if (!this.canAbortFill) return againstRule('to leg has a transaction that may still land')
    return this.incoherent(this.from.state, 'pending')
  }

  private offerFillRefusal(): Refusal | null {
    if (!this.isOffer) return againstRule('only an offer is filled in one transaction')
    return this.outcome === null && this.legsState === 'filling' ? null : illegal(`cannot fill while ${this.state}`)
  }

  // `refused` means nothing of ours went out. A stuck swap may be judged again; `refused` and `lost` are final.
  private failureRefusal(outcome: SwapOutcome): Refusal | null {
    const current = this.outcome
    if (current === outcome) return null
    if (current !== null && current !== SwapOutcome.Stuck) return illegal(`already ${current}`)
    const legs = this.legsState
    if (current === null && legs !== null && SwapState.isTerminal(legs)) return illegal(`already ${legs}`)
    // Asked of the leg, not of the swap state: a stuck swap can hold legs that name no state.
    const nothingOut = this.to.state === 'pending' || this.to.state === 'refunded'
    if (outcome === SwapOutcome.Refused && !nothingOut) {
      return againstRule('our payout may be out, so it cannot be refused')
    }
    return null
  }

  private rearmRefusal(): Refusal | null {
    if (this.outcome !== SwapOutcome.Stuck) return illegal(`only a stuck swap is rearmed, this one is ${this.state}`)
    const resolved = this.preimage !== null || this.to.state === 'refunded'
    if (!resolved) return againstRule('no preimage is known and our payout is not back')
    return this.legsState === null ? againstRule(`legs ${this.from.state}/${this.to.state} make no sense`) : null
  }

  private get legsState(): DerivedSwapState | null {
    return SwapState.derive(this.from.state, this.to.state)
  }
}
