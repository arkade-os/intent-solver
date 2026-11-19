import { describe, expect, it } from 'vitest'
import { EvmReceiveMachine, EvmSendMachine } from '@arkade-os/solver-core/core/evmSwapState.js'
import type { StateMachine } from '@arkade-os/solver-core/core/stateMachine.js'
import { Leg, LegMachine, type ContractKind, type LegState } from '@arkade-os/solver-core/domain/swap/leg.js'
import { SwapState, type SwapOutcome } from '@arkade-os/solver-core/domain/swap/swap_state.js'
import { AssetRfqMachine } from '@arkade-os/solver-corridors/machines/assetRfq.js'
import { LnReceiveMachine } from '@arkade-os/solver-corridors/machines/lnReceive.js'
import { LnSendMachine } from '@arkade-os/solver-corridors/machines/lnSend.js'
import { OnchainSendMachine } from '@arkade-os/solver-corridors/machines/onchainSend.js'

type Pair = readonly [from: LegState, to: LegState]
type Position = readonly Pair[] | SwapOutcome

interface Corridor {
  readonly machine: StateMachine<string, string>
  readonly from: ContractKind
  readonly to: ContractKind
  /** Every pair of leg states a legacy state can stand for; one legacy word often covers several. */
  readonly positions: Record<string, Position>
  /** Where the legacy flag and the model disagree on purpose, with the reason. */
  readonly exposureExceptions?: Record<string, string>
}

const QUOTED: Pair[] = [
  ['pending', 'pending'],
  ['locking', 'pending'],
]
const COLLECTING: Pair[] = [
  ['locked', 'claimed'],
  ['claiming', 'claimed'],
]
const REFUNDED: Pair[] = [
  ['locked', 'refunded'],
  ['refunding', 'refunded'],
  ['refunded', 'refunded'],
]

const CORRIDORS: Record<string, Corridor> = {
  lnSend: {
    machine: LnSendMachine,
    from: 'vhtlc',
    to: 'lightning',
    positions: {
      quoted: QUOTED,
      funded: [['locked', 'pending']],
      // `paying` and `paid` are one pair; the payment id on the leg tells them apart.
      paying: [['locked', 'locking']],
      paid: [['locked', 'locking']],
      claiming: COLLECTING,
      claimed: [['claimed', 'claimed']],
      refused: 'refused',
      stuck: 'stuck',
    },
  },
  lnReceive: {
    machine: LnReceiveMachine,
    from: 'lightning',
    to: 'vhtlc',
    positions: {
      quoted: QUOTED,
      armed: [
        ['locked', 'pending'],
        ['locked', 'locking'],
      ],
      funded: [['locked', 'locked']],
      claimed: COLLECTING,
      refunding: [['locked', 'refunding']],
      settled: [['claimed', 'claimed']],
      refunded: REFUNDED,
      refused: 'refused',
      stuck: 'stuck',
    },
    exposureExceptions: {
      'armed locked/locking':
        'legacy calls a funding in flight unexposed; every other corridor, and the model, call it exposed',
    },
  },
  onchainSend: {
    machine: OnchainSendMachine,
    from: 'vhtlc',
    to: 'onchain-htlc',
    positions: {
      quoted: QUOTED,
      funded: [['locked', 'pending']],
      funding_onchain: [['locked', 'locking']],
      awaiting_claim: [
        ['locked', 'locked'],
        ['locked', 'claiming'],
      ],
      claiming: COLLECTING,
      refunding_onchain: [['locked', 'refunding']],
      claimed: [['claimed', 'claimed']],
      refunded: REFUNDED,
      refused: 'refused',
      stuck: 'stuck',
    },
  },
  assetRfq: {
    machine: AssetRfqMachine,
    from: 'offer',
    to: 'payment',
    positions: {
      quoted: QUOTED,
      funded: [['locked', 'pending']],
      filling: [['locked', 'locking']],
      filled: [['claimed', 'claimed']],
      refused: 'refused',
      stuck: 'stuck',
    },
  },
  evmSend: {
    machine: EvmSendMachine,
    from: 'vhtlc',
    to: 'evm-htlc',
    positions: {
      // The planner acts on a funded lockup while the row still says `quoted`.
      quoted: [...QUOTED, ['locked', 'pending']],
      funded: [['locked', 'pending']],
      locking_evm: [['locked', 'locking']],
      awaiting_claim: [
        ['locked', 'locked'],
        ['locked', 'claiming'],
      ],
      claiming: COLLECTING,
      claimed: [['claimed', 'claimed']],
      refunding_evm: [['locked', 'refunding']],
      refunded: REFUNDED,
      refused: 'refused',
      stuck: 'stuck',
    },
  },
  evmReceive: {
    machine: EvmReceiveMachine,
    from: 'evm-htlc',
    to: 'vhtlc',
    positions: {
      quoted: [...QUOTED, ['locked', 'pending']],
      awaiting_lock: QUOTED,
      locked: [['locked', 'pending']],
      funding_arkade: [['locked', 'locking']],
      awaiting_claim: [
        ['locked', 'locked'],
        ['locked', 'claiming'],
      ],
      claiming: COLLECTING,
      claimed: [['claimed', 'claimed']],
      refunding_arkade: [['locked', 'refunding']],
      refunded: REFUNDED,
      refused: 'refused',
      stuck: 'stuck',
    },
  },
}

