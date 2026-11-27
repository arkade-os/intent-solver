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
type Lived = 'quoted' | 'armed' | 'funded' | 'claimed' | 'refunding' | 'settled' | 'refunded'

/** The columns of `receive_swap` a swap is read from. The table has more; they describe the contract. */
export interface ReceiveSwapRecord {
  readonly id: string
  readonly state: Lived | Failed
  readonly updatedAt: number
  readonly paymentHash: string
  readonly amountSats: number
  readonly payoutSats: number
  readonly invoiceExpiresAt: number
  readonly htlcExpiresAt: number | null
  readonly fundStartedAt: number | null
  readonly arkadeLockupTxid: string | null
  readonly arkadeLockupVout: number | null
  readonly settleAttemptedAt: number | null
  readonly preimage: string | null
  readonly refundArkTxid: string | null
  readonly failureReason: string | null
  readonly rfqId: string | null
}

const legsAt = (row: ReceiveSwapRecord, state: Lived): readonly [from: LegState, to: LegState] => {
  switch (state) {
    case 'quoted':
      return ['pending', 'pending']
    case 'armed':
      // The fund lease is the row's only trace of a fill that may be in flight.
      return ['locked', row.fundStartedAt === null ? 'pending' : 'locking']
    case 'funded':
      return ['locked', 'locked']
    case 'claimed':
      return [row.settleAttemptedAt === null ? 'locked' : 'claiming', 'claimed']
    case 'refunding':
      return ['locked', 'refunding']
    case 'settled':
      return ['claimed', 'claimed']
    case 'refunded':
      // The hold is left to expire and that is never recorded, so the row only proves it was armed.
      return ['locked', 'refunded']
  }
}

// A failed row forgets the state it failed from. This is the furthest one its columns still prove.
const lastProven = (row: ReceiveSwapRecord): Lived => {
  if (row.preimage !== null) return 'claimed'
  if (row.arkadeLockupTxid !== null) return 'funded'
  return row.htlcExpiresAt !== null || row.fundStartedAt !== null ? 'armed' : 'quoted'
}

const isFailed = (state: Lived | Failed): state is Failed => state === 'refused' || state === 'stuck'

// A lockup recorded without its output index stays a bare txid: nothing here guesses which output is ours.
const lockupOf = (row: ReceiveSwapRecord): Reference[] => {
  if (row.arkadeLockupTxid === null) return []
  const vout = row.arkadeLockupVout
  return [Reference.of(vout === null ? row.arkadeLockupTxid : `${row.arkadeLockupTxid}:${vout}`)]
}

const time = (seconds: number | null): UnixSeconds | null => (seconds === null ? null : UnixSeconds.of(seconds))

export const swapFromReceiveRow = (row: ReceiveSwapRecord): Swap => {
  const failed = isFailed(row.state)
  const [from, to] = legsAt(row, isFailed(row.state) ? lastProven(row) : row.state)
  // The row keeps one timestamp for both legs; only the fund lease has its own.
  const changed = UnixSeconds.of(row.updatedAt)
  const fillStarted = to === 'locking' ? time(row.fundStartedAt) : null
  const amount = Amount.of(BTC, BigInt(row.amountSats))
  const payout = Amount.of(BTC, BigInt(row.payoutSats))
  const fee = Amount.of(BTC, BigInt(Math.max(0, row.amountSats - row.payoutSats)))
  const refund = row.refundArkTxid === null ? [] : [Reference.of(row.refundArkTxid)]
  return Swap.restore(
    {
      id: SwapId.of(row.id),
      rfqId: row.rfqId === null ? null : RfqId.of(row.rfqId),
      quote: Quote.of(UnixSeconds.of(row.invoiceExpiresAt), { fee, spreadBps: 0 }),
      hashlock: Hashlock.of(row.paymentHash),
      preimage: row.preimage === null ? null : Preimage.of(row.preimage),
      from: Leg.restore(
        'from',
        { rail: 'lightning', amount, contract: 'lightning', version: null },
        from,
        { funding: [], claim: [], refund: [] },
        changed,
        time(row.htlcExpiresAt),
      ),
      to: Leg.restore(
        'to',
        { rail: 'arkade', amount: payout, contract: 'vhtlc', version: null },
        to,
        { funding: lockupOf(row), claim: [], refund },
        fillStarted ?? changed,
      ),
      outcome: failed ? (row.state === 'refused' ? SwapOutcome.Refused : SwapOutcome.Stuck) : null,
      outcomeReason: failed ? row.failureReason : null,
    },
    // The row has no revision column. Every write moves `updated_at` forward, so it serves as one.
    row.updatedAt,
  )
}
