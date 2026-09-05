/**
 * The two `lightning:BTC<->arkade:<asset>` stores.
 *
 * What is worth pinning here is not CRUD but the three things a wrong answer
 * moves money on: which states count towards a cap, which unit each cap is in,
 * and which edges the lifecycle admits.
 */

import { describe, it, expect } from 'vitest'
import {
  LnAssetReceiveSwapStore,
  EXPOSED as RECEIVE_EXPOSED,
  NON_TERMINAL as RECEIVE_NON_TERMINAL,
  type LnAssetReceiveQuoteRecord,
} from '@arkade-os/solver-corridors/db/lnAssetReceiveSwaps.js'
import {
  LnAssetSendSwapStore,
  EXPOSED as SEND_EXPOSED,
  NON_TERMINAL as SEND_NON_TERMINAL,
  type LnAssetSendQuoteRecord,
} from '@arkade-os/solver-corridors/db/lnAssetSendSwaps.js'

const ASSET = `${'aa'.repeat(32)}0100`
const OTHER = `${'bb'.repeat(32)}0000`
const hash = (n: number) => n.toString(16).padStart(64, '0')

const receiveStore = () => LnAssetReceiveSwapStore.open(':memory:')
const sendStore = () => LnAssetSendSwapStore.open(':memory:')

const receiveQuote = (over: Partial<LnAssetReceiveQuoteRecord> = {}): LnAssetReceiveQuoteRecord => ({
  id: 'r1',
  paymentHash: hash(1),
  pair: `lightning:BTC->arkade:${ASSET}`,
  amountSats: 100_000,
  assetId: ASSET,
  assetDecimals: 6,
  payoutAssetAmount: 1_000_000n,
  invoice: 'lnbcrt1...',
  invoiceExpiresAt: 2_000_000_000,
  payoutAddress: 'ark1qexample',
  payoutPkScript: '51'.repeat(17),
  payoutPubkey: 'cc'.repeat(32),
  claimPacket: 'sealed',
  refundLocktime: 2_000_003_600,
  solverPubkey: 'dd'.repeat(32),
  serverPubkey: 'ee'.repeat(32),
  claimDelay: 512,
  refundDelay: 1024,
  refundWithoutReceiverDelay: 2048,
  emulatorPubkey: 'ff'.repeat(33),
  pkScript: '51'.repeat(17),
  lockupAddress: 'ark1qlockup',
  solverRefundPkScript: '51'.repeat(17),
  rfqId: null,
  ...over,
})

const sendQuote = (over: Partial<LnAssetSendQuoteRecord> = {}): LnAssetSendQuoteRecord => ({
  id: 's1',
  paymentHash: hash(1),
  pair: `arkade:${ASSET}->lightning:BTC`,
  invoice: 'lnbcrt1...',
  invoiceExpiresAt: 2_000_000_000,
  payoutSats: 50_000,
  assetId: ASSET,
  assetDecimals: 6,
  lockupAssetAmount: 500_000n,
  lockupDeadline: 1_999_999_000,
  refundLocktime: 2_000_003_600,
  solverPubkey: 'dd'.repeat(32),
  serverPubkey: 'ee'.repeat(32),
  claimDelay: 512,
  refundDelay: 1024,
  refundWithoutReceiverDelay: 2048,
  emulatorPubkey: 'ff'.repeat(33),
  pkScript: '51'.repeat(17),
  lockupAddress: 'ark1qlockup',
  refundPkScript: '51'.repeat(17),
  clientRefundPubkey: 'cc'.repeat(32),
  rfqId: null,
  ...over,
})

