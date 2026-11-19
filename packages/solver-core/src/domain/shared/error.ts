import type { ValueOf } from './brand.js'

export const ErrorCode = {
  /** A value that can never be valid: a negative amount, a malformed hash. */
  Invalid: 'invalid',
  /** A move the state machine has no edge for. */
  IllegalTransition: 'illegal_transition',
  /** A valid move that a rule forbids right now. */
  RuleViolated: 'rule_violated',
  /** Another writer got there first; reload and retry. */
  Conflict: 'conflict',
  /** Stored history that cannot have been produced by the commands. */
  Corrupt: 'corrupt',
} as const

export type ErrorCode = ValueOf<typeof ErrorCode>

export class DomainError extends Error {
  override readonly name = 'DomainError'

  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }
}
