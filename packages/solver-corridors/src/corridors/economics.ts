/**
 * Which of each corridor's columns the solver RECEIVED, and which it PAID OUT.
 *
 * The companion to `projections.ts` and the same kind of knowledge: only the
 * corridor knows that its inbound number is the client's lockup on one leg and
 * the hold invoice on another. Getting the pair the wrong way round reports a
 * loss as a profit, on a screen built to be trusted — which is why the
 * subtraction itself lives in core (`analytics/economics.ts`) and every
 * corridor here only names its two columns.
 *
 * The four BTC corridors agree on more than they look: all of them take
 * `amount_sats` from the client and deliver `payout_sats`. Lightning-send is
 * the exception, and it is a real one — that corridor has no payout column at
 * all (see `projections.ts`), because it quotes the invoice amount directly.
 * There the solver's intake is whatever the lockup actually held and its outlay
 * is the invoice, so the two columns are swapped relative to its siblings.
 */
import { economicsOf, type SwapEconomics } from '@arkade-os/solver-core/analytics/economics.js'
import { phaseOfStates } from '@arkade-os/solver-core/core/swapView.js'
import type { CorridorDescriptor } from '@arkade-os/solver-core/core/corridorDescriptor.js'
import { LN_SEND, LN_RECEIVE, ONCHAIN_SEND, ONCHAIN_RECEIVE } from './index.js'
import { presentedState } from './projections.js'
import type { SendSwapRow } from '../db/swaps.js'
import type { ReceiveSwapRow } from '../db/receiveSwaps.js'
import type { OnchainSendSwapRow } from '../db/onchainSwaps.js'
import type { OnchainReceiveSwapRow } from '../db/onchainReceiveSwaps.js'
import type { AssetRfqSwapRow } from '../db/assetRfqSwaps.js'

/**
 * The word every store in this package sends an EXPOSED failure to — each one's
 * `failStates.exposed`, and the asset store's `fail()` routing.
 *
 * A row here is one where the solver paid out and was not made whole, which is
 * the only state this layer is willing to call a LOSS. `refused` is not one:
 * the capital came back. A live exposed row is not one either: it may still
 * claim.
 */
const LOST = 'stuck'

const sats = (amount: number | null): { assetId: null; amount: string | null; decimals: number } => ({
  assetId: null,
  amount: amount === null ? null : String(amount),
  decimals: 8,
})

/**
 * Lightning send. Inbound is the LOCKUP, not `amountSats`.
 *
 * `amountSats` is the invoice this solver pays; what it takes in is whatever
 * the client's covenant actually held, which is null until the lockup is seen.
 * Null rather than the quoted figure on purpose — before funding there is no
 * intake, and substituting the quote would book a spread on a swap that may
 * never happen.
 */
export const sendEconomics = (row: SendSwapRow): SwapEconomics => {
  const state = presentedState(row.state, row.refundOutcome)
  return economicsOf({
    id: row.id,
    corridor: LN_SEND.pair,
    state,
    phase: phaseOfStates(LN_SEND.states, state),
    quotedAt: row.createdAt,
    settledAt: row.updatedAt,
    inbound: sats(row.lockupValue),
    outbound: sats(row.amountSats),
    lost: row.state === LOST,
  })
}

export const receiveEconomics = (row: ReceiveSwapRow): SwapEconomics =>
  economicsOf({
    id: row.id,
    corridor: LN_RECEIVE.pair,
    state: row.state,
    phase: phaseOfStates(LN_RECEIVE.states, row.state),
    quotedAt: row.createdAt,
    settledAt: row.updatedAt,
    inbound: sats(row.amountSats),
    outbound: sats(row.payoutSats),
    lost: row.state === LOST,
  })

export const onchainSendEconomics = (row: OnchainSendSwapRow): SwapEconomics => {
  const state = presentedState(row.state, row.refundOutcome)
  return economicsOf({
    id: row.id,
    corridor: ONCHAIN_SEND.pair,
    state,
    phase: phaseOfStates(ONCHAIN_SEND.states, state),
    quotedAt: row.createdAt,
    settledAt: row.updatedAt,
    inbound: sats(row.amountSats),
    outbound: sats(row.payoutSats),
    lost: row.state === LOST,
  })
}

/**
 * Onchain receive, read from the AMENDED pair when there is one.
 *
 * `fundedValueSats`/`fundedPayoutSats` record what the client's output actually
 * held and the payout re-derived against it, and they must be read TOGETHER:
 * mixing the amended intake with the quoted payout invents a spread neither
 * number describes. Absence means the swap was never amended, so the quoted
 * pair is the fact.
 */
export const onchainReceiveEconomics = (row: OnchainReceiveSwapRow): SwapEconomics =>
  economicsOf({
    id: row.id,
    corridor: ONCHAIN_RECEIVE.pair,
    state: row.state,
    phase: phaseOfStates(ONCHAIN_RECEIVE.states, row.state),
    quotedAt: row.createdAt,
    settledAt: row.updatedAt,
    inbound: sats(row.fundedValueSats ?? row.amountSats),
    outbound: sats(row.fundedPayoutSats ?? row.payoutSats),
    lost: row.state === LOST,
  })

/**
 * The asset RFQ leg — the only corridor whose economics are an FX RATE.
 *
 * Its two legs can be different assets, so there is no sats spread to report
 * and `economicsOf` answers null for one. What it does carry is the executed
 * rate, and `durationSeconds` beside it: a quote here commits this solver to a
 * price until `valid_until` while the market moves underneath, so the pair
 * together is what makes a drawn-out fill legible as the loss it can be.
 *
 * The inbound leg is the client's DEPOSIT and the outbound is what the covenant
 * obliges any spend to deliver — the same direction as `from`/`to` on the row,
 * which is stated from the client's side and happens to coincide.
 *
 * Decimals are null rather than guessed: they are a property of the market
 * config (`admin_market`), which this store does not hold, and an assumed 8
 * against a 6-decimal stablecoin is wrong by a hundredfold.
 */
export const assetRfqEconomics = (row: AssetRfqSwapRow, descriptor: CorridorDescriptor): SwapEconomics =>
  economicsOf({
    id: row.id,
    corridor: descriptor.pair,
    state: row.state,
    phase: phaseOfStates(descriptor.states, row.state),
    quotedAt: row.createdAt,
    settledAt: row.updatedAt,
    inbound: { assetId: row.fromAssetId, amount: row.fromAmount.toString(), decimals: null },
    outbound: { assetId: row.toAssetId, amount: row.toAmount.toString(), decimals: null },
    lost: row.state === LOST,
  })
