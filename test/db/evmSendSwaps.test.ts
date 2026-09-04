/**
 * The store guards that cost money when wrong.
 *
 * Everything here is about what a CRASH or a CONCURRENT TICK can do, because
 * that is the only reason this table exists rather than in-memory state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EvmSendSwapStore, type EvmSendQuoteRecord } from '@arkade-os/solver-corridors-evm/db/evmSendSwaps.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'

const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
let store: EvmSendSwapStore
let now = 1_800_000_000

const quote = (over: Partial<EvmSendQuoteRecord> = {}): EvmSendQuoteRecord => ({
  id: 'swap-1',
  paymentHash: 'aa'.repeat(32),
  amountSats: 50_000,
  payoutSats: 49_500,
  // Deliberately past 2^53: an ERC20 amount is 256-bit, and a store that
  // round-trips this as a number silently rounds a payout.
  evmAmount: '123456789012345678901234567890',
  tokenAddress: TOKEN,
  evmContractAddress: '0x1111111111111111111111111111111111111111',
  evmChainId: 8453,
  evmTimeout: 21_000_000,
  validUntil: 1_800_000_060,
  minConfirmations: 5,
  minAgeSeconds: 720,
  evmClaimAddress: '0x2222222222222222222222222222222222222222',
  evmRefundAddress: '0x3333333333333333333333333333333333333333',
  refundLocktime: 1_800_090_000,
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

beforeEach(async () => {
  store = await EvmSendSwapStore.open(betterSqliteDriver(':memory:'), () => now)
})
afterEach(async () => {
  await store.close()
})

describe('EvmSendSwapStore', () => {
  it('round-trips an ERC20 amount that a number would round', async () => {
    const row = await store.insertQuote(quote())
    expect(row.evmAmount).toBe('123456789012345678901234567890')
    expect((await store.get('swap-1')).evmAmount).toBe('123456789012345678901234567890')
  })

  it('round-trips nonInteractiveParameters through the real store, both ways', async () => {
    // The same encode/decode path ('1'/null on the wire, boolean|null in the
    // row) the other corridors assert — an inconsistency here is a silent
    // address divergence for this corridor alone.
    const on = await store.insertQuote(quote())
    expect(on.nonInteractiveParameters).toBe(true)

    const off = await store.insertQuote(
      quote({ id: 'swap-2', rfqId: 'rfq-2', paymentHash: 'ab'.repeat(32), nonInteractiveParameters: false }),
    )
    expect(off.nonInteractiveParameters).toBeNull()
  })

  it('refuses a second LIVE row on one payment hash', async () => {
    // Two lockups against one hash means whichever client loses the race is
    // claimed with no refund.
    await store.insertQuote(quote())
    await expect(store.insertQuote(quote({ id: 'swap-2', rfqId: 'rfq-2' }))).rejects.toThrow()
  })

  it('lets a REFUSED row free the hash again', async () => {
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'refused')
    await expect(store.insertQuote(quote({ id: 'swap-2', rfqId: 'rfq-2' }))).resolves.toBeTruthy()
  })

  it('counts every non-terminal state against the cap, quotes included', async () => {
    // A quoted row is a claim on the float at a fixed rate: the quote is
    // binding and the client can fund any time inside its window. Counting
    // only money-committed states would let unlimited concurrent quotes slip
    // past the cap and all be paid at once — the invariant the Lightning
    // store states on its own committedSats.
    await store.insertQuote(quote())
    expect(await store.committedSats()).toBe(50_000)
    await store.transition('swap-1', 'quoted', 'funded')
    expect(await store.committedSats()).toBe(50_000)
    await store.transition('swap-1', 'funded', 'locking_evm')
    expect(await store.committedSats()).toBe(50_000)
    await store.transition('swap-1', 'locking_evm', 'refunding_evm')
    expect(await store.committedSats()).toBe(50_000)
    await store.transition('swap-1', 'refunding_evm', 'refunded')
    expect(await store.committedSats()).toBe(0)
  })

  it('will not let two ticks advance the same row', async () => {
    // The from-state guard is the whole point: a second tick that read the same
    // state is TOLD it lost, rather than silently doing nothing.
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'funded')
    await expect(store.transition('swap-1', 'quoted', 'funded')).rejects.toThrow(/not in state quoted/)
  })

  it('refuses to write a column it does not know', async () => {
    await store.insertQuote(quote())
    await expect(store.transition('swap-1', 'quoted', 'funded', { evm_lock_txid_typo: '0xabc' })).rejects.toThrow(
      /unknown column/,
    )
  })

  it('records every transition, so a stuck row can be read back', async () => {
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'funded')
    await store.fail('swap-1', 'funded', 'evm lock reverted')
    const row = await store.get('swap-1')
    expect(row.state).toBe('stuck')
    expect(row.failureReason).toBe('evm lock reverted')
    expect((await store.history('swap-1')).map((e) => e.to)).toEqual(['quoted', 'funded', 'stuck'])
  })

  it('finds a row by rfq id, which every status request falls through', async () => {
    await store.insertQuote(quote())
    expect((await store.findByRfqId('rfq-1'))?.id).toBe('swap-1')
    expect(await store.findByRfqId('rfq-missing')).toBeNull()
  })

  it('round-trips the quote window and the refund outcome', async () => {
    const row = await store.insertQuote(quote())
    expect(row.validUntil).toBe(1_800_000_060)
    expect(row.refundOutcome).toBeNull()
  })

  it('lists refused rows with an unresolved lockup for the refund sweep', async () => {
    await store.insertQuote(quote())
    // Live row: nothing to refund.
    expect(await store.findRefundable()).toEqual([])

    await store.transition('swap-1', 'quoted', 'refused')
    expect((await store.findRefundable()).map((r) => r.id)).toEqual(['swap-1'])

    // Resolved either way — pushed by us, or spent externally — it is not
    // listed again.
    await store.patch('swap-1', { refund_outcome: 'pushed', refund_ark_txid: 'ark-txid' })
    expect(await store.findRefundable()).toEqual([])

    await store.insertQuote(quote({ id: 'swap-2', paymentHash: 'bb'.repeat(32), rfqId: 'rfq-2' }))
    await store.transition('swap-2', 'quoted', 'refused')
    await store.patch('swap-2', { refund_outcome: 'external' })
    expect(await store.findRefundable()).toEqual([])
  })

  it('records a refund txid only for the first claimant', async () => {
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'refunding_evm')

    expect(await store.claimRefundTxid('swap-1', 'first')).toBe(true)
    expect(await store.claimRefundTxid('swap-1', 'second')).toBe(false)
    expect((await store.get('swap-1')).evmRefundTxid, 'the second writer overwrote the first').toBe('first')
  })
})
