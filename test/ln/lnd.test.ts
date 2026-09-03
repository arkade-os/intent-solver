import { describe, it, expect, vi, beforeEach } from 'vitest'
import { forgeInvoiceWithPreimage } from '@arkade-os/solver-rails-fake/ln/fake/bolt11.js'

// `payViaPaymentRequest` and `getWalletInfo` are request/response calls made on
// a gRPC client the adapter constructs internally, so the only way to assert
// what it SENDS is to module-mock the vendor -- the same pattern
// test/onchain/lnd.test.ts already uses on this package.
const { payViaPaymentRequest, getWalletInfo, getInvoice, getRoutingFeeEstimate, createInvoice } = vi.hoisted(() => ({
  payViaPaymentRequest: vi.fn(),
  getWalletInfo: vi.fn(),
  getInvoice: vi.fn(),
  getRoutingFeeEstimate: vi.fn(),
  createInvoice: vi.fn(),
}))
vi.mock('lightning', async (importOriginal) => {
  const actual = await importOriginal<typeof import('lightning')>()
  return {
    ...actual,
    authenticatedLndGrpc: vi.fn(() => ({ lnd: {} })),
    payViaPaymentRequest,
    getWalletInfo,
    getInvoice,
    getRoutingFeeEstimate,
    createInvoice,
  }
})

