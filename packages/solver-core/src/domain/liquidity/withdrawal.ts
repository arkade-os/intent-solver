import type { Amount } from '../shared/amount.js'
import { nonEmpty, type Brand, type ValueOf } from '../shared/brand.js'
import type { Endpoint } from '../shared/endpoint.js'

export type WithdrawalId = Brand<string, 'WithdrawalId'>
export const withdrawalId = (value: string): WithdrawalId => nonEmpty('withdrawal id', value)

export const WithdrawalState = {
  Preparing: 'preparing',
  Sending: 'sending',
  Sent: 'sent',
  Uncertain: 'uncertain',
  Failed: 'failed',
} as const

export type WithdrawalState = ValueOf<typeof WithdrawalState>

// No edge from `sending` to `failed`: once submitted, "it did not go out" needs proof, so it is `uncertain`.
const EDGES: Record<WithdrawalState, readonly WithdrawalState[]> = {
  preparing: ['sending', 'uncertain', 'failed'],
  sending: ['sent', 'uncertain'],
  uncertain: ['sent', 'failed'],
  sent: [],
  failed: [],
}

export interface WithdrawalProps {
  readonly id: WithdrawalId
  /** Which pool of funds the operator is drawing on. */
  readonly scope: string
  readonly endpoint: Endpoint
  readonly address: string
  readonly amount: Amount
  readonly fee: Amount | null
  readonly reference: string | null
  readonly state: WithdrawalState
}

/** Value an operator takes out of the solver. */
export class Withdrawal {
  private constructor(private props: WithdrawalProps) {}

  static prepare(id: WithdrawalId, scope: string, endpoint: Endpoint, address: string, amount: Amount): Withdrawal {
    if (amount.isZero || amount.asset !== endpoint.asset) {
      throw new Error(`withdrawal ${id}: needs a positive amount of ${endpoint.asset}`)
    }
    if (address === '' || scope === '') throw new Error(`withdrawal ${id}: missing address or scope`)
    return new Withdrawal({
      id,
      scope,
      endpoint,
      address,
      amount,
      fee: null,
      reference: null,
      state: WithdrawalState.Preparing,
    })
  }

  static restore(props: WithdrawalProps): Withdrawal {
    return new Withdrawal(props)
  }

  get id(): WithdrawalId {
    return this.props.id
  }
  get state(): WithdrawalState {
    return this.props.state
  }
  get snapshot(): WithdrawalProps {
    return this.props
  }
  /** What leaves the rail: the amount and its fee. Known from `sending` on, so a checkpoint can account for it. */
  get debit(): Amount | null {
    return this.props.fee === null ? null : this.props.amount.plus(this.props.fee)
  }

  send(fee: Amount): void {
    if (fee.asset !== this.props.amount.asset) throw this.error(`fee must be in ${this.props.amount.asset}`)
    this.move(WithdrawalState.Sending)
    this.props = { ...this.props, fee }
  }

  sent(reference: string): void {
    if (reference === '' || this.props.fee === null) throw this.error('a sent withdrawal needs its fee and reference')
    this.move(WithdrawalState.Sent)
    this.props = { ...this.props, reference }
  }

  /** It may or may not have gone out; a reference, when there is one, is what an operator checks. */
  uncertain(reference: string | null = null): void {
    this.move(WithdrawalState.Uncertain)
    this.props = { ...this.props, reference: reference ?? this.props.reference }
  }

  fail(): void {
    this.move(WithdrawalState.Failed)
  }

  private move(to: WithdrawalState): void {
    if (!EDGES[this.state].includes(to)) throw this.error(`cannot go ${this.state} -> ${to}`)
    this.props = { ...this.props, state: to }
  }

  private error(message: string): Error {
    return new Error(`withdrawal ${this.id}: ${message}`)
  }
}
