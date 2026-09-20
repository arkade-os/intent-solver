/**
 * Capturing what routing ACTUALLY cost — the adapter and the store.
 *
 * The fee was reaching the adapter and being thrown away: `PaymentOutcome`
 * narrowed LND's payment record to `{ secret }`, so the one realized execution
 * cost this service can observe never left the rail. These tests pin both the
 * mapping and the column it lands in, and — as much as anything — pin that an
 * ABSENT fee stays absent rather than becoming a zero.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { toPaymentResult, feeSatsFromMtokens } from '@arkade-os/solver-rails-lnd/ln/lnd/adapter.js'
import { SwapStore, type QuoteRecord } from '@arkade-os/solver-corridors/db/swaps.js'

describe('the LND adapter maps the fee LND actually charged', () => {
  const confirmed = (payment: Record<string, unknown>) =>
    toPaymentResult('p1', { is_confirmed: true, payment } as never)

  it('reports the routing fee off a settled payment', () => {
    expect(confirmed({ secret: 'ab'.repeat(32), fee_mtokens: '12340' }).feePaidSats).toBe(13)
  })

  /**
   * Rounds UP from the millisat truth, per `feeSatsFromMtokens`. For a COST the
   * conservative direction is to overstate: a fee rounded down is profit the
   * solver did not make.
   */
  it('rounds a sub-sat fee up rather than down', () => {
    expect(feeSatsFromMtokens('1')).toBe(1)
    expect(confirmed({ secret: 'ab'.repeat(32), fee_mtokens: '1' }).feePaidSats).toBe(1)
  })

  it('reports a genuinely free route as zero, which is not the same as unknown', () => {
    expect(confirmed({ secret: 'ab'.repeat(32), fee_mtokens: '0' }).feePaidSats).toBe(0)
  })

  it('omits the fee entirely when the vendor did not report one', () => {
    expect(confirmed({ secret: 'ab'.repeat(32) }).feePaidSats).toBeUndefined()
  })

  /**
   * An unreadable fee must not fail a payment that SETTLED. The preimage is in
   * hand and the swap can proceed; the fee is reporting. This is the opposite
   * of what the same helper does for an estimate, where a fee that cannot be
   * read must stop a quote priced on it from going out.
   */
  it('degrades to unmeasured on an unreadable fee rather than throwing away the preimage', () => {
    const result = confirmed({ secret: 'ab'.repeat(32), fee_mtokens: 'not-a-number' })
    expect(result.status).toBe('succeeded')
    expect(result.preimage).toBe('ab'.repeat(32))
    expect(result.feePaidSats).toBeUndefined()
    expect(() => feeSatsFromMtokens('not-a-number')).toThrow(/unreadable routing fee/)
  })

  it('reports no fee on a failed payment — nothing was routed', () => {
    expect(toPaymentResult('p1', { is_failed: true, failed: {} }).feePaidSats).toBeUndefined()
  })
})

describe('the send store keeps the realized fee beside the quoted one', () => {
  let store: SwapStore
  let clock = 1_800_000_000

  const quote = (over: Partial<QuoteRecord> = {}): QuoteRecord => ({
    id: 'swap-1',
    invoice: 'lnbc5u1p...',
    paymentHash: 'a'.repeat(64),
    amountSats: 100_300,
    invoiceExpiresAt: clock + 3600,
    quotedRefundDeadline: clock + 7200,
    refundLocktime: clock + 7200,
    senderPubkey: '01'.repeat(32),
    receiverPubkey: '02'.repeat(32),
    serverPubkey: '03'.repeat(32),
    claimDelay: 605_184,
    refundDelay: 605_696,
    refundWithoutReceiverDelay: 606_208,
    pkScript: '5120' + 'ab'.repeat(32),
    lockupAddress: 'ark1qexample',
    nonInteractiveParameters: true,
    ...over,
  })

  beforeEach(async () => {
    store = await SwapStore.open(':memory:', () => clock)
  })
  afterEach(() => store.close())

  it('round-trips the fee through a patch', async () => {
    await store.insertQuote(quote())
    await store.patch('swap-1', { routing_fee_paid_sats: 137 })
    expect((await store.get('swap-1')).routingFeePaidSats).toBe(137)
  })

  it('reads back NULL on a row nobody recorded a fee for — unmeasured, not free', async () => {
    await store.insertQuote(quote())
    expect((await store.get('swap-1')).routingFeePaidSats).toBeNull()
  })

  it('keeps a zero fee as zero, distinct from never having been told', async () => {
    await store.insertQuote(quote())
    await store.patch('swap-1', { routing_fee_paid_sats: 0 })
    expect((await store.get('swap-1')).routingFeePaidSats).toBe(0)
  })

  /**
   * The budget and the bill are different columns on purpose: the gap between
   * them is the difference between a corridor that made money and one that only
   * looked like it did.
   */
  it('does not disturb the quote-time budget beside it', async () => {
    await store.insertQuote(quote({ quotedRoutingFeeSats: 500 }))
    await store.patch('swap-1', { routing_fee_paid_sats: 620 })
    const row = await store.get('swap-1')
    expect(row.quotedRoutingFeeSats).toBe(500)
    expect(row.routingFeePaidSats).toBe(620)
  })

  it('refuses to let a transition write the column, which is patch-only', async () => {
    await store.insertQuote(quote())
    await expect(
      store.transition('swap-1', 'quoted', 'funded', { routing_fee_paid_sats: 10 } as never),
    ).rejects.toThrow(/may not set column/)
  })
})
