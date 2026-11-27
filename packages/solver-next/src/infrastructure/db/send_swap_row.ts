import { Amount } from '../../domain/shared/amount.js'
import { Asset } from '../../domain/shared/asset.js'
import { RfqId, SwapId } from '../../domain/shared/ids.js'
import { UnixSeconds } from '../../domain/shared/time.js'
import { Hashlock, Preimage } from '../../domain/swap/hashlock.js'
import { Leg, Reference, type LegState } from '../../domain/swap/leg.js'
import { Quote } from '../../domain/swap/quote.js'
import { Swap } from '../../domain/swap/swap.js'
import { SwapOutcome } from '../../domain/swap/swap_state.js'

const BTC = Asset.of('BTC')

type Failed = 'refused' | 'stuck'
type Lived = 'quoted' | 'funded' | 'paying' | 'paid' | 'claiming' | 'claimed'

/** The columns of `swap` a Lightning send is read from. The table has more; they describe the contract and the payment. */
export interface SendSwapRecord {
  readonly id: string
  readonly state: Lived | Failed
  readonly updatedAt: number
  readonly paymentHash: string
  /** What the client locks: the invoice and our fee. */
  readonly amountSats: number
  /** The invoice alone. It is not a column: the caller reads it from the invoice. */
  readonly invoiceSats: number
  readonly invoiceExpiresAt: number
  readonly quotedRefundDeadline: number | null
  readonly lockupTxid: string | null
  readonly lockupVout: number | null
  readonly payAttemptedAt: number | null
  readonly paymentId: string | null
  readonly preimage: string | null
  readonly claimArkTxid: string | null
  readonly refundArkTxid: string | null
  readonly failureReason: string | null
  readonly rfqId: string | null
}

const legsAt = (row: SendSwapRecord, state: Lived): readonly [from: LegState, to: LegState] => {
  switch (state) {
    case 'quoted':
      return ['pending', 'pending']
    case 'funded':
      return ['locked', 'pending']
    case 'paying':
      return ['locked', 'locking']
    case 'paid':
      // The node says it paid. Until the preimage is read the domain has nothing to call the leg filled with.
      return ['locked', row.preimage ? 'claimed' : 'locking']
    case 'claiming':
      return ['claiming', 'claimed']
    case 'claimed':
      return ['claimed', 'claimed']
  }
}

// A failed row forgets the state it failed from. This is the furthest one its columns still prove.
const lastProven = (row: SendSwapRecord): Lived => {
  if (row.preimage) return 'paid'
  if (row.paymentId !== null || row.payAttemptedAt !== null) return 'paying'
  return row.lockupTxid !== null ? 'funded' : 'quoted'
}

const isFailed = (state: Lived | Failed): state is Failed => state === 'refused' || state === 'stuck'

const references = (...values: (string | null)[]): Reference[] =>
  values.filter((value): value is string => value !== null).map(Reference.of)

const time = (seconds: number | null): UnixSeconds | null => (seconds === null ? null : UnixSeconds.of(seconds))

export const swapFromSendRow = (row: SendSwapRecord): Swap => {
  const failed = isFailed(row.state)
  const [from, to] = legsAt(row, isFailed(row.state) ? lastProven(row) : row.state)
  // The row keeps one timestamp for both legs; only the payment attempt has its own.
  const changed = UnixSeconds.of(row.updatedAt)
  const sentAt = to === 'locking' ? time(row.payAttemptedAt) : null
  const lockup =
    row.lockupTxid === null || row.lockupVout === null ? row.lockupTxid : `${row.lockupTxid}:${row.lockupVout}`
  return Swap.restore(
    {
      id: SwapId.of(row.id),
      rfqId: row.rfqId === null ? null : RfqId.of(row.rfqId),
      quote: Quote.of(UnixSeconds.of(row.invoiceExpiresAt), {
        fee: Amount.of(BTC, BigInt(Math.max(0, row.amountSats - row.invoiceSats))),
        spreadBps: 0,
      }),
      hashlock: Hashlock.of(row.paymentHash),
      preimage: row.preimage ? Preimage.of(row.preimage) : null,
      from: Leg.restore(
        'from',
        { rail: 'arkade', amount: Amount.of(BTC, BigInt(row.amountSats)), contract: 'vhtlc', version: null },
        from,
        { funding: references(lockup), claim: references(row.claimArkTxid), refund: references(row.refundArkTxid) },
        changed,
        time(row.quotedRefundDeadline),
      ),
      to: Leg.restore(
        'to',
        { rail: 'lightning', amount: Amount.of(BTC, BigInt(row.invoiceSats)), contract: 'lightning', version: null },
        to,
        { funding: references(row.paymentId), claim: [], refund: [] },
        sentAt ?? changed,
      ),
      outcome: failed ? (row.state === 'refused' ? SwapOutcome.Refused : SwapOutcome.Stuck) : null,
      outcomeReason: failed ? row.failureReason : null,
    },
    // The row has no revision column. Every write moves `updated_at` forward, so it serves as one.
    row.updatedAt,
  )
}
