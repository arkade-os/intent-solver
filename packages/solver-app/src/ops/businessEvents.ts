/**
 * The balance is CACHED and timer-refreshed because `wallet.getBalance()` awaits
 * the same unfiltered `contractSnapshot()` as `getSpendableVtxos()`
 * (`chunk-JVHO6XHG.js` 12825, 12887, 12980) — measured at ~951ms.
 */

import { outcomeOfTransition, percentChange, formatSats } from '@arkade-os/solver-core/core/businessEvent.js'
import type { CorridorStates } from '@arkade-os/solver-core/core/businessEvent.js'

export interface BalanceReading {
  availableSats: number
  committedSats: number
  at: number
}

export interface BalanceSampler {
  current(): BalanceReading | null
}

export interface BalanceSamplerOptions {
  readAvailableSats(): Promise<number>
  readCommittedSats(): Promise<number>
  now(): number
  onError?(error: unknown): void
}

export const createBalanceSampler = (options: BalanceSamplerOptions): BalanceSampler & { sample(): Promise<void> } => {
  let reading: BalanceReading | null = null
  return {
    current: () => reading,
    sample: async () => {
      try {
        const [availableSats, committedSats] = await Promise.all([
          options.readAvailableSats(),
          options.readCommittedSats(),
        ])
        reading = { availableSats, committedSats, at: options.now() }
      } catch (error) {
        // A stale reading beats none, and a throw would kill the driving interval.
        options.onError?.(error)
      }
    },
  }
}

export interface AnnouncedBalanceStore {
  getLastAnnouncedBalance(): Promise<number | null>
  setLastAnnouncedBalance(sats: number): Promise<void>
}

export interface SwapOutcomeReporterOptions {
  corridor: string
  states: CorridorStates
  balances: BalanceSampler
  store: AnnouncedBalanceStore
  post(text: string): void
  now(): number
  onError?(error: unknown): void
}

export interface SwapTransition {
  id: string
  from: string | null
  to: string
}

const line = (
  corridor: string,
  swapId: string,
  outcome: 'fulfilled' | 'failed',
  state: string,
  reading: BalanceReading | null,
  change: string,
  ageSeconds: number,
): string => {
  const verdict = outcome === 'fulfilled' ? 'Swap fulfilled' : 'Swap FAILED to be fulfilled'
  const balances =
    reading === null
      ? 'balances: unread (no sample taken yet)'
      : `balances: ${formatSats(reading.availableSats)} sats available, ` +
        `${formatSats(reading.committedSats)} sats committed (${ageSeconds}s old)`
  return `${verdict} — ${corridor} — ${swapId} — ended in ${state}\n${balances}, change since last event: ${change}`
}

/** Never rejects: the store calls this from the money path. */
export const createSwapOutcomeReporter = (
  options: SwapOutcomeReporterOptions,
): ((transition: SwapTransition) => void) => {
  const { corridor, states, balances, store, post, now, onError } = options

  return ({ id, from, to }) => {
    const outcome = outcomeOfTransition(states, from ?? '', to)
    if (outcome === null) return

    const reading = balances.current()
    // DEFERRED, not merely un-awaited: an async body runs synchronously to its
    // first `await`, which would put a database call on the settlement path.
    queueMicrotask(() => {
      void (async () => {
        try {
          const previous = await store.getLastAnnouncedBalance()
          const change = reading === null ? 'n/a' : percentChange(previous, reading.availableSats)
          const age = reading === null ? 0 : Math.max(0, now() - reading.at)
          post(line(corridor, id, outcome, to, reading, change, age))
          // AFTER posting: a failed write costs one repeated comparison, not a
          // missing event.
          if (reading !== null) await store.setLastAnnouncedBalance(reading.availableSats)
        } catch (error) {
          onError?.(error)
        }
      })()
    })
  }
}
