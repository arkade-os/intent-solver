/**
 * The read behind `AssetOfferDeps.outputsAt`.
 *
 * `offerDepositFrom` is pure by design — outputs in, a deposit out — so
 * something has to perform the read, and this is it. Two things can go wrong
 * here and both are silent: a paged answer read as complete undercounts a
 * deposit into `offer_unfunded`, and a spent output read as live resurrects a
 * deposit that is gone.
 */
import { describe, it, expect, vi } from 'vitest'
import { offerOutputsAt } from '@arkade-os/solver-arkade/arkade/offerOutputs.js'
import type { ArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'

const SCRIPT = '5120' + 'ab'.repeat(32)
const USD = '41bcbb06921a0e9f6fe4f1b003b878cbb43d9ca3f6d14cab7940090458765a390000'

const vtxo = (over: Record<string, unknown> = {}) => ({
  txid: 'a'.repeat(64),
  vout: 0,
  script: SCRIPT,
  value: 5_000,
  ...over,
})

const ctxWith = (getVtxos: unknown): Pick<ArkadeContext, 'wallet'> =>
  ({ wallet: { indexerProvider: { getVtxos } } }) as unknown as Pick<ArkadeContext, 'wallet'>

describe('offerOutputsAt', () => {
  it('asks the indexer for that script and maps what it returns', async () => {
    const getVtxos = vi.fn(async () => ({
      vtxos: [vtxo({ assets: [{ assetId: USD, amount: 900n }] })],
      page: { current: 0, total: 1 },
    }))
    const outputs = await offerOutputsAt(ctxWith(getVtxos), SCRIPT)

    expect(getVtxos).toHaveBeenCalledWith(expect.objectContaining({ scripts: [SCRIPT] }))
    expect(outputs).toEqual([
      { script: SCRIPT, value: 5_000, isSpent: false, isSwept: false, assets: [{ assetId: USD, amount: 900n }] },
    ])
  })

  it('reads every page, so a large deposit is not undercounted', async () => {
    const getVtxos = vi
      .fn()
      .mockResolvedValueOnce({ vtxos: [vtxo({ value: 60_000 })], page: { current: 0, total: 2 } })
      .mockResolvedValueOnce({ vtxos: [vtxo({ value: 40_000, vout: 1 })], page: { current: 1, total: 2 } })
    const outputs = await offerOutputsAt(ctxWith(getVtxos), SCRIPT)
    expect(outputs.map((o) => o.value)).toEqual([60_000, 40_000])
    expect(getVtxos).toHaveBeenCalledTimes(2)
  })

  it('marks an output SPENT when only `spentBy` says so', async () => {
    // The wire contract permits `isSpent: false` beside a populated `spentBy`,
    // and `offerDepositFrom` filters on `isSpent` alone. Passing the raw flag
    // through would let a filled offer be decided against its own dead deposit.
    const getVtxos = vi.fn(async () => ({
      vtxos: [vtxo({ isSpent: false, spentBy: 'b'.repeat(64) })],
      page: { current: 0, total: 1 },
    }))
    const outputs = await offerOutputsAt(ctxWith(getVtxos), SCRIPT)
    expect(outputs[0]!.isSpent).toBe(true)
  })

  it('keeps a swept output flagged', async () => {
    const getVtxos = vi.fn(async () => ({
      vtxos: [vtxo({ isSwept: true })],
      page: { current: 0, total: 1 },
    }))
    expect((await offerOutputsAt(ctxWith(getVtxos), SCRIPT))[0]!.isSwept).toBe(true)
  })

  it('stops on an empty page rather than spinning against a misbehaving server', async () => {
    const getVtxos = vi.fn(async () => ({ vtxos: [], page: { current: 0, total: 99 } }))
    expect(await offerOutputsAt(ctxWith(getVtxos), SCRIPT)).toEqual([])
    expect(getVtxos).toHaveBeenCalledTimes(1)
  })
})
