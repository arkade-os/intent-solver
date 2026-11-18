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

export const resolveLimits = (network: SwapNetwork, override?: Partial<Limits>): Limits =>
  withBounds(NETWORKS[network].limits, override, network)

/** Raises or lowers; what caps the money at risk is `limits.maxExposedSats`, checked at every corridor's admission. */
export const withBounds = (base: Limits, override?: Partial<Limits>, label = 'limits'): Limits => {
  // `??` does not catch NaN, and NaN compares false against every amount, silently removing the bound.
  // `MAX_SWAP_SATS="1e3x"` is enough to trigger it.
  for (const [name, value] of Object.entries(override ?? {})) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new Error(`limit override ${name} must be a positive finite number, got ${value}`)
    }
  }

  const minSats = override?.minSats ?? base.minSats
  const maxSats = override?.maxSats ?? base.maxSats

  if (minSats > maxSats) {
    throw new Error(`limits for ${label} are empty: minSats ${minSats} exceeds maxSats ${maxSats}`)
  }
  return { minSats, maxSats }
}

const clamp = (outer: Limits, inner: Limits): Limits => ({
  minSats: Math.max(outer.minSats, inner.minSats),
  maxSats: Math.min(outer.maxSats, inner.maxSats),
})

/** Bounds an older release clamped and that now apply as set; `corridor` null is the deployment's own range. */
export const clampedBefore = <K extends string>(
  network: SwapNetwork,
  deployment: Limits,
  corridors: Readonly<Record<K, Limits>>,
): { corridor: K | null; field: 'minSats' | 'maxSats'; now: number; was: number }[] => {
  const before = clamp(NETWORKS[network].limits, deployment)
  const ranges: [K | null, Limits, Limits][] = [
    [null, deployment, before],
    ...(Object.entries(corridors) as [K, Limits][]).map(([corridor, now]): [K, Limits, Limits] => [
      corridor,
      now,
      clamp(before, now),
    ]),
  ]
  return ranges.flatMap(([corridor, now, was]) =>
    (['minSats', 'maxSats'] as const)
      .filter((field) => now[field] !== was[field])
      .map((field) => ({ corridor, field, now: now[field], was: was[field] })),
  )
}

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
