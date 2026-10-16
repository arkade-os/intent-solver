/**
 * The by-hash fallback for a row that already HAS a payment id — neither prod
 * row that drove this change can be settled from the id alone. The id path's
 * own verdicts are covered by `test/admin/readPayment.test.ts`, which drives
 * this same function through the action that renders it.
 */
import { describe, it, expect, vi } from 'vitest'
import { paymentVerdict } from '@arkade-os/solver-app/ops/paymentVerdict.js'
import type { Services } from '@arkade-os/solver-app/ops/services.js'

const ROW = {
  paymentHash: 'aa'.repeat(32),
  paymentId: 'SparkLightningSendRequest:01a01c28',
  paymentBackend: null,
  paymentWallet: null,
}

const servicesWith = (over: {
  getPaymentThrows?: string
  status?: 'succeeded' | 'failed' | 'pending'
  preimage?: string
  byHash?: { status: 'committed' | 'settled' | 'returned'; preimage?: string } | null
  byHashThrows?: boolean
  noHashProbe?: boolean
  ownInvoice?: { status: 'pending' | 'armed' | 'settled' | 'cancelled' } | null
  backend?: string | null
  rowBackend?: string | null
}): Services =>
  ({
    config: { lnBackend: over.backend === undefined ? null : over.backend },
    ln: {
      getPayment: async (id: string) => {
        if (over.getPaymentThrows !== undefined) throw new Error(over.getPaymentThrows)
        return { id, status: over.status ?? 'pending', ...(over.preimage ? { preimage: over.preimage } : {}) }
      },
      ...(over.noHashProbe === true
        ? {}
        : {
            getSendHtlcState: async () => {
              if (over.byHashThrows === true) throw new Error('backend unreachable')
              return over.byHash ?? null
            },
          }),
      ...(over.ownInvoice === undefined ? {} : { getOwnInvoiceState: async () => over.ownInvoice }),
    },
  }) as unknown as Services

describe('paymentVerdict falls back to the payment hash when the id cannot settle it', () => {
  it('reads a returned htlc as a terminal failure, through the self-payment probe', async () => {
    const verdict = await paymentVerdict(
      servicesWith({ getPaymentThrows: 'Payment not found', byHash: { status: 'returned' }, ownInvoice: null }),
      ROW,
    )
    expect(verdict).toMatchObject({
      verdict: 'not-paid-refund-is-safe',
      commitment: 'returned',
      ownInvoice: 'not-ours',
    })
    expect(verdict.error).toContain('Payment not found')
  })

  it('still withholds on a returned htlc our own node can collect against', async () => {
    const verdict = await paymentVerdict(
      servicesWith({
        getPaymentThrows: 'Payment not found',
        byHash: { status: 'returned' },
        ownInvoice: { status: 'settled' },
      }),
      ROW,
    )
    expect(verdict.verdict).toBe('self-payment-do-not-refund')
  })

  it('reads a settled htlc with a preimage as paid, whatever the id lookup said', async () => {
    const verdict = await paymentVerdict(
      servicesWith({ status: 'pending', byHash: { status: 'settled', preimage: 'cd'.repeat(32) } }),
      ROW,
    )
    expect(verdict).toMatchObject({ verdict: 'paid-do-not-refund', hasPreimage: true })
    expect(JSON.stringify(verdict)).not.toContain('cd'.repeat(32))
  })

  it('stays undecided on a settled htlc with no preimage: money gone that we cannot claim against', async () => {
    const verdict = await paymentVerdict(servicesWith({ status: 'pending', byHash: { status: 'settled' } }), ROW)
    expect(verdict.verdict).toBe('undecided-push-nothing')
  })

  it('holds when the id still reads pending but the hash reads returned', async () => {
    const verdict = await paymentVerdict(
      servicesWith({ status: 'pending', byHash: { status: 'returned' }, ownInvoice: null }),
      ROW,
    )
    expect(verdict).toMatchObject({ verdict: 'undecided-push-nothing', commitment: 'returned' })
  })

  it('stays undecided while the htlc is still committed', async () => {
    const verdict = await paymentVerdict(servicesWith({ status: 'pending', byHash: { status: 'committed' } }), ROW)
    expect(verdict.verdict).toBe('undecided-push-nothing')
  })

  // The prod fork's case: its lookup scans only the newest 200 sends and the
  // row is 379 back, so null here is NOT "never submitted".
  it('stays undecided when the hash probe answers null for a row that has an id', async () => {
    const verdict = await paymentVerdict(servicesWith({ status: 'pending', byHash: null }), ROW)
    expect(verdict.verdict).toBe('undecided-push-nothing')
  })

  it('stays undecided when the hash probe throws, or does not exist', async () => {
    await expect(paymentVerdict(servicesWith({ status: 'pending', byHashThrows: true }), ROW)).resolves.toMatchObject({
      verdict: 'undecided-push-nothing',
    })
    await expect(paymentVerdict(servicesWith({ status: 'pending', noHashProbe: true }), ROW)).resolves.toMatchObject({
      verdict: 'undecided-push-nothing',
    })
  })

  it('never reaches the hash probe once the id proves settlement', async () => {
    const probe = vi.fn(async () => ({ status: 'returned' as const }))
    const services = servicesWith({ status: 'succeeded' })
    ;(services.ln as unknown as { getSendHtlcState: unknown }).getSendHtlcState = probe
    expect((await paymentVerdict(services, ROW)).verdict).toBe('paid-do-not-refund')
    expect(probe).not.toHaveBeenCalled()
  })

  it('refuses to decide at all for an id another backend minted, before any probe runs', async () => {
    const probe = vi.fn(async () => ({ status: 'returned' as const }))
    const services = servicesWith({ backend: 'lnd', byHash: { status: 'returned' } })
    ;(services.ln as unknown as { getSendHtlcState: unknown }).getSendHtlcState = probe
    const verdict = await paymentVerdict(services, { ...ROW, paymentBackend: 'spark' })
    expect(verdict.verdict).toBe('other-wallet-push-nothing')
    expect(probe).not.toHaveBeenCalled()
  })

  it('refuses to decide for an id minted from another seed on the same backend', async () => {
    const services = servicesWith({ backend: 'spark-breez' })
    ;(services.ln as unknown as { walletFingerprint: unknown }).walletFingerprint = async () => 'wallet-now'
    const verdict = await paymentVerdict(services, {
      ...ROW,
      paymentBackend: 'spark-breez',
      paymentWallet: 'wallet-then',
    })
    expect(verdict).toMatchObject({
      verdict: 'other-wallet-push-nothing',
      paidBy: { backend: 'spark-breez', wallet: 'wallet-then' },
      runningNow: { backend: 'spark-breez', wallet: 'wallet-now' },
    })
  })

  it('refuses without a Lightning rail rather than guessing', async () => {
    await expect(paymentVerdict({ ln: null } as unknown as Services, ROW)).rejects.toThrow(/Lightning rail/)
  })
})
