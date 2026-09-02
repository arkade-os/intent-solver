import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SwapStore } from '@arkade-os/solver-corridors/db/swaps.js'
import { OnchainSendSwapStore } from '@arkade-os/solver-corridors/db/onchainSwaps.js'

let now = 1_000_000
const clock = () => now

/** Distinct payment hashes per id: the live-hash index is unique. */
const sendQuote = (id: string) => ({
  id,
  invoice: `lnbcrt1${id}`,
  paymentHash: `0${id}`.repeat(32).slice(0, 64),
  amountSats: 10_000,
  invoiceExpiresAt: now + 3600,
  refundLocktime: now + 7200,
  senderPubkey: 'bb'.repeat(32),
  receiverPubkey: 'cc'.repeat(32),
  serverPubkey: 'dd'.repeat(32),
  claimDelay: 512,
  refundDelay: 1024,
  refundWithoutReceiverDelay: 1536,
  pkScript: 'ee'.repeat(34),
  lockupAddress: 'tark1example',
  refundPkScript: 'ff'.repeat(34),
  emulatorPubkey: '11'.repeat(33),
  clientRefundPubkey: '22'.repeat(32),
  receiverPkScript: '33'.repeat(34),
  nonInteractiveParameters: true,
})

describe('SwapStore.page()', () => {
  let store: SwapStore

  beforeEach(async () => {
    now = 1_000_000
    store = await SwapStore.open(':memory:', clock)
  })

  afterEach(async () => {
    await store.close()
  })

  it('returns terminal swaps, which findRecoverable() cannot', async () => {
    await store.insertQuote(sendQuote('a'))
    await store.transition('a', 'quoted', 'refused', {})
    expect(await store.findRecoverable()).toHaveLength(0)
    const page = await store.page({})
    expect(page.rows.map((r) => r.id)).toEqual(['a'])
  })

  it('pages newest-first and walks the cursor without repeating rows', async () => {
    for (const id of ['a', 'b', 'c']) {
      await store.insertQuote(sendQuote(id))
      now += 10
    }
    const first = await store.page({ limit: 2 })
    expect(first.rows.map((r) => r.id)).toEqual(['c', 'b'])
    expect(first.nextCursor).not.toBeNull()
    const second = await store.page({ limit: 2, cursor: first.nextCursor })
    expect(second.rows.map((r) => r.id)).toEqual(['a'])
    expect(second.nextCursor).toBeNull()
  })

  it('filters by state', async () => {
    await store.insertQuote(sendQuote('a'))
    await store.insertQuote(sendQuote('b'))
    await store.transition('a', 'quoted', 'refused', {})
    const page = await store.page({ states: ['refused'] })
    expect(page.rows.map((r) => r.id)).toEqual(['a'])
  })

  it('rejects a non-positive limit rather than returning everything', async () => {
    await expect(store.page({ limit: -1 })).rejects.toThrow(/positive integer/)
  })
})

describe('OnchainSendSwapStore history + findByStates', () => {
  let store: OnchainSendSwapStore

  const onchainQuote = {
    id: 'swap-1',
    paymentHash: 'aa'.repeat(32),
    amountSats: 50_000,
    payoutSats: 49_500,
    refundLocktime: 1_003_600,
    providerPubkey: 'bb'.repeat(32),
    serverPubkey: 'cc'.repeat(32),
    claimDelay: 512,
    refundDelay: 1024,
    refundWithoutReceiverDelay: 1536,
    pkScript: 'dd'.repeat(34),
    lockupAddress: 'tark1example',
    refundPkScript: 'ee'.repeat(34),
    emulatorPubkey: 'ff'.repeat(33),
    clientRefundPubkey: '44'.repeat(32),
    receiverPkScript: '55'.repeat(34),
    payoutPubkey: '11'.repeat(32),
    htlcPubkey: '22'.repeat(32),
    htlcLocktime: 1_001_800,
    minConfirmations: 1,
    onchainAddress: 'bcrt1pexample',
    onchainPkScript: '33'.repeat(34),
    nonInteractiveParameters: true,
  }

  beforeEach(async () => {
    now = 1_000_000
    store = await OnchainSendSwapStore.open(':memory:', clock)
  })

  afterEach(async () => {
    await store.close()
  })

  it('reads the event trail transition() has been writing all along', async () => {
    await store.insertQuote(onchainQuote)
    await store.transition('swap-1', 'quoted', 'funded', {})
    // `detail` is null on a plain transition — it is non-null only on a NOTE, a
    // thing that happened TO the swap without moving it through the lifecycle.
    // Every store reports the field now: all four event tables have always
    // declared the column and written it, and only the Lightning-send store
    // used to read it back.
    expect(await store.history('swap-1')).toEqual([
      { at: 1_000_000, from: null, to: 'quoted', detail: null },
      { at: 1_000_000, from: 'quoted', to: 'funded', detail: null },
    ])
  })

  it('findByStates() narrows to the named states', async () => {
    await store.insertQuote(onchainQuote)
    await store.transition('swap-1', 'quoted', 'funded', {})
    expect((await store.findByStates(['funded'])).map((r) => r.id)).toEqual(['swap-1'])
    expect(await store.findByStates(['quoted'])).toHaveLength(0)
    expect(await store.findByStates([])).toHaveLength(0)
  })

  it('page() sees a terminal onchain swap', async () => {
    await store.insertQuote(onchainQuote)
    await store.transition('swap-1', 'quoted', 'refused', {})
    const page = await store.page({})
    expect(page.rows.map((r) => r.state)).toEqual(['refused'])
  })
})
