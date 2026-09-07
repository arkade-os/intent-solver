import { describe, it, expect } from 'vitest'
import { requestRestart, RestartDisabledError } from '@arkade-os/solver-app/ops/restart.js'
import { pendingRestartKeys } from '@arkade-os/solver-app/admin/settings.js'
import { ACTIONS } from '@arkade-os/solver-app/admin/routes/actions.js'

const capture = () => {
  const signals: Array<[number, string]> = []
  const timers: Array<[() => void, number]> = []
  return {
    signals,
    timers,
    deps: {
      signal: (pid: number, sig: NodeJS.Signals) => signals.push([pid, sig]),
      setTimer: (fn: () => void, ms: number) => timers.push([fn, ms]),
      pid: 4242,
    },
  }
}

describe('requestRestart', () => {
  it('refuses when disabled, naming the variable and why it exists', () => {
    const c = capture()
    expect(() => requestRestart({ ...c.deps, enabled: false })).toThrow(RestartDisabledError)
    expect(() => requestRestart({ ...c.deps, enabled: false })).toThrow(/ADMIN_RESTART_ENABLED/)
    expect(() => requestRestart({ ...c.deps, enabled: false })).toThrow(/nothing brings it back/)
  })

  it('signals nothing at all when disabled', () => {
    const c = capture()
    expect(() => requestRestart({ ...c.deps, enabled: false })).toThrow()
    expect(c.timers).toEqual([])
    expect(c.signals).toEqual([])
  })

  it('sends SIGTERM, not an exit, and only after the response can flush', () => {
    const c = capture()
    const result = requestRestart({ ...c.deps, enabled: true })

    expect(result).toMatchObject({ restarting: true, signal: 'SIGTERM', pid: 4242 })
    expect(c.signals).toEqual([])
    expect(c.timers).toHaveLength(1)

    const scheduled = c.timers[0]
    if (!scheduled) throw new Error('expected a scheduled timer')
    expect(scheduled[1]).toBeGreaterThan(0)

    scheduled[0]()
    expect(c.signals).toEqual([[4242, 'SIGTERM']])
  })
})

describe('pendingRestartKeys', () => {
  it('is empty when the stored overrides are the ones this process booted with', () => {
    expect(pendingRestartKeys({ A: '1', B: '2' }, { A: '1', B: '2' })).toEqual([])
  })

  it('does not report an override a restart has already applied', () => {
    expect(pendingRestartKeys({ MAX_EXPOSED_SATS: '500' }, { MAX_EXPOSED_SATS: '500' })).toEqual([])
  })

  it('reports an added, a changed and a cleared override alike', () => {
    expect(pendingRestartKeys({ CHANGED: '1', CLEARED: '9' }, { CHANGED: '2', ADDED: '3' })).toEqual([
      'ADDED',
      'CHANGED',
      'CLEARED',
    ])
  })

  it('sorts, so the banner does not reorder itself between polls', () => {
    expect(pendingRestartKeys({}, { Z: '1', A: '1', M: '1' })).toEqual(['A', 'M', 'Z'])
  })
})

describe('the restart action', () => {
  const armed = () => {
    const action = ACTIONS['restart-solver']
    if (!action) throw new Error('restart-solver is not registered')
    if (action.tier !== 'armed') throw new Error(`expected an armed action, got ${action.tier}`)
    return action
  }

  it('is armed, so a stray fetch cannot stop the solver', () => {
    expect(armed().tier).toBe('armed')
  })

  it('asks for a literal word, there being no swap id to type', () => {
    expect(armed().confirmKind).toBe('literal:RESTART')
    expect(armed().expectedConfirm({})).toBe('RESTART')
  })

  it('warns that a supervisor is what restarts, not the button', () => {
    expect(armed().warning).toMatch(/supervisor/)
  })
})
