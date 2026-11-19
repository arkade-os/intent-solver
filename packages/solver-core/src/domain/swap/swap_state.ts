import type { ValueOf } from '../shared/brand.js'
import type { LegState } from './leg.js'

export const SwapOutcome = {
  Refused: 'refused',
  Lost: 'lost',
  Stuck: 'stuck',
} as const

export type SwapOutcome = ValueOf<typeof SwapOutcome>

type Pair = readonly [from: LegState | '*', to: LegState]

interface Derived {
  readonly pairs: readonly Pair[]
  /** Paid out `to`, not yet collected `from`. */
  readonly exposed: boolean
  readonly terminal: boolean
}

const DERIVED = {
  quoted: {
    pairs: [
      ['pending', 'pending'],
      ['locking', 'pending'],
    ],
    exposed: false,
    terminal: false,
  },
  funded: { pairs: [['locked', 'pending']], exposed: false, terminal: false },
  filling: { pairs: [['locked', 'locking']], exposed: true, terminal: false },
  awaiting_claim: {
    pairs: [
      ['locked', 'locked'],
      ['locked', 'claiming'],
    ],
    exposed: true,
    terminal: false,
  },
  filled: { pairs: [['locked', 'claimed']], exposed: true, terminal: false },
  settling: { pairs: [['claiming', 'claimed']], exposed: true, terminal: false },
  settled: { pairs: [['claimed', 'claimed']], exposed: false, terminal: true },
  // Either side is unwinding and our payout is not back yet. A `from` that fails back while
  // `to` is still locked belongs here: the only safe move left is to refund `to`.
  refunding: {
    pairs: [
      ['locked', 'refunding'],
      ['refunding', 'refunding'],
      ['refunded', 'refunding'],
      ['refunding', 'locked'],
      ['refunded', 'locked'],
    ],
    exposed: true,
    terminal: false,
  },
  refunded: { pairs: [['*', 'refunded']], exposed: false, terminal: true },
} as const satisfies Record<string, Derived>

export type DerivedSwapState = keyof typeof DERIVED
export type SwapState = DerivedSwapState | SwapOutcome

const ENTRIES = Object.entries(DERIVED) as [DerivedSwapState, Derived][]

const isDerived = (state: SwapState): state is DerivedSwapState => state in DERIVED

/** Null for a pair outside the table: legs that disagree about what happened. */
export const deriveSwapState = (from: LegState, to: LegState): DerivedSwapState | null =>
  ENTRIES.find(([, { pairs }]) => pairs.some(([f, t]) => (f === '*' || f === from) && t === to))?.[0] ?? null

export const isSwapExposed = (state: SwapState): boolean => isDerived(state) && DERIVED[state].exposed

export const isSwapTerminal = (state: SwapState): boolean => !isDerived(state) || DERIVED[state].terminal
