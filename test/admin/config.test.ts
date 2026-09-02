/**
 * `ADMIN_PORT` and `ADMIN_HOST`.
 *
 * The port is opt-in: unset means the console never starts and an existing
 * deployment opens no new socket. The host is the ONE knob in `loadConfig`
 * that deliberately does not refuse a risky value — a non-loopback bind is
 * allowed, because access control for this port is a reverse proxy's job by
 * deployment decision and the container case requires it (the Dockerfile's
 * default command is `relay`, which opens no port of its own, so in Docker
 * this is the only listening socket and loopback would be unreachable).
 *
 * That exception is pinned here so a later "harden every knob" pass cannot
 * quietly turn it into a refusal and break every containerised deployment.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadConfig } from '../../src/config.js'

const CONFIG_KEYS = ['ADMIN_PORT', 'ADMIN_HOST', 'LN_BACKEND', 'LN_MNEMONIC', 'PORT', 'HOST']

const BASE_ENV: Record<string, string> = {
  SWAP_NETWORK: 'regtest',
  ARK_MNEMONIC: 'test mnemonic, never a real one',
  ARK_SERVER_URL: 'http://localhost:7070',
  EMULATOR_URL: 'http://localhost:7073',
  LN_BACKEND: 'fake',
}

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of CONFIG_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  for (const [key, value] of Object.entries(BASE_ENV)) {
    saved[key] ??= process.env[key]
    process.env[key] = value
  }
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('the admin console port', () => {
  it('is off when ADMIN_PORT is unset — no new socket for an existing deployment', () => {
    expect(loadConfig().adminPort).toBeNull()
  })

  it('treats a set-but-empty value as unset, like every other knob here', () => {
    process.env.ADMIN_PORT = '   '
    expect(loadConfig().adminPort).toBeNull()
  })

  it('reads a port when one is given', () => {
    process.env.ADMIN_PORT = '8788'
    expect(loadConfig().adminPort).toBe(8788)
  })

  it('refuses a port outside the legal range', () => {
    process.env.ADMIN_PORT = '70000'
    expect(() => loadConfig()).toThrow(/ADMIN_PORT/)
  })

  it('refuses a non-numeric port rather than silently disabling the console', () => {
    process.env.ADMIN_PORT = 'yes'
    expect(() => loadConfig()).toThrow(/ADMIN_PORT/)
  })
})

describe('the admin console binding', () => {
  it('defaults to loopback, matching HOST', () => {
    process.env.ADMIN_PORT = '8788'
    expect(loadConfig().adminHost).toBe('127.0.0.1')
  })

  it('ALLOWS a non-loopback bind — the reverse proxy is the access control', () => {
    process.env.ADMIN_PORT = '8788'
    process.env.ADMIN_HOST = '0.0.0.0'
    expect(loadConfig().adminHost).toBe('0.0.0.0')
  })

  it('does not disturb the RFQ port and host', () => {
    process.env.ADMIN_PORT = '8788'
    const config = loadConfig()
    expect(config.port).toBe(8787)
    expect(config.host).toBe('127.0.0.1')
  })
})
