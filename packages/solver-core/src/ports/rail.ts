import type { LegSeen } from '../domain/swap/observation.js'
import type { Reference, Side } from '../domain/swap/leg.js'
import type { Swap } from '../domain/swap/swap.js'

/** Reads a rail and changes nothing, so it may be called from anywhere, as often as needed. */
export interface RailWatcher {
  observe(swap: Swap, side: Side): Promise<LegSeen>
}

/** `unknown` is not `not_sent`: something may have left, so the leg must not be tried again blindly. */
export type Sent =
  { readonly sent: 'yes'; readonly reference: Reference } | { readonly sent: 'no' } | { readonly sent: 'unknown' }

/** Moves value. Called only AFTER the leg was recorded as `locking` / `claiming` / `refunding`. */
export interface RailService {
  lock(swap: Swap, side: Side): Promise<Sent>
  claim(swap: Swap, side: Side): Promise<Sent>
  refund(swap: Swap, side: Side): Promise<Sent>
}
