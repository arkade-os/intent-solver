/**
 * The state vocabulary for `onchain:BTC->arkade:<asset>`.
 *
 * Declared in core, beside the planner that decides on it, for the reason
 * `evmSwapState.ts` gives: the planner is pure and may not import the store, so
 * the states have to live somewhere both can see.
 *
 * The words are the sats receive leg's, unchanged
 * (`db/onchainReceiveSwaps.ts`), because the lifecycle is the same one — the
 * client funds an L1 HTLC, the solver funds an Arkade lockup, a claim reveals
 * `P`, the solver collects. Only the DENOMINATION of the lockup differs, and a
 * different set of words for one identical flow would make the two legs read as
 * different problems.
 */

export type OnchainAssetReceiveState =
  | 'quoted'
  | 'awaiting_confirmations'
  | 'funding_arkade'
  | 'awaiting_claim'
  | 'claimed'
  | 'settled'
  | 'refunding_arkade'
  | 'refunded'
  | 'refused'
  | 'stuck'

export const ONCHAIN_ASSET_NON_TERMINAL: readonly OnchainAssetReceiveState[] = [
  'quoted',
  'awaiting_confirmations',
  'funding_arkade',
  'awaiting_claim',
  'claimed',
  'refunding_arkade',
]

/**
 * Where the solver's own money is at risk.
 *
 * Starts at `funding_arkade` and not before: until the lockup is paid, nothing
 * of the solver's has moved and abandoning the row costs it nothing.
 */
export const ONCHAIN_ASSET_EXPOSED: readonly OnchainAssetReceiveState[] = [
  'funding_arkade',
  'awaiting_claim',
  'claimed',
  'refunding_arkade',
]
