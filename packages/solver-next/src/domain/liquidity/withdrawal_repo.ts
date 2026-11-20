import type { Withdrawal, WithdrawalId } from './withdrawal.js'

export interface WithdrawalRepository {
  add(withdrawal: Withdrawal): Promise<void>
  update(id: WithdrawalId, change: (withdrawal: Withdrawal) => void | Promise<void>): Promise<Withdrawal>
  get(id: WithdrawalId): Promise<Withdrawal | null>
  listUnfinished(): Promise<readonly Withdrawal[]>
}
