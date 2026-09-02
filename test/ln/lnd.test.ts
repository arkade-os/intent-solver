import { describe, it, expect, vi, beforeEach } from 'vitest'
import { forgeInvoiceWithPreimage } from '@arkade-os/solver-rails-fake/ln/fake/bolt11.js'

// `payViaPaymentRequest` and `getWalletInfo` are request/response calls made on
// a gRPC client the adapter constructs internally, so the only way to assert
// what it SENDS is to module-mock the vendor -- the same pattern
// test/onchain/lnd.test.ts already uses on this package.
const { payViaPaymentRequest, getWalletInfo, getInvoice } = vi.hoisted(() => ({
  payViaPaymentRequest: vi.fn(),
  getWalletInfo: vi.fn(),
  getInvoice: vi.fn(),
}))
vi.mock('lightning', async (importOriginal) => {
  const actual = await importOriginal<typeof import('lightning')>()
  return {
    ...actual,
    authenticatedLndGrpc: vi.fn(() => ({ lnd: {} })),
    payViaPaymentRequest,
    getWalletInfo,
    getInvoice,
  }
})

const {
  heldTimeoutHeight,
  isInvoiceNotFound,
  isoToUnixSeconds,
  rejectionReason,
  toExpiresAt,
  toGetPaymentRejection,
  toHoldStatus,
  toPaymentResult,
  FAILED_PAYMENT_REASONS,
  LndLightningBackendAdapter,
} = await import('@arkade-os/solver-rails-lnd/ln/lnd/adapter.js')

describe('rejectionReason', () => {
  // The `lightning` package rejects promises with [code, reason, details?]
  // tuples, not Error instances -- this is the one place that shape is parsed.
  it('extracts the reason string from a lightning-style rejection tuple', () => {
    expect(rejectionReason([503, 'PaymentRejectedByDestination'])).toBe('PaymentRejectedByDestination')
    expect(rejectionReason([503, 'UnexpectedErrorWhenSettlingHodlInvoice', { err: new Error('x') }])).toBe(
      'UnexpectedErrorWhenSettlingHodlInvoice',
    )
  })

  it('returns undefined for anything that is not a lightning-style tuple', () => {
    expect(rejectionReason(new Error('network error'))).toBeUndefined()
    expect(rejectionReason('plain string')).toBeUndefined()
    expect(rejectionReason(undefined)).toBeUndefined()
    expect(rejectionReason([])).toBeUndefined()
  })
})

describe('isoToUnixSeconds', () => {
  it('converts an LND ISO 8601 date to unix seconds', () => {
    expect(isoToUnixSeconds('2026-08-06T00:00:00.000Z')).toBe(1785974400)
  })
})

describe('toExpiresAt', () => {
  it('adds expirySeconds to the given unix-seconds clock and returns ISO 8601', () => {
    expect(toExpiresAt(1785974400, 600)).toBe('2026-08-06T00:10:00.000Z')
  })
})

describe('toHoldStatus', () => {
  it('reports cancelled before anything else, even if other flags are also set', () => {
    expect(toHoldStatus({ is_canceled: true, is_confirmed: true, is_held: true })).toBe('cancelled')
  })

  it('reports settled once confirmed', () => {
    expect(toHoldStatus({ is_canceled: false, is_confirmed: true, is_held: false })).toBe('settled')
  })

  it('reports armed once held but not yet confirmed', () => {
    expect(toHoldStatus({ is_canceled: false, is_confirmed: false, is_held: true })).toBe('armed')
  })

  it('reports pending when nothing has happened yet', () => {
    expect(toHoldStatus({ is_canceled: false, is_confirmed: false, is_held: false })).toBe('pending')
  })
})

describe('heldTimeoutHeight', () => {
  /**
   * The exact `payments[]` entry a live LND returned for a held hold-invoice
   * HTLC on regtest, trimmed to the fields read here. `timeout` is the vendor's
   * rename of LND's `htlcs[].expiry_height` — the same response's `lncli`
   * cross-check reported `expiry_height: 276` for this HTLC, while the
   * invoice's BOLT11 window was only 600 seconds.
   */
  const held = { is_held: true, timeout: 276 }

  it('reads the held HTLC CLTV timeout height', () => {
    expect(heldTimeoutHeight([held])).toBe(276)
  })

  it('reports nothing when no HTLC is being held', () => {
    expect(heldTimeoutHeight([])).toBeNull()
  })

  /**
   * `payments[]` is every HTLC ever accepted against the invoice, not only the
   * live ones -- a cancelled attempt keeps its entry. Reading a dead HTLC's
   * deadline would answer for an HTLC nobody has to settle.
   */
  it('ignores HTLCs that are no longer held', () => {
    expect(heldTimeoutHeight([{ is_held: false, timeout: 200 }])).toBeNull()
    expect(heldTimeoutHeight([{ is_held: false, timeout: 200 }, held])).toBe(276)
  })

  /**
   * A multipath payment arms several HTLCs, each routed independently and so
   * each with its own CLTV. The invoice settles as a whole, so the earliest
   * expiry is the one that bounds the solver.
   */
  it('takes the earliest deadline across a multipath payment', () => {
    expect(
      heldTimeoutHeight([
        { is_held: true, timeout: 300 },
        { is_held: true, timeout: 261 },
        { is_held: true, timeout: 288 },
      ]),
    ).toBe(261)
  })
})

