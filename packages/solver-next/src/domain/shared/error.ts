import type { ValueOf } from './brand.js'

export const ErrorCode = {
  Invalid: 'invalid',
  IllegalTransition: 'illegal_transition',
  RuleViolated: 'rule_violated',
  Conflict: 'conflict',
  Corrupt: 'corrupt',
} as const

export type ErrorCode = ValueOf<typeof ErrorCode>

export abstract class DomainError extends Error {
  abstract readonly code: ErrorCode

  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

export class InvalidValue extends DomainError {
  readonly code = ErrorCode.Invalid
}

export class IllegalTransition extends DomainError {
  readonly code = ErrorCode.IllegalTransition
}

export class RuleViolated extends DomainError {
  readonly code = ErrorCode.RuleViolated
}

export class Conflict extends DomainError {
  readonly code = ErrorCode.Conflict
}

export class CorruptHistory extends DomainError {
  readonly code = ErrorCode.Corrupt
}