describe('LnAssetReceiveSwapStore', () => {
  it('round-trips a quote, keeping the asset amount exact', async () => {
    const store = await receiveStore()
    // Past 2^63: the value SQLite's INTEGER would silently mangle.
    const huge = 123_456_789_012_345_678_901_234_567_890n
    const row = await store.insertQuote(receiveQuote({ payoutAssetAmount: huge }))
    expect(row.payoutAssetAmount).toBe(huge)
    expect((await store.get('r1')).payoutAssetAmount).toBe(huge)
    await store.close()
  })

  /**
   * The payout is an ASSET, so this corridor commits no sats. Reporting its
   * atomic units here would add an asset amount to a sats total — the exact
   * mistake `assetRfqSwaps.ts` filters `to_asset_id IS NULL` to avoid.
   */
  it('reports zero committed SATS however much asset is out', async () => {
    const store = await receiveStore()
    await store.insertQuote(receiveQuote({ payoutAssetAmount: 10n ** 24n }))
    await store.transition('r1', 'quoted', 'armed', {})
    await store.transition('r1', 'armed', 'funded', {})
    expect(await store.committedSats()).toBe(0)
    await store.close()
  })

  /**
   * #21 § 2(a)'s doctrine: a QUOTED swap is capacity the solver may have to
   * honour, so counting only the funded states lets unlimited concurrent quotes
   * past the inventory gate and fund at once.
   */
  it('counts committed asset units across every non-terminal state, not just the funded ones', async () => {
    const store = await receiveStore()
    await store.insertQuote(receiveQuote({ id: 'a', paymentHash: hash(1), payoutAssetAmount: 100n }))
    await store.insertQuote(receiveQuote({ id: 'b', paymentHash: hash(2), payoutAssetAmount: 200n }))
    // `a` stays merely quoted; `b` is funded.
    await store.transition('b', 'quoted', 'armed', {})
    await store.transition('b', 'armed', 'funded', {})
    expect(await store.committedAssetUnits(ASSET)).toBe(300n)

    // A terminal row stops counting.
    await store.fail('a', 'quoted', 'lapsed')
    expect(await store.committedAssetUnits(ASSET)).toBe(200n)
    await store.close()
  })

  it('never counts another asset against this one', async () => {
    const store = await receiveStore()
    await store.insertQuote(receiveQuote({ id: 'a', paymentHash: hash(1), assetId: OTHER, payoutAssetAmount: 999n }))
    expect(await store.committedAssetUnits(ASSET)).toBe(0n)
    expect(await store.committedAssetUnits(OTHER)).toBe(999n)
    await store.close()
  })

  it('refuses a live duplicate on one payment hash, and admits one after the first ends', async () => {
    const store = await receiveStore()
    await store.insertQuote(receiveQuote({ id: 'a' }))
    await expect(store.insertQuote(receiveQuote({ id: 'b' }))).rejects.toThrow(/UNIQUE/i)
    await store.fail('a', 'quoted', 'lapsed')
    await expect(store.insertQuote(receiveQuote({ id: 'b' }))).resolves.toBeDefined()
    await store.close()
  })

  /** `refunding -> claimed` is what stops a completed swap being recorded as a refund. */
  it('admits a late claim out of refunding, and refuses a walk backwards', async () => {
    const store = await receiveStore()
    await store.insertQuote(receiveQuote())
    await store.transition('r1', 'quoted', 'armed', {})
    await store.transition('r1', 'armed', 'funded', {})
    await store.transition('r1', 'funded', 'refunding', {})
    expect(await store.transition('r1', 'refunding', 'claimed', { preimage: 'ab'.repeat(32) })).toBe(true)
    await expect(store.transition('r1', 'claimed', 'funded', {})).rejects.toThrow(/illegal transition/)
    await store.close()
  })

  it('routes a failure by exposure: refused before the asset moves, stuck after', async () => {
    const store = await receiveStore()
    await store.insertQuote(receiveQuote({ id: 'a', paymentHash: hash(1) }))
    await store.fail('a', 'quoted', 'lapsed')
    expect((await store.get('a')).state).toBe('refused')

    await store.insertQuote(receiveQuote({ id: 'b', paymentHash: hash(2) }))
    await store.transition('b', 'quoted', 'armed', {})
    await store.transition('b', 'armed', 'funded', {})
    await store.fail('b', 'funded', 'lost the lockup')
    expect((await store.get('b')).state).toBe('stuck')
    await store.close()
  })

  it('refuses to write a column outside its allowlist', async () => {
    const store = await receiveStore()
    await store.insertQuote(receiveQuote())
    await expect(store.transition('r1', 'quoted', 'armed', { refund_locktime: 1 })).rejects.toThrow(/may not set/)
    await expect(store.patch('r1', { payout_asset_amount: '1' })).rejects.toThrow(/may not set/)
    await store.close()
  })

  it('exposes only states where the asset is really out', () => {
    expect([...RECEIVE_EXPOSED].sort()).toEqual(['claimed', 'funded', 'refunding'])
    for (const state of RECEIVE_EXPOSED) expect(RECEIVE_NON_TERMINAL).toContain(state)
  })
})

