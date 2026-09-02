/**
 * Behavioural guards on the only operator action that SPENDS.
 *
 * These replace what `test/cli/poolMint.test.ts` could only assert against
 * source text: that file's own docstring says it matched on the source
 * "rather than by calling the function because `packages/solver-app/src/cli.ts` runs `main()` and
 * then `process.exit()` at module load and does not export". `packages/solver-app/src/ops/pool.ts`
 * has no such problem, so the same money-safety property is asserted here by
 * actually calling it — the spend must never happen without the opt-in, and
 * never while another provider may hold reservations this process cannot see.
 *
 * The source-level guard is kept alongside, re-pointed at this module.
 */

import { createCorridorReaderSet } from '@arkade-os/solver-core/core/corridor.js'
import { describe, it, expect, vi } from 'vitest'
import { mintPool, poolPlan, committedAcrossCorridors } from '@arkade-os/solver-app/ops/pool.js'
import type { Services } from '@arkade-os/solver-app/ops/services.js'
import { readerSetFromDeps, type FlatCorridorDeps } from '@arkade-os/solver-app/ops/corridorSet.js'

const zero = () => ({ committedSats: vi.fn().mockResolvedValue(0) })

const servicesWith = (over: {
  committed?: number
  spendable?: number[]
  send?: ReturnType<typeof vi.fn>
  /** Outpoint keys the ledger is holding, as `txid:vout`. */
  reserved?: string[]
}) => {
  const committed = over.committed ?? 0
  const send = over.send ?? vi.fn().mockResolvedValue('ark-txid')
  // Real outpoints, not just values: the reserved filter keys on them, and a
  // fixture without them cannot tell a filtered coin from an unfiltered one.
  const coins = (over.spendable ?? [300_000]).map((value, i) => ({ txid: `coin${i}`, vout: 0, value }))
  const stores = {
    store: { committedSats: vi.fn().mockResolvedValue(committed) },
    onchainStore: zero(),
    receiveStore: zero(),
    onchainReceiveStore: zero(),
  }
  return {
    config: { limits: { minSats: 1_000, maxSats: 100_000 }, maxExposedSats: 300_000 },
    arkade: {
      reservations: { reserved: () => new Set(over.reserved ?? []) },
      wallet: {
        getSpendableVtxos: vi.fn().mockResolvedValue(coins),
        arkProvider: { getInfo: vi.fn().mockResolvedValue({ dust: 330 }) },
        getAddress: vi.fn().mockResolvedValue('tark1solver'),
        send,
      },
    },
    ...stores,
    // What `committedAcrossCorridors` iterates; `createServices` supplies it in
    // production.
    readers: readerSetFromDeps(stores as unknown as FlatCorridorDeps),
  } as unknown as Services
}

describe('poolPlan — reserved coins', () => {
  it('does not offer a coin an in-flight funding has pinned', async () => {
    // `planPool` documents its input as "already filtered of reserved", and this
    // is the caller that owes it that. Unfiltered, the split spends a coin a
    // funding is mid-flight on and that swap can no longer fund — the exact
    // collision the reservation ledger exists to prevent.
    const all = await poolPlan(servicesWith({ spendable: [300_000, 250_000] }))
    expect(all.spendable).toEqual([300_000, 250_000])

    const pinned = await poolPlan(servicesWith({ spendable: [300_000, 250_000], reserved: ['coin0:0'] }))
    expect(pinned.spendable).toEqual([250_000])
  })

  it('does not mistake the committed-rows gate for reservation safety', async () => {
    // The gate below is a proxy for a SECOND process and is explicitly loose. It
    // says nothing about this process's own ledger, so a float with nothing
    // committed can still hold pinned coins — which is precisely the in-process
    // case (admin console, lifecycle re-split) the filter is for.
    const plan = await poolPlan(servicesWith({ committed: 0, spendable: [300_000], reserved: ['coin0:0'] }))
    expect(plan.spendable).toEqual([])
    expect(plan.plan.outputs).toEqual([])
  })
})

describe('poolPlan', () => {
  it('reads the float without spending anything', async () => {
    const send = vi.fn()
    const services = servicesWith({ send })
    const result = await poolPlan(services)
    expect(result.spendable).toEqual([300_000])
    expect(send).not.toHaveBeenCalled()
  })
})

/**
 * This number bounds how much the solver may have at risk at once
 * (`MAX_EXPOSED_SATS`, issue #96), so a corridor missing from the sum is
 * headroom the cap hands out twice. It named the four stores explicitly, which
 * was correct while four was all there could be — and became a hole the moment
 * a corridor could be registered that this build was never compiled against.
 */
describe('committedAcrossCorridors', () => {
  const reader = (pair: string, sats: number) =>
    ({ descriptor: { pair }, committedSats: vi.fn().mockResolvedValue(sats) }) as never

  it('sums all four corridors, not just the Lightning one', async () => {
    const set = createCorridorReaderSet([
      reader('arkade:BTC->lightning:BTC', 1),
      reader('arkade:BTC->onchain:BTC', 2),
      reader('lightning:BTC->arkade:BTC', 4),
      reader('onchain:BTC->arkade:BTC', 8),
    ])
    expect(await committedAcrossCorridors(set)).toBe(15)
  })

  /**
   * The gap this closes. A plugged-in corridor's exposure counts against the
   * SAME cap — otherwise the solver quotes past a bound an operator set
   * deliberately, and nothing anywhere reports that it did.
   */
  it('counts a corridor this build was never compiled against', async () => {
    const set = createCorridorReaderSet([reader('arkade:BTC->lightning:BTC', 1), reader('arkade:BTC->fake:BTC', 16)])
    expect(await committedAcrossCorridors(set)).toBe(17)
  })

  it('is zero for a solver serving nothing', async () => {
    expect(await committedAcrossCorridors(createCorridorReaderSet([]))).toBe(0)
  })
})

describe('mintPool — the spend gate', () => {
  it('refuses to spend while any corridor has a non-terminal swap', async () => {
    const send = vi.fn()
    const result = await mintPool(servicesWith({ committed: 5_000, send }))
    expect(send).not.toHaveBeenCalled()
    expect(result).toMatchObject({ committedSats: 5_000 })
    expect('refused' in result && result.refused).toMatch(/reserves coins in memory/)
  })

  it('only force lets that gate past, and says so', async () => {
    const send = vi.fn().mockResolvedValue('ark-txid')
    const result = await mintPool(servicesWith({ committed: 5_000, send }), { force: true })
    expect(send).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ txid: 'ark-txid' })
  })

  it('spends exactly once — a split is one Arkade transaction, not one per piece', async () => {
    const send = vi.fn().mockResolvedValue('ark-txid')
    const result = await mintPool(servicesWith({ send }))
    expect(send).toHaveBeenCalledTimes(1)
    // Every piece rides on that single call, as trailing recipients.
    expect(send.mock.calls[0]!.length).toBeGreaterThan(1)
    expect(result).toMatchObject({ txid: 'ark-txid' })
  })

  it('does not spend when the float is already the right shape', async () => {
    const send = vi.fn()
    // A pool already split into many small pieces has nothing to plan.
    const spendable = Array.from({ length: 64 }, () => 4_000)
    const result = await mintPool(servicesWith({ spendable, send }))
    expect(send).not.toHaveBeenCalled()
    expect(result).toEqual({ skipped: 'nothing-to-do' })
  })
})
