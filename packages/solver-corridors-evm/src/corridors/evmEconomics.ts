/**
 * The ERC20 corridors' economics — the cross-asset case the model exists for.
 *
 * Both directions settle sats against a token, so neither has a spread its two
 * LEGS can express. Both nevertheless book one: `payout_sats` is persisted at
 * quote time as `amount_sats` after this corridor's fee, in BOTH stores and in
 * that direction, so `amount_sats - payout_sats` is the sats the solver kept
 * whichever way the trade ran. That figure is handed to `economicsOf` as
 * `quotedSpreadSats`, and the executed rate carries the FX story beside it.
 *
 * The LEGS, however, are not symmetric, and this is the pair it would be
 * easiest to get backwards:
 *
 *  - **send** — the client locks sats at the Arkade covenant and the solver
 *    locks the ERC20. Sats in, token out.
 *  - **receive** — the client locks the ERC20 and the solver funds sats. Token
 *    in, sats out.
 *
 * `exposureSats` is `payout_sats` on both, for the same reason it is not the
 * outbound leg: on the send direction the outbound leg is a token amount, and a
 * stuck row there would otherwise report no loss at all.
 */
import { economicsOf, type SwapEconomics } from '@arkade-os/solver-core/analytics/economics.js'
import { phaseOfStates } from '@arkade-os/solver-core/core/swapView.js'
import type { CorridorDescriptor } from '@arkade-os/solver-core/core/corridorDescriptor.js'
import type { EvmSendSwapRow } from '../db/evmSendSwaps.js'
import type { EvmReceiveSwapRow } from '../db/evmReceiveSwaps.js'

/**
 * The word both EVM stores park a failure under.
 *
 * AN UPPER BOUND ON THIS FAMILY, and the difference from the four BTC corridors
 * is worth knowing before reading the number. Those stores route a failure by
 * EXPOSURE — `stuck` only when the solver may already be out of pocket, and
 * `refused` when nothing moved. Both EVM stores' `fail()` transitions to
 * `stuck` unconditionally, so a row that failed before it locked anything is
 * filed beside one that failed after.
 *
 * Reported as at-risk anyway, deliberately. This layer takes the corridor's own
 * terminal word rather than second-guessing it, and of the two ways to be
 * wrong, over-reporting what might be gone sends an operator to look at a row
 * that turns out to be fine; under-reporting hides one that is not. Narrowing
 * it means the store routing by exposure as its siblings do, which is a change
 * to a money path and belongs in its own commit.
 */
const LOST = 'stuck'

const satsLeg = (amount: number): { assetId: null; amount: string; decimals: number } => ({
  assetId: null,
  amount: String(amount),
  decimals: 8,
})

/**
 * The token leg. The ERC20 address IS the asset id here, which is what keeps
 * two different tokens from being pooled into one rate series — and decimals
 * are null rather than assumed, since a 6-decimal USDC and an 18-decimal DAI
 * would otherwise plot on one axis twelve orders of magnitude apart.
 */
const tokenLeg = (row: {
  evmAmount: string
  tokenAddress: string
}): { assetId: string; amount: string; decimals: null } => ({
  assetId: row.tokenAddress,
  amount: row.evmAmount,
  decimals: null,
})

export const evmSendEconomics = (
  row: EvmSendSwapRow,
  descriptor: CorridorDescriptor,
  presented: string,
): SwapEconomics =>
  economicsOf({
    id: row.id,
    corridor: descriptor.pair,
    state: presented,
    phase: phaseOfStates(descriptor.states, presented),
    quotedAt: row.createdAt,
    settledAt: row.updatedAt,
    inbound: satsLeg(row.amountSats),
    outbound: tokenLeg(row),
    quotedSpreadSats: row.amountSats - row.payoutSats,
    exposureSats: row.payoutSats,
    lost: row.state === LOST,
  })

export const evmReceiveEconomics = (row: EvmReceiveSwapRow, descriptor: CorridorDescriptor): SwapEconomics =>
  economicsOf({
    id: row.id,
    corridor: descriptor.pair,
    state: row.state,
    phase: phaseOfStates(descriptor.states, row.state),
    quotedAt: row.createdAt,
    settledAt: row.updatedAt,
    inbound: tokenLeg(row),
    outbound: satsLeg(row.payoutSats),
    quotedSpreadSats: row.amountSats - row.payoutSats,
    exposureSats: row.payoutSats,
    lost: row.state === LOST,
  })
