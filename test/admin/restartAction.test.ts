/**
 * The restart button, and the two things that must be true before it exists.
 *
 * A restart is the ONLY way a stored setting or market reaches a running solver
 * — `createServices` resolves both once and nothing re-reads them — so the button
 * is the other half of the staleness alert in `configDrift.test.ts`. It is also
 * the one action here that stops the process, which makes it the one whose
 * friction and whose audit row matter most:
 *
 *  - it goes through the SAME armed gate as every money-moving action, so the
 *    typed confirmation is checked by the server before anything is armed and a
 *    bare `fetch` gets no shortcut;
 *  - it refuses outright unless the deployment has declared a supervisor, because
 *    nothing inside the process can establish that anything will start it again.
 *    A button that exits an unsupervised solver leaves it stopped.
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildAdminApp } from '@arkade-os/solver-app/admin/server.js'
import { ACTIONS } from '@arkade-os/solver-app/admin/routes/actions.js'
import { createProcessRestart, UNSUPERVISED_REFUSAL } from '@arkade-os/solver-app/ops/restart.js'
import { createServicesBody } from '../support/createServicesBody.js'

const corridor = (committedSats = 0, live: unknown[] = []) => ({
  committedSats: vi.fn().mockResolvedValue(committedSats),
  findRecoverable: vi.fn().mockResolvedValue(live),
})

const readerSet = (corridors: unknown[]) => ({
  get: () => undefined,
  size: corridors.length,
  [Symbol.iterator]: () => corridors[Symbol.iterator](),
})

const fakeServices = (over: Record<string, unknown> = {}) => ({
  adminStore: {
    recordAction: vi.fn().mockResolvedValue(undefined),
    listActions: vi.fn().mockResolvedValue([]),
    getOverrides: vi.fn().mockResolvedValue({}),
  },
  config: {},
  readers: readerSet([corridor(50_151, [{ id: 'swap-1' }, { id: 'swap-2' }])]),
  restart: { refusal: null, arm: vi.fn().mockReturnValue({ signalInMs: 1_000, forceAfterMs: 30_000 }) },
  ...over,
})

const post = (body: unknown, services: ReturnType<typeof fakeServices> = fakeServices()) =>
  buildAdminApp({ services: services as never, startedAt: 1, mode: 'relay' }).fetch(
    new Request('http://admin/api/actions/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

describe('createProcessRestart', () => {
  it('refuses when the deployment has not declared a supervisor', () => {
    const signal = vi.fn()
    const restart = createProcessRestart({ adminRestartSupervised: false }, { signal, schedule: (run) => run() })
    expect(restart.refusal).toBe(UNSUPERVISED_REFUSAL)
    expect(() => restart.arm()).toThrow(/ADMIN_RESTART_SUPERVISED/)
    // The refusal is the whole point: nothing may be signalled on a deployment
    // that would not come back.
    expect(signal).not.toHaveBeenCalled()
  })

  it('names the supervisors that make it safe, so the refusal is actionable', () => {
    expect(UNSUPERVISED_REFUSAL).toMatch(/docker-compose\.yml/)
    expect(UNSUPERVISED_REFUSAL).toMatch(/Restart=always/)
  })

  it('signals rather than exiting, so the sweep drains and every database closes', () => {
    const signal = vi.fn()
    const exit = vi.fn()
    const scheduled: (() => void)[] = []
    const restart = createProcessRestart(
      { adminRestartSupervised: true },
      { signal, exit, schedule: (run) => void scheduled.push(run) },
    )
    expect(restart.refusal).toBeNull()

    const plan = restart.arm()
    expect(plan.signalInMs).toBeGreaterThan(0)
    // ARMED, NOT FIRED. The caller has an audit row to write and a response to
    // answer, and both happen while this timer is still pending.
    expect(signal).not.toHaveBeenCalled()

    scheduled.shift()?.()
    expect(signal).toHaveBeenCalledTimes(1)
    // The graceful path is given its budget before anything is forced.
    expect(exit).not.toHaveBeenCalled()
    scheduled.shift()?.()
    expect(exit).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/actions/restart', () => {
  it('is armed, so the console cannot offer it as a plain button', () => {
    expect(ACTIONS['restart']?.tier).toBe('armed')
  })

  it('refuses without the typed confirmation, and arms nothing', async () => {
    const services = fakeServices()
    const response = await post({}, services)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'confirm_required' })
    expect(services.restart.arm).not.toHaveBeenCalled()
  })

  it('refuses a confirmation that is not the literal, including its lowercase', async () => {
    const services = fakeServices()
    expect((await post({ confirm: 'restart' }, services)).status).toBe(400)
    expect((await post({ confirm: 'yes' }, services)).status).toBe(400)
    expect(services.restart.arm).not.toHaveBeenCalled()
  })

  it('says what a restart interrupts, in the refusal the UI renders', async () => {
    const body = (await (await post({ confirm: 'x' })).json()) as { warning: string }
    expect(body.warning).toMatch(/in flight/i)
  })

  it('arms the shutdown once the confirmation matches', async () => {
    const services = fakeServices()
    const response = await post({ confirm: 'RESTART' }, services)
    expect(response.status).toBe(200)
    expect(services.restart.arm).toHaveBeenCalledTimes(1)
  })

  it('writes the audit row, with what was in flight when the operator pressed it', async () => {
    const services = fakeServices()
    await post({ confirm: 'RESTART' }, services)
    expect(services.adminStore.recordAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'restart', outcome: 'ok' }),
    )
    const { detail } = services.adminStore.recordAction.mock.calls[0]![0] as { detail: string }
    // The numbers, not just the fact: "who restarted a solver holding 50,151
    // sats" is the question this row has to be able to answer later.
    expect(JSON.parse(detail)).toMatchObject({ inFlight: { committedSats: 50_151, liveCount: 2 } })
  })

  it('records the exposure BEFORE the process is signalled, never after', async () => {
    // The row is written by the route once `run` returns, and `arm` only
    // SCHEDULES — so the audit write always precedes the signal. Asserted at the
    // seam rather than left to the clock.
    const signalled: string[] = []
    const services = fakeServices({
      adminStore: {
        recordAction: vi.fn().mockImplementation(async () => void signalled.push('audit')),
        listActions: vi.fn().mockResolvedValue([]),
        getOverrides: vi.fn().mockResolvedValue({}),
      },
      restart: {
        refusal: null,
        arm: vi.fn().mockImplementation(() => {
          signalled.push('arm')
          return { signalInMs: 1_000, forceAfterMs: 30_000 }
        }),
      },
    })
    await post({ confirm: 'RESTART' }, services)
    expect(signalled).toEqual(['arm', 'audit'])
  })

  it('refuses on a deployment with no declared supervisor, and audits the refusal', async () => {
    const arm = vi.fn()
    const services = fakeServices({ restart: { refusal: UNSUPERVISED_REFUSAL, arm } })
    const response = await post({ confirm: 'RESTART' }, services)
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ ok: false, message: UNSUPERVISED_REFUSAL })
    expect(arm).not.toHaveBeenCalled()
    // A refusal an operator has to find later is exactly the row a log that
    // remembers only successes would lose.
    expect(services.adminStore.recordAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'restart', outcome: 'error' }),
    )
  })

  it('still restarts when the stores cannot be read, reporting that instead of the numbers', async () => {
    // A sick store is a reason to restart, not a reason the button stops working.
    const services = fakeServices({
      readers: readerSet([
        {
          committedSats: vi.fn().mockRejectedValue(new Error('database is locked')),
          findRecoverable: vi.fn().mockResolvedValue([]),
        },
      ]),
    })
    expect((await post({ confirm: 'RESTART' }, services)).status).toBe(200)
    const { detail } = services.adminStore.recordAction.mock.calls[0]![0] as { detail: string }
    expect(JSON.parse(detail)).toMatchObject({ inFlight: { unreadable: 'database is locked' } })
  })
})

describe('createServices wires the restart control', () => {
  it('builds it from this deployment’s config, never as a standing yes', () => {
    // Asserted against the source because constructing the stack needs an
    // Arkade wallet, a Lightning node and a chain a unit test has none of — the
    // reason `createServicesBody` exists.
    expect(createServicesBody()).toContain('restart: createProcessRestart(config)')
  })
})

/** The button itself, which is what an operator actually reaches. */
describe('the console renders the button', () => {
  const appSource = readFileSync(
    fileURLToPath(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url)),
    'utf8',
  )

  const panel = (): string => {
    const start = appSource.indexOf('const restartPanel')
    if (start === -1) throw new Error('restartPanel is gone')
    return appSource.slice(start, appSource.indexOf('const overviewView', start))
  }

  it('goes through the armed dialog, never straight to runAction', () => {
    // `armDialog` is the typed-confirmation step, and the server checks the same
    // word independently. A direct `runAction('restart')` would be a one-click
    // shutdown of a money-mover.
    expect(panel()).toContain("armDialog('restart'")
    expect(panel()).not.toContain("runAction('restart'")
  })

  it('states what is in flight before asking, from the figures already on screen', () => {
    expect(panel()).toContain('inFlightLine(o)')
    const line = appSource.slice(appSource.indexOf('const inFlightLine'), appSource.indexOf('const restartPanel'))
    expect(line).toContain('o.exposure.committedSats')
    expect(line).toContain('o.exposure.exposedCount')
    expect(line).toContain('stuckCount')
  })

  it('renders the refusal instead of the button where a restart cannot be taken', () => {
    expect(panel()).toMatch(/r\.refusal\s*\?/)
  })
})
