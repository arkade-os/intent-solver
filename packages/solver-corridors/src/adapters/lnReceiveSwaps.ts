import { Amount } from '@arkade-os/solver-core/domain/shared/amount.js'
import { Asset } from '@arkade-os/solver-core/domain/shared/asset.js'
import { Rail } from '@arkade-os/solver-core/domain/shared/endpoint.js'
import { RfqId, SwapId } from '@arkade-os/solver-core/domain/shared/ids.js'
import { UnixSeconds } from '@arkade-os/solver-core/domain/shared/time.js'
import { Hashlock, Preimage } from '@arkade-os/solver-core/domain/swap/hashlock.js'
import { ContractKind, Leg, Reference, Side, type LegState } from '@arkade-os/solver-core/domain/swap/leg.js'
import { AmountMode, Quote } from '@arkade-os/solver-core/domain/swap/quote.js'
import { Swap } from '@arkade-os/solver-core/domain/swap/swap.js'
import type { SwapRepository } from '@arkade-os/solver-core/domain/swap/swap_repo.js'
import { SwapOutcome } from '@arkade-os/solver-core/domain/swap/swap_state.js'
import type { ReceiveSwapRow, ReceiveSwapState, ReceiveSwapStore } from '../db/receiveSwaps.js'

const BTC = Asset.of('BTC')

type Failed = 'refused' | 'stuck'
type Lived = Exclude<ReceiveSwapState, Failed>

const legsAt = (row: ReceiveSwapRow, state: Lived): readonly [from: LegState, to: LegState] => {
  switch (state) {
    case 'quoted':
      return ['pending', 'pending']
    case 'armed':
      // The fund lease is the row's only trace of a payout that may be in flight.
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
      // The hold is cancelled best-effort and never recorded, so the row only proves it was held.
      return ['locked', 'refunded']
  }
}

// For a failed row whose history does not say where it failed from.
const lastProven = (row: ReceiveSwapRow): Lived => {
  if (row.preimage !== null) return 'claimed'
  if (row.arkadeLockupTxid !== null) return 'funded'
  return row.htlcExpiresAt !== null || row.fundStartedAt !== null ? 'armed' : 'quoted'
}

const isFailed = (state: ReceiveSwapState): state is Failed => state === 'refused' || state === 'stuck'

/** `failedFrom`: the state a `refused` / `stuck` row was in before, which the row itself forgets. */
export const swapFromReceiveRow = (row: ReceiveSwapRow, failedFrom: Lived | null = null): Swap => {
  const failed = isFailed(row.state)
  const [from, to] = legsAt(row, isFailed(row.state) ? (failedFrom ?? lastProven(row)) : row.state)
  const lockup =
    row.arkadeLockupTxid === null ? [] : [Reference.of(`${row.arkadeLockupTxid}:${row.arkadeLockupVout ?? 0}`)]
  const amount = Amount.of(BTC, BigInt(row.amountSats))
  const payout = Amount.of(BTC, BigInt(row.payoutSats))
  return Swap.fromSnapshot(
    {
      id: SwapId.of(row.id),
      rfqId: row.rfqId === null ? null : RfqId.of(row.rfqId),
      // Not kept on the row; both amounts were fixed at the quote, so nothing reads it back.
      amountMode: AmountMode.ExactIn,
      quote: Quote.of(UnixSeconds.of(row.invoiceExpiresAt), { fee: amount.minus(payout), spreadBps: 0 }),
      hashlock: Hashlock.of(row.paymentHash),
      preimage: row.preimage === null ? null : Preimage.of(row.preimage),
      from: Leg.restore(
        Side.From,
        { rail: Rail.Lightning, amount, contract: ContractKind.Lightning, version: null },
        from,
        { funding: [], claim: [], refund: [] },
      ),
      to: Leg.restore(Side.To, { rail: Rail.Arkade, amount: payout, contract: ContractKind.Vhtlc, version: null }, to, {
        funding: lockup,
        claim: [],
        refund: row.refundArkTxid === null ? [] : [Reference.of(row.refundArkTxid)],
      }),
      outcome: failed ? (row.state === 'refused' ? SwapOutcome.Refused : SwapOutcome.Stuck) : null,
      outcomeReason: failed ? row.failureReason : null,
    },
    // The legacy row has no revision; its last write is the closest thing to one.
    row.updatedAt,
  )
}

/** Reads `receive_swap` as swaps. Writes still go through the legacy orchestrator. */
export class LnReceiveSwaps implements Pick<SwapRepository, 'findByRfqId' | 'findLiveByHash'> {
  constructor(private readonly store: ReceiveSwapStore) {}

  async findByRfqId(rfqId: RfqId): Promise<Swap | null> {
    const row = await this.store.findByRfqId(rfqId)
    return row === null ? null : this.load(row)
  }

  async findLiveByHash(hashlock: Hashlock): Promise<readonly Swap[]> {
    const row = await this.store.findLiveByPaymentHash(hashlock)
    return row === null ? [] : [await this.load(row)]
  }

  async load(row: ReceiveSwapRow): Promise<Swap> {
    if (!isFailed(row.state)) return swapFromReceiveRow(row)
    const failure = (await this.store.history(row.id)).findLast((e) => e.to === row.state && e.from !== e.to)
    return swapFromReceiveRow(row, (failure?.from ?? null) as Lived | null)
  }
}
