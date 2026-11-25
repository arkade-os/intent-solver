import { describe, expect, it, vi } from 'vitest'
import type { lookup } from 'node:dns/promises'
import { RateLimiter } from '@arkade-os/solver-core/core/rateLimit.js'
import {
  createPinnedTaxiFetch,
  guardedTaxiFetch,
  normalizeTaxiUrl,
  publicTaxiAddress,
} from '@arkade-os/solver-app/ops/taxiUrlGuard.js'

const mainnet = { isMainnet: true, allowPrivate: false }
const regtest = { isMainnet: false, allowPrivate: false }
const resolver = (...answers: { address: string; family: number }[]) =>
  (async () => answers) as unknown as typeof lookup
const limiter = () => new RateLimiter(10, 60, () => 0)

describe('a request-named Taxi URL', () => {
  it('normalises a public https origin', () => {
    expect(normalizeTaxiUrl('https://Taxi.Example.com./', mainnet)).toBe('https://taxi.example.com')
    expect(normalizeTaxiUrl('https://taxi.example.com:443/v1', mainnet)).toBe('https://taxi.example.com/v1')
  })

  it.each([
    ['http://taxi.example.com', 'https on mainnet'],
    ['https://taxi.example.com:8443', 'port 443'],
    ['https://93.184.216.34', 'DNS name'],
    ['https://user:pw@taxi.example.com', 'credentials'],
    ['https://taxi.example.com/?a=1', 'query'],
    ['https://taxi.example.com/#f', 'fragment'],
    ['https://localhost../', 'empty label'],
    ['ftp://taxi.example.com', 'http or https'],
    ['taxi.example.com', 'absolute URL'],
  ])('refuses %s on mainnet', (raw, reason) => {
    expect(() => normalizeTaxiUrl(raw, mainnet)).toThrow(reason)
  })

  it.each([
    'http://localhost:3000',
    'http://127.0.0.1',
    'http://10.1.2.3',
    'http://100.64.0.1',
    'http://169.254.169.254',
    'http://172.16.0.1',
    'http://192.168.1.1',
    'http://[::1]',
    'http://[fd00::1]',
    'http://[fe80::1]',
    'http://[::ffff:127.0.0.1]',
    'http://[64:ff9b::a00:1]',
    'http://taxi',
    'http://taxi.internal',
    'http://taxi.local.',
  ])('refuses the private host %s', (raw) => {
    expect(() => normalizeTaxiUrl(raw, regtest)).toThrow('must not be private')
  })

  it('admits a private host only when the composition root allows it', () => {
    expect(normalizeTaxiUrl('http://taxi:3000', { isMainnet: false, allowPrivate: true })).toBe('http://taxi:3000')
  })
})

describe('the address a Taxi host resolves to', () => {
  it('refuses a name with any private answer, or with none', async () => {
    const mixed = resolver({ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 })
    await expect(publicTaxiAddress('taxi.example.com', mixed)).rejects.toThrow('private address')
    const mapped = resolver({ address: '::ffff:7f00:1', family: 6 })
    await expect(publicTaxiAddress('taxi.example.com', mapped)).rejects.toThrow('private address')
    await expect(publicTaxiAddress('taxi.example.com', resolver())).rejects.toThrow('no addresses')
  })

  it('returns the first answer when every one is public', async () => {
    const answers = resolver({ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 })
    await expect(publicTaxiAddress('taxi.example.com', answers)).resolves.toEqual({
      address: '93.184.216.34',
      family: 4,
    })
  })
})

describe('a guarded Taxi fetch', () => {
  it('refuses a redirect even from a fetch that ignored redirect: error', async () => {
    const base = vi.fn<typeof fetch>(async () => new Response(null, { status: 302 }))
    await expect(guardedTaxiFetch(base, limiter())('https://taxi.example.com/v1/quote')).rejects.toThrow('redirect')
    expect(base.mock.calls[0]![1]).toMatchObject({ redirect: 'error' })
  })

  it('refuses a body over the cap, declared or streamed', async () => {
    const big = new Uint8Array(256 * 1024 + 1)
    const declared = async () => new Response(big, { headers: { 'content-length': String(big.length) } })
    await expect(guardedTaxiFetch(declared, limiter())('https://taxi.example.com')).rejects.toThrow('content-length')
    const streamed = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(big)
            controller.close()
          },
        }),
      )
    await expect(guardedTaxiFetch(streamed, limiter())('https://taxi.example.com')).rejects.toThrow('over 262144 bytes')
  })

  it('spends the host budget before the network, and the global one only after it', async () => {
    const base = vi.fn<typeof fetch>(async () => new Response('{}'))
    const once = () => new RateLimiter(1, 60, () => 0)
    const guarded = guardedTaxiFetch(base, once(), { global: once() })
    await guarded('https://a.example.com')
    await expect(guarded('https://a.example.com')).rejects.toThrow('rate-limited: a.example.com')
    await expect(guarded('https://b.example.com')).rejects.toThrow('across every host')
    expect(base).toHaveBeenCalledOnce()
  })
})

describe('the pinned Taxi fetch', () => {
  it('connects to the address it pinned and carries the request and reply through', async () => {
    const { createServer } = await import('node:http')
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ method: request.method, host: request.headers.host, body }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const pinned: string[] = []
    const pinnedFetch = createPinnedTaxiFetch(async (host) => {
      pinned.push(host)
      return { address: '127.0.0.1', family: 4 }
    })
    try {
      const reply = await pinnedFetch(`http://taxi.example:${port}/v1/fills`, { method: 'POST', body: 'signed' })
      expect(reply.status).toBe(200)
      expect(await reply.json()).toEqual({ method: 'POST', host: `taxi.example:${port}`, body: 'signed' })
      expect(pinned).toEqual(['taxi.example'])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('refuses before connecting when the name resolves to a private address', async () => {
    const resolve = (async () => [{ address: '10.0.0.7', family: 4 }]) as never
    const pinnedFetch = createPinnedTaxiFetch((host) => publicTaxiAddress(host, resolve))
    await expect(pinnedFetch('https://taxi.example/v1/info')).rejects.toThrow('private address')
  })
})
