import { expect, it } from 'vitest'
import { arkadeFundingOwed } from '../../packages/solver-app/src/ops/pool.js'
import type { CorridorReaderSet } from '@arkade-os/solver-core/core/corridor.js'

it('uses unfunded Arkade obligations and conservatively counts older registered readers', async () => {
  const readers = [
    { committedSats: async () => 10000, outstandingArkadeSats: async () => 2000 },
    { committedSats: async () => 3000 },
    { committedSats: async () => 8000, outstandingArkadeSats: async () => 0 },
  ] as unknown as CorridorReaderSet
  expect(await arkadeFundingOwed(readers)).toBe(5000)
})
