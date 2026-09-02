import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { OfferFillStore, NON_TERMINAL, type OfferFillState } from '@arkade-os/solver-corridors/db/offerFills.js'

let now = 1_800_000_000
const clock = () => now

let store: OfferFillStore

const baseIntent = {
  id: 'fill-1',
  offerTxid: 'aa'.repeat(32),
  offerVout: 0,
  offerPkScript: '66'.repeat(34),
  // The client wants an asset; this service pays it out of the float.
  wantAssetId: '41bcbb06921a0e9f6fe4f1b003b878cbb43d9ca3f6d14cab7940090458765a390000',
  wantAmount: 2_000n,
  // The offer holds BTC, which this service receives by filling it.
  offerAssetId: null,
  offerAmount: 50_000n,
}

beforeEach(async () => {
  now = 1_800_000_000
  store = await OfferFillStore.open(':memory:', clock)
})

afterEach(async () => {
  await store.close()
})

describe('OfferFillStore', () => {
  it('insertIntent() persists a fillable row before anything is submitted', async () => {
    const row = await store.insertIntent(baseIntent)
    expect(row.state).toBe('fillable')
    // The point of the row existing this early: nothing is on chain yet.
    expect(row.fillTxid).toBeNull()
    expect(row.createdAt).toBe(now)
  })

  it('round-trips amounts as bigint, not number', async () => {
    // Amounts are atomic units and can exceed Number.MAX_SAFE_INTEGER. Stored
    // as TEXT for that reason, so the type must survive the trip intact — a
    // column typed INTEGER would silently mangle this value.
    const huge = 9_007_199_254_740_993n // 2^53 + 1: not representable as a double
    const row = await store.insertIntent({ ...baseIntent, offerAmount: huge })
    const read = await store.findById(row.id)
    expect(read?.offerAmount).toBe(huge)
    expect(typeof read?.offerAmount).toBe('bigint')
  })

  it('keeps a BTC leg as null rather than a sentinel asset id', async () => {
    // Same distinction `core/assetOffer.ts` draws: the packet OMITS the asset
    // for BTC, and a sentinel string would make a BTC leg look like an asset.
    const row = await store.insertIntent(baseIntent)
    expect(row.offerAssetId).toBeNull()
    expect(row.wantAssetId).toBe(baseIntent.wantAssetId)
  })
})

describe('OfferFillStore: the outpoint guard', () => {
  it('refuses a second live row for the same offer outpoint', async () => {
    // Two workers that both like one offer must not both submit `fulfill`.
    // The loser must fail here, BEFORE either spends.
    await store.insertIntent(baseIntent)
    // Matched on the constraint, not a bare toThrow: a bare one would pass on a
    // typo in the test's own setup and prove nothing about the index.
    await expect(store.insertIntent({ ...baseIntent, id: 'fill-2' })).rejects.toThrow(/UNIQUE constraint failed/)
  })

  it('allows a different vout of the same transaction', async () => {
    // The guard is per OUTPOINT, not per transaction: one funding tx can carry
    // more than one offer output, and they are unrelated contracts.
    await store.insertIntent(baseIntent)
    const second = await store.insertIntent({ ...baseIntent, id: 'fill-2', offerVout: 1 })
    expect(second.state).toBe('fillable')
  })

  it('allows a re-attempt once the earlier row is terminal and did NOT fill', async () => {
    // A `lost` row is not a claim on the outpoint. If the offer somehow reads
    // as fillable again, nothing here should stand in the way.
    const first = await store.insertIntent(baseIntent)
    await store.transition(first.id, 'fillable', 'lost')
    const retry = await store.insertIntent({ ...baseIntent, id: 'fill-2' })
    expect(retry.state).toBe('fillable')
  })

  it('does NOT allow a re-attempt once a fill succeeded', async () => {
    // `filled` stays in the guard: the output is spent, and a second row for it
    // would describe a spend that cannot happen. This is the case where the
    // partial index earns its WHERE clause rather than being a plain unique.
    const first = await store.insertIntent(baseIntent)
    await store.transition(first.id, 'fillable', 'filling', { fill_txid: 'bb'.repeat(32) })
    await store.transition(first.id, 'filling', 'filled')
    await expect(store.insertIntent({ ...baseIntent, id: 'fill-2' })).rejects.toThrow(/UNIQUE constraint failed/)
  })

  it('findLiveByOutpoint() finds the live row and ignores a dead one', async () => {
    const first = await store.insertIntent(baseIntent)
    await store.transition(first.id, 'fillable', 'lost')
    expect(await store.findLiveByOutpoint(baseIntent.offerTxid, baseIntent.offerVout)).toBeUndefined()

    const second = await store.insertIntent({ ...baseIntent, id: 'fill-2' })
    const live = await store.findLiveByOutpoint(baseIntent.offerTxid, baseIntent.offerVout)
    expect(live?.id).toBe(second.id)
  })
})

