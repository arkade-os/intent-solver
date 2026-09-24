/**
 * Ruling 3's SSRF hygiene for a request-named Taxi URL — stricter than the
 * operator `TAXI_URL` gate at `config.ts` (~:1108-1125), which allows
 * loopback and plaintext for a value the operator typed rather than a payer.
 */

import { RateLimiter } from '@arkade-os/solver-core/core/rateLimit.js'

export interface TaxiUrlPolicy {
  isMainnet: boolean
  /** TAXI_RECEIVER_ALLOW_PRIVATE — read at the composition root, never here. */
  allowPrivate: boolean
}

const BODY_CAP_BYTES = 256 * 1024
const TIMEOUT_MS = 5000
const PRIVATE_SUFFIXES = ['.local', '.internal', '.home.arpa']

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/
const LOOPBACK_V4 = /^127(\.\d{1,3}){3}$/

// A DNS root dot must not exempt a host from the suffix/loopback checks below
// ("taxi.internal." vs "taxi.internal"), so it is stripped before matching.
const stripRootDot = (host: string): string => (host.endsWith('.') ? host.slice(0, -1) : host)

const isIpLiteral = (host: string): boolean => host.startsWith('[') || IPV4_LITERAL.test(host)

const isPrivate = (host: string): boolean => {
  const bare = stripRootDot(host)
  if (bare === 'localhost' || bare === '[::1]' || LOOPBACK_V4.test(bare)) return true
  return PRIVATE_SUFFIXES.some((suffix) => bare.endsWith(suffix))
}

/** Ruling 3, rules 1-5. Throws on any violation; never used for `config.ts`'s TAXI_URL. */
export const normalizeTaxiUrl = (raw: string, policy: TaxiUrlPolicy): string => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`taxi url must be an absolute URL, got "${raw}"`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`taxi url must be http or https, got "${url.protocol}"`)
  }
  if (policy.isMainnet) {
    if (url.protocol !== 'https:') {
      throw new Error(`taxi url must use https on mainnet, got "${url.protocol}"`)
    }
    if (url.port !== '' && url.port !== '443') {
      throw new Error(`taxi url must use port 443 on mainnet, got "${url.port}"`)
    }
  }
  if (url.username !== '' || url.password !== '') throw new Error('taxi url must not carry credentials')
  if (url.search !== '') throw new Error('taxi url must not carry a query')
  if (url.hash !== '') throw new Error('taxi url must not carry a fragment')
  if (policy.isMainnet && isIpLiteral(url.hostname)) {
    throw new Error(`taxi url host must be a DNS name on mainnet, got "${url.hostname}"`)
  }
  if (!policy.allowPrivate && isPrivate(url.hostname)) {
    throw new Error(`taxi url host must not be private, got "${url.hostname}"`)
  }
  return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`
}

/**
 * Ruling 3, rules 6-7. `redirect: 'error'` is set AND the response is
 * inspected — a stub, or a fetch implementation that ignores the option,
 * still hands back a 3xx. The limiter is consulted before `base` runs at all,
 * keyed per host, so an exhausted host never reaches the network.
 */
export const guardedTaxiFetch =
  (base: typeof fetch, limiter: RateLimiter): typeof fetch =>
  async (input, init) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const host = new URL(target).hostname
    if (!limiter.take(host)) throw new Error(`taxi host is rate-limited: ${host}`)

    const response = await base(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`taxi response was a redirect: HTTP ${response.status}`)
    }
    const body = await response.arrayBuffer()
    if (body.byteLength > BODY_CAP_BYTES) {
      throw new Error(`taxi response body too large: ${body.byteLength} bytes`)
    }
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