describe('LnAssetSendSwapStore', () => {
  /**
   * #21 § 1's finding, and the one line that separates this leg from its
   * mirror: the payout IS the BTC leg, so the house cap needs no new unit.
   */
  it('reports the sats payout as committed, across every non-terminal state', async () => {
    const store = await sendStore()
    await store.insertQuote(sendQuote({ id: 'a', paymentHash: hash(1), payoutSats: 1_000 }))
    await store.insertQuote(sendQuote({ id: 'b', paymentHash: hash(2), payoutSats: 2_000 }))
    expect(await store.committedSats()).toBe(3_000)

    await store.transition('b', 'quoted', 'funded', {})
    await store.transition('b', 'funded', 'paying', {})
    expect(await store.committedSats()).toBe(3_000)

    await store.fail('a', 'quoted', 'lapsed')
    expect(await store.committedSats()).toBe(2_000)
    await store.close()
  })

  it('counts the asset it expects to receive, per asset id', async () => {
    const store = await sendStore()
    await store.insertQuote(sendQuote({ id: 'a', paymentHash: hash(1), lockupAssetAmount: 7n }))
    await store.insertQuote(sendQuote({ id: 'b', paymentHash: hash(2), assetId: OTHER, lockupAssetAmount: 9n }))
    expect(await store.committedAssetUnits(ASSET)).toBe(7n)
    expect(await store.committedAssetUnits(OTHER)).toBe(9n)
    await store.close()
  })

  /**
   * No edge back to `funded` from `paying`: once a payment is submitted its
   * outcome is either known or unknown, and "unknown" is `stuck` — never a
   * retry, which is how a solver pays one invoice twice.
   */
  it('is forward-only across the payment states', async () => {
    const store = await sendStore()
    await store.insertQuote(sendQuote())
    await store.transition('s1', 'quoted', 'funded', {})
    await store.transition('s1', 'funded', 'paying', {})
    await expect(store.transition('s1', 'paying', 'funded', {})).rejects.toThrow(/illegal transition/)
    await expect(store.transition('s1', 'paying', 'quoted', {})).rejects.toThrow(/illegal transition/)
    await store.close()
  })

  /**
   * Money is out from `paid` on, so no terminal-without-a-human edge exists
   * there. `paying -> refused` survives only for the caller that holds PROOF
   * the sats never left; `fail()` cannot reach it, and that asymmetry is the
   * guard.
   */
  it('gives paid and claiming no refused edge, and never lets fail() reach one', async () => {
    const store = await sendStore()
    await store.insertQuote(sendQuote())
    await store.transition('s1', 'quoted', 'funded', {})
    await store.transition('s1', 'funded', 'paying', {})
    await store.fail('s1', 'paying', 'unknown outcome')
    expect((await store.get('s1')).state).toBe('stuck')

    const second = await sendStore()
    await second.insertQuote(sendQuote())
    await second.transition('s1', 'quoted', 'funded', {})
    await second.transition('s1', 'funded', 'paying', {})
    await second.transition('s1', 'paying', 'paid', { preimage: 'ab'.repeat(32) })
    await expect(second.transition('s1', 'paid', 'refused', {})).rejects.toThrow(/illegal transition/)
    await second.close()
    await store.close()
  })

  it('has no refunding state at all — the client reclaims its own lockup', async () => {
    const store = await sendStore()
    await store.insertQuote(sendQuote())
    // @ts-expect-error `refunding` is not a state of this lifecycle.
    await expect(store.transition('s1', 'quoted', 'refunding', {})).rejects.toThrow()
    await store.close()
  })

  it('exposes only states where sats may already have left', () => {
    expect([...SEND_EXPOSED].sort()).toEqual(['claiming', 'paid', 'paying'])
    for (const state of SEND_EXPOSED) expect(SEND_NON_TERMINAL).toContain(state)
  })

  it('refuses a live duplicate on one payment hash', async () => {
    const store = await sendStore()
    await store.insertQuote(sendQuote({ id: 'a' }))
    await expect(store.insertQuote(sendQuote({ id: 'b' }))).rejects.toThrow(/UNIQUE/i)
    await store.close()
  })
})
