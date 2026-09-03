/**
 * Turning `<CORRIDOR>_FEE_CAP_SATS` into something an onchain corridor prices
 * with — the join between `config.ts`'s bounds, the backend's fee estimate and
 * `core/pricing.ts`.
 *
 * Its own module rather than two closures inside `createServices` because the
 * decision it makes is the one that must not go wrong: a deployment that
 * configured nothing has to quote what it quoted before, and that property is
 * only worth as much as it is TESTED. `createServices` needs live backends and
 * a wallet, so nothing that only exists inside it can be exercised.
 */

import { freshly } from '@arkade-os/solver-core/util/freshness.js'
import { networkFeePricing, onchainCostSats, type PricingStrategy } from '@arkade-os/solver-core/core/pricing.js'
import type { Fee } from '@arkade-os/solver-core/core/corridorPolicy.js'
import type { Config, NetworkFeeBounds } from '../config.js'

/**
 * ONE sampled sats/vbyte reading for BOTH onchain corridors, or null when
 * neither asked for live pricing.
 *
 * Shared rather than one per corridor because they read the same backend's same
 * estimate: a reader each would double the upstream traffic and let the two
 * directions price the same instant off two different numbers.
 *
 * NULL is not an optimisation. `freshly` fetches on READ and holds nothing
 * until something reads it, so a sampler built for corridors that will never
 * consult it is simply a sampler that never fetches — but it is also a
 * live handle on a backend a deployment did not ask this of, and the honest
 * expression of "no corridor prices live here" is not having one.
 */
export const onchainFeeRateSampler = (input: {
  /**
   * Every corridor's bounds. Null entries want no live pricing.
   *
   * Typed as the config field itself rather than re-spelling its shape: this
   * READS a per-corridor table, it does not declare a second one, and
   * `test/boundaries.ts`'s census counts declarations for a reason.
   */
  bounds: Config['corridorNetworkFees']
  estimateFeeRate: () => Promise<number>
  refreshAfterMs: number
  staleAfterMs: number
  /** Injected so tests need no timers. Wall clock by default. */
  now?: () => number
}): (() => number | null) | null => {
  if (!Object.values(input.bounds).some((bounds) => bounds !== null)) return null
  return freshly({
    fetch: input.estimateFeeRate,
    refreshAfterMs: input.refreshAfterMs,
    staleAfterMs: input.staleAfterMs,
    now: input.now ?? (() => Date.now()),
  })
}

/**
 * How one onchain corridor prices, or UNDEFINED to leave it exactly as it was.
 *
 * Undefined rather than a strategy that happens to agree with the old numbers.
 * The orchestrators already fall back to `fixedFeePricing(fee)` when handed no
 * pricing, and routing the unconfigured default through a second implementation
 * is how a deployment that asked for nothing still ends up quoting something
 * new — the rounding on the `amount_side: 'to'` path is subtle enough that a
 * near-copy would drift by a sat.
 *
 * `vsize` is the size of the transaction THIS corridor's solver broadcasts,
 * which differs by direction: the receive leg pays to claim the client's HTLC,
 * the send leg pays to fund one. @see solver-rails' onchain/sizing.ts.
 *
 * `base` is the corridor's configured fee. Its flat becomes the fallback for
 * when the sample is stale or the backend is down — never zero, because
 * quoting no execution cost is how the solver ends up paying it — and its bps
 * is passed through untouched, since a spread covers proportional risk that
 * does not move with a fee market.
 */
export const onchainCorridorPricing = (input: {
  bounds: NetworkFeeBounds | null
  base: Fee
  /** The shared sampler, or null when nothing samples. Either absence keeps the old pricing. */
  feeRate: (() => number | null) | null
  vsize: number
}): PricingStrategy | undefined => {
  if (input.bounds === null || input.feeRate === null) return undefined
  return networkFeePricing({
    base: input.base,
    costSats: onchainCostSats(input.vsize, input.feeRate),
    capSats: input.bounds.capSats,
    minSats: input.bounds.minSats,
  })
}
