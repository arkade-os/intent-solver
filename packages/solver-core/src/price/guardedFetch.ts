/**
 * A `fetch` for feed URLs an operator has only TYPED, refusing private destinations
 * wherever they appear: the typed host, any address it resolves to, and every
 * redirect hop.
 *
 * The check runs inside the socket's own DNS lookup, so the address refused is the
 * address connected to — a resolve-then-fetch check would race DNS rebinding. Built
 * on `node:http` because the global `fetch` takes no lookup hook without `undici`.
 */

import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import type { LookupFunction } from 'node:net'
import { Readable } from 'node:stream'
import { isPrivateFeedHost } from '../core/assetMarketConfig.js'

const MAX_REDIRECTS = 5
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const NULL_BODY = new Set([204, 205, 304])

export interface GuardedFetchDeps {
  lookup?: typeof dnsLookup
  isPrivate?: (address: string) => boolean
}

const refusingLookup =
  (resolve: typeof dnsLookup, isPrivate: (address: string) => boolean): LookupFunction =>
  (hostname, options, callback) =>
    resolve(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
      if (error) return callback(error, '', 0)
      const blocked = addresses.find((a) => isPrivate(a.address))
      if (blocked) {
        return callback(new Error(`feed host ${hostname} resolves to private address ${blocked.address}`), '', 0)
      }
      if (options.all) return (callback as (e: null, a: LookupAddress[]) => void)(null, addresses)
      callback(null, addresses[0]!.address, addresses[0]!.family)
    })

export const createGuardedFetch = (deps: GuardedFetchDeps = {}): typeof globalThis.fetch => {
  const isPrivate = deps.isPrivate ?? isPrivateFeedHost
  const lookup = refusingLookup(deps.lookup ?? dnsLookup, isPrivate)

  const get = (url: URL, init?: RequestInit): Promise<http.IncomingMessage> =>
    new Promise((resolve, reject) => {
      const client = url.protocol === 'https:' ? https : http
      const request = client.request(
        url,
        {
          method: 'GET',
          headers: init?.headers as http.OutgoingHttpHeaders | undefined,
          signal: init?.signal ?? undefined,
          lookup,
        },
        resolve,
      )
      request.on('error', reject).end()
    })

  return (async (input: string | URL | Request, init?: RequestInit) => {
    let url = new URL(input instanceof Request ? input.url : String(input))
    for (let hop = 0; ; hop++) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`feed ${String(input)}: refused a hop to ${url.protocol}`)
      }
      // An IP literal never reaches `lookup`: Node connects to it directly.
      if (isPrivate(url.hostname)) throw new Error(`feed ${String(input)}: refused private host ${url.hostname}`)
      const response = await get(url, init)
      const status = response.statusCode ?? 502
      const location = response.headers.location
      if (REDIRECTS.has(status) && location) {
        response.resume()
        if (hop >= MAX_REDIRECTS) throw new Error(`feed ${String(input)}: more than ${MAX_REDIRECTS} redirects`)
        url = new URL(location, url)
        continue
      }
      const body = NULL_BODY.has(status) ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>)
      return new Response(body, { status, statusText: response.statusMessage ?? '' })
    }
  }) as typeof globalThis.fetch
}