const {
  feeSatsFromMtokens,
  heldTimeoutHeight,
  isInvoiceNotFound,
  isNoFeeEstimate,
  isoToUnixSeconds,
  probeTimeoutMs,
  rejectionReason,
  toExpiresAt,
  toGetPaymentRejection,
  toHoldStatus,
  toPaymentResult,
  FAILED_PAYMENT_REASONS,
  MIN_ROUTE_FEE_PROBE_MS,
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
/**
 * The operator-funding invoice, and one claim above all: the expiry is real.
 *
 * `createInvoice`'s result carries NO expiry — not in its type and not at run
 * time, where the vendor assembles the resolved object field by field without
 * one. Reading `created.expires_at` therefore yields `undefined`, and
 * `new Date(undefined).getTime()` is `NaN`, so the console would count down from
 * a number that is not one and an operator would be told a dead invoice was
 * live. The mock below returns exactly what the vendor really returns, so a
 * version that reaches for the echoed field fails here rather than in a browser.
 */
describe('LndLightningBackendAdapter.createInvoice', () => {
  const TIMESTAMP = 1_800_000_000
  const EXPIRY_SECONDS = 900
  const forged = forgeInvoiceWithPreimage({
    network: 'bcrt',
    amountSats: 1000,
    timestamp: TIMESTAMP,
    expirySeconds: EXPIRY_SECONDS,
  })

  beforeEach(() => {
    vi.clearAllMocks()
    // The vendor's REAL resolved shape — `request` and no expiry anywhere in it.
    createInvoice.mockResolvedValue({ request: forged.invoice, id: 'x', secret: 'y', created_at: '2027-01-15T00:00:00Z' })
  })

  it('reports the expiry encoded in the invoice, which is what a payer enforces', async () => {
    const adapter = await LndLightningBackendAdapter.create({ socket: 's', cert: 'c', macaroon: 'm' })

    const minted = await adapter.createInvoice!({ memo: 'solver float deposit' })

    expect(minted.invoice).toBe(forged.invoice)
    expect(minted.expiresAt).toBe(TIMESTAMP + EXPIRY_SECONDS)
    // The `NaN` this guards against is not caught by a truthiness check —
    // `Number.isFinite` is, and the console arithmetic depends on it.
    expect(Number.isFinite(minted.expiresAt)).toBe(true)
  })

  it('asks for an AMOUNTLESS invoice unless an amount was given', async () => {
    const adapter = await LndLightningBackendAdapter.create({ socket: 's', cert: 'c', macaroon: 'm' })

    await adapter.createInvoice!({ memo: 'm' })

    // Omitted, never `tokens: 0`: that is a zero-amount invoice on some nodes
    // and an amountless one on others, and the two differ in whether a payer may
    // choose what to send.
    expect(createInvoice.mock.calls[0]![0]).not.toHaveProperty('tokens')
    expect(createInvoice.mock.calls[0]![0]).toMatchObject({ description: 'm' })

    await adapter.createInvoice!({ amountSats: 25_000 })
    expect(createInvoice.mock.calls[1]![0]).toMatchObject({ tokens: 25_000 })
    expect(createInvoice.mock.calls[1]![0]).not.toHaveProperty('description')
  })
})

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

describe('feeSatsFromMtokens', () => {
  // Rounding down is the direction that costs money: a fee reported a sat low
  // is a quote priced a sat low, paid out of the solver's own spread.
  it('rounds a millisat figure UP to whole sats', () => {
    expect(feeSatsFromMtokens('1')).toBe(1)
    expect(feeSatsFromMtokens('1001')).toBe(2)
    expect(feeSatsFromMtokens('10999')).toBe(11)
  })

  it('leaves an exact satoshi figure alone', () => {
    expect(feeSatsFromMtokens('2000')).toBe(2)
  })

  // A direct peer costs nothing to reach. The vendor guards on `!routing_fee_msat`
  // but LND's gRPC options decode int64 as a STRING, so a zero fee arrives as
  // the truthy '0' and reaches this conversion rather than being rejected.
  it('reports a free route as zero rather than as an error', () => {
    expect(feeSatsFromMtokens('0')).toBe(0)
  })

  // NaN compares false against every cap and floor downstream, and a coerced 0
  // would quote a free execution. Both are silent; the throw is not.
  it('throws on a figure it cannot read rather than coercing one', () => {
    expect(() => feeSatsFromMtokens('not-a-number')).toThrow(/unreadable routing fee/)
    expect(() => feeSatsFromMtokens('-1000')).toThrow(/unreadable routing fee/)
  })
})

describe('probeTimeoutMs', () => {
  // The vendor rounds our milliseconds to whole seconds and then reads 0 as
  // "unset", falling back to its own 60s default -- so an un-floored 200ms would
  // buy the LONGEST probe on offer instead of the shortest.
  it('floors a sub-second budget at one whole second', () => {
    expect(probeTimeoutMs(200)).toBe(MIN_ROUTE_FEE_PROBE_MS)
    expect(probeTimeoutMs(0)).toBe(MIN_ROUTE_FEE_PROBE_MS)
    expect(Math.round(MIN_ROUTE_FEE_PROBE_MS / 1000)).toBeGreaterThan(0)
  })

  it('passes a budget the conversion survives through unchanged', () => {
    expect(probeTimeoutMs(5_000)).toBe(5_000)
  })
})

describe('isNoFeeEstimate', () => {
  // The vendor's own mapping of any failure_reason other than none, so it covers
  // both "the probe found nothing" and "the probe ran out of its time".
  it('recognises the probe not finding a route', () => {
    expect(isNoFeeEstimate([404, 'RouteToDestinationNotFound', { failure: 'FAILURE_REASON_NO_ROUTE' }])).toBe(true)
    expect(isNoFeeEstimate([404, 'RouteToDestinationNotFound', { failure: 'FAILURE_REASON_TIMEOUT' }])).toBe(true)
  })

  // estimateRouteFee does not exist before LND 0.18.4. A permanent, knowable
  // absence of the capability is exactly what the port's null is for.
  it('recognises a node too old to have the call at all', () => {
    expect(isNoFeeEstimate([503, 'UnexpectedGetRoutingFeeEstimateError', { err: { code: 12 } }])).toBe(true)
  })

  // A node that cannot be reached is the same fault every other call would hit.
  // Answering null would leave a dead backend looking exactly like a working one
  // whose routes happen to be unpriceable.
  it('does not read an unreachable node as a missing estimate', () => {
    expect(isNoFeeEstimate([503, 'UnexpectedGetRoutingFeeEstimateError', { err: { code: 14 } }])).toBe(false)
    expect(isNoFeeEstimate([503, 'UnexpectedGetRoutingFeeEstimateError', {}])).toBe(false)
    expect(isNoFeeEstimate([503, 'ExpectedFeeInGetRoutingFeeEstimateResponse'])).toBe(false)
    expect(isNoFeeEstimate(new Error('network error'))).toBe(false)
  })
})

describe('LndLightningBackendAdapter.estimateSendFee', () => {
  const forged = forgeInvoiceWithPreimage({
    network: 'bcrt',
    amountSats: 1000,
    timestamp: 1_800_000_000,
    expirySeconds: 3600,
    minFinalCltvBlocks: 40,
  })

  const estimate = async (timeoutMs = 5_000) => {
    const adapter = await LndLightningBackendAdapter.create({ socket: 's', cert: 'c', macaroon: 'm' })
    return adapter.estimateSendFee({ invoice: forged.invoice, timeoutMs })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    getWalletInfo.mockResolvedValue({ current_block_height: 840_000 })
  })

  it('answers the routing fee for THIS invoice, rounded up to sats', async () => {
    getRoutingFeeEstimate.mockResolvedValue({ fee_mtokens: '10500', timeout: 144 })
    await expect(estimate()).resolves.toEqual({ feeSats: 11 })
  })

  // The payment request goes over whole rather than being taken apart into a
  // destination and an amount: what is measured has to be what gets paid.
  it('hands the backend the invoice itself, under the caller’s time budget', async () => {
    getRoutingFeeEstimate.mockResolvedValue({ fee_mtokens: '1000', timeout: 144 })
    await estimate(5_000)
    expect(getRoutingFeeEstimate).toHaveBeenCalledWith(expect.objectContaining({ request: forged.invoice }))
    expect(getRoutingFeeEstimate).toHaveBeenCalledWith(expect.objectContaining({ timeout: 5_000 }))
  })

  it('never asks for a budget the vendor would round away into its own 60s default', async () => {
    getRoutingFeeEstimate.mockResolvedValue({ fee_mtokens: '1000', timeout: 144 })
    await estimate(200)
    expect(getRoutingFeeEstimate).toHaveBeenCalledWith(expect.objectContaining({ timeout: MIN_ROUTE_FEE_PROBE_MS }))
  })

  // A probe fails where a payment succeeds, so this is a missing price and not a
  // verdict on whether the invoice is payable.
  it('answers null when the probe finds nothing', async () => {
    getRoutingFeeEstimate.mockRejectedValue([404, 'RouteToDestinationNotFound', { failure: 'FAILURE_REASON_NO_ROUTE' }])
    await expect(estimate()).resolves.toBeNull()
  })

  it('answers null on a node too old for the call', async () => {
    getRoutingFeeEstimate.mockRejectedValue([503, 'UnexpectedGetRoutingFeeEstimateError', { err: { code: 12 } }])
    await expect(estimate()).resolves.toBeNull()
  })

  // Null here would hide a dead node behind "every quote falls back to the flat".
  it('re-throws a fault it does not recognise rather than quoting around it', async () => {
    getRoutingFeeEstimate.mockRejectedValue([503, 'UnexpectedGetRoutingFeeEstimateError', { err: { code: 14 } }])
    await expect(estimate()).rejects.toBeDefined()
  })

  // LND reserves nothing: the probe and the later payment are unconnected calls,
  // and a token would claim a link between them that does not exist.
  it('mints no handle, because nothing here is prepared to be spent against', async () => {
    getRoutingFeeEstimate.mockResolvedValue({ fee_mtokens: '10500', timeout: 144 })
    await expect(estimate()).resolves.not.toHaveProperty('feeHandle')
  })
})
