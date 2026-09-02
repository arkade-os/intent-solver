/**
 * Amount policy.
 *
 * Limits are a blast radius, not a business rule: both legs pay out before they
 * collect, so a cap turns "a bug costs the wallet" into "a bug costs one swap". Which
 * network gets which range lives in `networks.ts`.
 */

import { NETWORKS, type SwapNetwork } from './networks.js'

export interface Limits {
  minSats: number
  maxSats: number
}

/**
 * Resolve the limits for a network. An override may only ever NARROW the range —
 * widening it would silently raise the amount at risk.
 */
export const resolveLimits = (network: SwapNetwork, override?: Partial<Limits>): Limits =>
  narrow(NETWORKS[network].limits, override, network)

/**
 * Apply an override in the narrowing direction only.
 *
 * Separate from {@link resolveLimits} so narrowing can LAYER (network default, then
 * `MAX_SWAP_SATS`, then a per-corridor knob). Each step only reduces risk, so the
 * order cannot change the safety of the outcome.
 */
export const narrow = (base: Limits, override?: Partial<Limits>, label = 'limits'): Limits => {
  // `??` does not catch NaN, and `Math.min(1000, NaN)` is NaN -- which compares false
  // against every amount, silently removing the cap this module exists to enforce.
  // `MAX_SWAP_SATS="1e3x"` is enough to trigger it.
  for (const [name, value] of Object.entries(override ?? {})) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new Error(`limit override ${name} must be a positive finite number, got ${value}`)
    }
  }

  const minSats = Math.max(base.minSats, override?.minSats ?? base.minSats)
  const maxSats = Math.min(base.maxSats, override?.maxSats ?? base.maxSats)

  if (minSats > maxSats) {
    throw new Error(`limits for ${label} are empty: minSats ${minSats} exceeds maxSats ${maxSats}`)
  }
  return { minSats, maxSats }
}

/**
 * The solver's spread in basis points. One constant so the registry card, the open-RFQ
 * bids and quote pricing cannot drift apart.
 */
export const SOLVER_FEE_BPS = 0

/**
 * The floor under {@link maxRoutingFeeSats}.
 *
 * Raised from 10, which sat one sat under a real backend minimum and made every swap
 * at or below 2000 sats permanently unservable (`maxFeeSats does not cover fee
 * estimate [value: 10, expected: 11 sats]`, mainnet). 25 rather than 11 for headroom,
 * which costs nothing because the cap only ever REFUSES.
 */
export const MIN_ROUTING_FEE_CAP_SATS = 25

/**
 * Cap on the routing fee we will pay to deliver a send. A fraction with a floor,
 * because a flat cap either blocks small swaps or is meaningless for large ones.
 */
export const maxRoutingFeeSats = (amountSats: number): number =>
  Math.max(MIN_ROUTING_FEE_CAP_SATS, Math.ceil(amountSats * 0.005))
