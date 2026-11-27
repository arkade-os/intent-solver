import { Amount } from '../shared/amount.js'
import { nonEmpty, type Brand, type ValueOf } from '../shared/brand.js'
import type { Rail } from '../shared/endpoint.js'
import { IllegalTransition, InvalidValue, RuleViolated } from '../shared/error.js'
import type { UnixSeconds } from '../shared/time.js'

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

export const LEG_MOVES = {
  pending: ['locking', 'locked', 'claiming', 'claimed'],
  locking: ['pending', 'locked', 'claiming', 'claimed', 'refunding'],
  locked: ['claiming', 'claimed', 'refunding', 'refunded'],
  // `-> refunded`: our claim lost the race to the other side's refund. Without it a loss could not be recorded.
  claiming: ['claimed', 'refunded'],
  refunding: ['claiming', 'claimed', 'refunded'],
  claimed: [],
  refunded: [],
} as const satisfies Record<string, readonly string[]>

export type LegState = keyof typeof LEG_MOVES

export const FactKind = {
  Funding: 'funding',
  Claim: 'claim',
  Refund: 'refund',
} as const

export type FactKind = ValueOf<typeof FactKind>

export type Reference = Brand<string, 'Reference'>
export const Reference = { of: (value: string): Reference => nonEmpty('reference', value) }

export type ContractVersion = Brand<string, 'ContractVersion'>
export const ContractVersion = { of: (value: string): ContractVersion => nonEmpty('contract version', value) }

export type FactHistory = Readonly<Record<FactKind, readonly Reference[]>>

export type LegFacts = Partial<Record<FactKind, Reference>>

/** One output that holds a leg's money. */
export interface LockedOutput {
  readonly outpoint: Reference
  readonly amount: Amount
}

export interface LegTerms {
  readonly rail: Rail
  readonly amount: Amount
  readonly contract: ContractKind
  readonly version: ContractVersion | null
}

// A payment we send is `locking` while in flight: it never waits locked, and never refunds.
const STATES_NEVER_ENTERED: Partial<Record<ContractKind, Partial<Record<Side, readonly LegState[]>>>> = {
  lightning: { to: ['locked', 'refunding', 'refunded'] },
  offer: { from: ['refunding', 'refunded'], to: ['refunding', 'refunded'] },
  payment: { to: ['locked', 'refunding', 'refunded'] },
}

const NO_FACTS: FactHistory = { funding: [], claim: [], refund: [] }

const withFacts = (history: FactHistory, added: LegFacts): FactHistory => {
  const next = { ...history }
  for (const kind of Object.keys(added) as FactKind[]) {
    const reference = added[kind]
    if (reference !== undefined && history[kind].at(-1) !== reference) next[kind] = [...history[kind], reference]
  }
  return next
}

export class Leg {
  private constructor(
    readonly side: Side,
    readonly terms: LegTerms,
    readonly state: LegState,
    readonly facts: FactHistory,
    readonly since: UnixSeconds,
    readonly expiresAt: UnixSeconds | null,
    /** Empty for a leg that is not held in outputs, such as a Lightning payment. */
    readonly outputs: readonly LockedOutput[],
  ) {}

  static open(side: Side, terms: LegTerms, at: UnixSeconds): Leg {
    if (terms.amount.isZero) throw new InvalidValue(`${side} leg amount must be positive`)
    return new Leg(side, terms, 'pending', NO_FACTS, at, null, [])
  }

  static restore(
    side: Side,
    terms: LegTerms,
    state: LegState,
    facts: FactHistory,
    since: UnixSeconds,
    expiresAt: UnixSeconds | null = null,
    outputs: readonly LockedOutput[] = [],
  ): Leg {
    return new Leg(side, terms, state, facts, since, expiresAt, outputs)
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

  fact(kind: FactKind): Reference | null {
    return this.facts[kind].at(-1) ?? null
  }

  static canTransition(leg: { side: Side; contract: ContractKind }, from: LegState, to: LegState): boolean {
    const moves: readonly LegState[] = LEG_MOVES[from]
    return moves.includes(to) && !STATES_NEVER_ENTERED[leg.contract]?.[leg.side]?.includes(to)
  }

  knows(facts: LegFacts): boolean {
    return (Object.keys(facts) as FactKind[]).every(
      (kind) => facts[kind] === undefined || facts[kind] === this.fact(kind),
    )
  }

  canMoveTo(state: LegState): boolean {
    return Leg.canTransition(this, this.state, state)
  }

  moveTo(state: LegState, at: UnixSeconds, facts: LegFacts = {}, expiresAt: UnixSeconds | null = null): Leg {
    if (!this.canMoveTo(state)) throw new IllegalTransition(`${this.side} leg cannot go ${this.state} -> ${state}`)
    const expires = expiresAt ?? this.expiresAt
    return new Leg(this.side, this.terms, state, withFacts(this.facts, facts), at, expires, this.outputs)
  }

  record(facts: LegFacts): Leg {
    const known = withFacts(this.facts, facts)
    return new Leg(this.side, this.terms, this.state, known, this.since, this.expiresAt, this.outputs)
  }

  /** The outputs the leg's money is in. Together they hold exactly its amount: no more is ever taken on. */
  heldIn(outputs: readonly LockedOutput[]): Leg {
    const total = outputs.reduce((sum, output) => sum.plus(output.amount), Amount.zero(this.amount.asset))
    if (!total.equals(this.amount)) {
      throw new RuleViolated(`${this.side} leg is for ${this.amount.units}, its outputs hold ${total.units}`)
    }
    if (new Set(outputs.map((output) => output.outpoint)).size !== outputs.length) {
      throw new RuleViolated(`${this.side} leg names the same output twice`)
    }
    return new Leg(this.side, this.terms, this.state, this.facts, this.since, this.expiresAt, outputs)
  }
}
