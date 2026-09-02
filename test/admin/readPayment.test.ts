/**
 * `read-payment` — the console action that answers the one question a `stuck`
 * row cannot answer about itself.
 *
 * `stuck` means the payment was already EXPOSED when it failed: the row does
 * not know whether the sats left. It is also terminal — `step()` has no case
 * for it and the sweep skips it — so `recheck` re-polls nothing and the row
 * stays stuck forever. Observed in production: a 50,151-sat row sat stuck for
 * four days, and resolving it needed a shell on the host.
 *
 * The verdict strings are the point. An operator is deciding refund-versus-
 * claim with real money, and "succeeded" rendered next to a refund button has
 * been misread before, so the action says what to DO rather than leaving the
 * reader to map a status onto an action.
 */

import { describe, it, expect } from 'vitest'
import { ACTIONS } from '@arkade-os/solver-app/admin/routes/actions.js'
import type { Services } from '@arkade-os/solver-app/ops/services.js'

const LN_SEND = 'arkade:BTC->lightning:BTC'

const servicesWith = (over: {
  paymentId?: string | null
  status?: 'succeeded' | 'failed' | 'pending'
  preimage?: string
  /** What our OWN node says about this invoice, when it can be asked at all. */
  ownInvoice?: { status: 'pending' | 'armed' | 'settled' | 'cancelled' } | null
  ownInvoiceThrows?: boolean
  getPaymentThrows?: string
}): Services =>
  ({
    store: { get: async () => ({ id: 'swap-1', paymentId: over.paymentId ?? null, paymentHash: 'aa'.repeat(32) }) },
    ln: {
      getPayment: async (id: string) => {
        if (over.getPaymentThrows !== undefined) throw new Error(over.getPaymentThrows)
        return {
          id,
          status: over.status ?? 'pending',
          ...(over.preimage ? { preimage: over.preimage } : {}),
        }
      },
      ...(over.ownInvoice !== undefined || over.ownInvoiceThrows === true
        ? {
            getOwnInvoiceState: async () => {
              if (over.ownInvoiceThrows === true) throw new Error('node unreachable')
              return over.ownInvoice ?? null
            },
          }
        : {}),
    },
  }) as unknown as Services

const read = (services: Services) => ACTIONS['read-payment']!.run(services, { id: 'swap-1', corridor: LN_SEND })