describe('toPaymentResult', () => {
  it('reports succeeded with the preimage once confirmed', () => {
    const result = toPaymentResult('deadbeef', { is_confirmed: true, payment: { secret: 'cafe' } })
    expect(result).toEqual({ id: 'deadbeef', status: 'succeeded', preimage: 'cafe', evidence: 'terminal' })
  })

  it('reports failed once LND says failed', () => {
    expect(toPaymentResult('deadbeef', { is_failed: true })).toEqual({
      id: 'deadbeef',
      status: 'failed',
      evidence: 'terminal',
      failureReason: 'unknown',
    })
  })

  it('reports pending when nothing has resolved yet', () => {
    expect(toPaymentResult('deadbeef', {})).toEqual({ id: 'deadbeef', status: 'pending', evidence: 'in_flight' })
  })

  // `is_confirmed` comes from the vendor as `!!payment` and should never be
  // true without one -- but if it ever were, silently reporting `pending`
  // would strand the swap forever rather than surface the bug.
  it('throws rather than silently reporting pending when confirmed with no payment record', () => {
    expect(() => toPaymentResult('deadbeef', { is_confirmed: true })).toThrow(/confirmed with no preimage/)
  })

  // Unresolved is unresolved, and the adapter must NOT read `is_pending` to
  // decide otherwise. `lightning@12.2.3` derives it as
  // `!res.payment && !res.failed` (get_payment.js:124), so it is already
  // implied here and carries nothing. Were a future version to drop the field,
  // treating its absence as "not in flight" would report a stall on every
  // healthy payment — so both shapes must answer the same.
  it('reports an unresolved payment as in flight however the backend words it', () => {
    expect(toPaymentResult('deadbeef', { is_pending: true }).evidence).toBe('in_flight')
    expect(toPaymentResult('deadbeef', {}).evidence).toBe('in_flight')
  })

  it('marks a resolved payment as terminal, whichever way it went', () => {
    const confirmed = toPaymentResult('deadbeef', { is_confirmed: true, payment: { secret: 'cafe' } })
    expect(confirmed.evidence).toBe('terminal')
    expect(toPaymentResult('deadbeef', { is_failed: true }).evidence).toBe('terminal')
  })

  // `is_invalid_payment` is LND's "the destination rejected this", which is how
  // an invoice a third party already settled comes back. The vendor turns each
  // of these into one of `FAILED_PAYMENT_REASONS`; dropping the flag left the
  // service unable to say WHY a swap died.
  it('carries the reason LND gave for a failure', () => {
    const reasonFor = (failed: Record<string, boolean>) =>
      toPaymentResult('deadbeef', { is_failed: true, failed }).failureReason
    expect(reasonFor({ is_invalid_payment: true })).toBe('rejected_by_destination')
    expect(reasonFor({ is_pathfinding_timeout: true })).toBe('pathfinding_timeout')
    expect(reasonFor({ is_insufficient_balance: true })).toBe('insufficient_balance')
    expect(reasonFor({ is_route_not_found: true })).toBe('route_not_found')
  })

  it('does not invent a reason when LND gave none', () => {
    expect(toPaymentResult('deadbeef', { is_failed: true }).failureReason).toBe('unknown')
  })
})

describe('toGetPaymentRejection', () => {
  // LND has no record at all of the payment hash -- the original payInvoice
  // call never reached it. Nothing above this adapter retries payInvoice
  // once a paymentId is on the row, so this must resolve to `failed`, not
  // `pending`, or the swap polls the same rejection forever.
  it('maps a SentPaymentNotFound rejection to failed', () => {
    const result = toGetPaymentRejection('deadbeef', [404, 'SentPaymentNotFound'])
    expect(result).toEqual({ id: 'deadbeef', status: 'failed', evidence: 'no_record' })
  })

  // `failed` alone cannot say whether LND tried and the payment died or whether
  // it never heard of the hash. Both resolve the swap, but only the second
  // proves nothing was ever sent -- the one fact that makes a refund provably
  // safe without trusting a payer-side verdict.
  it('records that LND had no record of the payment at all', () => {
    expect(toGetPaymentRejection('deadbeef', [404, 'SentPaymentNotFound']).evidence).toBe('no_record')
  })

  it('re-throws any other rejection', () => {
    expect(() => toGetPaymentRejection('deadbeef', [503, 'UnknownStatusOfPayment'])).toThrow()
    expect(() => toGetPaymentRejection('deadbeef', new Error('network error'))).toThrow('network error')
  })
})

