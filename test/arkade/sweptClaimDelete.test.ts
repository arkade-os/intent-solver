import { describe, expect, it, vi } from 'vitest'
import { ArkError, ArkErrorName } from '@arkade-os/sdk'
import { deleteSweptClaimIntent } from '@arkade-os/solver-arkade/arkade/sweptClaim.js'
import type { ArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'

const contextWithDelete = (deleteIntent: () => Promise<void>): ArkadeContext =>
  ({ wallet: { arkProvider: { deleteIntent } } }) as unknown as ArkadeContext

describe('swept claim cancellation', () => {
  it('does not treat an absent pending intent as proven cancelled', async () => {
    const error = new ArkError(3, 'no matching intents found', ArkErrorName.INVALID_INTENT_PROOF)
    const deleteIntent = vi.fn(async () => {
      throw error
    })

    await expect(deleteSweptClaimIntent(contextWithDelete(deleteIntent), 'ZGVsZXRl')).rejects.toThrow(
      'cancellation is unverified',
    )
    expect(deleteIntent).toHaveBeenCalledOnce()
  })

  it('accepts a confirmed delete response', async () => {
    const deleteIntent = vi.fn(async () => undefined)

    await expect(deleteSweptClaimIntent(contextWithDelete(deleteIntent), 'ZGVsZXRl')).resolves.toBeUndefined()
    expect(deleteIntent).toHaveBeenCalledOnce()
  })
})
