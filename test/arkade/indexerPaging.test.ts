/** The paging loop the four indexer reads share, against a server that does not honour `pageIndex`. */
import { describe, it, expect, vi } from 'vitest'
import { IndexerPagingError } from '@arkade-os/solver-arkade/arkade/indexerPaging.js'
import { liveOfferOutpoints } from '@arkade-os/solver-arkade/arkade/offerOutpoints.js'
import { offerOutputsAt } from '@arkade-os/solver-arkade/arkade/offerOutputs.js'
import { findLockupOutpoints, findLockups, type ArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'

const SCRIPT = '5120' + 'ab'.repeat(32)

const vtxo = (over: Record<string, unknown> = {}) => ({
  txid: 'a'.repeat(64),
  vout: 0,
  script: SCRIPT,
  value: 5_000,
  isSpent: false,
  spentBy: '',
  settledBy: '',
  isSwept: false,
  ...over,
})

const ctxWith = (getVtxos: unknown): ArkadeContext =>
  ({ wallet: { indexerProvider: { getVtxos } } }) as unknown as ArkadeContext

const READS: { name: string; read: (ctx: ArkadeContext) => Promise<readonly unknown[]> }[] = [
  { name: 'findLockups', read: (ctx) => findLockups(ctx, SCRIPT) },
  { name: 'findLockupOutpoints', read: (ctx) => findLockupOutpoints(ctx, SCRIPT) },
  { name: 'offerOutputsAt', read: (ctx) => offerOutputsAt(ctx, SCRIPT) },
  { name: 'liveOfferOutpoints', read: (ctx) => liveOfferOutpoints(ctx, SCRIPT) },
]

/** A call budget, not a timeout: an unbounded loop has to fail as a breach, not as a slow suite. */
const budgeted = (respond: (pageIndex: number) => unknown, budget = 25) => {
  let calls = 0
  return vi.fn(async ({ pageIndex }: { pageIndex: number }) => {
    if (++calls > budget) throw new Error(`indexer called ${calls} times: the paging loop never stopped`)
    return respond(pageIndex)
  })
}

/** `arkd`'s own `paginate`: page numbers are 1-based, and a requested 0 is clamped up to 1. */
const arkdPaging = (rows: readonly unknown[], pageSize: number) =>
  budgeted((pageIndex) => {
    const num = Math.max(pageIndex, 1)
    const total = Math.ceil(rows.length / pageSize)
    return {
      vtxos: rows.slice((num - 1) * pageSize, num * pageSize),
      page: { current: num, next: num < total ? num + 1 : total, total },
    }
  })

describe.each(READS)('$name', ({ read }) => {
  it('stops when the indexer repeats the page it was asked to move past', async () => {
    const getVtxos = budgeted(() => ({ vtxos: [vtxo()], page: { current: 0, total: 99 } }))
    await expect(read(ctxWith(getVtxos))).rejects.toBeInstanceOf(IndexerPagingError)
    expect(getVtxos).toHaveBeenCalledTimes(1)
  })

  it('stops when the indexer names a next page it has already served', async () => {
    const getVtxos = budgeted(() => ({ vtxos: [vtxo()], page: { current: 0, next: 1, total: 99 } }))
    await expect(read(ctxWith(getVtxos))).rejects.toBeInstanceOf(IndexerPagingError)
    expect(getVtxos).toHaveBeenCalledTimes(2)
  })

  it('reads the last page of a three-page script', async () => {
    const getVtxos = arkdPaging(
      [0, 1, 2, 3, 4].map((vout) => vtxo({ vout })),
      2,
    )
    await expect(read(ctxWith(getVtxos))).resolves.toHaveLength(5)
    expect(getVtxos).toHaveBeenCalledTimes(3)
  })
})

describe('vtxoPages', () => {
  it('gives up on a server that keeps advancing and never ends', async () => {
    const getVtxos = budgeted(
      (pageIndex) => ({ vtxos: [vtxo()], page: { current: pageIndex + 1, next: pageIndex + 1, total: 1_000_000 } }),
      2_000,
    )
    await expect(findLockups(ctxWith(getVtxos), SCRIPT)).rejects.toBeInstanceOf(IndexerPagingError)
    expect(getVtxos).toHaveBeenCalledTimes(1_000)
  })
})
