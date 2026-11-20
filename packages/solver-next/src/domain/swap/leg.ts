import type { Amount } from '../shared/amount.js'
import { nonEmpty, type Brand, type ValueOf } from '../shared/brand.js'
import type { Rail } from '../shared/endpoint.js'
import { IllegalTransition, InvalidValue } from '../shared/error.js'
import { defineMachine, type StateOf } from '../shared/state_machine.js'
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

// `exposed` is false everywhere: exposure depends on both legs together, so the swap decides it.
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

export const ReferenceKind = {
  Funding: 'funding',
  Claim: 'claim',
  Refund: 'refund',
} as const

export type ReferenceKind = ValueOf<typeof ReferenceKind>

/** Where a leg shows on its rail: a txid, an outpoint, a payment id. */
export type Reference = Brand<string, 'Reference'>
export const Reference = { of: (value: string): Reference => nonEmpty('reference', value) }

export type ContractVersion = Brand<string, 'ContractVersion'>
export const ContractVersion = { of: (value: string): ContractVersion => nonEmpty('contract version', value) }

/**
 * Oldest first; the last is the current one.
 * A list because transactions get replaced: a refund is fee-bumped, a claim spends several outputs.
 */
export type ReferenceHistory = Readonly<Record<ReferenceKind, readonly Reference[]>>

export type LegReferences = Partial<Record<ReferenceKind, Reference>>

export interface LegTerms {
  readonly rail: Rail
  readonly amount: Amount
  readonly contract: ContractKind
  /** What the leg was agreed under; null where the contract has only ever had one version. */
  readonly version: ContractVersion | null
}

// ln payment send in flight is `locking`: it is never a lock waiting on chain, and it never refunds.
const NEVER: Partial<Record<ContractKind, Partial<Record<Side, readonly LegState[]>>>> = {
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
    /** When the leg entered `state`. Used to tell a send still in progress from one that was never made. */
    readonly since: UnixSeconds,
    /** When the lock times out, as the rail showed it when the lock was recorded. Null where it was not shown. */
    readonly expiresAt: UnixSeconds | null,
  ) {}

  static open(side: Side, terms: LegTerms, at: UnixSeconds): Leg {
    if (terms.amount.isZero) throw new InvalidValue(`${side} leg amount must be positive`)
    return new Leg(side, terms, 'pending', NO_REFERENCES, at, null)
  }

  /** For a repository: what was stored is trusted, not re-validated. */
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

  /** The current reference of a kind, or null when none was recorded. */
  reference(kind: ReferenceKind): Reference | null {
    return this.references[kind].at(-1) ?? null
  }

  /** The state table, minus the moves this kind of contract cannot make on this side. */
  static canTransition(leg: { side: Side; contract: ContractKind }, from: LegState, to: LegState): boolean {
    return LegMachine.canTransition(from, to) && !NEVER[leg.contract]?.[leg.side]?.includes(to)
  }

  canMoveTo(state: LegState): boolean {
    return Leg.canTransition(this, this.state, state)
  }

  moveTo(state: LegState, at: UnixSeconds, references: LegReferences = {}, expiresAt: UnixSeconds | null = null): Leg {
    if (!this.canMoveTo(state)) throw new IllegalTransition(`${this.side} leg cannot go ${this.state} -> ${state}`)
    const expires = expiresAt ?? this.expiresAt
    return new Leg(this.side, this.terms, state, withReferences(this.references, references), at, expires)
  }

  /** A reference learned without the leg changing state: a payment id after the intent, a replacement transaction. */
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
