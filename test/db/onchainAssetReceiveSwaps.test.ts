import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  OnchainAssetReceiveSwapStore,
  type OnchainAssetReceiveQuoteRecord,
} from '@arkade-os/solver-corridors/db/onchainAssetReceiveSwaps.js'

let now = 1_000_000
const clock = () => now
let store: OnchainAssetReceiveSwapStore

const ASSET = 'ab'.repeat(32) + '0100'
const PAIR = `onchain:BTC->arkade:${ASSET}`

const baseQuote: OnchainAssetReceiveQuoteRecord = {
  id: 'swap-1',
  pair: PAIR,
  paymentHash: 'aa'.repeat(32),
  amountSats: 50_000,
  payoutUnits: 250_000n,
  payoutAssetId: ASSET,
  payoutDecimals: 6,
  lockupSats: 330,
  htlcLocktime: now + 1800,
  refundLocktime: now + 900,
  minConfirmations: 1,
  providerPubkey: 'bb'.repeat(32),
  clientPayoutPubkey: 'dd'.repeat(32),
  serverPubkey: 'cc'.repeat(32),
  claimDelay: 512,
  refundDelay: 1024,
  refundWithoutReceiverDelay: 1536,
  emulatorPubkey: 'ff'.repeat(33),
  pkScript: 'dd'.repeat(34),
  lockupAddress: 'tark1example',
  refundPkScript: 'ee'.repeat(34),
  clientPayoutPkScript: '77'.repeat(34),
  nonInteractiveParameters: true,
  htlcPubkey: '22'.repeat(32),
  clientOnchainRefundPubkey: '11'.repeat(32),
  onchainAddress: 'bcrt1pexample',
  onchainPkScript: '33'.repeat(34),
  claimPacket: Buffer.from('sealed-packet').toString('base64'),
}

beforeEach(async () => {
  now = 1_000_000
  store = await OnchainAssetReceiveSwapStore.open(':memory:', clock)
})

afterEach(async () => {
  await store.close()
})

describe('OnchainAssetReceiveSwapStore', () => {
  it('persists a quoted row with its asset payout', async () => {
    const row = await store.insertQuote(baseQuote)
    expect(row.state).toBe('quoted')
    expect(row.payoutUnits).toBe(250_000n)
    expect(row.payoutAssetId).toBe(ASSET)
    expect(row.payoutDecimals).toBe(6)
    expect(row.lockupSats).toBe(330)
    expect(row.preimage).toBeNull()
  })

  it('round-trips a payout past what a double holds exactly', async () => {
    // The reason the column is TEXT. An 18-decimal amount is well past
    // Number.MAX_SAFE_INTEGER, and a lossy round trip here moves money.
    const huge = 123_456_789_012_345_678_901_234_567_890n
    const row = await store.insertQuote({ ...baseQuote, payoutUnits: huge })
    expect(row.payoutUnits).toBe(huge)
    expect((await store.get('swap-1')).payoutUnits).toBe(huge)
  })

  it('rejects a duplicate live payment hash', async () => {
    await store.insertQuote(baseQuote)
    await expect(store.insertQuote({ ...baseQuote, id: 'swap-2' })).rejects.toThrow(/UNIQUE/i)
  })

  it('frees the hash again once a row is refused', async () => {
    await store.insertQuote(baseQuote)
    await store.fail('swap-1', 'quoted', 'lockup timeout')
    await expect(store.insertQuote({ ...baseQuote, id: 'swap-2' })).resolves.toMatchObject({ state: 'quoted' })
  })

  it('reports the BTC leg as committed sats, never the asset units', async () => {
    // Summing atomic units into a sats total would report two different units
    // as one number. `amount_sats` is real sats on this leg.
    await store.insertQuote(baseQuote)
    expect(await store.committedSats()).toBe(50_000)
  })

  it('stops counting a row once it is terminal', async () => {
    await store.insertQuote(baseQuote)
    await store.fail('swap-1', 'quoted', 'lockup timeout')
    expect(await store.committedSats()).toBe(0)
  })

  it('counts a QUOTED row, not only an exposed one', async () => {
    // The house doctrine: a quote the solver has issued is capacity it may have
    // to honour, so counting only exposed rows would let unlimited concurrent
    // quotes slip past the cap.
    await store.insertQuote(baseQuote)
    const row = await store.get('swap-1')
    expect(row.state).toBe('quoted')
    expect(await store.committedSats()).toBe(50_000)
  })

  describe('the fund lease', () => {
    beforeEach(async () => {
      await store.insertQuote(baseQuote)
      await store.transition('swap-1', 'quoted', 'awaiting_confirmations', {})
      await store.transition('swap-1', 'awaiting_confirmations', 'funding_arkade', {})
    })

    it('is won by exactly one caller', async () => {
      // Two workers in the same window would otherwise both pay, out of the
      // solver's own asset float, against different coins.
      expect(await store.claimFundLease('swap-1', 'funding_arkade')).toBe(true)
      expect(await store.claimFundLease('swap-1', 'funding_arkade')).toBe(false)
    })

    it('is not granted from the wrong state', async () => {
      expect(await store.claimFundLease('swap-1', 'quoted')).toBe(false)
    })

    it('is re-winnable only after an explicit release', async () => {
      expect(await store.claimFundLease('swap-1', 'funding_arkade')).toBe(true)
      await store.releaseFundLease('swap-1')
      expect(await store.claimFundLease('swap-1', 'funding_arkade')).toBe(true)
    })

    it('does not expire on its own', async () => {
      // A lease that timed out would let a second worker pay while the first is
      // still in flight, reinstating the double-fund on a timer.
      expect(await store.claimFundLease('swap-1', 'funding_arkade')).toBe(true)
      now += 86_400
      expect(await store.claimFundLease('swap-1', 'funding_arkade')).toBe(false)
    })
  })

  it('refuses an illegal transition', async () => {
    await store.insertQuote(baseQuote)
    await expect(store.transition('swap-1', 'quoted', 'settled', {})).rejects.toThrow()
  })

  it('fails an exposed row to stuck and a clean one to refused', async () => {
    await store.insertQuote(baseQuote)
    await store.fail('swap-1', 'quoted', 'nothing moved')
    expect((await store.get('swap-1')).state).toBe('refused')

    await store.insertQuote({ ...baseQuote, id: 'swap-2', paymentHash: 'bc'.repeat(32) })
    await store.transition('swap-2', 'quoted', 'awaiting_confirmations', {})
    await store.transition('swap-2', 'awaiting_confirmations', 'funding_arkade', {})
    await store.fail('swap-2', 'funding_arkade', 'money is out')
    expect((await store.get('swap-2')).state).toBe('stuck')
  })

  it('finds a row by its rfq id', async () => {
    await store.insertQuote({ ...baseQuote, rfqId: 'ee'.repeat(32) })
    expect(await store.findByRfqId('ee'.repeat(32))).toMatchObject({ id: 'swap-1' })
  })

  it('keeps rows for different markets apart by pair', async () => {
    const other = 'cd'.repeat(32) + '0000'
    await store.insertQuote(baseQuote)
    await store.insertQuote({
      ...baseQuote,
      id: 'swap-2',
      paymentHash: 'bc'.repeat(32),
      pair: `onchain:BTC->arkade:${other}`,
      payoutAssetId: other,
    })
    const rows = await store.findRecoverable()
    expect(rows.map((r) => r.pair)).toEqual([PAIR, `onchain:BTC->arkade:${other}`])
  })
})
