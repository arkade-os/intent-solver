import type { ValueOf } from '../domain/shared/brand.js'
import type { UnixSeconds } from '../domain/shared/time.js'

export const ActionOutcome = {
  Ok: 'ok',
  Error: 'error',
} as const

export type ActionOutcome = ValueOf<typeof ActionOutcome>

/** One line of the audit log: what an operator did, to what, and how it ended. */
export interface ActionRecord {
  readonly at: UnixSeconds
  readonly action: string
  readonly target: string | null
  readonly outcome: ActionOutcome
  readonly detail: string | null
  /** Redacted before it gets here: no feed URLs, no keys. */
  readonly params: string
  /** Ties together the lines one save produced, e.g. a pricing change touching several settings. */
  readonly group: string | null
}

export interface ActionLog {
  // Must not throw into the action it records: a failed audit write would invite a retry of a payout.
  append(record: ActionRecord): Promise<void>
  recent(limit: number): Promise<readonly ActionRecord[]>
}
