/**
 * Balances are CACHED and timer-refreshed. `wallet.getBalance()` awaits the same
 * unfiltered `contractSnapshot()` as `getSpendableVtxos()` (~951ms measured), and
 * the Lightning and onchain reads are the same class of call. None of them may
 * run on the transition that just committed.
 *
 * What an operator reads here is each corridor's own floats, plus the swap's
 * amount and payout. "Sats committed" was the house-wide in-flight exposure, a
 * different number from the row, and it was the one the alert used to lead with.
 */

import { outcomeOfTransition, formatSats } from '@arkade-os/solver-core/core/businessEvent.js'
import type { CorridorStates } from '@arkade-os/solver-core/core/businessEvent.js'

export interface LightningFloat {
  /** Spendable outbound liquidity. The wallet panel's "available". */
  availableSats: number
  /** What the node can still receive. The wallet panel's "incoming". */
  incomingSats: number
}

export interface OnchainFloat {
  confirmedSats: number
  /** The onchain wallet IS the Lightning pool, so the two figures are one balance. */
  sharedWithLightning: boolean
}

export interface Sampled<T> {
  value: T
  /** Unix seconds, the same clock `now()` uses. */
  at: number
}

export interface BalanceReading {
  arkade: Sampled<number> | null
  lightning: Sampled<LightningFloat> | null
  onchain: Sampled<OnchainFloat> | null
}

export interface BalanceSampler {
  current(): BalanceReading | null
}

export interface BalanceSamplerOptions {
  readArkadeAvailableSats(): Promise<number>
  /** Absent when this deployment has no Lightning rail. */
  readLightning?(): Promise<LightningFloat>
  readOnchain?(): Promise<OnchainFloat>
  now(): number
  onError?(error: unknown): void
}

const sideError = (label: string, error: unknown): Error =>
  new Error(`${label} balance: ${error instanceof Error ? error.message : String(error)}`, { cause: error })

