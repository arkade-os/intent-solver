import type { ValueOf } from '../domain/shared/brand.js'
import type { LegSeen } from '../domain/swap/observation.js'
import type { Reference, Side } from '../domain/swap/leg.js'
import type { Swap } from '../domain/swap/swap.js'

/** Reads a rail and changes nothing, so it may be called from anywhere, as often as needed. */
export interface RailWatcher {
  observe(swap: Swap, side: Side): Promise<LegSeen>
}

export const SendStatus = {
  Sent: 'sent',
  NotSent: 'not_sent',
  Unknown: 'unknown',
} as const

export type SendStatus = ValueOf<typeof SendStatus>

/** `unknown` means something may have left, so the same thing must not simply be sent again. */
export type SendResult =
  | { readonly status: typeof SendStatus.Sent; readonly reference: Reference }
  | { readonly status: typeof SendStatus.NotSent | typeof SendStatus.Unknown }

/** Moves value. Called only AFTER the leg was recorded as `locking` / `claiming` / `refunding`. */
export interface RailService {
  lock(swap: Swap, side: Side): Promise<SendResult>
  claim(swap: Swap, side: Side): Promise<SendResult>
  refund(swap: Swap, side: Side): Promise<SendResult>
}
