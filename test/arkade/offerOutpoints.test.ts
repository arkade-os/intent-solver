/**
 * The read behind `AssetRfqDeps.depositAt`, and the one behind the settle.
 *
 * `offerOutputsAt` answers HOW MUCH is at a script; a fill spends one input, so
 * this answers WHICH outpoint. Both failures are silent: a paged answer read as
 * complete can hide the deposit entirely, and a spent output read as live makes
 * a filled negotiation look fundable again.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  heldOnOutpoint,
  largestOfferOutpoint,
  liveOfferOutpoints,
} from '@arkade-os/solver-arkade/arkade/offerOutpoints.js'
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

const outpoint = (over: Partial<{ txid: string; vout: number; sats: bigint }> = {}) => ({
  txid: 'a'.repeat(64),
  vout: 0,
  sats: 5_000n,
  assets: [],
  ...over,
})

describe('liveOfferOutpoints', () => {
  it('asks the indexer for that script and carries the outpoint through', async () => {
    const getVtxos = vi.fn(async () => ({
      vtxos: [vtxo({ vout: 2, assets: [{ assetId: USD, amount: 900n }] })],
      page: { current: 0, total: 1 },
    }))
    const live = await liveOfferOutpoints(ctxWith(getVtxos), SCRIPT)

    expect(getVtxos).toHaveBeenCalledWith(expect.objectContaining({ scripts: [SCRIPT] }))
    expect(live).toEqual([{ txid: 'a'.repeat(64), vout: 2, sats: 5_000n, assets: [{ assetId: USD, amount: 900n }] }])
  })

  it('normalises a string asset amount, which the wallet view reports', async () => {
    // 256-bit amounts: the string spelling must never reach a `number`.
    const big = '115792089237316195423570985008687907853269984665640564039457584007913129639935'
    const getVtxos = vi.fn(async () => ({
      vtxos: [vtxo({ assets: [{ assetId: USD, amount: big }] })],
      page: { current: 0, total: 1 },
    }))
    expect((await liveOfferOutpoints(ctxWith(getVtxos), SCRIPT))[0]!.assets[0]!.amount).toBe(BigInt(big))
  })

  it('drops an output spent only according to `spentBy`', async () => {
    // The wire contract permits `isSpent: false` beside a populated `spentBy`.
    // Kept, this outpoint would be handed to `fulfill` as the deposit to spend.
    const getVtxos = vi.fn(async () => ({
      vtxos: [vtxo({ isSpent: false, spentBy: 'b'.repeat(64) })],
      page: { current: 0, total: 1 },
    }))
    expect(await liveOfferOutpoints(ctxWith(getVtxos), SCRIPT)).toEqual([])
  })

  it('drops a swept output', async () => {
    const getVtxos = vi.fn(async () => ({ vtxos: [vtxo({ isSwept: true })], page: { current: 0, total: 1 } }))
    expect(await liveOfferOutpoints(ctxWith(getVtxos), SCRIPT)).toEqual([])
  })

  it('reads every page, so the funded outpoint is not missed on page two', async () => {
    const getVtxos = vi
      .fn()
      .mockResolvedValueOnce({ vtxos: [vtxo({ value: 300 })], page: { current: 0, total: 2 } })
      .mockResolvedValueOnce({ vtxos: [vtxo({ value: 40_000, vout: 1 })], page: { current: 1, total: 2 } })
    const live = await liveOfferOutpoints(ctxWith(getVtxos), SCRIPT)
    expect(live.map((o) => o.sats)).toEqual([300n, 40_000n])
    expect(getVtxos).toHaveBeenCalledTimes(2)
  })

  it('stops on an empty page rather than spinning against a misbehaving server', async () => {
    const getVtxos = vi.fn(async () => ({ vtxos: [], page: { current: 0, total: 99 } }))
    expect(await liveOfferOutpoints(ctxWith(getVtxos), SCRIPT)).toEqual([])
    expect(getVtxos).toHaveBeenCalledTimes(1)
  })
})

describe('largestOfferOutpoint', () => {
  const USDA = '11'.repeat(34)
  const carrying = (vout: number, amount: bigint) => outpoint({ vout, sats: 330n, assets: [{ assetId: USDA, amount }] })

  it('is null when nothing is funded, which is how a quote waits', () => {
    expect(largestOfferOutpoint([], null)).toBeNull()
  })

  it('takes the largest rather than the first, for a BTC deposit', () => {
    // Identical terms compile to one address, so an earlier negotiation's dust
    // can sit beside this deposit; taking the first would report it funded short.
    const dust = outpoint({ vout: 0, sats: 330n })
    const real = outpoint({ vout: 1, sats: 20_000n })
    expect(largestOfferOutpoint([dust, real], null)).toBe(real)
    expect(largestOfferOutpoint([real, dust], null)).toBe(real)
  })

  it('ranks an ASSET deposit by the asset, not by the carrier it rides', () => {
    // Both carriers are dust, so sats tie and the indexer's order would decide.
    // A stale carrier holding a nonzero-but-short amount passes the
    // orchestrator's `> 0` funding check, is recorded on the row, and sticks it
    // at settle — with the right outpoint sitting beside it the whole time.
    const stale = carrying(0, 1n)
    const live = carrying(1, 500n)
    expect(largestOfferOutpoint([stale, live], USDA)).toBe(live)
    expect(largestOfferOutpoint([live, stale], USDA)).toBe(live)
  })

  it('falls back to sats when the leg ties', () => {
    const small = carrying(0, 500n)
    const big = { ...carrying(1, 500n), sats: 20_000n }
    expect(largestOfferOutpoint([small, big], USDA)).toBe(big)
  })

  it('ignores an outpoint carrying a different asset entirely', () => {
    const other = outpoint({ vout: 0, sats: 20_000n, assets: [{ assetId: '22'.repeat(34), amount: 10n ** 9n }] })
    const mine = carrying(1, 5n)
    expect(largestOfferOutpoint([other, mine], USDA)).toBe(mine)
  })
})

describe('heldOnOutpoint', () => {
  it('reads sats for the BTC leg', () => {
    expect(heldOnOutpoint(outpoint({ sats: 7n }), null)).toBe(7n)
  })

  it('sums an asset across entries rather than taking the first', () => {
    const held = {
      ...outpoint(),
      assets: [
        { assetId: USD, amount: 4n },
        { assetId: USD, amount: 6n },
      ],
    }
    expect(heldOnOutpoint(held, USD)).toBe(10n)
  })

  it('reads zero for an asset the outpoint does not carry', () => {
    expect(heldOnOutpoint(outpoint(), USD)).toBe(0n)
  })
})
