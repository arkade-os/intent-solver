import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import type { Brand } from '../shared/brand.js'

export type Hashlock = Brand<string, 'Hashlock'>
export type Preimage = Brand<string, 'Preimage'>

// Lowercase only: hashes are compared as strings, so two spellings of one hash must not both exist.
const HEX_32_BYTES = /^[0-9a-f]{64}$/

const hex32 = <B extends string>(name: string, value: string): B => {
  if (!HEX_32_BYTES.test(value)) throw new Error(`${name} must be 32 bytes of lowercase hex`)
  return value as B
}

export const hashlock = (value: string): Hashlock => hex32('hashlock', value)
export const preimage = (value: string): Preimage => hex32('preimage', value)

export const hashlockOf = (secret: Preimage): Hashlock => hex.encode(sha256(hex.decode(secret))) as Hashlock

export const opens = (secret: Preimage, lock: Hashlock): boolean => hashlockOf(secret) === lock
