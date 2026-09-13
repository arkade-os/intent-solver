/**
 * The store guards that cost money when wrong.
 *
 * Mostly what a CRASH or a CONCURRENT TICK can do — the reason this state is on
 * disk at all — plus the two reads no other corridor has: a sats total that is
 * always zero, and an aggregate denominated in the asset's own atomic units.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  AssetEvmSendSwapStore,
  type AssetEvmSendQuoteRecord,
} from '@arkade-os/solver-corridors-evm/db/assetEvmSendSwaps.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'

const ASSET = '11'.repeat(32) + '0000'
const OTHER_ASSET = '22'.repeat(32) + '0000'
const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const NOW = 1_800_000_000

let store: AssetEvmSendSwapStore

const quote = (over: Partial<AssetEvmSendQuoteRecord> = {}): AssetEvmSendQuoteRecord => ({
  id: 'swap-1',
  paymentHash: 'aa'.repeat(32),
  assetId: ASSET,
  assetDecimals: 18,
  // Past 2^53 on purpose, in all three: an 18-decimal asset's atomic amount is
  // exactly why these columns are TEXT.
  assetUnits: '1000000000000000001',
  payoutUnits: '990000000000000001',
  evmAmount: '123456789012345678901234567890',
  tokenAddress: TOKEN,
  evmContractAddress: '0x1111111111111111111111111111111111111111',
  evmChainId: 8453,
  evmTimeout: 21_000_000,
  validUntil: NOW + 60,
  minConfirmations: 5,
  minAgeSeconds: 720,
  evmClaimAddress: '0x2222222222222222222222222222222222222222',
  evmRefundAddress: '0x3333333333333333333333333333333333333333',
  refundLocktime: NOW + 86_400,
  providerPubkey: 'bb'.repeat(32),
  serverPubkey: 'cc'.repeat(32),
  claimDelay: 512,
  refundDelay: 1024,
  refundWithoutReceiverDelay: 1536,
  pkScript: '5120' + 'dd'.repeat(32),
  lockupAddress: 'tark1lockup',
  refundPkScript: '5120' + 'ee'.repeat(32),
  emulatorPubkey: 'ff'.repeat(32),
  clientRefundPubkey: '11'.repeat(32),
  receiverPkScript: '5120' + '22'.repeat(32),
  nonInteractiveParameters: true,
  rfqId: 'rfq-1',
  ...over,
})

const second = (over: Partial<AssetEvmSendQuoteRecord> = {}): AssetEvmSendQuoteRecord =>
  quote({ id: 'swap-2', paymentHash: 'bb'.repeat(32), rfqId: 'rfq-2', ...over })

beforeEach(async () => {
  store = await AssetEvmSendSwapStore.open(betterSqliteDriver(':memory:'), () => NOW)
})
afterEach(async () => {
  await store.close()
})

describe('AssetEvmSendSwapStore amounts', () => {
  it('round-trips all three atomic amounts a number would round', async () => {
    const row = await store.insertQuote(quote())
    for (const read of [row, await store.get('swap-1')]) {
      expect(read.assetUnits).toBe('1000000000000000001')
      expect(read.payoutUnits).toBe('990000000000000001')
      expect(read.evmAmount).toBe('123456789012345678901234567890')
    }
  })

  it('stores the asset id in CANONICAL order, byte for byte', async () => {
    // The reversal `OP_INSPECTOUTASSETLOOKUP` needs happens once inside the
    // covenant builder. A second, reversed spelling on disk would compare
    // unequal to the wire's and to the registry's.
    const row = await store.insertQuote(quote())
    expect(row.assetId).toBe(ASSET)
    expect(row.assetDecimals).toBe(18)
  })

  it('round-trips nonInteractiveParameters through the real store, both ways', async () => {
    expect((await store.insertQuote(quote())).nonInteractiveParameters).toBe(true)
    expect((await store.insertQuote(second({ nonInteractiveParameters: false }))).nonInteractiveParameters).toBeNull()
  })
})

describe('the sats total this corridor cannot honestly report', () => {
  it('is zero in every state, so the house cap never counts an asset amount as sats', async () => {
    // Summing atomic units into `maxExposedSats` would add an asset amount to a
    // sats total; converting through the pair's price would make the cap depend
    // on the feed that priced the swap. Zero is the stated third answer.
    await store.insertQuote(quote())
    expect(await store.committedSats()).toBe(0)
    for (const [from, to] of [
      ['quoted', 'funded'],
      ['funded', 'locking_evm'],
      ['locking_evm', 'awaiting_claim'],
    ] as const) {
      await store.transition('swap-1', from, to)
      expect(await store.committedSats()).toBe(0)
    }
  })
})

describe('committedAssetUnits', () => {
  it('sums as bigints, so an 18-decimal total is exact', async () => {
    await store.insertQuote(quote())
    await store.insertQuote(second())
    expect((await store.committedAssetUnits()).get(ASSET)).toBe(2_000_000_000_000_000_002n)
  })

  it('counts a quoted row, and stops counting a terminal one', async () => {
    // A binding quote is a claim on the float: the client may fund any time
    // inside its window, so counting only money-committed states would let
    // unlimited concurrent quotes past the aggregate and all be filled at once.
    await store.insertQuote(quote())
    expect((await store.committedAssetUnits()).get(ASSET)).toBe(1_000_000_000_000_000_001n)
    await store.transition('swap-1', 'quoted', 'refunding_evm')
    expect((await store.committedAssetUnits()).get(ASSET)).toBe(1_000_000_000_000_000_001n)
    await store.transition('swap-1', 'refunding_evm', 'refunded')
    expect((await store.committedAssetUnits()).get(ASSET)).toBeUndefined()
  })

  it('keys by asset id, so one asset`s exposure never bounds another`s', async () => {
    await store.insertQuote(quote())
    await store.insertQuote(second({ assetId: OTHER_ASSET, assetUnits: '7' }))
    const totals = await store.committedAssetUnits()
    expect(totals.get(ASSET)).toBe(1_000_000_000_000_000_001n)
    expect(totals.get(OTHER_ASSET)).toBe(7n)
  })
})

describe('the guards a concurrent tick runs into', () => {
  it('refuses a second LIVE row on one payment hash', async () => {
    // Two lockups against one hash means whichever client loses the race is
    // claimed with no refund.
    await store.insertQuote(quote())
    await expect(store.insertQuote(second({ paymentHash: 'aa'.repeat(32) }))).rejects.toThrow()
  })

  it('lets a REFUSED row free the hash again', async () => {
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'refused')
    await expect(store.insertQuote(second({ paymentHash: 'aa'.repeat(32) }))).resolves.toBeTruthy()
  })

  it('will not let two ticks advance the same row', async () => {
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'funded')
    await expect(store.transition('swap-1', 'quoted', 'funded')).rejects.toThrow(/not in state quoted/)
  })

  it('records a refund txid only for the first claimant', async () => {
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'refunding_evm')
    expect(await store.claimRefundTxid('swap-1', 'first')).toBe(true)
    expect(await store.claimRefundTxid('swap-1', 'second')).toBe(false)
    expect((await store.get('swap-1')).evmRefundTxid, 'the second writer overwrote the first').toBe('first')
  })

  it.each([
    ['transition', () => store.transition('swap-1', 'quoted', 'funded', { evm_lock_txid_typo: '0xabc' })],
    ['patch', () => store.patch('swap-1', { asset_units: '1' })],
  ])('refuses a column %s does not know', async (_where, write) => {
    await store.insertQuote(quote())
    await expect(write()).rejects.toThrow(/unknown column/)
  })
})

describe('the reads a sweep and an operator depend on', () => {
  it('records every transition, so a stuck row can be read back', async () => {
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'funded')
    await store.fail('swap-1', 'funded', 'evm lock reverted')
    const row = await store.get('swap-1')
    expect(row.state).toBe('stuck')
    expect(row.failureReason).toBe('evm lock reverted')
    expect((await store.history('swap-1')).map((e) => e.to)).toEqual(['quoted', 'funded', 'stuck'])
  })

  it('finds a row by rfq id and by live payment hash', async () => {
    await store.insertQuote(quote())
    expect((await store.findByRfqId('rfq-1'))?.id).toBe('swap-1')
    expect(await store.findByRfqId('rfq-missing')).toBeNull()
    expect((await store.findLiveByPaymentHash('aa'.repeat(32)))?.id).toBe('swap-1')
    await store.transition('swap-1', 'quoted', 'refused')
    expect(await store.findLiveByPaymentHash('aa'.repeat(32))).toBeNull()
  })

  it('lists live rows for the sweep, and drops them at a terminal state', async () => {
    await store.insertQuote(quote())
    expect((await store.findLive()).map((r) => r.id)).toEqual(['swap-1'])
    await store.transition('swap-1', 'quoted', 'claimed')
    expect(await store.findLive()).toEqual([])
  })

  it('lists refused rows with an unresolved lockup for the refund sweep', async () => {
    await store.insertQuote(quote())
    expect(await store.findRefundable()).toEqual([])

    await store.transition('swap-1', 'quoted', 'refused')
    expect((await store.findRefundable()).map((r) => r.id)).toEqual(['swap-1'])

    // Resolved either way — pushed by us, or spent externally — it is not
    // listed again.
    await store.patch('swap-1', { refund_outcome: 'pushed', refund_ark_txid: 'ark-txid' })
    expect(await store.findRefundable()).toEqual([])

    await store.insertQuote(second())
    await store.transition('swap-2', 'quoted', 'refused')
    await store.patch('swap-2', { refund_outcome: 'external' })
    expect(await store.findRefundable()).toEqual([])
  })
})
