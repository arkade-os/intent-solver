/**
 * The amounts an onchain-receive swap is settled against, once its HTLC output
 * is a fact rather than a quote.
 *
 * ## Why one module, and why it takes the row
 *
 * This leg moves money in two directions from one funded output: the solver
 * PAYS the client an Arkade lockup, and later COLLECTS the client's HTLC. Read
 * the collect side from what the output actually holds and the pay side from
 * what was quoted, and the whole of any overfund lands in the solver's own
 * wallet — silently, on a swap that otherwise looks perfect.
 *
 * So both sides are derived here, from ONE resolution of one number, and
 * neither entry point takes an amount parameter at all. There is nowhere for a
 * caller to pass the quoted number to, which is the property that has to
 * survive the change that relaxes funding to a tolerance band: the collect side
 * cannot move without the pay side moving with it.
 *
 * ## Today
 *
 * `fundedValueSats` is NULL on every row, so every value here equals the quoted
 * one and nothing observable changes.
 */

import type { ClaimTxParams } from '@arkade-os/solver-rails/onchain/claim.js'
import type { OnchainReceiveSwapRow } from '../db/onchainReceiveSwaps.js'

/** The subset of the row that decides an amount. Narrower than the row so a caller cannot smuggle another number in. */
export type FundedAmountRow = Pick<OnchainReceiveSwapRow, 'amountSats' | 'payoutSats' | 'fundedValueSats'>

export interface OnchainReceiveFundedAmounts {
  /** What the client's HTLC output holds: the claim input's `witnessUtxo.amount`. */
  fundingValueSats: number
  /**
   * What the solver owes the client in the Arkade lockup against that value.
   *
   * DERIVED, never re-priced and never read back from a column. The solver
   * keeps exactly the absolute fee its quote named, so the difference between
   * what was quoted and what arrived flows entirely to the client — which the
   * client can check against the two numbers the quote already carries. Going
   * back through pricing here would let an operator on a live fee rate turn a
   * re-size into a re-price.
   */
  arkadePayoutSats: number
}

export const onchainReceiveFundedAmounts = (row: FundedAmountRow): OnchainReceiveFundedAmounts => {
  const fundingValueSats = row.fundedValueSats ?? row.amountSats
  return {
    fundingValueSats,
    arkadePayoutSats: row.payoutSats + (fundingValueSats - row.amountSats),
  }
}

/** Everything about the claim spend that is NOT an amount. */
export interface OnchainClaimSpend {
  htlc: ClaimTxParams['htlc']
  preimage: Uint8Array
  fundingTxid: string
  fundingVout: number
  destinationScript: Uint8Array
}

export interface OnchainClaimSizing {
  /** Sized and built from these. `payoutAmountSats` on it is the sizing placeholder, not the real output. */
  params: ClaimTxParams
  /** The real claim output — against the same funded value `params` is sized on, by construction. */
  payoutAfterFee: (fee: bigint) => bigint
  /** What the output holds, for the refusals that have to name it. */
  fundingValueSats: number
}

export const onchainClaimSizing = (row: FundedAmountRow, spend: OnchainClaimSpend): OnchainClaimSizing => {
  const { fundingValueSats } = onchainReceiveFundedAmounts(row)
  return {
    params: { ...spend, fundingValueSats, payoutAmountSats: BigInt(fundingValueSats) },
    payoutAfterFee: (fee) => BigInt(fundingValueSats) - fee,
    fundingValueSats,
  }
}
