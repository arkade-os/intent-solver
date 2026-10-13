import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { lookup as dnsLookup } from 'node:dns'
import { createGuardedFetch } from '@arkade-os/solver-core/price/guardedFetch.js'
import { createPriceFeed } from '@arkade-os/solver-core/price/feed.js'

// The server is on loopback, so "private" here is 10/8: `public.test` resolves to
// loopback and passes, `rebind.test` resolves to 10.0.0.5 and must be refused.
const ADDRESSES: Record<string, string> = { 'public.test': '127.0.0.1', 'rebind.test': '10.0.0.5' }
const lookup = ((hostname: string, _options: unknown, callback: (...args: unknown[]) => void) => {
  const address = ADDRESSES[hostname]
  if (!address) return callback(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }))
  callback(null, [{ address, family: 4 }])
}) as unknown as typeof dnsLookup
const fetchGuarded = createGuardedFetch({ lookup, isPrivate: (address) => address.startsWith('10.') })

let server: Server
let port = 0
const hits: string[] = []

beforeAll(async () => {
  server = createServer((request, response) => {
    hits.push(request.url ?? '')
    const [path, target] = (request.url ?? '').split('?to=')
    if (path === '/redirect') return response.writeHead(302, { location: decodeURIComponent(target!) }).end()
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"price":"63512.42"}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const redirectTo = (target: string) => `http://public.test:${port}/redirect?to=${encodeURIComponent(target)}`

describe('createGuardedFetch', () => {
  it('reads a feed whose host resolves publicly, through the real price reader', async () => {
    const price = await createPriceFeed({ fetch: fetchGuarded })(`http://public.test:${port}/price`, '/price')
    expect(price).toEqual({ mantissa: 6351242n, scale: 2 })
  })

  it('refuses a public-looking host that resolves to a private address, before connecting', async () => {
    const before = hits.length
    await expect(fetchGuarded(`http://rebind.test:${port}/price`)).rejects.toThrow(/private address 10\.0\.0\.5/)
    expect(hits.length).toBe(before)
  })

  it('follows a redirect between public hosts', async () => {
    const response = await fetchGuarded(redirectTo(`http://public.test:${port}/price`))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('63512.42')
  })

  it('refuses a redirect to a host that resolves privately', async () => {
    await expect(fetchGuarded(redirectTo(`http://rebind.test:${port}/price`))).rejects.toThrow(/private address/)
  })

  it('refuses a redirect to a private IP literal, which never reaches the lookup', async () => {
    await expect(fetchGuarded(redirectTo('http://10.0.0.5/price'))).rejects.toThrow(/private host 10\.0\.0\.5/)
  })

  it('refuses a redirect off http(s)', async () => {
    await expect(fetchGuarded(redirectTo('file:///etc/passwd'))).rejects.toThrow(/file:/)
  })

  it('defaults to isPrivateFeedHost, refusing loopback without a request', async () => {
    const before = hits.length
    await expect(createGuardedFetch()(`http://127.0.0.1:${port}/price`)).rejects.toThrow(/private host/)
    expect(hits.length).toBe(before)
  })
})
