/**
 * The read half of `onchain:BTC->arkade:<asset>`, with two markets in one table.
 * The money path is covered in `test/receive/onchainAssetOrchestrator.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  OnchainAssetReceiveSwapStore,
  type OnchainAssetReceiveQuoteRecord,
} from '@arkade-os/solver-corridors/db/onchainAssetReceiveSwaps.js'
import {
  onchainAssetReceiveDescriptor,
  onchainAssetReceiveReader,
} from '@arkade-os/solver-corridors/corridors/onchainAssetReceive.js'

const ASSET_A = `${'aa'.repeat(32)}0100`
const ASSET_B = `${'bb'.repeat(32)}0100`
const USDA = onchainAssetReceiveDescriptor({ symbol: 'USDA', assetId: ASSET_A })
const EURA = onchainAssetReceiveDescriptor({ symbol: 'EURA', assetId: ASSET_B })

let store: OnchainAssetReceiveSwapStore

const quote = (id: string, pair: string, assetId: string): OnchainAssetReceiveQuoteRecord => ({
  id,
  pair,
  paymentHash: id.padEnd(64, '0'),
  amountSats: 50_000,
  payoutUnits: 250_000n,
  payoutAssetId: assetId,
  payoutDecimals: 6,
  lockupSats: 330,
  htlcLocktime: 1_801_800,
  refundLocktime: 1_800_900,
  minConfirmations: 1,
  providerPubkey: 'bb'.repeat(32),
  clientPayoutPubkey: 'dd'.repeat(32),
  serverPubkey: 'cc'.repeat(32),
  claimDelay: 512,
  refundDelay: 1024,
  refundWithoutReceiverDelay: 1536,
  emulatorPubkey: 'ff'.repeat(33),
  pkScript: 'dd'.repeat(34),
  lockupAddress: `tark1${id}`,
  refundPkScript: 'ee'.repeat(34),
  clientPayoutPkScript: '77'.repeat(34),
  nonInteractiveParameters: true,
  htlcPubkey: '22'.repeat(32),
  clientOnchainRefundPubkey: '11'.repeat(32),
  onchainAddress: `bcrt1p${id}`,
  onchainPkScript: '33'.repeat(34),
  claimPacket: Buffer.from('sealed-packet').toString('base64'),
})

beforeEach(async () => {
  store = await OnchainAssetReceiveSwapStore.open(':memory:', () => 1_000_000)
})

afterEach(async () => {
  await store.close()
})

describe('onchainAssetReceiveReader', () => {
  beforeEach(async () => {
    await store.insertQuote(quote('usda-1', USDA.pair, ASSET_A))
    await store.insertQuote(quote('eura-1', EURA.pair, ASSET_B))
    await store.insertQuote(quote('usda-2', USDA.pair, ASSET_A))
  })

  it('pages its own market and no other', async () => {
    const usda = await onchainAssetReceiveReader(USDA, store).page({})
    const eura = await onchainAssetReceiveReader(EURA, store).page({})
    expect(usda.swaps.map((s) => s.id)).toEqual(['usda-2', 'usda-1'])
    expect(eura.swaps.map((s) => s.id)).toEqual(['eura-1'])
  })

  it('fills a page from its own rows when the other market interleaves them', async () => {
    const reader = onchainAssetReceiveReader(USDA, store)
    expect((await reader.page({ limit: 2 })).swaps.map((s) => s.id)).toEqual(['usda-2', 'usda-1'])
  })

  it('hands back a cursor that ends only when this market is exhausted', async () => {
    const reader = onchainAssetReceiveReader(USDA, store)
    // Stopping the way any client does: on an empty page.
    const seen: string[] = []
    let cursor: string | null = null
    for (;;) {
      const page = await reader.page({ limit: 1, cursor })
      if (page.swaps.length === 0) break
      seen.push(...page.swaps.map((s) => s.id))
      cursor = page.nextCursor
      if (cursor === null) break
    }
    expect(seen).toEqual(['usda-2', 'usda-1'])
  })

  it('narrows by state and market together', async () => {
    const reader = onchainAssetReceiveReader(USDA, store)
    await store.fail('usda-2', 'quoted', 'operator halted the market')
    expect((await reader.page({ states: ['refused'] })).swaps.map((s) => s.id)).toEqual(['usda-2'])
    expect((await onchainAssetReceiveReader(EURA, store).page({ states: ['refused'] })).swaps).toEqual([])
  })
})
