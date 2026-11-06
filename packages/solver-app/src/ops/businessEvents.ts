/**
 * Balances are cached and timer-refreshed. `wallet.getBalance()` awaits the same
 * unfiltered snapshot as `getSpendableVtxos()` (~951ms). Neither it nor the
 * Lightning read may run on the transition that just committed.
 */

import { outcomeOfTransition, formatSats } from '@arkade-os/solver-core/core/businessEvent.js'
import type { CorridorStates } from '@arkade-os/solver-core/core/businessEvent.js'
import { within } from './guardedRead.js'

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
  /** Start a read after any older sample finishes, so it observes a completed transition. */
  refresh(): Promise<boolean>
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
  let inFlight: Promise<boolean> | null = null
  let refreshAfter: Promise<boolean> | null = null
  const readSide = async <T>(
    read: (() => Promise<T>) | undefined,
    label: string,
    onFailure: () => void,
  ): Promise<T | undefined> => {
    if (!read) return undefined
    try {
      return await read()
    } catch (error) {
      onFailure()
      const message = error instanceof Error ? error.message : String(error)
      options.onError?.(new Error(`${label} balance: ${message}`, { cause: error }))
      return undefined
    }
  }
  // `undefined` from a configured side means the read failed: keep the previous sample.
  const remember = <T>(previous: Sampled<T> | null, next: T | undefined, at: number): Sampled<T> | null =>
    next === undefined ? previous : { value: next, at }
  const read = async (): Promise<boolean> => {
    let failed = false
    try {
      const at = options.now()
      const [arkade, lightning] = await Promise.all([
        readSide(options.readArkadeAvailableSats, 'arkade', () => {
          failed = true
        }),
        readSide(options.readLightning, 'lightning', () => {
          failed = true
        }),
      ])
      reading = {
        arkade: remember(reading?.arkade ?? null, arkade, at),
        lightning: options.readLightning ? remember(reading?.lightning ?? null, lightning, at) : null,
      }
      return !failed
    } finally {
      inFlight = null
    }
  }
  return {
    current: () => reading,
    sample: () => (inFlight ??= read()).then(() => {}),
    refresh: () => {
      if (refreshAfter) return refreshAfter
      const turn = (inFlight ? inFlight.catch(() => false) : Promise.resolve(false)).then(() => {
        const result = (inFlight ??= read())
        refreshAfter = null
        return result
      })
      refreshAfter = turn
      return turn
    },
  }
}

export interface SwapOutcomeReporterOptions {
  corridor: string
  states: CorridorStates
  balances: BalanceSampler
  /** False when this deployment has no Lightning rail. */
  lightning: boolean
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
    ? `${formatSats(amountSats)} sats`
    : `${formatSats(amountSats)} sats → payout ${formatSats(payoutSats)} sats`

// Samples come from a timer, so an age is only worth a word once it outlives a few ticks.
const STALE_SAMPLE_SECONDS = 120
const BALANCE_REFRESH_TIMEOUT_MS = 10_000

const message = (
  options: SwapOutcomeReporterOptions,
  swapId: string,
  outcome: 'fulfilled' | 'failed',
  size: string | null,
  reading: BalanceReading | null,
  refreshed: boolean,
): string => {
  const { corridor, lightning: hasLightning, now } = options
  const status = outcome === 'fulfilled' ? '✅ *Swap fulfilled*' : '🚨 *Swap STUCK*'
  const balances: string[] = [`\`${swapId}\``]
  const ages: number[] = []
  if (hasLightning) {
    const lightning = reading?.lightning ?? null
    if (lightning === null) balances.push('Lightning unread')
    else {
      const { availableSats, incomingSats } = lightning.value
      balances.push(
        `Lightning ${formatSats(availableSats)}${incomingSats > 0 ? ` (+${formatSats(incomingSats)} incoming)` : ''}`,
      )
      ages.push(now() - lightning.at)
    }
  }
  const arkade = reading?.arkade ?? null
  if (arkade === null) balances.push('Arkade unread')
  else {
    balances.push(`Arkade ${formatSats(arkade.value)}`)
    ages.push(now() - arkade.at)
  }
  const oldest = Math.max(0, ...ages)
  if (oldest > STALE_SAMPLE_SECONDS) balances.push(`balances ${oldest}s old`)
  if (!refreshed) balances.push('balances not refreshed')
  return [`${status} · ${corridor.replace('->', ' → ')} · ${size ?? 'amount unread'}`, balances.join(' · ')].join('\n')
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

    // DEFERRED, not merely un-awaited: an async body runs synchronously to its
    // first `await`, which would put a database call on the settlement path.
    queueMicrotask(() => {
      void (async () => {
        try {
          let refreshed = true
          const balancesRead = within(() => balances.refresh(), BALANCE_REFRESH_TIMEOUT_MS)().then(
            (fresh) => {
              refreshed = fresh
            },
            (error) => {
              refreshed = false
              onError?.(error)
            },
          )
          let size: string | null = null
          try {
            size = await terms(id)
          } catch (error) {
            onError?.(error)
          }
          await balancesRead
          post(message(options, id, outcome, size, balances.current(), refreshed))
        } catch (error) {
          onError?.(error)
        }
      })()
    })
  }
}
