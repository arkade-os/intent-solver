import type { Brand } from './brand.js'
import { DomainError, ErrorCode } from './error.js'

export type UnixSeconds = Brand<number, 'UnixSeconds'>

export const UnixSeconds = {
  of(value: number): UnixSeconds {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new DomainError(ErrorCode.Invalid, `not a unix timestamp in seconds: ${value}`)
    return value as UnixSeconds
  },
}
