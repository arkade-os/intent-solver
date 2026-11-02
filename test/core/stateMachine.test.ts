import { describe, it, expect } from 'vitest'
import { defineMachine, stepFor, type StateOf } from '@arkade-os/solver-core/core/stateMachine.js'

const Door = defineMachine({
  closed: { live: true, exposed: false, lockable: true, to: ['open', 'broken'] },
  open: { live: true, exposed: true, to: ['closed', 'broken'] },
  broken: { live: false, exposed: false, to: [] },
  gone: { live: false, exposed: false, lockable: true, to: [] },
})
type DoorState = StateOf<typeof Door>

describe('defineMachine', () => {
  it('derives the sets in declaration order', () => {
    expect(Door.states).toEqual(['closed', 'open', 'broken', 'gone'])
    expect(Door.live).toEqual(['closed', 'open'])
    expect(Door.exposed).toEqual(['open'])
    expect(Door.terminal).toEqual(['broken', 'gone'])
    expect(Door.where('lockable')).toEqual(['closed', 'gone'])
  })

  it('answers membership and edges', () => {
    expect([Door.isLive('open'), Door.isLive('broken')]).toEqual([true, false])
    expect([Door.isTerminal('gone'), Door.isTerminal('closed')]).toEqual([true, false])
    expect([Door.isExposed('open'), Door.isExposed('closed')]).toEqual([true, false])
    expect(Door.canTransition('closed', 'open')).toBe(true)
    expect(Door.canTransition('broken', 'open')).toBe(false)
    expect(Door.edges.open).toEqual(['closed', 'broken'])
  })

  it('writes a SQL list in the order given', () => {
    expect(Door.sqlList(Door.live)).toBe("'closed','open'")
    expect(Door.sqlList([])).toBe('')
  })

  it('rejects an exposed state that is not live', () => {
    expect(() => defineMachine({ a: { live: false, exposed: true, to: [] } })).toThrow(/'a' is exposed but not live/)
  })

  it('rejects an edge to an unknown state at runtime too', () => {
    const table = { a: { live: true, exposed: false, to: ['b'] } } as never
    expect(() => defineMachine(table)).toThrow(/edge to unknown state 'b'/)
  })

  it('does not compile an unknown state or flag', () => {
    // @ts-expect-error 'ajar' is not a state
    Door.isLive('ajar')
    // @ts-expect-error 'b' is not a state
    expect(() => defineMachine({ a: { live: true, exposed: false, to: ['b'] } })).toThrow()
    // @ts-expect-error 'painted' is not a flag
    expect(Door.where('painted')).toEqual([])
    const s: DoorState = 'gone'
    expect(Door.isTerminal(s)).toBe(true)
  })
})

describe('stepFor', () => {
  type Row = { state: DoorState }
  const step = async () => true

  it('dispatches live states and returns false for terminal ones', async () => {
    const run = stepFor<DoorState, Row>(Door, { closed: step, open: async () => false, broken: null, gone: null })
    expect(await run({ state: 'closed' })).toBe(true)
    expect(await run({ state: 'open' })).toBe(false)
    expect(await run({ state: 'broken' })).toBe(false)
    expect(await run({ state: 'corrupt' as DoorState })).toBe(false)
  })

  it('throws on a live state with no step and a terminal one with a step', () => {
    expect(() => stepFor<DoorState, Row>(Door, { closed: null, open: step, broken: null, gone: null })).toThrow(
      /'closed' is live but has no step/,
    )
    expect(() => stepFor<DoorState, Row>(Door, { closed: step, open: step, broken: step, gone: null })).toThrow(
      /'broken' is terminal but has a step/,
    )
  })

  it('does not compile with a state missing', () => {
    // @ts-expect-error 'gone' has no entry
    expect(() => stepFor<DoorState, Row>(Door, { closed: step, open: step, broken: null })).toThrow()
  })
})