const key = ([from, to]: Pair): string => `${from}/${to}`

/** Every pair one command of the aggregate can reach: a single leg step, or the offer's atomic fill. */
const steps = ({ from, to }: Corridor, [f, t]: Pair): Pair[] => {
  const next: Pair[] = [
    ...LegMachine.edges[f]
      .filter((state) => Leg.canTransition({ side: 'from', contract: from }, f, state))
      .map((state): Pair => [state, t]),
    ...LegMachine.edges[t]
      .filter((state) => Leg.canTransition({ side: 'to', contract: to }, t, state))
      .map((state): Pair => [f, state]),
  ].filter(([a, b]) => SwapState.derive(a, b) !== null)
  if (from === 'offer' && f === 'locked' && t === 'locking') next.push(['claimed', 'claimed'])
  return next
}

const reaches = (corridor: Corridor, starts: readonly Pair[], goals: readonly Pair[]): boolean => {
  const wanted = new Set(goals.map(key))
  const seen = new Set<string>()
  const queue = [...starts]
  for (let pair = queue.shift(); pair; pair = queue.shift()) {
    if (wanted.has(key(pair))) return true
    if (seen.has(key(pair))) continue
    seen.add(key(pair))
    queue.push(...steps(corridor, pair))
  }
  return false
}

const exposedPair = ([from, to]: Pair): boolean => SwapState.isExposed(SwapState.derive(from, to)!)

/** Whether the aggregate can make the move a legacy edge stands for. */
const expressible = (corridor: Corridor, from: string, to: string): boolean => {
  const [a, b] = [corridor.positions[from]!, corridor.positions[to]!]
  if (typeof b !== 'string') {
    // Out of `stuck` the model only resumes to collect, as legacy does.
    return typeof a === 'string' ? a === 'stuck' && b.every(([, t]) => t === 'claimed') : reaches(corridor, a, b)
  }
  if (typeof a === 'string') return a === 'stuck'
  // `refused` needs nothing of ours out; a payout that provably failed is taken back first (`lockFailed`).
  return b !== 'refused' || a.some((pair) => !exposedPair(pair) || pair[1] === 'locking')
}

describe.each(Object.entries(CORRIDORS))('%s on the leg model', (_, corridor) => {
  const { machine, positions, exposureExceptions = {} } = corridor
  const legs = (state: string): readonly Pair[] =>
    typeof positions[state] === 'string' ? [] : (positions[state] as Pair[])

  it('places every legacy state', () => {
    expect(Object.keys(positions).sort()).toEqual([...machine.states].sort())
    for (const state of machine.states) {
      for (const pair of legs(state)) expect(SwapState.derive(...pair), `${state} ${key(pair)}`).not.toBeNull()
    }
  })

  it('agrees on what is live and what is exposed', () => {
    const disagreements: string[] = []
    for (const state of machine.states) {
      const position = positions[state]!
      if (typeof position === 'string') {
        if (machine.isLive(state) || machine.isExposed(state)) disagreements.push(`${state} is an outcome but live`)
        continue
      }
      for (const pair of position) {
        const derived = SwapState.derive(...pair)!
        if (machine.isLive(state) === SwapState.isTerminal(derived))
          disagreements.push(`${state} ${key(pair)} liveness`)
        if (machine.isExposed(state) !== SwapState.isExposed(derived)) disagreements.push(`${state} ${key(pair)}`)
      }
    }
    expect(disagreements).toEqual(Object.keys(exposureExceptions))
  })

  it('can make every move the legacy machine allows', () => {
    const missing = machine.states.flatMap((from) =>
      machine.edges[from]!.filter((to) => !expressible(corridor, from, to)).map((to) => `${from} -> ${to}`),
    )
    expect(missing).toEqual([])
  })
})
