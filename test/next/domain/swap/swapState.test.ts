import { describe, expect, it } from 'vitest'
import { LEG_MOVES, type LegState } from '@arkade-os/solver-next/domain/swap/leg.js'
import { SwapOutcome, SwapState, type DerivedSwapState } from '@arkade-os/solver-next/domain/swap/swap_state.js'

const LEG_STATES = Object.keys(LEG_MOVES) as LegState[]
const PAIRS = LEG_STATES.flatMap((from) => LEG_STATES.map((to) => [from, to] as const))

describe('SwapState', () => {
  it('names each pair of leg states once, and says nothing for legs that disagree', () => {
    const named = Object.fromEntries(PAIRS.map(([from, to]) => [`${from}/${to}`, SwapState.derive(from, to)]))
    expect(Object.fromEntries(Object.entries(named).filter(([, state]) => state !== null))).toEqual({
      'pending/pending': 'quoted',
      'locking/pending': 'quoted',
      'locked/pending': 'funded',
      'locked/locking': 'filling',
      'locked/locked': 'awaiting_claim',
      'locked/claiming': 'awaiting_claim',
      'locked/claimed': 'filled',
      'claiming/claimed': 'settling',
      'claimed/claimed': 'settled',
      'locked/refunding': 'refunding',
      'refunding/refunding': 'refunding',
      'refunded/refunding': 'refunding',
      'refunding/locked': 'refunding',
      'refunded/locked': 'refunding',
      'pending/refunded': 'refunded',
      'locking/refunded': 'refunded',
      'locked/refunded': 'refunded',
      'refunding/refunded': 'refunded',
      'refunded/refunded': 'refunded',
    })
  })

  it('is exposed exactly while our payout may be out and the client side is not ours yet', () => {
    const exposed: DerivedSwapState[] = ['filling', 'awaiting_claim', 'filled', 'settling', 'refunding']
    const all: DerivedSwapState[] = ['quoted', 'funded', ...exposed, 'settled', 'refunded']
    expect(all.filter(SwapState.isExposed)).toEqual(exposed)
    expect(Object.values(SwapOutcome).some(SwapState.isExposed)).toBe(false)
  })

  it('is finished when both legs are, and on every outcome', () => {
    const all: DerivedSwapState[] = [
      'quoted',
      'funded',
      'filling',
      'awaiting_claim',
      'filled',
      'settling',
      'settled',
      'refunding',
      'refunded',
    ]
    expect(all.filter(SwapState.isTerminal)).toEqual(['settled', 'refunded'])
    expect(Object.values(SwapOutcome).every(SwapState.isTerminal)).toBe(true)
  })

  it('never calls a swap finished while a leg can still move, nor exposed once both are final', () => {
    for (const [from, to] of PAIRS) {
      const state = SwapState.derive(from, to)
      if (state === null) continue
      const bothFinal = LEG_MOVES[from].length === 0 && LEG_MOVES[to].length === 0
      if (SwapState.isTerminal(state)) expect(LEG_MOVES[to].length, `${from}/${to}`).toBe(0)
      if (bothFinal) expect(SwapState.isExposed(state), `${from}/${to}`).toBe(false)
    }
  })
})
