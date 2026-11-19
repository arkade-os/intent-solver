import type { Brand } from './brand.js'

export type UnixSeconds = Brand<number, 'UnixSeconds'>

export const UnixSeconds = {
  of(value: number): UnixSeconds {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`not a unix timestamp in seconds: ${value}`)
    return value as UnixSeconds
  },
}
