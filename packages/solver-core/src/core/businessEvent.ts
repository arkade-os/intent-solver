/**
 * Business-event arithmetic — no transport, no I/O. Fulfilment comes from the
 * corridor's OWN `states.delivered`: `claimed` is delivery on the send legs and
 * merely in flight on the receive ones.
 */

import { phaseOfStates } from './swapView.js'

export type SwapOutcome = 'fulfilled' | 'failed' | null

export interface CorridorStates {
  readonly live: readonly string[]
  readonly exposed: readonly string[]
  readonly delivered: readonly string[]
}

/** `from` is unused: it documents that this classifies a TRANSITION, not a row at rest. */
export const outcomeOfTransition = (states: CorridorStates, from: string, to: string): SwapOutcome => {
  const phase = phaseOfStates(states, to)
  if (phase === 'open' || phase === 'exposed') return null
  return phase === 'done' ? 'fulfilled' : 'failed'
}

/**
 * `n/a` covers the two cases with no honest percentage: no previous reading, and
 * a previous reading of zero. Unchanged is `+0.00%` — a real measurement.
 */
export const percentChange = (previous: number | null, current: number): string => {
  if (previous === null || previous === 0) return 'n/a'
  const delta = ((current - previous) / previous) * 100
  return `${delta >= 0 ? '+' : '-'}${Math.abs(delta).toFixed(2)}%`
}

export const formatSats = (sats: number): string => sats.toLocaleString('en-US')

export type TransitionHook = (event: { id: string; from: string | null; to: string }) => void

/**
 * In CORE because three stores carry their own `transition` and
 * `solver-corridors-evm` does not depend on `solver-corridors`. The catch is
 * load-bearing: the transition has COMMITTED, so a throw would reject a call
 * whose row moved.
 */
export const announceTransition = (
  hook: TransitionHook | undefined,
  id: string,
  from: string | null,
  to: string,
): void => {
  try {
    hook?.({ id, from, to })
  } catch {
    // Intentionally ignored — see above.
  }
}
