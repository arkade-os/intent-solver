import { expect, it, vi } from 'vitest'
import { arkadeFundableSats, arkadeFundingOwed } from '../../packages/solver-app/src/ops/pool.js'
import { LOCKUP_FUNDING_FILTER } from '@arkade-os/solver-corridors/receive/fundLockup.js'
import type { ArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'
import type { CorridorReaderSet } from '@arkade-os/solver-core/core/corridor.js'

it('uses unfunded Arkade obligations and conservatively counts older registered readers', async () => {
  const readers = [
    { committedSats: async () => 10000, outstandingArkadeSats: async () => 2000 },
    { committedSats: async () => 3000 },
    { committedSats: async () => 8000, outstandingArkadeSats: async () => 0 },
  ] as unknown as CorridorReaderSet
  expect(await arkadeFundingOwed(readers)).toBe(5000)
})

it('counts the fundable float from the coins and rule funding uses', async () => {
  const getSpendableVtxos = vi.fn(async () => [
    { value: 10_000 },
    { value: 5_000, assets: [{ assetId: 'a', amount: 1 }] },
    { value: 330, assets: [{ assetId: 'b', amount: 1 }] },
  ])
  const ctx = { wallet: { getSpendableVtxos }, dustSats: 330n } as unknown as ArkadeContext
  expect(await arkadeFundableSats(ctx)).toBe(10_000 + 5_000 - 330)
  expect(getSpendableVtxos).toHaveBeenCalledWith(LOCKUP_FUNDING_FILTER)
})
