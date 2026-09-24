import { describe, it, expect } from 'vitest'
import { RateLimiter } from '@arkade-os/solver-core/core/rateLimit.js'
import { normalizeTaxiUrl, guardedTaxiFetch, type TaxiUrlPolicy } from '@arkade-os/solver-app/ops/taxiUrlGuard.js'

const main: TaxiUrlPolicy = { isMainnet: true, allowPrivate: false }
const regtest: TaxiUrlPolicy = { isMainnet: false, allowPrivate: true }
// High headroom: a limiter that should not be the thing under test in a given case.
const limiter = () => new RateLimiter(1000, 60, () => 0)

describe('normalizeTaxiUrl', () => {
  it('accepts an https host on mainnet and strips the trailing slash', () => {
    expect(normalizeTaxiUrl('https://taxi.example/', main)).toBe('https://taxi.example')
  })

  it('refuses a malformed URL (rule 1)', () => {
    expect(() => normalizeTaxiUrl('not a url', main)).toThrow(/absolute URL/)
  })

  it('refuses a non-http(s) scheme (rule 1)', () => {
    expect(() => normalizeTaxiUrl('ftp://taxi.example', main)).toThrow(/http/)
  })

  it('refuses plaintext on mainnet even on loopback', () => {
    expect(() => normalizeTaxiUrl('http://127.0.0.1:8080', main)).toThrow(/https/)
  })

  it('refuses an IP literal on mainnet', () => {
    expect(() => normalizeTaxiUrl('https://203.0.113.4', main)).toThrow(/DNS name/)
  })

  it('refuses an IPv6 literal on mainnet (rule 4)', () => {
    expect(() => normalizeTaxiUrl('https://[2001:db8::1]', main)).toThrow(/DNS name/)
  })

  it('refuses credentials, a query and a fragment', () => {
    expect(() => normalizeTaxiUrl('https://a:b@taxi.example', main)).toThrow(/credentials/)
    expect(() => normalizeTaxiUrl('https://taxi.example/?x=1', main)).toThrow(/query/)
    expect(() => normalizeTaxiUrl('https://taxi.example/#f', main)).toThrow(/fragment/)
  })

  it('refuses userinfo with no password too (rule 3)', () => {
    expect(() => normalizeTaxiUrl('https://user@taxi.example', main)).toThrow(/credentials/)
  })

  it('refuses a non-443 port on mainnet', () => {
    expect(() => normalizeTaxiUrl('https://taxi.example:8443', main)).toThrow(/port/)
  })

  it('refuses a private suffix unless allowed', () => {
    expect(() => normalizeTaxiUrl('https://taxi.internal', { isMainnet: false, allowPrivate: false })).toThrow(
      /private/,
    )
    expect(normalizeTaxiUrl('http://taxi.internal', regtest)).toBe('http://taxi.internal')
  })

  it('refuses an IPv6 loopback literal off mainnet unless allowed (rule 5)', () => {
    expect(() => normalizeTaxiUrl('https://[::1]', { isMainnet: false, allowPrivate: false })).toThrow(/private/)
  })

  it('refuses the whole 127.0.0.0/8 range, not just 127.0.0.1 (rule 5)', () => {
    expect(() => normalizeTaxiUrl('http://127.5.5.5', { isMainnet: false, allowPrivate: false })).toThrow(/private/)
  })

  it('a trailing root dot does not evade the private-suffix check (rule 5)', () => {
    expect(() => normalizeTaxiUrl('https://taxi.internal.', { isMainnet: false, allowPrivate: false })).toThrow(
      /private/,
    )
  })

  it('normalizes an uppercase scheme and host rather than rejecting them', () => {
    expect(normalizeTaxiUrl('HTTPS://TAXI.EXAMPLE/', main)).toBe('https://taxi.example')
  })
})

describe('guardedTaxiFetch', () => {
  it('sends redirect:"error" and a 5s abort signal on every call (rule 6)', async () => {
    let seen: RequestInit | undefined
    const f = guardedTaxiFetch(async (_input, init) => {
      seen = init
      return new Response('{}')
    }, limiter())
    await f('https://taxi.example/v1/info')
    expect(seen?.redirect).toBe('error')
    expect(seen?.signal).toBeInstanceOf(AbortSignal)
  })

  it('refuses a redirect it is handed rather than trusting the option', async () => {
    // A stubbed fetch ignores `redirect: 'error'`, so the guard must inspect the
    // response itself; asserting only the option would pass against any stub.
    const f = guardedTaxiFetch(async () => new Response('', { status: 302, headers: { location: '/x' } }), limiter())
    await expect(f('https://taxi.example/v1/info')).rejects.toThrow(/redirect/)
  })

  it('refuses a body past the cap', async () => {
    const f = guardedTaxiFetch(async () => new Response('x'.repeat(256 * 1024 + 1)), limiter())
    await expect(f('https://taxi.example/v1/info')).rejects.toThrow(/too large/)
  })

  it('rate-limits per host and lets a different host through', async () => {
    const lim = new RateLimiter(2, 60, () => 0)
    let calls = 0
    const f = guardedTaxiFetch(async () => {
      calls++
      return new Response('{}')
    }, lim)
    await f('https://a.example/v1/info')
    await f('https://a.example/v1/info')
    expect(calls).toBe(2)
    await expect(f('https://a.example/v1/info')).rejects.toThrow(/rate/)
    // The rate-limited call above must never have reached the base fetch.
    expect(calls).toBe(2)
    await expect(f('https://b.example/v1/info')).resolves.toBeDefined()
    expect(calls).toBe(3)
  })
})
