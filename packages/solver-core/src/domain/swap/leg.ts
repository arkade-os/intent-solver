import { defineMachine, type StateOf } from '../../core/stateMachine.js'
import type { Amount } from '../shared/amount.js'
import type { ValueOf } from '../shared/brand.js'
import type { Rail } from '../shared/endpoint.js'

export const Side = {
  From: 'from',
  To: 'to',
} as const

export type Side = ValueOf<typeof Side>

export const ContractKind = {
  Vhtlc: 'vhtlc',
  Lightning: 'lightning',
  OnchainHtlc: 'onchain-htlc',
  EvmHtlc: 'evm-htlc',
  Offer: 'offer',
  /** A plain output paid inside the transaction that takes an offer: no contract of its own. */
  Payment: 'payment',
} as const

export type ContractKind = ValueOf<typeof ContractKind>

// Every flag false: exposure is a property of the pair of legs, not of one leg.
export const LegMachine = defineMachine({
  pending: { live: true, exposed: false, to: ['locking', 'locked', 'claiming', 'claimed'] },
  locking: { live: true, exposed: false, to: ['pending', 'locked', 'claiming', 'claimed', 'refunding'] },
  locked: { live: true, exposed: false, to: ['claiming', 'claimed', 'refunding', 'refunded'] },
  // `-> refunded`: our claim lost the race to the other side's refund. Without it a loss could not be recorded.
  claiming: { live: true, exposed: false, to: ['claimed', 'refunded'] },
  refunding: { live: true, exposed: false, to: ['claiming', 'claimed', 'refunded'] },
  claimed: { live: false, exposed: false, to: [] },
  refunded: { live: false, exposed: false, to: [] },
})

export type LegState = StateOf<typeof LegMachine>

export type FactKind = 'funding' | 'claim' | 'refund'

/**
 * References into the rail (txid, outpoint, payment id), oldest first; the last is the current one.
 * A list because transactions get replaced: a refund is fee-bumped, a claim spends several outputs.
 */
export type LegFacts = Readonly<Record<FactKind, readonly string[]>>

export type LegReferences = Partial<Record<FactKind, string>>

export interface LegTerms {
  readonly rail: Rail
  readonly amount: Amount
  readonly contract: ContractKind
  /** The version of the contract the leg was agreed under, where the rail has several. */
  readonly version?: string
}

// ln payment send in flight is `locking`: it is never a lock waiting on chain, and it never refunds.
const NEVER: Partial<Record<ContractKind, Partial<Record<Side, readonly LegState[]>>>> = {
  lightning: { to: ['locked', 'refunding', 'refunded'] },
  offer: { from: ['refunding', 'refunded'], to: ['refunding', 'refunded'] },
  payment: { to: ['locked', 'refunding', 'refunded'] },
}

export const legCanTransition = (leg: { side: Side; contract: ContractKind }, from: LegState, to: LegState): boolean =>
  LegMachine.canTransition(from, to) && !NEVER[leg.contract]?.[leg.side]?.includes(to)

const NO_FACTS: LegFacts = { funding: [], claim: [], refund: [] }

const withReferences = (facts: LegFacts, references: LegReferences): LegFacts => {
  const next = { ...facts }
  for (const kind of Object.keys(references) as FactKind[]) {
    const reference = references[kind]
    if (reference !== undefined && facts[kind].at(-1) !== reference) next[kind] = [...facts[kind], reference]
  }
  return next
}

export class Leg {
  private constructor(
    readonly side: Side,
    readonly terms: LegTerms,
    readonly state: LegState,
    readonly facts: LegFacts,
  ) {}

  static open(side: Side, terms: LegTerms): Leg {
    if (terms.amount.isZero) throw new Error(`${side} leg amount must be positive`)
    return new Leg(side, terms, 'pending', NO_FACTS)
  }

  /** For a repository: what was stored is trusted, not re-validated. */
  static restore(side: Side, terms: LegTerms, state: LegState, facts: LegFacts): Leg {
    return new Leg(side, terms, state, facts)
  }

  get rail(): Rail {
    return this.terms.rail
  }
  get amount(): Amount {
    return this.terms.amount
  }
  get contract(): ContractKind {
    return this.terms.contract
  }

  /** The current reference of a kind, or null when none was recorded. */
  reference(kind: FactKind): string | null {
    return this.facts[kind].at(-1) ?? null
  }

  canMoveTo(state: LegState): boolean {
    return legCanTransition(this, this.state, state)
  }

  moveTo(state: LegState, references: LegReferences = {}): Leg {
    if (!this.canMoveTo(state)) throw new Error(`${this.side} leg cannot go ${this.state} -> ${state}`)
    return new Leg(this.side, this.terms, state, withReferences(this.facts, references))
  }

  /** A reference learned without the leg changing state: a payment id after the intent, a replacement transaction. */
  record(references: LegReferences): Leg {
    return new Leg(this.side, this.terms, this.state, withReferences(this.facts, references))
  }
}
