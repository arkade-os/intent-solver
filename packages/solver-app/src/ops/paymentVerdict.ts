/**
 * What became of a Lightning send's payment — the ONE implementation, shared by
 * the `read-payment` action and the float pass's swept-lockup reconciler.
 * Verdicts are named for what the caller MAY DO rather than for what the
 * backend said: "failed" next to a refund button has been misread before.
 * NEVER returns the preimage, only whether one exists.
 */

import type { LightningBackend } from '@arkade-os/solver-core/ports/lightning.js'
import type { Services } from './services.js'

export type PaymentVerdictName =
  | 'never-submitted'
  | 'not-paid-refund-is-safe'
  | 'paid-do-not-refund'
  | 'self-payment-do-not-refund'
  | 'other-wallet-push-nothing'
  | 'undecided-push-nothing'

export interface PaymentVerdict {
  verdict: PaymentVerdictName
  paymentId: string | null
  commitment?: string
  hasPreimage?: boolean
  status?: string
  ownInvoice?: string
  error?: string
  paidBy?: { backend: string | null; wallet: string | null }
  runningNow?: { backend: string | null; wallet: string | null }
}

export interface PaymentVerdictRow {
  paymentHash: string
  paymentId: string | null
  paymentBackend: string | null
  paymentWallet: string | null
}

const selfPaymentCheck = async (ln: LightningBackend, paymentHash: string): Promise<{ held: boolean; how: string }> => {
  const probe = ln.getOwnInvoiceState
  if (probe === undefined) return { held: false, how: 'probe-unavailable' }
  try {
    const own = (await probe.call(ln, paymentHash)) ?? null
    if (own === null) return { held: false, how: 'not-ours' }
    return { held: own.status !== 'pending' && own.status !== 'cancelled', how: own.status }
  } catch {
    return { held: false, how: 'probe-failed' }
  }
}

const commitmentByHash = async (
  ln: LightningBackend,
  paymentHash: string,
): Promise<{ commitment: string; status?: 'settled' | 'returned' | 'committed'; hasPreimage?: boolean }> => {
  const probe = ln.getSendHtlcState
  if (!probe) return { commitment: 'probe-unavailable' }
  let committed
  try {
    committed = await probe.call(ln, paymentHash)
  } catch {
    return { commitment: 'probe-failed' }
  }
  if (committed === null) return { commitment: 'none' }
  return { commitment: committed.status, status: committed.status, hasPreimage: Boolean(committed.preimage) }
}

export const paymentVerdict = async (services: Services, row: PaymentVerdictRow): Promise<PaymentVerdict> => {
  const ln = services.ln
  if (!ln) throw new Error('the Lightning rail is not available; a payment cannot be read without it')

  if (!row.paymentId) {
    // NOT proof nothing was submitted: a backend can commit against the hash
    // one call BEFORE it mints the id.
    const seen = await commitmentByHash(ln, row.paymentHash)
    if (seen.commitment === 'probe-unavailable') {
      return { paymentId: null, commitment: seen.commitment, verdict: 'never-submitted' }
    }
    if (seen.commitment === 'probe-failed') {
      return { paymentId: null, commitment: seen.commitment, verdict: 'undecided-push-nothing' }
    }
    if (seen.commitment === 'none') return { paymentId: null, commitment: seen.commitment, verdict: 'never-submitted' }
    const byHash = { paymentId: null, commitment: seen.commitment, hasPreimage: seen.hasPreimage === true }
    if (seen.status === 'settled') return { ...byHash, verdict: 'paid-do-not-refund' }
    if (seen.status === 'returned') return { ...byHash, verdict: 'not-paid-refund-is-safe' }
    return { ...byHash, verdict: 'undecided-push-nothing' }
  }

  // After a provider or seed change this lookup fails EXACTLY like a sick
  // database; null on either side is UNKNOWN, never a match.
  const running = await ln.walletFingerprint?.().catch(() => undefined)
  const foreignWallet = Boolean(running && row.paymentWallet && row.paymentWallet !== running)
  const foreignBackend = Boolean(row.paymentBackend && row.paymentBackend !== services.config.lnBackend)
  if (foreignWallet || foreignBackend) {
    return {
      paymentId: row.paymentId,
      paidBy: { backend: row.paymentBackend, wallet: row.paymentWallet },
      runningNow: { backend: services.config.lnBackend, wallet: running ?? null },
      verdict: 'other-wallet-push-nothing',
    }
  }

  let payment
  try {
    payment = await ln.getPayment(row.paymentId)
  } catch (error) {
    // Prod has a row whose id a since-replaced backend minted while the
    // wallet still held the htlc under the hash.
    const lost = { paymentId: row.paymentId, error: error instanceof Error ? error.message : String(error) }
    const byHash = await terminalByHash(ln, row)
    return byHash ? { ...lost, ...byHash } : { ...lost, verdict: 'undecided-push-nothing' }
  }
  const hasPreimage = Boolean(payment.preimage)
  const seen = { paymentId: row.paymentId, status: payment.status, hasPreimage }
  // A preimage IS settlement, whatever the status says.
  if (payment.status === 'succeeded' || hasPreimage) return { ...seen, verdict: 'paid-do-not-refund' }
  if (payment.status !== 'failed') {
    // Where a fork parks a `failed` it cannot tell from
    // PreimageProvidingFailed; only the htlc settles it. A `returned` beside a
    // still-pending id is a contradiction, so only a settlement is taken here.
    const byHash = await terminalByHash(ln, row)
    if (byHash?.verdict === 'paid-do-not-refund') return { ...seen, ...byHash }
    return { ...seen, ...(byHash ? { commitment: byHash.commitment } : {}), verdict: 'undecided-push-nothing' }
  }

  const own = await selfPaymentCheck(ln, row.paymentHash)
  if (own.held) return { ...seen, ownInvoice: own.how, verdict: 'self-payment-do-not-refund' }
  return { ...seen, ownInvoice: own.how, verdict: 'not-paid-refund-is-safe' }
}

const terminalByHash = async (
  ln: LightningBackend,
  row: PaymentVerdictRow,
): Promise<(Pick<PaymentVerdict, 'verdict'> & Omit<Partial<PaymentVerdict>, 'verdict'>) | null> => {
  const seen = await commitmentByHash(ln, row.paymentHash)
  if (seen.status === 'settled' && seen.hasPreimage) {
    return { commitment: seen.commitment, hasPreimage: true, verdict: 'paid-do-not-refund' }
  }
  if (seen.status !== 'returned') return null
  const own = await selfPaymentCheck(ln, row.paymentHash)
  return {
    commitment: seen.commitment,
    ownInvoice: own.how,
    verdict: own.held ? 'self-payment-do-not-refund' : 'not-paid-refund-is-safe',
  }
}
