import { describe, it, expect, vi } from 'vitest'
import { provenDepth, type DepthReader } from '@arkade-os/solver-rails-evm/evm/lockDepth.js'
import type { Erc20SwapLock } from '@arkade-os/solver-rails-evm/evm/erc20Swap.js'

const lock: Erc20SwapLock = {
  preimageHash: new Uint8Array(32).fill(0x11),
  amount: 1_000n,
  tokenAddress: new Uint8Array(20).fill(0x22),
  claimAddress: new Uint8Array(20).fill(0x33),
  refundAddress: new Uint8Array(20).fill(0x44),
  timelock: 500n,
}

const reader = (over: Partial<DepthReader> = {}): DepthReader =>
  ({
    isLockedAt: vi.fn().mockResolvedValue(true),
    blockTimestampAt: vi.fn().mockResolvedValue(1_000_000),
    ...over,
  }) as DepthReader

const question = { present: true, height: 1_000, minConfirmations: 12, nowSeconds: 1_000_600 }

describe('provenDepth', () => {
  it('asks whether the lock was there at the CONFIGURED depth, not at the tip', async () => {
    // The probe height IS the policy. Asking at the tip answers the question
    // `isLocked` already answers, which is how the check became a no-op.
    const isLockedAt = vi.fn().mockResolvedValue(true)
    await provenDepth(reader({ isLockedAt }), lock, question)
    expect(isLockedAt.mock.calls[0]?.[1]).toBe(989n) // 1000 - 12 + 1
  })

  it('reports the configured depth once proven, and the age from the probe block', async () => {
    const depth = await provenDepth(reader(), lock, question)
    expect(depth).toEqual({ confirmations: 12, ageSeconds: 600 })
  })

  it('proves nothing when the lock was not there that far back', async () => {
    const depth = await provenDepth(reader({ isLockedAt: vi.fn().mockResolvedValue(false) }), lock, question)
    expect(depth).toEqual({ confirmations: 0, ageSeconds: 0 })
  })

  /**
   * A lock created and then CLAIMED between the probe block and now would still
   * read as present at the probe. `present` is what catches it: the contract
   * clears its flag on claim, so the tip read goes false.
   */
  it('proves nothing when the lock is gone at the tip, however deep it once was', async () => {
    const isLockedAt = vi.fn().mockResolvedValue(true)
    const depth = await provenDepth(reader({ isLockedAt }), lock, { ...question, present: false })
    expect(depth).toEqual({ confirmations: 0, ageSeconds: 0 })
    // And it did not spend a read to find that out.
    expect(isLockedAt).not.toHaveBeenCalled()
  })

  it('proves nothing on a chain younger than the configured depth', async () => {
    // `eth_call` at a negative height is not a question. Without the guard this
    // asks for block -1 and the node's error decides the corridor's behaviour.
    const isLockedAt = vi.fn().mockResolvedValue(true)
    const depth = await provenDepth(reader({ isLockedAt }), lock, { ...question, height: 5 })
    expect(depth).toEqual({ confirmations: 0, ageSeconds: 0 })
    expect(isLockedAt).not.toHaveBeenCalled()
  })

  /**
   * THE ARCHIVE-NODE CASE. `isLockedAt` is an `eth_call` at a historical height,
   * so a node that has pruned that far cannot answer — which means the depth an
   * operator may configure is implicitly bounded by their node's retention.
   *
   * Letting that escape would fail the whole tick over a question whose honest
   * answer is "cannot tell yet". Swallowing it silently would stall the corridor
   * with nothing to read. So: reported, and treated as not-yet-deep.
   */
  it('treats a node that cannot answer as NOT PROVEN, not as absent', async () => {
    const onError = vi.fn()
    const boom = new Error('missing trie node')
    const depth = await provenDepth(reader({ isLockedAt: vi.fn().mockRejectedValue(boom) }), lock, question, onError)
    expect(depth).toEqual({ confirmations: 0, ageSeconds: 0 })
    expect(onError).toHaveBeenCalledWith(boom)
  })

  it('does not throw when the TIMESTAMP read is the one that fails', async () => {
    // Half-proven is not proven: depth without an age cannot satisfy a policy
    // that requires both.
    const onError = vi.fn()
    const depth = await provenDepth(
      reader({ blockTimestampAt: vi.fn().mockRejectedValue(new Error('pruned')) }),
      lock,
      question,
      onError,
    )
    expect(depth).toEqual({ confirmations: 0, ageSeconds: 0 })
    expect(onError).toHaveBeenCalled()
  })

  it('survives a caller that passes no error sink', async () => {
    const depth = await provenDepth(reader({ isLockedAt: vi.fn().mockRejectedValue(new Error('x')) }), lock, question)
    expect(depth.confirmations).toBe(0)
  })
})
