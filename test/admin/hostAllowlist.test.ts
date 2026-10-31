// DNS-rebinding defence: the same-site guard passes a rebinding fetch (same-origin,
// Origin host == request host), so only the Host — pinned here — gives it away.
import { describe, it, expect, vi } from 'vitest'
import { buildAdminApp, adminHostAllowlist } from '@arkade-os/solver-app/admin/server.js'

const services = (config: Record<string, unknown>) => ({
  adminStore: { recordAction: vi.fn(), listActions: vi.fn(), getOverrides: vi.fn() },
  store: { get: vi.fn(), patch: vi.fn() },
  config,
  corridors: { get: () => undefined, size: 0, [Symbol.iterator]: () => [][Symbol.iterator]() },
})

const app = (config: Record<string, unknown>) =>
  buildAdminApp({ services: services(config) as never, startedAt: 1_000_000, mode: 'relay' })

const mutate = (host: string, config: Record<string, unknown>) =>
  app(config).fetch(
    new Request(`http://${host}/api/actions/no-such-action`, {
      method: 'POST',
      headers: { origin: `http://${host}`, 'content-type': 'application/json' },
      body: '{}',
    }),
  )

const LOOPBACK = { adminHost: '127.0.0.1', adminPort: 8788 }

describe('adminHostAllowlist', () => {
  it('pins the bound host and its loopback aliases at the admin port', () => {
    const hosts = adminHostAllowlist(LOOPBACK)
    expect(hosts.has('127.0.0.1:8788')).toBe(true)
    expect(hosts.has('localhost:8788')).toBe(true)
    expect(hosts.has('[::1]:8788')).toBe(true)
    expect(hosts.has('attacker.com')).toBe(false)
  })

  it('honours operator-declared hosts verbatim, port and all', () => {
    const hosts = adminHostAllowlist({
      ...LOOPBACK,
      adminAllowedHosts: ['solver.example.com', 'tunnel.example.com:9000'],
    })
    expect(hosts.has('solver.example.com')).toBe(true)
    expect(hosts.has('tunnel.example.com:9000')).toBe(true)
    expect(hosts.has('tunnel.example.com')).toBe(false)
  })

  it('is empty when no admin port is configured, so nothing is pinned', () => {
    expect(adminHostAllowlist({ adminHost: '127.0.0.1', adminPort: null }).size).toBe(0)
  })
})

describe('the mutating guard pins the Host header', () => {
  it('rejects a rebinding Host even when it looks same-origin', async () => {
    const response = await mutate('attacker.com', LOOPBACK)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: 'host_not_allowed',
      message: expect.stringContaining('attacker.com is not a Host'),
    })
  })

  it.each(['127.0.0.1:8788', 'localhost:8788', '[::1]:8788'])(
    'does not reject on Host grounds when the console is reached at %s',
    async (host) => {
      const response = await mutate(host, LOOPBACK)
      expect(response.status).not.toBe(403)
    },
  )

  it('admits a Host the operator declared, and still refuses the same name without its port', async () => {
    const config = { ...LOOPBACK, adminAllowedHosts: ['solver.example.com:8788'] }
    expect((await mutate('solver.example.com:8788', config)).status).not.toBe(403)
    expect((await mutate('solver.example.com', config)).status).toBe(403)
  })

  it('stays inert when no port is configured, leaving every current caller alone', async () => {
    const response = await mutate('admin', { adminHost: '127.0.0.1', adminPort: null })
    expect(response.status).not.toBe(403)
  })
})