describe('isInvoiceNotFound', () => {
  // The vendor wraps every lookup failure as [503, 'UnexpectedLookupInvoiceErr',
  // {err}] — the raw gRPC NOT_FOUND lives inside the third element.
  it('recognises LND’s not-found by its nested gRPC code', () => {
    expect(isInvoiceNotFound([503, 'UnexpectedLookupInvoiceErr', { err: { code: 5 } }])).toBe(true)
  })

  it('recognises it by the details string too', () => {
    const err = [503, 'UnexpectedLookupInvoiceErr', { err: { details: 'unable to locate invoice' } }]
    expect(isInvoiceNotFound(err)).toBe(true)
  })

  it('does not read a transport failure as not-found — the safe direction matters here', () => {
    expect(isInvoiceNotFound([503, 'UnexpectedLookupInvoiceErr', { err: { code: 14 } }])).toBe(false)
    expect(isInvoiceNotFound([503, 'UnexpectedServiceError', { err: { code: 5 } }])).toBe(false)
    expect(isInvoiceNotFound(new Error('network error'))).toBe(false)
  })
})

describe('LndLightningBackendAdapter.getOwnInvoiceState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getWalletInfo.mockResolvedValue({ current_block_height: 840_000 })
  })

  it('returns our own invoice’s state when the node minted one — hold or plain', async () => {
    getInvoice.mockResolvedValue({ is_confirmed: false, tokens: 2100 })
    const adapter = await LndLightningBackendAdapter.create({ socket: 's', cert: 'c', macaroon: 'm' })
    await expect(adapter.getOwnInvoiceState('ab'.repeat(32))).resolves.toEqual({
      status: 'pending',
      expiresAt: null,
      amountSats: 2100,
    })
  })

  it('maps a settled invoice, so a contradictory backend answer stays visible', async () => {
    getInvoice.mockResolvedValue({ is_confirmed: true, tokens: 2100 })
    const adapter = await LndLightningBackendAdapter.create({ socket: 's', cert: 'c', macaroon: 'm' })
    await expect(adapter.getOwnInvoiceState('ab'.repeat(32))).resolves.toMatchObject({ status: 'settled' })
  })

  it('answers null for a hash the node never minted', async () => {
    getInvoice.mockRejectedValue([
      503,
      'UnexpectedLookupInvoiceErr',
      { err: { code: 5, details: 'unable to locate invoice' } },
    ])
    const adapter = await LndLightningBackendAdapter.create({ socket: 's', cert: 'c', macaroon: 'm' })
    await expect(adapter.getOwnInvoiceState('ab'.repeat(32))).resolves.toBeNull()
  })

  it('rethrows any other lookup failure rather than guessing "not ours"', async () => {
    getInvoice.mockRejectedValue([
      503,
      'UnexpectedLookupInvoiceErr',
      { err: { code: 14, details: 'dns resolution failed' } },
    ])
    const adapter = await LndLightningBackendAdapter.create({ socket: 's', cert: 'c', macaroon: 'm' })
    await expect(adapter.getOwnInvoiceState('ab'.repeat(32))).rejects.toThrow()
  })
})

/**
 * The enforced half of the send leg's double-collect bound.
 *
 * `refundLocktimeFor` quotes the client's refund deadline against a worst case
 * of `minFinalCltvBlocks + ROUTE_CLTV_BUDGET_BLOCKS`. These assert the payment
 * we actually send is capped at that same worst case, so our outbound HTLC
 * cannot still be live when the refund path opens.
 */
