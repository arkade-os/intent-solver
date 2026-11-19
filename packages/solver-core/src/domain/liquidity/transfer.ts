import type { Amount } from '../shared/amount.js'
import { nonEmpty, type Brand, type ValueOf } from '../shared/brand.js'
import type { Endpoint } from '../shared/endpoint.js'
import type { UnixSeconds } from '../shared/time.js'
import { DomainError, ErrorCode } from '../shared/error.js'

export type TransferId = Brand<string, 'TransferId'>
export const TransferId = { of: (value: string): TransferId => nonEmpty('transfer id', value) }

export const TransferOrigin = {
  Manual: 'manual',
  Automatic: 'automatic',
} as const

export type TransferOrigin = ValueOf<typeof TransferOrigin>

export const TransferState = {
  Quoted: 'quoted',
  Submitting: 'submitting',
  Pending: 'pending',
  NeedsReconciliation: 'needs_reconciliation',
  Completed: 'completed',
  Refunded: 'refunded',
  Cancelled: 'cancelled',
} as const

export type TransferState = ValueOf<typeof TransferState>

// `submitting` can only resolve to pending or to "we do not know": a debit may have left.
const EDGES: Record<TransferState, readonly TransferState[]> = {
  quoted: ['submitting', 'cancelled'],
  submitting: ['pending', 'needs_reconciliation'],
  // Reconciliation can find the transfer already finished, either way.
  needs_reconciliation: ['pending', 'completed', 'refunded'],
  pending: ['completed', 'refunded'],
  completed: [],
  refunded: [],
  cancelled: [],
}

export interface TransferProps {
  readonly id: TransferId
  readonly origin: TransferOrigin
  readonly from: Endpoint
  readonly to: Endpoint
  /** What the destination is credited. */
  readonly net: Amount
  /** What the source is debited; `fee` is the difference. */
  readonly debit: Amount
  /** The caller's idempotency key: asking again with it returns this transfer instead of a second one. */
  readonly requestKey: string | null
  readonly state: TransferState
  /** Set on submit and never changed: from then on the debit counts against the day, whatever happens next. */
  readonly chargedAt: UnixSeconds | null
  readonly fundingTxid: string | null
  readonly credited: Amount | null
}

/** A rebalance: value moved between two of our own inventories. */
export class Transfer {
  private constructor(private props: TransferProps) {}

  static quote(terms: Omit<TransferProps, 'state' | 'chargedAt' | 'fundingTxid' | 'credited'>): Transfer {
    if (terms.from.equals(terms.to))
      throw new DomainError(ErrorCode.Invalid, `transfer ${terms.id}: source and destination are the same`)
    if (terms.net.isZero || !terms.debit.gte(terms.net)) {
      throw new DomainError(ErrorCode.Invalid, `transfer ${terms.id}: debit must cover a positive net credit`)
    }
    return new Transfer({ ...terms, state: TransferState.Quoted, chargedAt: null, fundingTxid: null, credited: null })
  }

  static restore(props: TransferProps): Transfer {
    return new Transfer(props)
  }

  get id(): TransferId {
    return this.props.id
  }
  get state(): TransferState {
    return this.props.state
  }
  get snapshot(): TransferProps {
    return this.props
  }
  get fee(): Amount {
    return this.props.debit.minus(this.props.net)
  }
  get charged(): boolean {
    return this.props.chargedAt !== null
  }

  submit(at: UnixSeconds): void {
    this.move(TransferState.Submitting)
    this.props = { ...this.props, chargedAt: at }
  }

  /** The source took it: `fundingTxid` is the proof, and reconciliation arrives here with one too. */
  accepted(fundingTxid: string): void {
    if (fundingTxid === '') throw this.error(ErrorCode.Invalid, 'an accepted transfer needs its funding transaction')
    this.move(TransferState.Pending)
    this.props = { ...this.props, fundingTxid }
  }

  /** The submission's outcome is unknown, e.g. the process restarted mid-submit. */
  lostTrack(): void {
    this.move(TransferState.NeedsReconciliation)
  }

  cancel(): void {
    this.move(TransferState.Cancelled)
  }

  complete(credited: Amount): void {
    if (!credited.gte(this.props.net))
      throw this.error(ErrorCode.RuleViolated, `credited ${credited.units} is short of ${this.props.net.units}`)
    this.move(TransferState.Completed)
    this.props = { ...this.props, credited }
  }

  refund(): void {
    this.move(TransferState.Refunded)
  }

  private move(to: TransferState): void {
    if (!EDGES[this.state].includes(to))
      throw this.error(ErrorCode.IllegalTransition, `cannot go ${this.state} -> ${to}`)
    this.props = { ...this.props, state: to }
  }

  private error(code: ErrorCode, message: string): DomainError {
    return new DomainError(code, `transfer ${this.id}: ${message}`)
  }
}
