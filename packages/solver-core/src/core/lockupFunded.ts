/**
 * Whether a lockup holds what the quote said it would.
 *
 * WHY THIS IS ITS OWN DECISION. Every funding gate in this repo sums an
 * output's `.value` and compares it to the row's sats figure. That is right for
 * the four BTC corridors, where sats ARE the amount — and it stops being right
 * the moment the amount lives in an asset. A lockup funded with the correct
 * sats carrier but the wrong asset amount reads as funded, and the swap
 * proceeds for a figure nobody quoted.
 *
 * The covenant does not catch that and should not try: `enforcePayToAsset`
 * relates the refund OUTPUT to the INPUT (`out >= in`), which is the only
 * correct rule for a refund — binding it to the quote would refund an
 * underfunding client MORE than they locked, out of the solver's own pocket.
 * Checking the funded amount against the quote is this layer's job, not the
 * script's.
 *
 * Landed ahead of the asset corridors on purpose. `CovenantSwapParams.asset` is
 * currently a tripwire that refuses to build an asset lockup at all; the day
 * that is lifted, this check has to already exist, or lifting it opens exactly
 * the hole it was guarding.
 *
 * Pure: no wallet, no clock, no I/O.
 */

/** The slice of a funded output this decision reads. */
export interface FundedOutputView {
  /** Sats on the output. */
  value: number
  /** The assets it carries, when it carries any. */
  assets?: readonly { assetId: string; amount: bigint }[]
}

/**
 * What the row says should be there.
 *
 * A discriminated union rather than an optional asset field, so a caller cannot
 * pass an asset id and a sats amount together and have one silently ignored.
 */
export type LockupExpectation = { kind: 'sats'; amount: number } | { kind: 'asset'; assetId: string; amount: bigint }

/**
 * Is the lockup funded for what was quoted?
 *
 * `>=` rather than `===` in both cases: an overpayment is still a funded
 * lockup, and the quote already fixed what the counterparty is owed.
 *
 * ON THE ASSET SIDE, only the NAMED asset counts. A lockup carrying a large
 * amount of some other asset is not funded — that is the case a naive
 * "does it carry assets" check would wave through, and it is trivially
 * cheap for a client to construct.
 */
export const lockupIsFunded = (outputs: readonly FundedOutputView[], expectation: LockupExpectation): boolean => {
  if (expectation.kind === 'sats') {
    return outputs.reduce((sum, output) => sum + output.value, 0) >= expectation.amount
  }
  // `bigint` throughout: an asset amount is not bounded by what a double holds,
  // and the SDK's own `Asset.amount` says so.
  let held = 0n
  for (const output of outputs) {
    for (const asset of output.assets ?? []) {
      if (asset.assetId === expectation.assetId) held += asset.amount
    }
  }
  // A zero expectation is not "trivially satisfied": an asset lockup for nothing
  // is not a lockup, and answering true would let a quote with a mispriced zero
  // amount settle as funded.
  return expectation.amount > 0n && held >= expectation.amount
}