describe('LndLightningBackendAdapter.payInvoice', () => {
  const CURRENT_HEIGHT = 840_000
  const forged = forgeInvoiceWithPreimage({
    network: 'bcrt',
    amountSats: 1000,
    timestamp: 1_800_000_000,
    expirySeconds: 3600,
    minFinalCltvBlocks: 40,
  })

  const pay = async (maxCltvBlocks: number) => {
    const adapter = await LndLightningBackendAdapter.create({ socket: 's', cert: 'c', macaroon: 'm' })
    return adapter.payInvoice({ invoice: forged.invoice, maxFeeSats: 10, idempotencyKey: 'k', maxCltvBlocks })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    getWalletInfo.mockResolvedValue({ current_block_height: CURRENT_HEIGHT })
    payViaPaymentRequest.mockResolvedValue({ id: 'deadbeef', secret: 'cafe' })
  })

  // `max_timeout_height` is an ABSOLUTE chain height, not a delta: the vendor
  // turns it back into LND's `cltv_limit` by subtracting the height IT reads
  // (`subscribe_to_pay.js`, `limit - height`). So the budget has to be added to
  // a height read from this same node.
  it('caps the payment at the current height plus the worst-case CLTV budget', async () => {
    await pay(472)
    expect(payViaPaymentRequest).toHaveBeenCalledWith(
      expect.objectContaining({ max_timeout_height: CURRENT_HEIGHT + 472 }),
    )
  })

  it('takes the ceiling from the caller rather than deriving one of its own', async () => {
    await pay(200)
    expect(payViaPaymentRequest).toHaveBeenCalledWith(
      expect.objectContaining({ max_timeout_height: CURRENT_HEIGHT + 200 }),
    )
  })

  // A height read that fails must NOT fall through to an uncapped payment:
  // paying without the ceiling is the exact bug this closes.
  it('never pays when the height it would cap against cannot be read', async () => {
    getWalletInfo.mockRejectedValue(new Error('chain backend unreachable'))
    await expect(pay(472)).rejects.toThrow('chain backend unreachable')
    expect(payViaPaymentRequest).not.toHaveBeenCalled()
  })

  // A failure this call sees and one the poll sees later are the same fact, so
  // they must reach a client as the same `payment_failure_reason`. Before this
  // the immediate path reported neither, and which of two identical failures
  // carried a reason depended only on how fast LND answered.
  it('carries the rail’s own verdict on a failure it learns immediately', async () => {
    payViaPaymentRequest.mockRejectedValue([503, 'PaymentRejectedByDestination'])
    const result = await pay(472)
    expect(result.status).toBe('failed')
    expect(result.failureReason).toBe('rejected_by_destination')
    expect(result.evidence).toBe('terminal')
  })

  // The exception in the allowlist: the vendor's pre-flight CLTV guard fires
  // BEFORE sendPaymentV2, so LND never heard of this payment. `getPayment`
  // would answer `SentPaymentNotFound` — the polled path's `no_record` — and
  // calling it `terminal` here would claim LND settled something it never saw.
  it('calls a pre-flight refusal no_record, not a terminal failure', async () => {
    payViaPaymentRequest.mockRejectedValue([400, 'MaxTimeoutTooNearCurrentHeightToMakePayment'])
    const result = await pay(472)
    expect(result.status).toBe('failed')
    expect(result.evidence).toBe('no_record')
  })

  it('declares itself enforcing, which is what licenses the best-hint rule', () => {
    // `max_timeout_height` above is the mechanism; this is the same fact stated
    // where the send leg's route-hint policy can read it. Only on a rail that
    // declines an over-long route may an invoice's bad ALTERNATIVE hint be
    // ignored — being wrong then costs a refused payment, not an HTLC outliving
    // the client's refund.
    expect(LndLightningBackendAdapter.prototype.enforcesRouteCltv).toBe(true)
  })
})

/**
 * Both ways a CLTV ceiling can refuse a payment, and both must land on
 * `failed`. Reporting `pending` for a payment that provably never left would
 * park the swap on a poll that can only ever return the same answer.
 *
 * Reason strings captured from a live regtest LND (boltz-lnd) by paying a
 * counterparty invoice with a deliberately tight `max_timeout_height`.
 */
describe('FAILED_PAYMENT_REASONS covers a refused CLTV ceiling', () => {
  // LND itself found no route inside `cltv_limit`. Observed for a ceiling of
  // final_cltv + 3 against a one-hop route needing final_cltv + 4.
  it('treats LND finding no route inside the ceiling as terminal', () => {
    expect(FAILED_PAYMENT_REASONS.has('PaymentPathfindingFailedToFindPossibleRoute')).toBe(true)
  })

  // The vendor's own pre-flight guard, raised BEFORE sendPaymentV2 is called at
  // all, when the ceiling leaves less than the invoice's final delta + 3. Only
  // reachable now that a ceiling is passed, and `getPayment` answers
  // SentPaymentNotFound afterwards -- the sats provably never moved.
  it('treats the vendor refusing the ceiling as terminal', () => {
    expect(FAILED_PAYMENT_REASONS.has('MaxTimeoutTooNearCurrentHeightToMakePayment')).toBe(true)
  })
})
