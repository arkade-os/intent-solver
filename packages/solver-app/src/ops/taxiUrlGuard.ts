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
const PRIVATE_SUFFIXES = ['.local', '.internal', '.home.arpa', '.localhost']

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/

// A DNS root dot must not exempt a host from the suffix/loopback checks below
// ("taxi.internal." vs "taxi.internal"), so it is stripped before matching.
const stripRootDot = (host: string): string => (host.endsWith('.') ? host.slice(0, -1) : host)

const isIpLiteral = (host: string): boolean => host.startsWith('[') || IPV4_LITERAL.test(host)

const ipv4Octets = (host: string): [number, number, number, number] | null => {
  if (!IPV4_LITERAL.test(host)) return null
  const parts = host.split('.').map(Number)
  return parts.length === 4 ? (parts as [number, number, number, number]) : null
}

// "no private destination", not just the literal spellings rule 5 names:
// 0/8, 10/8, 100.64/10 (CGN), 127/8, 169.254/16, 172.16/12, 192.168/16.
const isPrivateIPv4 = ([a, b]: [number, number, number, number]): boolean =>
  a === 0 ||
  a === 10 ||
  (a === 100 && b >= 64 && b <= 127) ||
  a === 127 ||
  (a === 169 && b === 254) ||
  (a === 172 && b >= 16 && b <= 31) ||
  (a === 192 && b === 168)

// WHATWG always serializes a bracket-stripped IPv6 literal in canonical
// compressed form, so only the first group (for the fc00::/7 and fe80::/10
// masks) and a literal "::ffff:" prefix (for a mapped IPv4) need reading.
const isPrivateIPv6 = (bare: string): boolean => {
  if (bare === '::' || bare === '::1') return true
  const first = parseInt(bare.startsWith('::') ? '0' : (bare.split(':', 1)[0] ?? '0'), 16)
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10
  if (!bare.startsWith('::ffff:')) return false
  const [hiRaw, loRaw] = bare.slice('::ffff:'.length).split(':')
  const hi = parseInt(hiRaw ?? '0', 16)
  const lo = parseInt(loRaw ?? '0', 16)
  return isPrivateIPv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff])
}

const isPrivate = (host: string): boolean => {
  const bare = stripRootDot(host)
  if (bare === 'localhost') return true
  if (bare.startsWith('[')) return isPrivateIPv6(bare.slice(1, -1))
  const octets = ipv4Octets(bare)
  if (octets && isPrivateIPv4(octets)) return true
  // A dotless name only ever resolves inside a search domain or cluster DNS.
  if (!bare.includes('.')) return true
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
  // Only ONE root dot is stripped below, so "localhost.." would otherwise dodge every name check.
  if (stripRootDot(url.hostname).split('.').includes('')) {
    throw new Error(`taxi url host has an empty label, got "${url.hostname}"`)
  }
  if (!policy.allowPrivate && isPrivate(url.hostname)) {
    throw new Error(`taxi url host must not be private, got "${url.hostname}"`)
  }
  // Same helper the rate-limit key below reuses, so "taxi.example." and
  // "taxi.example" collapse to one string rather than two cached clients.
  const host = stripRootDot(url.hostname) + (url.port ? `:${url.port}` : '')
  return `${url.protocol}//${host}${url.pathname === '/' ? '' : url.pathname}`
}

// Streams rather than buffers: a hostile body is cancelled the moment the
// running total crosses the cap, not after it has all landed in memory.
const readCapped = async (body: ReadableStream<Uint8Array> | null): Promise<Uint8Array> => {
  if (!body) return new Uint8Array(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > BODY_CAP_BYTES) {
      await reader.cancel()
      throw new Error(`taxi response body too large: over ${BODY_CAP_BYTES} bytes`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * Ruling 3, rules 6-7. `redirect: 'error'` is set AND the response is
 * inspected — a stub, or a fetch implementation that ignores the option,
 * still hands back a 3xx. The limiter is consulted before `base` runs at all,
 * keyed per host, so an exhausted host never reaches the network.
 */
export const guardedTaxiFetch =
  (
    base: typeof fetch,
    limiter: RateLimiter,
    /** `global` is one budget across every host, spent only once the host's own allowed the request. */
    options: { timeoutMs?: number; global?: RateLimiter } = {},
  ): typeof fetch =>
  async (input, init) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const host = stripRootDot(new URL(target).hostname)
    if (!limiter.take(host)) throw new Error(`taxi host is rate-limited: ${host}`)
    if (options.global && !options.global.take('*')) {
      throw new Error('taxi quote reads are rate-limited across every host')
    }

    const signal = AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS)
    const response = await base(input, { ...init, redirect: 'error', signal })
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`taxi response was a redirect: HTTP ${response.status}`)
    }
    const declared = response.headers.get('content-length')
    if (declared !== null && Number(declared) > BODY_CAP_BYTES) {
      throw new Error(`taxi response body too large: content-length ${declared} bytes`)
    }
    const body = await readCapped(response.body)
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