export const createBalanceSampler = (options: BalanceSamplerOptions): BalanceSampler & { sample(): Promise<void> } => {
  let reading: BalanceReading | null = null
  // `getBalance()` has no deadline, so a caller that does not await must not stack reads behind a hung one.
  let inFlight: Promise<void> | null = null
  const readSide = async <T>(read: (() => Promise<T>) | undefined, label: string): Promise<T | undefined> => {
    if (!read) return undefined
    try {
      return await read()
    } catch (error) {
      // A stale reading beats none, and a throw would kill the driving interval.
      options.onError?.(sideError(label, error))
      return undefined
    }
  }
  // `undefined` from a configured side means the read failed: keep the previous sample.
  const remember = <T>(previous: Sampled<T> | null, next: T | undefined, at: number): Sampled<T> | null =>
    next === undefined ? previous : { value: next, at }
  const read = async () => {
    try {
      const at = options.now()
      const [arkade, lightning, onchain] = await Promise.all([
        readSide(options.readArkadeAvailableSats, 'arkade'),
        readSide(options.readLightning, 'lightning'),
        readSide(options.readOnchain, 'onchain'),
      ])
      reading = {
        arkade: remember(reading?.arkade ?? null, arkade, at),
        lightning: options.readLightning ? remember(reading?.lightning ?? null, lightning, at) : null,
        onchain: options.readOnchain ? remember(reading?.onchain ?? null, onchain, at) : null,
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

export interface SwapTerms {
  /** One clause: what the client brought and what this solver was to deliver. */
  size: string
  failureReason: string | null
}

export interface SwapOutcomeReporterOptions {
  corridor: string
  states: CorridorStates
  balances: BalanceSampler
  /**
   * `LN_BACKEND`, so the Lightning line names the rail (`spark`, `lnd`) rather
   * than a generic wallet. Null when this deployment has no rail.
   */
  lightningName: string | null
  /** Read off the swap row. Called only after the reporter has decided to post. */
  terms(id: string): Promise<SwapTerms>
  post(text: string): void
  now(): number
  onError?(error: unknown): void
}

export interface SwapTransition {
  id: string
  from: string | null
  to: string
}

/**
 * Terminal, and not a pager. `refused` never funded (nothing moved), `refunded`
 * already returned the capital, `lost` is an offer somebody else took. `stuck`
 * is the row that waits for a person. An unrecognised terminal still pages:
 * nothing has classified it, which is the case to see.
 */
const QUIET_FAILURES = new Set(['refused', 'refunded', 'lost'])

export const btcSwapSize = (amountSats: number, payoutSats: number | null): string =>
  payoutSats === null
    ? `amount ${formatSats(amountSats)} sats`
    : `amount ${formatSats(amountSats)} sats -> payout ${formatSats(payoutSats)} sats`

/** Atomic units, grouped only while the value is exactly a JS number. */
export const formatAmount = (amount: bigint, unit: string): string => {
  const text =
    amount >= 0n && amount <= BigInt(Number.MAX_SAFE_INTEGER) ? formatSats(Number(amount)) : amount.toString()
  return `${text} ${unit}`
}

const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim()

const wants = (corridor: string, side: 'lightning' | 'onchain' | 'arkade'): boolean => {
  if (side === 'arkade') {
    return corridor.includes('arkade') || (!corridor.includes('lightning') && !corridor.includes('onchain'))
  }
  return corridor.includes(side)
}

const message = (
  options: SwapOutcomeReporterOptions,
  swapId: string,
  outcome: 'fulfilled' | 'failed',
  state: string,
  terms: SwapTerms | null,
  reading: BalanceReading | null,
): string => {
  const { corridor, lightningName, now } = options
  const headline =
    outcome === 'fulfilled'
      ? `Swap fulfilled — ${corridor} — ${swapId}`
      : state === 'stuck'
        ? `Swap STUCK — ${corridor} — ${swapId}`
        : `Swap FAILED to be fulfilled — ${corridor} — ${swapId} — ended in ${state}`
  const reason = outcome === 'fulfilled' || terms?.failureReason == null ? null : oneLine(terms.failureReason)
  const age = (at: number) => `${Math.max(0, now() - at)}s old`
  const lightningLabel = lightningName ? `Lightning (${lightningName})` : 'Lightning'
  const lines = [headline, terms?.size ?? 'amount unread']
  if (reason) lines.push(`reason: ${reason}`)
  if (reading === null) lines.push('balances: unread (no sample taken yet)')
  else {
    if (wants(corridor, 'lightning')) {
      const lightning = reading.lightning
      lines.push(
        lightning === null
          ? `${lightningLabel}: unread`
          : `${lightningLabel}: ${formatSats(lightning.value.availableSats)} sats available, ` +
              `${formatSats(lightning.value.incomingSats)} sats incoming (${age(lightning.at)})`,
      )
    }
    if (wants(corridor, 'onchain')) {
      const onchain = reading.onchain
      if (onchain === null) lines.push('Onchain: unread')
      else {
        const shared = onchain.value.sharedWithLightning ? `, same pool as ${lightningLabel}` : ''
        lines.push(`Onchain: ${formatSats(onchain.value.confirmedSats)} sats confirmed${shared} (${age(onchain.at)})`)
      }
    }
    if (wants(corridor, 'arkade')) {
      const arkade = reading.arkade
      lines.push(
        arkade === null ? 'Arkade: unread' : `Arkade: ${formatSats(arkade.value)} sats available (${age(arkade.at)})`,
      )
    }
  }
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
    if (outcome === 'failed' && QUIET_FAILURES.has(to)) return

    const reading = balances.current()
    // DEFERRED, not merely un-awaited: an async body runs synchronously to its
    // first `await`, which would put a database call on the settlement path.
    queueMicrotask(() => {
      void (async () => {
        try {
          let described: SwapTerms | null = null
          try {
            described = await terms(id)
          } catch (error) {
            onError?.(error)
          }
          post(message(options, id, outcome, to, described, reading))
        } catch (error) {
          onError?.(error)
        }
      })()
    })
  }
}
