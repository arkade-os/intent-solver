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
import { usableSatsOf } from '@arkade-os/solver-arkade/arkade/lockupFunding.js'
import type { Services } from '@arkade-os/solver-app/ops/services.js'
import { readerSetFromDeps, type FlatCorridorDeps } from '@arkade-os/solver-app/ops/corridorSet.js'

const zero = () => ({ committedSats: vi.fn().mockResolvedValue(0) })

const servicesWith = (over: {
  committed?: number
  spendable?: number[]
  send?: ReturnType<typeof vi.fn>
  /** Outpoint keys the ledger is holding, as `txid:vout`. */
  reserved?: string[]
  /**
   * Whole coins, when a case needs a field beyond `value` — an asset, above all.
   * `spendable` stays the shorthand for the sats-only cases that are most of them.
   */
  coins?: { txid: string; vout: number; value: number; assets?: { assetId: string; amount: bigint }[] }[]
}) => {
  const committed = over.committed ?? 0
  const send = over.send ?? vi.fn().mockResolvedValue('ark-txid')
  // Real outpoints, not just values: the reserved filter keys on them, and a
  // fixture without them cannot tell a filtered coin from an unfiltered one.
  const coins = over.coins ?? (over.spendable ?? [300_000]).map((value, i) => ({ txid: `coin${i}`, vout: 0, value }))
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
 * The pool used to read a coin's whole `value` and drop its `assets`, which made an
 * asset-bearing coin indistinguishable from ordinary sats inventory. It is not: an
 * asset must ride on sats, so spending the coin leaves one dust pinned on the change
 * output that carries the asset onward. `selectLockupFunding` has discounted for that
 * since #114; the pool did not, so the two disagreed about what the same coin could
 * fund — the pool planning against sats the funding path already knew it could not
 * reach.
 *
 * `getSpendableVtxos` does not filter these out and cannot be asked to: the SDK builds
 * `getBalance().availableAssets` by walking that very set and reading `vtxo.assets`,
 * so a non-empty `availableAssets` and an asset-bearing spendable coin are the same
 * fact.
 */
describe('poolPlan — an asset-bearing coin is not ordinary sats', () => {
  const withAsset = (value: number) => ({
    txid: 'asset0',
    vout: 0,
    value,
    assets: [{ assetId: 'a'.repeat(64), amount: 500n }],
  })
  const plain = (value: number) => ({ txid: 'plain0', vout: 0, value })

  it('counts a coin at what it can fund, not at what it holds', async () => {
    const result = await poolPlan(servicesWith({ coins: [withAsset(100_000)] }))
    // dust is 330 in this fixture, and that dust is spoken for before the pool gets
    // a say.
    expect(result.spendable).toEqual([99_670])
    expect(result.assetEncumberedSats).toBe(330)
    expect(result.assetBearingPieces).toBe(1)
  })

  it('drops a coin worth no more than dust instead of counting it as a piece', async () => {
    // It can pay for its own asset change and nothing else. Counted, it would occupy
    // a slot against the pool's `maxCount` ceiling while funding zero swaps — and an
    // asset corridor mints these routinely as change.
    const result = await poolPlan(servicesWith({ coins: [plain(300_000), withAsset(330)] }))
    expect(result.spendable).toEqual([300_000])
    // The whole coin is encumbered, not merely one dust of it.
    expect(result.assetEncumberedSats).toBe(330)
    expect(result.assetBearingPieces).toBe(1)
  })

  it('never reports more encumbered than a coin actually holds', async () => {
    // Below dust, so the discount would run past the coin's own value. Unclamped this
    // reports 330 sat pinned on a coin holding 200 — a figure larger than the float it
    // is describing, which is worse than saying nothing.
    const result = await poolPlan(servicesWith({ coins: [plain(300_000), withAsset(200)] }))
    expect(result.spendable).toEqual([300_000])
    expect(result.assetEncumberedSats).toBe(200)
  })

  it('leaves a coin carrying nothing completely alone', async () => {
    // The constraint the change is held to: a float with no assets plans exactly as
    // it did, and reports nothing encumbered.
    const result = await poolPlan(servicesWith({ coins: [plain(300_000), { txid: 'c1', vout: 0, value: 250_000 }] }))
    expect(result.spendable).toEqual([300_000, 250_000])
    expect(result.assetEncumberedSats).toBe(0)
    expect(result.assetBearingPieces).toBe(0)
  })

  it('does not charge for an asset on a coin a funding has already pinned', async () => {
    // Reserved coins leave the float before any of this, so one cannot show up as
    // float an operator is told is unavailable — it is not float at all right now.
    const result = await poolPlan(servicesWith({ coins: [withAsset(100_000)], reserved: ['asset0:0'] }))
    expect(result.spendable).toEqual([])
    expect(result.assetEncumberedSats).toBe(0)
    expect(result.assetBearingPieces).toBe(0)
  })

  it('agrees with the funding path about the same coin', async () => {
    // One rule, shared, rather than two spellings that drift. Were the pool to keep
    // its own, this is the assertion that would fail first.
    const coins = [withAsset(100_000), plain(80_000)]
    const result = await poolPlan(servicesWith({ coins }))
    expect(result.spendable).toEqual(coins.map((coin) => usableSatsOf(coin, 330)))
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
