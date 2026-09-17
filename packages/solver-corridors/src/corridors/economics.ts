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
import { amountSatsOf } from '@arkade-os/solver-core/invoice/decode.js'
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
 * Did the client's money actually ARRIVE?
 *
 * The ledger is a window over every row, `quoted` and lapsed ones included, and
 * a quote is a set of TERMS rather than a record of anything that happened.
 * Reporting its amounts as an intake gives an unfunded row a spread and an
 * executed-looking rate — which is the same class of mistake as reporting a
 * corridor at zero instead of unmeasured, and it contradicts the rule this
 * module opens with.
 *
 * Each corridor answers from its own evidence. Two shapes appear below:
 *
 *  - **A column**, where one exists, is exact — a lockup value, a deposit
 *    txid, a held-HTLC deadline.
 *  - **The lifecycle**, where no column records the client's side. `quoted`
 *    means "nothing has moved" in every store's own vocabulary, and a
 *    `refused` row is the ambiguous one: it is a lapsed quote when nothing was
 *    refunded, and a funded swap that was given back when something was. That
 *    is precisely what `refundOutcome` records, which is why `presentedState`
 *    already reads it to tell those two apart.
 */
const fundedByLifecycle = (state: string, refundOutcome: 'pushed' | 'external' | null): boolean =>
  state !== 'quoted' && !(state === 'refused' && refundOutcome === null)

/**
 * The invoice's own amount, or null when it cannot be read.
 *
 * `amountSatsOf` throws on an amountless or malformed invoice. This corridor
 * cannot quote one — the limits bound the invoice amount before anything is
 * stored — but the ledger is a BULK READ over historical rows, and one
 * unparseable string from some earlier release must degrade to "this swap's
 * outlay is unknown" rather than take down the whole P&L scan with it. Null is
 * already the vocabulary for that everywhere else here.
 */
const invoiceSats = (invoice: string): number | null => {
  try {
    return amountSatsOf(invoice)
  } catch {
    return null
  }
}

/**
 * Lightning send — the corridor where BOTH columns mean intake, and reading
 * them as a pair yields exactly zero.
 *
 * `amount_sats` here is THE LOCKUP, not the invoice. `send/orchestrator.ts`
 * stores `giveSatsFor(invoice, fee)` into it and says so at the call site, and
 * the funding gate then transitions only on `locked === row.amountSats` — an
 * overfunded lockup is refused outright, because an Arkade vtxo is exact-value.
 * So on every row that can ever be realized, `lockup_value` and `amount_sats`
 * are EQUAL BY CONSTRUCTION. Subtracting one from the other reports a flat zero
 * for the whole corridor, at any fee setting, while counting it as priced —
 * indistinguishable on screen from a corridor that genuinely broke even.
 *
 * The outlay is the INVOICE, re-decoded from the row. That is not a shortcut:
 * the orchestrator calls the persisted invoice "authoritative" for exactly this
 * question, and `wire/payloads.ts` already answers the client's `to_amount`
 * the same way. The invoice amount is the only record of what this solver paid,
 * because nothing else on the row holds it.
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
    // Null until the lockup is seen. Substituting the quoted figure would book
    // a spread on a swap nobody has funded and may never fund.
    inbound: sats(row.lockupValue),
    outbound: sats(invoiceSats(row.invoice)),
    // What a quote BUDGETED for routing — an upper bound set at quote time and
    // used as `maxFeeSats`, never the fee actually paid. Reported beside the
    // spread and never subtracted from it. @see SwapEconomics.quotedCostSats
    quotedCostSats: row.quotedRoutingFeeSats,
    lost: row.state === LOST,
  })
}

/**
 * Lightning receive. The intake is the client's held HTLC, and the evidence is
 * the LIFECYCLE — specifically NOT `htlcExpiresAt`, which looks like the right
 * column and is a trap.
 *
 * That field is null on the COUPLED path by design: `receive/orchestrator.ts`
 * transitions `quoted -> armed` with `htlc_expires_at: null` precisely because
 * there is no `E` to record there, and uses the null as the marker for that
 * path. Reading it as "not funded" would report no intake on every coupled
 * swap, settled ones included.
 *
 * `refundOutcome` is passed as null because this store has no such column — it
 * records a refund as a STATE. That makes the rule `state` is neither `quoted`
 * nor `refused`, which is what those two words mean here.
 */
export const receiveEconomics = (row: ReceiveSwapRow): SwapEconomics =>
  economicsOf({
    id: row.id,
    corridor: LN_RECEIVE.pair,
    state: row.state,
    phase: phaseOfStates(LN_RECEIVE.states, row.state),
    quotedAt: row.createdAt,
    settledAt: row.updatedAt,
    inbound: sats(fundedByLifecycle(row.state, null) ? row.amountSats : null),
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
    // No column records the client's Arkade lockup on this leg, so the
    // lifecycle is the evidence. @see fundedByLifecycle
    inbound: sats(fundedByLifecycle(row.state, row.refundOutcome) ? row.amountSats : null),
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
    // `fundingTxid` is the CLIENT's HTLC — the solver's own broadcast is
    // `arkadeFundTxid` — so it is exact evidence that the intake arrived.
    inbound: sats(row.fundingTxid === null ? null : (row.fundedValueSats ?? row.amountSats)),
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
    // The deposit outpoint is exact evidence: until one is observed at the
    // offer script, the quoted `fromAmount` is terms and not an intake.
    inbound: {
      assetId: row.fromAssetId,
      amount: row.depositTxid === null ? null : row.fromAmount.toString(),
      decimals: null,
    },
    outbound: { assetId: row.toAssetId, amount: row.toAmount.toString(), decimals: null },
    lost: row.state === LOST,
  })
