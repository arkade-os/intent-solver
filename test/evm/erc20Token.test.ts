/**
 * The two TOKEN calls, and the one thing about them that differs from every
 * other call this corridor makes: where they are addressed.
 */
import { describe, it, expect } from 'vitest'
import { hex } from '@scure/base'
import { keccak_256 } from '@noble/hashes/sha3.js'
import {
  ALLOWANCE_SIGNATURE,
  APPROVE_SIGNATURE,
  approvalStepFor,
  encodeAllowance,
  encodeApprove,
} from '@arkade-os/solver-rails-evm/evm/erc20Token.js'

const wordAt = (calldata: Uint8Array, index: number): string =>
  hex.encode(calldata.subarray(4 + index * 32, 4 + (index + 1) * 32))

const padded = (byte: number) => '00'.repeat(12) + byte.toString(16).padStart(2, '0').repeat(20)

describe('selectors — pinned against the public 4byte registry', () => {
  // Same reasoning as erc20Swap.test.ts: our own keccak agrees with itself
  // whatever the signature string says, and a wrong one reverts only on chain.
  //
  // 0x095ea7b3 has three deliberate collisions registered against it, so the
  // check that matters is that `approve(address,uint256)` is one of the
  // signatures hashing to it — which it is.
  it.each([
    [APPROVE_SIGNATURE, '095ea7b3'],
    [ALLOWANCE_SIGNATURE, 'dd62ed3e'],
  ])('%s -> %s', (signature, expected) => {
    expect(hex.encode(keccak_256(new TextEncoder().encode(signature)).subarray(0, 4))).toBe(expected)
  })
})

describe('encodeApprove', () => {
  it('puts the spender first and the amount second', () => {
    const spender = new Uint8Array(20).fill(0x7a)
    const encoded = encodeApprove(spender, 1_000n)
    expect(hex.encode(encoded.subarray(0, 4))).toBe('095ea7b3')
    expect(wordAt(encoded, 0)).toBe(padded(0x7a))
    expect(wordAt(encoded, 1)).toBe('00'.repeat(30) + '03e8')
    expect(encoded.length).toBe(4 + 64)
  })

  it('rejects an address that is not 20 bytes rather than padding whatever it got', () => {
    expect(() => encodeApprove(new Uint8Array(32).fill(1), 1n)).toThrow(/spender must be 20 bytes/)
  })
})

describe('encodeAllowance', () => {
  it('puts the owner first and the spender second, which is not symmetric', () => {
    // Reversed, this reads the allowance the SWAP CONTRACT has granted the
    // solver — which is always zero, so the caller would approve on every lock
    // and never notice the reads were meaningless.
    const owner = new Uint8Array(20).fill(0x11)
    const spender = new Uint8Array(20).fill(0x22)
    const encoded = encodeAllowance(owner, spender)
    expect(hex.encode(encoded.subarray(0, 4))).toBe('dd62ed3e')
    expect(wordAt(encoded, 0)).toBe(padded(0x11))
    expect(wordAt(encoded, 1)).toBe(padded(0x22))
  })
})

/**
 * Which sequence a given allowance implies. The third case exists because some
 * widely-held tokens refuse an approve that moves a non-zero allowance to
 * another non-zero value.
 */
describe('approvalStepFor', () => {
  it('does nothing when the allowance is already exactly right', () => {
    expect(approvalStepFor(500n, 500n)).toEqual({ kind: 'none' })
  })

  it('approves directly from zero', () => {
    expect(approvalStepFor(0n, 500n)).toEqual({ kind: 'approve', amount: 500n })
  })

  it('resets first when a different non-zero allowance is in place', () => {
    expect(approvalStepFor(200n, 500n)).toEqual({ kind: 'reset-then-approve', amount: 500n })
  })

  it('resets first even when the existing allowance is LARGER than needed', () => {
    // Tempting to treat as 'none' — the lock would succeed. But leaving a
    // larger allowance keeps the float exposed beyond this one lock, which is
    // the whole reason approvals here are exact rather than unlimited.
    expect(approvalStepFor(10_000n, 500n)).toEqual({ kind: 'reset-then-approve', amount: 500n })
  })

  it('refuses a non-positive amount rather than approving zero', () => {
    expect(() => approvalStepFor(0n, 0n)).toThrow(/amount must be positive/)
  })
})
