/**
 * The admin console must not take the global `Response` with it.
 *
 * `@hono/node-server` replaces `globalThis.Request` and `globalThis.Response`
 * with its own lightweight classes when a listener is created, unless
 * `overrideGlobalObjects: false` is passed. That is a fine trade for a process
 * that only serves HTTP. This one also CONSUMES it, through a WebAssembly SDK
 * whose glue tests every fetch result with a bare `instanceof Response`
 * resolved from the global scope — so the swap makes a genuine undici response
 * fail its cast, and the SDK reports it as
 * `authentication error: network error`, nowhere near the real cause. It took
 * mainnet down for a day on 2026-08-21.
 *
 * Asserted two ways because each catches what the other cannot: the first pins
 * the LIBRARY behaviour we depend on, so a Hono upgrade that renames or drops
 * the flag fails here rather than in production; the second pins OUR call
 * sites, so a server added later without the flag fails here too.
 *
 * The default (overriding) path is deliberately not exercised. Hono defines
 * the replacement without `configurable: true`, so triggering it once makes
 * the global permanently non-restorable for the rest of the worker — a test
 * that proves the bug would poison every test after it.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getRequestListener } from '@hono/node-server'

const cli = readFileSync(fileURLToPath(new URL('../../src/cli.ts', import.meta.url)), 'utf8')

describe('the admin console leaves the global fetch classes alone', () => {
  it('keeps globalThis.Response identical when the flag is passed', () => {
    const before = globalThis.Response
    const beforeRequest = globalThis.Request

    getRequestListener(() => new Response('ok'), { overrideGlobalObjects: false })

    expect(globalThis.Response).toBe(before)
    expect(globalThis.Request).toBe(beforeRequest)
  })

  it('passes the shared options at every serve() call site in cli.ts', () => {
    const calls = cli.match(/serve\(\{[^}]*\}\)/g) ?? []
    expect(calls.length, 'expected serve() call sites in src/cli.ts').toBeGreaterThan(0)
    const missing = calls.filter((call) => !call.includes('HONO_SERVE_OPTIONS'))
    expect(missing, `serve() without HONO_SERVE_OPTIONS: ${missing.join(' | ')}`).toEqual([])
  })

  it('defines those options as the opt-out Hono actually reads', () => {
    expect(cli).toMatch(/HONO_SERVE_OPTIONS = \{ overrideGlobalObjects: false \}/)
  })
})
