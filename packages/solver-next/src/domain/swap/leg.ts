import type { Amount } from '../shared/amount.js'
import { nonEmpty, type Brand, type ValueOf } from '../shared/brand.js'
import type { Rail } from '../shared/endpoint.js'
import { IllegalTransition, InvalidValue } from '../shared/error.js'
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

export const ReferenceKind = {
  Funding: 'funding',
  Claim: 'claim',
  Refund: 'refund',
} as const

export type ReferenceKind = ValueOf<typeof ReferenceKind>

export type Reference = Brand<string, 'Reference'>
export const Reference = { of: (value: string): Reference => nonEmpty('reference', value) }

export type ContractVersion = Brand<string, 'ContractVersion'>
export const ContractVersion = { of: (value: string): ContractVersion => nonEmpty('contract version', value) }

export type ReferenceHistory = Readonly<Record<ReferenceKind, readonly Reference[]>>

export type LegReferences = Partial<Record<ReferenceKind, Reference>>

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

const NO_REFERENCES: ReferenceHistory = { funding: [], claim: [], refund: [] }

const withReferences = (history: ReferenceHistory, added: LegReferences): ReferenceHistory => {
  const next = { ...history }
  for (const kind of Object.keys(added) as ReferenceKind[]) {
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
    readonly references: ReferenceHistory,
    readonly since: UnixSeconds,
    readonly expiresAt: UnixSeconds | null,
  ) {}

  static open(side: Side, terms: LegTerms, at: UnixSeconds): Leg {
    if (terms.amount.isZero) throw new InvalidValue(`${side} leg amount must be positive`)
    return new Leg(side, terms, 'pending', NO_REFERENCES, at, null)
  }

  static restore(
    side: Side,
    terms: LegTerms,
    state: LegState,
    references: ReferenceHistory,
    since: UnixSeconds,
    expiresAt: UnixSeconds | null = null,
  ): Leg {
    return new Leg(side, terms, state, references, since, expiresAt)
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

  reference(kind: ReferenceKind): Reference | null {
    return this.references[kind].at(-1) ?? null
  }

  static canTransition(leg: { side: Side; contract: ContractKind }, from: LegState, to: LegState): boolean {
    const moves: readonly LegState[] = LEG_MOVES[from]
    return moves.includes(to) && !STATES_NEVER_ENTERED[leg.contract]?.[leg.side]?.includes(to)
  }

  canMoveTo(state: LegState): boolean {
    return Leg.canTransition(this, this.state, state)
  }

  moveTo(state: LegState, at: UnixSeconds, references: LegReferences = {}, expiresAt: UnixSeconds | null = null): Leg {
    if (!this.canMoveTo(state)) throw new IllegalTransition(`${this.side} leg cannot go ${this.state} -> ${state}`)
    const expires = expiresAt ?? this.expiresAt
    return new Leg(this.side, this.terms, state, withReferences(this.references, references), at, expires)
  }

  record(references: LegReferences): Leg {
    return new Leg(
      this.side,
      this.terms,
      this.state,
      withReferences(this.references, references),
      this.since,
      this.expiresAt,
    )
  }
}
