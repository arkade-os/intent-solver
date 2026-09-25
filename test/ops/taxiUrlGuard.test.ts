import { describe, it, expect } from 'vitest'
import { RateLimiter } from '@arkade-os/solver-core/core/rateLimit.js'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  normalizeTaxiUrl,
  guardedTaxiFetch,
  publicTaxiAddress,
  createPinnedTaxiFetch,
  type TaxiUrlPolicy,
} from '@arkade-os/solver-app/ops/taxiUrlGuard.js'

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

  it('refuses localhost by name (rule 5)', () => {
    expect(() => normalizeTaxiUrl('http://localhost', { isMainnet: false, allowPrivate: false })).toThrow(/private/)
  })

  it.each([
    ['a *.localhost name', 'http://taxi.localhost', 'http://taxi.localhost'],
    ['a deeper *.localhost name', 'http://a.b.localhost.', 'http://a.b.localhost'],
    ['a single-label service name', 'http://arkd:7070', 'http://arkd:7070'],
    ['a single-label name with a root dot', 'http://taxi.', 'http://taxi'],
  ])('refuses %s unless allowed', (_why, url, normalized) => {
    expect(() => normalizeTaxiUrl(url, { isMainnet: false, allowPrivate: false })).toThrow(/private/)
    expect(normalizeTaxiUrl(url, regtest)).toBe(normalized)
  })

  it('refuses a *.localhost name on mainnet too', () => {
    expect(() => normalizeTaxiUrl('https://taxi.localhost', main)).toThrow(/private/)
  })

  it('still accepts a dotted public name that merely contains "localhost"', () => {
    expect(normalizeTaxiUrl('https://localhost.example', main)).toBe('https://localhost.example')
  })

  it.each([
    ['repeated trailing dots on localhost', 'http://localhost..', regtest],
    ['repeated trailing dots on a service name', 'http://arkd..:7070', regtest],
    ['repeated trailing dots on a public name', 'https://taxi.example..', main],
    ['a leading dot', 'https://.taxi.example', main],
    ['an empty inner label', 'https://taxi..example', main],
  ])('refuses %s, whatever the policy', (_why, url, policy) => {
    expect(() => normalizeTaxiUrl(url, policy)).toThrow(/empty label/)
    expect(() => normalizeTaxiUrl(url, { isMainnet: false, allowPrivate: false })).toThrow(/empty label/)
  })

  it('refuses an IPv6 loopback literal off mainnet unless allowed (rule 5)', () => {
    expect(() => normalizeTaxiUrl('https://[::1]', { isMainnet: false, allowPrivate: false })).toThrow(/private/)
  })

  it('refuses the whole 127.0.0.0/8 range, not just 127.0.0.1 (rule 5)', () => {
    expect(() => normalizeTaxiUrl('http://127.5.5.5', { isMainnet: false, allowPrivate: false })).toThrow(/private/)
  })

  // Rule 5's intent is "no private destination"; its literal list is narrower
  // than that. Each range below is refused unless allowed, off mainnet.
  it.each([
    ['0.0.0.0/8', 'http://0.1.2.3'],
    ['10/8', 'http://10.0.0.5'],
    ['100.64/10 (CGN)', 'http://100.64.0.1'],
    ['169.254/16', 'http://169.254.1.1'],
    ['172.16/12', 'http://172.20.5.5'],
    ['192.168/16', 'http://192.168.1.1'],
  ])('refuses IPv4 %s unless allowed (rule 5 extension)', (_range, url) => {
    expect(() => normalizeTaxiUrl(url, { isMainnet: false, allowPrivate: false })).toThrow(/private/)
    expect(normalizeTaxiUrl(url, { isMainnet: false, allowPrivate: true })).toBe(url)
  })

  it.each([
    ['::', 'https://[::]'],
    ['fc00::/7', 'https://[fd12:3456::1]'],
    ['fe80::/10', 'https://[fe80::1]'],
  ])('refuses IPv6 %s unless allowed (rule 5 extension)', (_range, url) => {
    expect(() => normalizeTaxiUrl(url, { isMainnet: false, allowPrivate: false })).toThrow(/private/)
    expect(() => normalizeTaxiUrl(url, { isMainnet: false, allowPrivate: true })).not.toThrow()
  })

  it('refuses an IPv4-mapped IPv6 loopback, dotted or hex form (rule 5 extension, Critical #1)', () => {
    const policy = { isMainnet: false, allowPrivate: false }
    expect(() => normalizeTaxiUrl('https://[::ffff:127.0.0.1]/v1/info', policy)).toThrow(/private/)
    expect(() => normalizeTaxiUrl('https://[::ffff:7f00:1]', policy)).toThrow(/private/)
    expect(normalizeTaxiUrl('https://[::ffff:127.0.0.1]/v1/info', { ...policy, allowPrivate: true })).toBe(
      'https://[::ffff:7f00:1]/v1/info',
    )
  })

  it('refuses a NAT64-embedded private IPv4 but not a public one (RFC 6052)', () => {
    const policy = { isMainnet: false, allowPrivate: false }
    expect(() => normalizeTaxiUrl('https://[64:ff9b::7f00:1]', policy)).toThrow(/private/)
    expect(() => normalizeTaxiUrl('https://[64:ff9b::a00:1]', policy)).toThrow(/private/)
    expect(normalizeTaxiUrl('https://[64:ff9b::7f00:1]', { ...policy, allowPrivate: true })).toBe(
      'https://[64:ff9b::7f00:1]',
    )
    expect(normalizeTaxiUrl('https://[64:ff9b::a00:1]', { ...policy, allowPrivate: true })).toBe(
      'https://[64:ff9b::a00:1]',
    )
    expect(normalizeTaxiUrl('https://[64:ff9b::808:808]', policy)).toBe('https://[64:ff9b::808:808]')
  })

  it('refuses IPv4-compatible and transition addresses that can reach private IPv4', () => {
    const policy = { isMainnet: false, allowPrivate: false }
    for (const host of ['::7f00:1', '64:ff9b:1::7f00:1', '2002:7f00:1::', '2001:0:7f00:1::']) {
      expect(() => normalizeTaxiUrl(`https://[${host}]`, policy)).toThrow(/private/)
    }
  })

  it('refuses a decimal or hex loopback literal the same as dotted-decimal (rule 5)', () => {
    const policy = { isMainnet: false, allowPrivate: false }
    expect(() => normalizeTaxiUrl('https://2130706433', policy)).toThrow(/private/)
    expect(() => normalizeTaxiUrl('https://0x7f.1', policy)).toThrow(/private/)
    expect(normalizeTaxiUrl('https://2130706433', { ...policy, allowPrivate: true })).toBe('https://127.0.0.1')
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

  it('does not let a caller-supplied init override redirect or the guard signal (Important #4)', async () => {
    let seen: RequestInit | undefined
    const f = guardedTaxiFetch(async (_input, init) => {
      seen = init
      return new Response('{}')
    }, limiter())
    const callerSignal = new AbortController().signal
    await f('https://taxi.example/v1/info', { redirect: 'follow', signal: callerSignal })
    expect(seen?.redirect).toBe('error')
    expect(seen?.signal).not.toBe(callerSignal)
  })

  it('refuses a body past the cap', async () => {
    const f = guardedTaxiFetch(async () => new Response('x'.repeat(256 * 1024 + 1)), limiter())
    await expect(f('https://taxi.example/v1/info')).rejects.toThrow(/too large/)
  })

  it('cancels a streamed body with no content-length once it crosses the cap (Important #3)', async () => {
    let cancelled = false
    let pulls = 0
    const chunk = new Uint8Array(200 * 1024)
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls > 3) return controller.close()
        controller.enqueue(chunk)
      },
      cancel() {
        cancelled = true
      },
    })
    const f = guardedTaxiFetch(async () => new Response(stream), limiter())
    await expect(f('https://taxi.example/v1/info')).rejects.toThrow(/too large/)
    // Crosses the cap on the 2nd chunk (400 KiB); the reader must stop there.
    expect(pulls).toBeLessThan(4)
    expect(cancelled).toBe(true)
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

  it('keys the limiter on the trailing-dot-stripped host, same as normalizeTaxiUrl (Critical #2)', async () => {
    const lim = new RateLimiter(1, 60, () => 0)
    const f = guardedTaxiFetch(async () => new Response('{}'), lim)
    await f('https://taxi.example./v1/info')
    await expect(f('https://taxi.example/v1/info')).rejects.toThrow(/rate/)
  })
})

