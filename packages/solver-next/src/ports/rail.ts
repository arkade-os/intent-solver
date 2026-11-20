import type { ValueOf } from '../domain/shared/brand.js'
import type { LegStatus } from '../domain/swap/observation.js'
import type { Reference, Side } from '../domain/swap/leg.js'
import type { Swap } from '../domain/swap/swap.js'

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

/** One rail, as the swap loop uses it. Lightning, Arkade, onchain and EVM each implement it once. */
export interface RailService {
  /** Only reads. Safe to call at any time. */
  status(swap: Swap, side: Side): Promise<LegStatus>
  // The three below move value. Call them only after the leg was saved as `locking` / `claiming` / `refunding`.
  lock(swap: Swap, side: Side): Promise<SendResult>
  claim(swap: Swap, side: Side): Promise<SendResult>
  refund(swap: Swap, side: Side): Promise<SendResult>
  /** The swap ended before the client locked anything: close what was opened for them. Best effort, safe to repeat. */
  retire?(swap: Swap, side: Side): Promise<void>
}
