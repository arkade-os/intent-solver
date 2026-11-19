import type { ValueOf } from './brand.js'

export const ErrorCode = {
  Invalid: 'invalid',
  IllegalTransition: 'illegal_transition',
  RuleViolated: 'rule_violated',
  Conflict: 'conflict',
  Corrupt: 'corrupt',
} as const

export type ErrorCode = ValueOf<typeof ErrorCode>

/** Catch by class inside the process; `code` is what crosses a wire or lands in a log. */
export abstract class DomainError extends Error {
  abstract readonly code: ErrorCode

  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** A value that can never be valid: a negative amount, a malformed hash. */
export class InvalidValue extends DomainError {
  readonly code = ErrorCode.Invalid
}

/** A move the state machine has no edge for. */
export class IllegalTransition extends DomainError {
  readonly code = ErrorCode.IllegalTransition
}

/** A valid move that a rule forbids right now. */
export class RuleViolated extends DomainError {
  readonly code = ErrorCode.RuleViolated
}

/** Another writer got there first; reload and retry. */
export class Conflict extends DomainError {
  readonly code = ErrorCode.Conflict
}

/** Stored history that the commands cannot have produced. */
export class CorruptHistory extends DomainError {
  readonly code = ErrorCode.Corrupt
}
