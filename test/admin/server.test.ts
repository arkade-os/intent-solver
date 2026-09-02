import { describe, it, expect } from 'vitest'
import { buildAdminApp } from '@arkade-os/solver-app/admin/server.js'

const app = (over: Partial<Parameters<typeof buildAdminApp>[0]> = {}) =>
  buildAdminApp({
    services: {} as never,
    startedAt: 1_000_000,
    mode: 'relay',
    now: () => 1_000_042,
    ...over,
  })

describe('the admin app', () => {
  it('answers a health probe with the mode it is hosted in', async () => {
    const response = await app().fetch(new Request('http://admin/api/healthz'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, mode: 'relay', uptimeSeconds: 42 })
  })

  it('reports the mode it was actually given, not a fixed one', async () => {
    const response = await app({ mode: 'serve' }).fetch(new Request('http://admin/api/healthz'))
    expect(await response.json()).toMatchObject({ mode: 'serve' })
  })

  it('never reports negative uptime if the clock moves backwards', async () => {
    const response = await app({ now: () => 999_999 }).fetch(new Request('http://admin/api/healthz'))
    expect(await response.json()).toMatchObject({ uptimeSeconds: 0 })
  })

  it('404s an unknown api route as JSON, not HTML', async () => {
    const response = await app().fetch(new Request('http://admin/api/nope'))
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toMatchObject({ error: 'not_found', path: '/api/nope' })
  })
})
