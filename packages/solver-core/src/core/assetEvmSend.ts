/**
 * The quote-time gate for `arkade:<asset>->ethereum:<token>`.
 *
 * The client locks an Arkade ASSET; the solver locks an ERC20; the client claims
 * the ERC20 revealing the preimage; the solver claims the asset lockup. That is
 * the `arkade:BTC->ethereum:<token>` sequence with a different denomination on
 * the funding leg, so the DEADLINE rule is imported from `evmSend.ts` rather
 * than restated — the race between the two timeouts does not care what funds it.
 *
 * What is genuinely different is the SIZE gate. The give leg is atomic units of
 * an asset, so it is a bigint, and its bounds are the only bound there is: this
 * corridor has no sats on either leg and so contributes nothing to
 * `maxExposedSats`. @see assetEvmCorridorConfig.ts.
 */

import { deriveEvmSendDeadlines, type EvmSendAcceptance, type EvmSendAcceptanceRefusal } from './evmSend.js'
import type { AtomicBounds } from './assetEvmCorridorConfig.js'
import { BPS_DENOMINATOR } from './assetOfferPrice.js'
import type { Fee } from './corridorPolicy.js'

export interface AssetEvmSendAcceptanceParams {
  /** What the CLIENT locks, in the asset's atomic units. */
  assetUnits: bigint
  assetLimits: AtomicBounds
  /** The solver's own worst-case Arkade recourse — @see evaluateEvmSendAcceptance. */
  unilateralClaimDelay: number
  nowSeconds: number
  orderMarginSeconds?: number
  minClaimWindowSeconds?: number
}

export const evaluateAssetEvmSendAcceptance = (params: AssetEvmSendAcceptanceParams): EvmSendAcceptance => {
  const { assetUnits, assetLimits } = params
  if (assetUnits < assetLimits.minUnits || assetUnits > assetLimits.maxUnits) {
    return { accept: false, reason: 'amount_out_of_range' }
  }
  return deriveEvmSendDeadlines(params)
}

/**
 * The give leg minus this corridor's spread, in the SAME atomic units.
 *
 * Rounded so the remainder stays with the solver, which is `feeSatsFor`'s
 * direction and for its reason: rounding a fee down means eating the remainder
 * on every swap, and at a small amount that remainder is most of the fee.
 *
 * `flatSats` is ignored — there is no sats leg to charge it against, and
 * `assetEvmCorridorPolicies` pins it to zero so the two cannot disagree.
 *
 * May return zero or less on a small give against a large spread. NOT clamped:
 * the caller must refuse that rather than pay out nothing, and a clamp here
 * would turn "the fee ate the swap" into a swap that settles for free.
 */
export const assetPayoutUnitsFor = (giveUnits: bigint, fee: Fee): bigint => {
  const bps = BigInt(fee.bps)
  const denominator = BigInt(BPS_DENOMINATOR)
  const charged = (giveUnits * bps + denominator - 1n) / denominator
  return giveUnits - charged
}

export type { EvmSendAcceptanceRefusal }
