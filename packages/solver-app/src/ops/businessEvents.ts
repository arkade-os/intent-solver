/**
 * Balances are cached and timer-refreshed. `wallet.getBalance()` awaits the same
 * unfiltered snapshot as `getSpendableVtxos()` (~951ms). Neither it nor the
 * Lightning read may run on the transition that just committed.
 */

import { outcomeOfTransition, formatSats } from '@arkade-os/solver-core/core/businessEvent.js'
import type { CorridorStates } from '@arkade-os/solver-core/core/businessEvent.js'

export interface Sampled<T> {
  value: T
  /** Unix seconds, the same clock `now()` uses. */
  at: number
}

export interface BalanceReading {
  arkade: Sampled<number> | null
  lightning: Sampled<{ availableSats: number; incomingSats: number }> | null
}

export interface BalanceSampler {
  current(): BalanceReading | null
}

export interface BalanceSamplerOptions {
  readArkadeAvailableSats(): Promise<number>
  /** Absent when this deployment has no Lightning rail. */
  readLightning?(): Promise<{ availableSats: number; incomingSats: number }>
  now(): number
  onError?(error: unknown): void
}

export const createBalanceSampler = (options: BalanceSamplerOptions): BalanceSampler & { sample(): Promise<void> } => {
  let reading: BalanceReading | null = null
  // `getBalance()` has no deadline, so a caller that does not await must not stack reads behind a hung one.
  let inFlight: Promise<void> | null = null
  const readSide = async <T>(read: (() => Promise<T>) | undefined, label: string): Promise<T | undefined> => {
    if (!read) return undefined
    try {
      return await read()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      options.onError?.(new Error(`${label} balance: ${message}`, { cause: error }))
      return undefined
    }
  }
  // `undefined` from a configured side means the read failed: keep the previous sample.
  const remember = <T>(previous: Sampled<T> | null, next: T | undefined, at: number): Sampled<T> | null =>
    next === undefined ? previous : { value: next, at }
  const read = async () => {
    try {
      const at = options.now()
      const [arkade, lightning] = await Promise.all([
        readSide(options.readArkadeAvailableSats, 'arkade'),
        readSide(options.readLightning, 'lightning'),
      ])
      reading = {
        arkade: remember(reading?.arkade ?? null, arkade, at),
        lightning: options.readLightning ? remember(reading?.lightning ?? null, lightning, at) : null,
      }
    } finally {
      inFlight = null
    }
  }
  return {
    current: () => reading,
    sample: () => (inFlight ??= read()),
  }
}

export interface SwapOutcomeReporterOptions {
  corridor: string
  states: CorridorStates
  balances: BalanceSampler
  /** `LN_BACKEND`. Null when this deployment has no rail. */
  lightningName: string | null
  /** The swap's amount line. Called only after the reporter has decided to post. */
  terms(id: string): Promise<string>
  post(text: string): void
  now(): number
  onError?(error: unknown): void
}

export interface SwapTransition {
  id: string
  from: string | null
  to: string
}

export const btcSwapSize = (amountSats: number, payoutSats: number | null): string =>
  payoutSats === null
    ? `amount ${formatSats(amountSats)} sats`
    : `amount ${formatSats(amountSats)} sats -> payout ${formatSats(payoutSats)} sats`

const message = (
  options: SwapOutcomeReporterOptions,
  swapId: string,
  outcome: 'fulfilled' | 'failed',
  size: string | null,
  reading: BalanceReading | null,
): string => {
  const { corridor, lightningName, now } = options
  const headline =
    outcome === 'fulfilled' ? `Swap fulfilled — ${corridor} — ${swapId}` : `Swap STUCK — ${corridor} — ${swapId}`
  const age = (at: number) => `${Math.max(0, now() - at)}s old`
  const lines = [headline, size ?? 'amount unread']
  if (lightningName !== null) {
    const lightning = reading?.lightning ?? null
    const label = `Lightning (${lightningName})`
    lines.push(
      lightning === null
        ? `${label}: unread`
        : `${label}: ${formatSats(lightning.value.availableSats)} sats available, ` +
            `${formatSats(lightning.value.incomingSats)} sats incoming (${age(lightning.at)})`,
    )
  }
  const arkade = reading?.arkade ?? null
  lines.push(
    arkade === null ? 'Arkade: unread' : `Arkade: ${formatSats(arkade.value)} sats available (${age(arkade.at)})`,
  )
  return lines.join('\n')
}

/** Never rejects: the store calls this from the money path. */
export const createSwapOutcomeReporter = (
  options: SwapOutcomeReporterOptions,
): ((transition: SwapTransition) => void) => {
  const { states, balances, terms, post, onError } = options

  return ({ id, from, to }) => {
    const outcome = outcomeOfTransition(states, from ?? '', to)
    if (outcome === null) return
    // `refused` never funded. Anything but `stuck` is not a pager.
    if (outcome === 'failed' && to !== 'stuck') return

    const reading = balances.current()
    // DEFERRED, not merely un-awaited: an async body runs synchronously to its
    // first `await`, which would put a database call on the settlement path.
    queueMicrotask(() => {
      void (async () => {
        try {
          let size: string | null = null
          try {
            size = await terms(id)
          } catch (error) {
            onError?.(error)
          }
          post(message(options, id, outcome, size, reading))
        } catch (error) {
          onError?.(error)
        }
      })()
    })
  }
}
