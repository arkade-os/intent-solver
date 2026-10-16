/**
 * E2E — the pool merging the solver's own float against a live arkd.
 *
 * The planner's arithmetic is unit-tested. What only arkd can answer is whether it
 * accepts one Arkade transaction spending fifty of the solver's coins under its
 * `maxTxWeight`. PREREQUISITES: arkd, emulator, a funded wallet. Run: `pnpm test:e2e`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCorridorReaderSet } from '@arkade-os/solver-core/core/corridor.js'
import { mintPool, poolPlan } from '@arkade-os/solver-app/ops/pool.js'
import type { Services } from '@arkade-os/solver-app/ops/services.js'
import { requireStack } from './support/preflight.js'
import {
  assertArkadeSpendable,
  openArkade,
  SETUP_TIMEOUT_MS,
  SWAP_TIMEOUT_MS,
  type E2eArkade,
} from './support/stack.js'

const COINS = 70
const COIN_SATS = 2_000
const PER_SEND = 7

let arkade: E2eArkade

// The deployment default cap (`maxSats * 3`): the harness's x100 lifts the ceiling past seventy coins.
const services = (): Services =>
  ({
    arkade: arkade.ctx,
    config: { limits: arkade.limits, maxExposedSats: arkade.limits.maxSats * 3 },
    readers: createCorridorReaderSet([]),
  }) as unknown as Services

const outpoint = (vtxo: { txid: string; vout: number }) => `${vtxo.txid}:${vtxo.vout}`

const waitFor = async (ready: (coins: { txid: string; vout: number; value: number }[]) => boolean) => {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const coins = await arkade.ctx.wallet.getSpendableVtxos()
    if (ready(coins)) return coins
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error('the float never reached the expected shape')
}

describe('e2e pool consolidation', () => {
  beforeAll(async () => {
    await requireStack('pool consolidation', ['arkd', 'emulator'])
    arkade = await openArkade()
  }, SETUP_TIMEOUT_MS)

  afterAll(() => {
    arkade?.close()
  })

  it(
    'merges fifty coins in one Arkade transaction arkd accepts',
    async () => {
      await assertArkadeSpendable(arkade, COINS * COIN_SATS + 10_000)
      const own = await arkade.ctx.wallet.getAddress()
      const piece = { address: own, amount: COIN_SATS }
      for (let sent = 0; sent < COINS; sent += PER_SEND) {
        await arkade.ctx.wallet.send(piece, ...Array.from({ length: PER_SEND - 1 }, () => piece))
      }
      const small = (coins: { value: number }[]) => coins.filter((coin) => coin.value === COIN_SATS).length
      const before = await waitFor((coins) => small(coins) >= COINS)

      expect((await poolPlan(services())).plan.reason).toMatch(/consolidating 50 of/)
      const result = await mintPool(services())
      if (!('minted' in result)) throw new Error(`mint did not spend: ${JSON.stringify(result)}`)
      expect(result.txid).toMatch(/^[0-9a-f]{64}$/)
      expect(result.spent).toHaveLength(50)

      const spent = new Set(result.spent)
      const known = new Set(before.map(outpoint))
      const after = await waitFor(
        (coins) =>
          !coins.some((coin) => spent.has(outpoint(coin))) &&
          coins.filter((coin) => !known.has(outpoint(coin))).length >= result.minted.length,
      )
      expect(before.length - after.length).toBeGreaterThanOrEqual(40)
      const landed = after.filter((coin) => !known.has(outpoint(coin))).map((coin) => coin.value)
      const sorted = (values: readonly number[]) => [...values].sort((a, b) => a - b)
      expect(sorted(landed)).toEqual(sorted(result.minted))
    },
    SWAP_TIMEOUT_MS,
  )
})