describe('OfferFillStore: the lifecycle', () => {
  it('walks the happy path and records the fill txid', async () => {
    const row = await store.insertIntent(baseIntent)
    const txid = 'bb'.repeat(32)
    expect(await store.transition(row.id, 'fillable', 'filling', { fill_txid: txid })).toBe(true)
    expect(await store.transition(row.id, 'filling', 'filled')).toBe(true)
    const done = await store.findById(row.id)
    expect(done?.state).toBe('filled')
    expect(done?.fillTxid).toBe(txid)
  })

  it.each<[OfferFillState, OfferFillState]>([
    ['fillable', 'filled'],
    ['fillable', 'stuck'],
    ['filling', 'refused'],
    ['filled', 'lost'],
    ['lost', 'filling'],
    ['refused', 'filling'],
    ['stuck', 'filled'],
  ])('refuses the illegal edge %s -> %s', async (from, to) => {
    const row = await store.insertIntent(baseIntent)
    await expect(store.transition(row.id, from, to)).rejects.toThrow(/illegal transition/)
  })

  it('is a compare-and-swap, so two ticks racing one row cannot both win', async () => {
    const row = await store.insertIntent(baseIntent)
    expect(await store.transition(row.id, 'fillable', 'filling')).toBe(true)
    // The second caller read `fillable` before the first won. It must be told
    // it lost rather than overwrite a row that has already moved.
    expect(await store.transition(row.id, 'fillable', 'filling')).toBe(false)
    expect((await store.findById(row.id))?.state).toBe('filling')
  })

  it('refuses to set a column that is not a transition column', async () => {
    // The offer's identity is fixed at insert: the covenant is derived from it,
    // so a row that could edit it could describe a contract nobody funded.
    const row = await store.insertIntent(baseIntent)
    await expect(store.transition(row.id, 'fillable', 'filling', { want_amount: '1' })).rejects.toThrow(
      /may not set column/,
    )
    await expect(store.transition(row.id, 'fillable', 'filling', { offer_pk_script: 'ff' })).rejects.toThrow(
      /may not set column/,
    )
  })

  it('fail() refuses a row that never submitted and sticks one that did', async () => {
    // The distinction that matters to an operator: a `refused` row spent
    // nothing and needs nobody, a `stuck` row submitted a fulfill whose outcome
    // is unresolved.
    const never = await store.insertIntent(baseIntent)
    await store.fail(never.id, 'fillable', 'inventory could not cover the want')
    expect((await store.findById(never.id))?.state).toBe('refused')

    const submitted = await store.insertIntent({ ...baseIntent, id: 'fill-2', offerVout: 1 })
    await store.transition(submitted.id, 'fillable', 'filling')
    await store.fail(submitted.id, 'filling', 'spend classified as indeterminate')
    const stuck = await store.findById(submitted.id)
    expect(stuck?.state).toBe('stuck')
    expect(stuck?.failureReason).toBe('spend classified as indeterminate')
  })
})

describe('OfferFillStore: queries', () => {
  it('listNonTerminal() returns exactly the states a tick must resolve', async () => {
    const fillable = await store.insertIntent(baseIntent)
    const filling = await store.insertIntent({ ...baseIntent, id: 'fill-2', offerVout: 1 })
    await store.transition(filling.id, 'fillable', 'filling')
    const done = await store.insertIntent({ ...baseIntent, id: 'fill-3', offerVout: 2 })
    await store.transition(done.id, 'fillable', 'lost')

    const live = await store.listNonTerminal()
    expect(live.map((r) => r.id).sort()).toEqual([fillable.id, filling.id].sort())
    // Pinned against the exported set, so a state added to one and not the
    // other cannot pass.
    for (const row of live) expect(NON_TERMINAL).toContain(row.state)
  })

  it('findByRfqId() correlates a fill with the request that asked for it', async () => {
    const row = await store.insertIntent({ ...baseIntent, rfqId: 'rfq-abc' })
    expect((await store.findByRfqId('rfq-abc'))?.id).toBe(row.id)
    expect(await store.findByRfqId('rfq-nope')).toBeUndefined()
  })

  it('findByRfqId() returns the LIVE re-attempt, not the dead row it shares an id with', async () => {
    // `rfq_id` is not unique, and the partial outpoint index deliberately admits
    // a re-attempt after a `lost` row — which carries the same RFQ id. Without
    // an ORDER BY, SQLite returns whichever row it likes, and a caller asking
    // "is this RFQ still being worked?" gets the corpse and answers no.
    const dead = await store.insertIntent({ ...baseIntent, rfqId: 'rfq-abc' })
    await store.transition(dead.id, 'fillable', 'lost')
    now += 1
    const live = await store.insertIntent({ ...baseIntent, id: 'fill-2', rfqId: 'rfq-abc' })

    const found = await store.findByRfqId('rfq-abc')
    expect(found?.id).toBe(live.id)
    expect(found?.state).toBe('fillable')
  })

  it('findByRfqId() stays deterministic when both rows land in the SAME second', async () => {
    // No clock advance, so `created_at` ties and `ORDER BY created_at DESC`
    // alone leaves an unordered pair — the same nondeterminism the ordering
    // exists to remove, in a narrower window. `rowid DESC` breaks it toward the
    // later insert, which is the live one.
    const dead = await store.insertIntent({ ...baseIntent, rfqId: 'rfq-same-second' })
    await store.transition(dead.id, 'fillable', 'lost')
    const live = await store.insertIntent({ ...baseIntent, id: 'fill-2', rfqId: 'rfq-same-second' })
    expect(live.createdAt).toBe(dead.createdAt)

    expect((await store.findByRfqId('rfq-same-second'))?.id).toBe(live.id)
  })

  it('fail() refuses a terminal row with a message about the call, not the graph', async () => {
    const row = await store.insertIntent(baseIntent)
    await store.transition(row.id, 'fillable', 'lost')
    await expect(store.fail(row.id, 'lost', 'too late')).rejects.toThrow(/terminal, so there is nothing left to fail/)
  })

  it('page() returns rows newest-first with a cursor', async () => {
    for (let i = 0; i < 3; i++) {
      now += 1
      await store.insertIntent({ ...baseIntent, id: `fill-${i}`, offerVout: i })
    }
    const { rows } = await store.page({ limit: 2 })
    expect(rows).toHaveLength(2)
  })
})
