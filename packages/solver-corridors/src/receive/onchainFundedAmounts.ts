/**
 * Every amount an onchain-receive swap settles against, from ONE resolution of
 * what its HTLC output actually holds.
 *
 * The solver PAYS the client an Arkade lockup and later COLLECTS that output.
 * Source those two from different numbers — the chain for one, the quote for
 * the other — and the whole of any overfund lands in the solver's own wallet.
 * Neither entry point takes an amount parameter, so there is nowhere to pass
 * the quoted number to.
 */

import type { ClaimTxParams } from '@arkade-os/solver-rails/onchain/claim.js'
import type { OnchainReceiveBand } from '@arkade-os/solver-core/core/onchainReceive.js'
import type { OnchainReceiveSwapRow } from '../db/onchainReceiveSwaps.js'

/** Narrower than the row, so a caller cannot smuggle another number in. */
export type FundedAmountRow = Pick<OnchainReceiveSwapRow, 'amountSats' | 'payoutSats' | 'fundedValueSats'>

/** One reader, so both ways a row can lack a band collapse to strict equality. */
export const bandOf = (
  row: Pick<OnchainReceiveSwapRow, 'amountSats' | 'minFromSats' | 'maxFromSats'>,
): OnchainReceiveBand => ({
  minFromSats: row.minFromSats ?? row.amountSats,
  maxFromSats: row.maxFromSats ?? row.amountSats,
})

export const hasBand = (row: Pick<OnchainReceiveSwapRow, 'minFromSats' | 'maxFromSats'>): boolean =>
  row.minFromSats !== null && row.maxFromSats !== null

export interface OnchainReceiveFundedAmounts {
  /** The claim input's `witnessUtxo.amount`. */
  fundingValueSats: number
  /**
   * DERIVED, never re-priced and never read back from a column: the solver keeps
   * the fee its quote named, the client takes the whole difference, and
   * re-entering pricing would let a live fee rate turn a re-size into a re-price.
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
  /** `payoutAmountSats` on it is a sizing placeholder, not the real output. */
  params: ClaimTxParams
  /** The real output, against the same funded value `params` is sized on. */
  payoutAfterFee: (fee: bigint) => bigint
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