describe('request-named Taxi DNS', () => {
  const resolver = (addresses: { address: string; family: number }[]) =>
    (async () => addresses) as unknown as typeof import('node:dns/promises').lookup

  it('rejects a mixed public/private answer and embedded private IPv4', async () => {
    await expect(
      publicTaxiAddress(
        'taxi.example',
        resolver([
          { address: '8.8.8.8', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ]),
      ),
    ).rejects.toThrow(/private address/)
    await expect(
      publicTaxiAddress('taxi.example', resolver([{ address: '64:ff9b::7f00:1', family: 6 }])),
    ).rejects.toThrow(/private address/)
    await expect(publicTaxiAddress('taxi.example', resolver([{ address: '::7f00:1', family: 6 }]))).rejects.toThrow(
      /private address/,
    )
    await expect(publicTaxiAddress('taxi.example', resolver([{ address: '8.8.8.8', family: 4 }]))).resolves.toEqual({
      address: '8.8.8.8',
      family: 4,
    })
  })

  it('rejects a DNS name resolving to loopback before opening a socket', async () => {
    let calls = 0
    const server = createServer((_request, response) => {
      calls++
      response.end('unexpected')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as AddressInfo).port
      const pinned = createPinnedTaxiFetch(resolver([{ address: '127.0.0.1', family: 4 }]))
      await expect(pinned(`http://taxi.example:${port}/v1/info`)).rejects.toThrow()
      expect(calls).toBe(0)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })
})