describe('read-payment', () => {
  it('is safe-tier: it decides an armed action, it is not one', async () => {
    // Deliberately not armed. It moves nothing, and putting a confirmation in
    // front of the only way to LEARN whether refunding is safe would push
    // operators toward pushing the refund blind.
    expect(ACTIONS['read-payment']!.tier).toBe('safe')
  })

  it('says do-not-refund when the payment settled', async () => {
    const result = (await read(servicesWith({ paymentId: 'p1', status: 'succeeded' }))) as Record<string, unknown>
    expect(result.verdict).toBe('paid-do-not-refund')
  })

  it('says do-not-refund on a preimage even if the status has not caught up', async () => {
    // A preimage IS settlement — it is the proof the payee released. Trusting
    // only the status word would call this undecided and invite a refund of a
    // swap that was paid.
    const result = (await read(
      servicesWith({ paymentId: 'p1', status: 'pending', preimage: 'ab'.repeat(32) }),
    )) as Record<string, unknown>
    expect(result.verdict).toBe('paid-do-not-refund')
  })

  it('says refund-is-safe only on a terminal failure', async () => {
    const result = (await read(servicesWith({ paymentId: 'p1', status: 'failed' }))) as Record<string, unknown>
    expect(result.verdict).toBe('not-paid-refund-is-safe')
  })

  /**
   * The finding that made this file worth re-reading. A payer-side "failed" is
   * NOT sufficient on its own: `refundProvenSelfPayment` withholds the refund
   * when our own node holds an armed or settled htlc for the same invoice,
   * because the payee side may still collect. That is precisely the row type
   * that parks in `stuck` — so it is precisely the row an operator opens this
   * action for, and answering `not-paid-refund-is-safe` would steer them into
   * the double payout the withhold exists to prevent.
   */
  for (const status of ['armed', 'settled'] as const) {
    it(`does NOT say refund-is-safe when our own node holds an ${status} htlc`, async () => {
      const result = (await read(
        servicesWith({ paymentId: 'p1', status: 'failed', ownInvoice: { status } }),
      )) as Record<string, unknown>
      expect(result.verdict).toBe('self-payment-do-not-refund')
      expect(result.ownInvoice).toBe(status)
    })
  }

  /**
   * The other side of the same probe. `pending` and `cancelled` are exactly the
   * two the orchestrator lets through, and this mirrors it rather than
   * inventing a second rule that can drift from the one that decides.
   */
  for (const status of ['pending', 'cancelled'] as const) {
    it(`still says refund-is-safe when our own htlc is ${status}`, async () => {
      const result = (await read(
        servicesWith({ paymentId: 'p1', status: 'failed', ownInvoice: { status } }),
      )) as Record<string, unknown>
      expect(result.verdict).toBe('not-paid-refund-is-safe')
    })
  }

  it('distinguishes "not ours" from "could not ask"', async () => {
    // Both allow the refund, matching the orchestrator — but only one of them
    // means the question was actually answered, and an operator weighing a
    // 50k-sat push deserves to know which one they are looking at.
    const notOurs = (await read(servicesWith({ paymentId: 'p1', status: 'failed', ownInvoice: null }))) as Record<
      string,
      unknown
    >
    expect(notOurs).toMatchObject({ verdict: 'not-paid-refund-is-safe', ownInvoice: 'not-ours' })

    const threw = (await read(servicesWith({ paymentId: 'p1', status: 'failed', ownInvoiceThrows: true }))) as Record<
      string,
      unknown
    >
    expect(threw).toMatchObject({ verdict: 'not-paid-refund-is-safe', ownInvoice: 'probe-failed' })

    const absent = (await read(servicesWith({ paymentId: 'p1', status: 'failed' }))) as Record<string, unknown>
    expect(absent).toMatchObject({ verdict: 'not-paid-refund-is-safe', ownInvoice: 'probe-unavailable' })
  })

  /**
   * `submitPayment` can fail between allocating an id and persisting it, so the
   * backend legitimately has no record of an id the row carries — one of the
   * exact cases this action exists for. Left uncaught the operator got a raw
   * error instead of a verdict.
   */
  it('returns a verdict, not an exception, when the backend has never heard of the id', async () => {
    const result = (await read(servicesWith({ paymentId: 'p1', getPaymentThrows: 'payment p1 not found' }))) as Record<
      string,
      unknown
    >
    // Not `never-submitted`: a backend that has FORGOTTEN a payment looks
    // identical from here, and that difference is worth real money.
    expect(result.verdict).toBe('undecided-push-nothing')
    expect(result.error).toContain('not found')
  })

  it('says push-nothing while the payment is still undecided', async () => {
    // The costly direction. Pending is not failure, and refunding here is the
    // double payout the row parked in `stuck` to prevent.
    const result = (await read(servicesWith({ paymentId: 'p1', status: 'pending' }))) as Record<string, unknown>
    expect(result.verdict).toBe('undecided-push-nothing')
  })

  it('answers without calling the backend when no payment was ever submitted', async () => {
    let called = false
    const services = {
      store: { get: async () => ({ id: 'swap-1', paymentId: null }) },
      ln: {
        getPayment: async () => {
          called = true
          throw new Error('should not be called')
        },
      },
    } as unknown as Services
    const result = (await ACTIONS['read-payment']!.run(services, { id: 'swap-1', corridor: LN_SEND })) as Record<
      string,
      unknown
    >
    expect(result.verdict).toBe('never-submitted')
    expect(called).toBe(false)
  })

  it('NEVER returns the preimage itself', async () => {
    // The console's one rule about `P`. Knowing one exists is what decides
    // refund-versus-claim; the value would then live in a browser, a
    // screenshot and a support thread.
    const preimage = 'ab'.repeat(32)
    const result = (await read(servicesWith({ paymentId: 'p1', status: 'succeeded', preimage }))) as Record<
      string,
      unknown
    >
    expect(result.hasPreimage).toBe(true)
    expect(JSON.stringify(result)).not.toContain(preimage)
    expect(Object.keys(result)).not.toContain('preimage')
  })

  it('refuses a corridor that does not pay over Lightning', async () => {
    await expect(
      ACTIONS['read-payment']!.run(servicesWith({ paymentId: 'p1' }), {
        id: 'swap-1',
        corridor: 'arkade:BTC->onchain:BTC',
      }),
    ).rejects.toThrow(/different rail/)
  })
})
