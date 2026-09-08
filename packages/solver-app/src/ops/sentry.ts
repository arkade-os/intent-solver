/**
 * Crash reporting to Sentry, built as an ALLOWLIST rather than a filter.
 *
 * This process holds a mnemonic, and the rule `cli.ts` and `admin/server.ts`
 * state — errors travel as messages, never as objects, because config objects
 * carry mnemonics — is why this hand-builds the event rather than hand an error
 * to an SDK whose Node defaults capture console breadcrumbs, outbound request
 * URLs, source context and module lists. The scrubber is the last line only.
 */

import { randomBytes } from 'node:crypto'
import { sha256 } from '@noble/hashes/sha2.js'
import { wordlist } from '@scure/bip39/wordlists/english.js'

export interface SentryDsn {
  endpoint: string
  publicKey: string
}

export interface SentryOptions {
  dsn: SentryDsn
  environment: string
  release?: string
  send?: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<unknown>
  now?: () => number
}

/** Every octet, not a `127.` prefix: that would read 127.evil.com as loopback. */
const isLoopback = (hostname: string): boolean => {
  const host = hostname.replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
}

/**
 * `{PROTOCOL}://{PUBLIC_KEY}@{HOST}{PATH}/{PROJECT_ID}`; the deprecated
 * `:{SECRET_KEY}` half is DISCARDED. Plaintext is refused off-loopback, as
 * `COVCLAIMD_URL` does: it would put the auth key on the wire.
 */
export const parseSentryDsn = (raw: string): SentryDsn => {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('SENTRY_DSN is not a URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('SENTRY_DSN must be http(s)')
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
    throw new Error(`SENTRY_DSN must use https off loopback, got "${url.protocol}//${url.host}"`)
  }
  if (!url.username) throw new Error('SENTRY_DSN has no public key')
  const segments = url.pathname.split('/').filter(Boolean)
  const projectId = segments.pop()
  if (!projectId || !/^\d+$/.test(projectId)) throw new Error('SENTRY_DSN has no numeric project id')
  const prefix = segments.length > 0 ? `/${segments.join('/')}` : ''
  return {
    endpoint: `${url.protocol}//${url.host}${prefix}/api/${projectId}/envelope/`,
    publicKey: url.username,
  }
}

const REDACTED = '<redacted>'

const BIP39 = new Set(wordlist)
const BIP39_INDEX = new Map(wordlist.map((word, index) => [word, index]))
const BIP39_MIN_WORDS = 12
const MNEMONIC_LENGTHS = [12, 15, 18, 21, 24]
const WORD = /[A-Za-z]+/g
/**
 * A whitespace-only rule read a JSON array or CSV line as twelve one-word runs;
 * the backslash covers a payload serialised twice, whose gap is `\",\"`. NOT
 * widened further — admitting letters or digits would chain any two BIP39 words
 * in a document, so one word per prefixed log LINE is not caught.
 */
const PHRASE_GAP = /^[\s,"'\[\]\\]+$/
/** List markers, bullets, pipes — the gap the CHECKSUMMED pass may also cross. It
 * cannot cross a word regardless, so 16 only bounds what a false positive swallows. */
const CHECKED_GAP = /^[^A-Za-z]{1,16}$/

type Token = { word: string; start: number; end: number }

const runsOf = (words: Token[], text: string, gap: RegExp): Token[][] => {
  const runs: Token[][] = []
  let run: Token[] = []
  const flush = (): void => {
    if (run.length > 0) runs.push(run)
    run = []
  }
  for (const token of words) {
    if (!BIP39.has(token.word.toLowerCase())) {
      flush()
      continue
    }
    const previous = run[run.length - 1]
    if (previous && !gap.test(text.slice(previous.end, token.start))) flush()
    run.push(token)
  }
  flush()
  return runs
}

/** 11 bits per word: `32N/3` entropy bits, then `N/3` checksum bits off SHA-256.
 * A test pins this to `validateMnemonic`, far too slow at ~3.7k/s to slide with. */
const checksumHolds = (words: string[]): boolean => {
  const bits: number[] = []
  for (const word of words) {
    const index = BIP39_INDEX.get(word)
    if (index === undefined) return false
    for (let bit = 10; bit >= 0; bit--) bits.push((index >>> bit) & 1)
  }
  const entropyBits = (words.length * 32) / 3
  const entropy = new Uint8Array(entropyBits / 8)
  for (let i = 0; i < entropyBits; i++) if (bits[i]) entropy[i >> 3]! |= 1 << (7 - (i % 8))
  const digest = sha256(entropy)
  for (let i = 0; i < words.length / 3; i++) {
    if (((digest[i >> 3]! >>> (7 - (i % 8))) & 1) !== bits[entropyBits + i]) return false
  }
  return true
}

const replaceSpans = (text: string, spans: Array<[number, number]>): string => {
  if (spans.length === 0) return text
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out: string[] = []
  let cursor = 0
  let [start, end] = spans[0]!
  for (const [from, to] of spans.slice(1)) {
    if (from <= end) {
      end = Math.max(end, to)
      continue
    }
    out.push(text.slice(cursor, start), REDACTED)
    cursor = end
    start = from
    end = to
  }
  out.push(text.slice(cursor, start), REDACTED, text.slice(end))
  return out.join('')
}

/**
 * Consecutive words that are all IN the BIP39 list — membership, not word shape.
 * A shape rule ("twelve lowercase words of 3-8 letters") eats ordinary messages.
 * Re-measured over this repo's 150k lines: the longest NON-mnemonic streak is
 * NINE, in SQL DDL. The checksum only ever ADDS a span, so a truncated, mistyped
 * or transposed phrase — still brute-forceable — is redacted exactly as before.
 */
const redactMnemonics = (text: string): string => {
  const words: Token[] = []
  for (let m = WORD.exec(text); m; m = WORD.exec(text)) {
    words.push({ word: m[0], start: m.index, end: m.index + m[0].length })
  }
  const strict: Array<[number, number]> = []
  for (const run of runsOf(words, text, PHRASE_GAP)) {
    if (run.length >= BIP39_MIN_WORDS) strict.push([run[0]!.start, run[run.length - 1]!.end])
  }
  const spans = [...strict]
  for (const run of runsOf(words, text, CHECKED_GAP)) {
    const lowered = run.map((token) => token.word.toLowerCase())
    for (const length of MNEMONIC_LENGTHS) {
      for (let i = 0; i + length <= run.length; i++) {
        const from = run[i]!.start
        const to = run[i + length - 1]!.end
        // Hashing inside a span already redacted cannot widen anything.
        if (strict.some(([at, until]) => at <= from && to <= until)) continue
        if (checksumHolds(lowered.slice(i, i + length))) spans.push([from, to])
      }
    }
  }
  return replaceSpans(text, spans)
}

/** `key: "value"` and `key=value` for anything whose name says it is a secret. */
const SECRET_KEY = 'mnemonic|seed|macaroon|passphrase|password|secret|private_?key|priv_?key|api_?key|token|auth'
const QUOTED_SECRET = new RegExp(`("?(?:${SECRET_KEY})"?\\s*[:=]\\s*)"[^"]*"`, 'gi')
const BARE_SECRET = new RegExp(`("?(?:${SECRET_KEY})"?\\s*[:=]\\s*)[^\\s,;}\\]]+`, 'gi')
/** `scheme://user:pass@host` — an RPC or relay URL with its credentials inline. */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi
/** Cert/macaroon/xprv scale. 80 not 64: a payment hash is the correlation key. */
const LONG_BLOB = /[A-Za-z0-9+/=_-]{80,}/g

/** @see DISPLAY_CHARS in tickErrors.ts — the discriminating part is the start. */
const MAX_TEXT = 1024

// Mnemonics FIRST, load-bearing: `BARE_SECRET` stops at whitespace, so on
// `mnemonic=<12 words>` it ate one word and left 11 — under the threshold.
export const scrubText = (text: string): string =>
  redactMnemonics(text)
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replace(QUOTED_SECRET, `$1"${REDACTED}"`)
    .replace(BARE_SECRET, `$1${REDACTED}`)
    .replace(LONG_BLOB, REDACTED)
    .slice(0, MAX_TEXT)

export interface SentryFrame {
  filename: string
  function?: string
  lineno?: number
  colno?: number
  in_app: boolean
}

const FRAME = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/

/**
 * Frames carry a LOCATION and nothing else. Sentry's schema also has `vars`,
 * `context_line`, `pre_context`, `post_context` and `abs_path` — locals, source
 * and the operator's home directory — and this never emits them.
 */
export const framesFrom = (stack: string | undefined): SentryFrame[] => {
  if (!stack) return []
  const frames: SentryFrame[] = []
  for (const line of stack.split('\n')) {
    const match = FRAME.exec(line)
    if (!match) continue
    const [, fn, file, lineno, colno] = match
    if (!file) continue
    const inApp = !file.includes('node_modules') && !file.startsWith('node:')
    frames.push({
      filename: relativeFile(file),
      ...(fn ? { function: scrubText(fn) } : {}),
      lineno: Number(lineno),
      colno: Number(colno),
      in_app: inApp,
    })
  }
  return frames.reverse()
}

/** Keep the repo-relative tail, so a path cannot name the operator or their box. */
const relativeFile = (file: string): string => {
  const normalised = file.replace(/\\/g, '/').replace(/^file:\/\/\/?/, '')
  const at = normalised.lastIndexOf('/packages/')
  if (at !== -1) return normalised.slice(at + 1)
  const modules = normalised.lastIndexOf('/node_modules/')
  if (modules !== -1) return normalised.slice(modules + 1)
  return normalised.slice(normalised.lastIndexOf('/') + 1)
}

export interface SentryEvent {
  event_id: string
  timestamp: number
  platform: 'node'
  level: 'error'
  environment: string
  release?: string
  logger: string
  exception: { values: [{ type: string; value: string; stacktrace: { frames: SentryFrame[] } }] }
}

/** Throwing here would throw inside the panic handler reporting the first fault. */
const textOf = (value: unknown): string => {
  try {
    return String(value)
  } catch {
    return '<unprintable>'
  }
}

export const buildEvent = (
  context: string,
  error: unknown,
  options: { environment: string; release?: string; eventId: string; timestamp: number },
): SentryEvent => {
  const isError = error instanceof Error
  return {
    event_id: options.eventId,
    timestamp: options.timestamp,
    platform: 'node',
    level: 'error',
    environment: options.environment,
    ...(options.release ? { release: options.release } : {}),
    logger: scrubText(context),
    exception: {
      values: [
        {
          type: scrubText(isError ? textOf(error.name) : typeof error),
          value: scrubText(isError ? textOf(error.message) : textOf(error)),
          stacktrace: { frames: framesFrom(isError ? error.stack : undefined) },
        },
      ],
    },
  }
}

export const envelopeFor = (event: SentryEvent): string => {
  const body = JSON.stringify(event)
  // No `dsn` header: the key travels in X-Sentry-Auth, so the body has no credential.
  return `${JSON.stringify({ event_id: event.event_id, sent_at: new Date(event.timestamp * 1000).toISOString() })}\n${JSON.stringify({ type: 'event', length: Buffer.byteLength(body), content_type: 'application/json' })}\n${body}\n`
}

export interface ErrorReporter {
  report(context: string, error: unknown): void
  flush(timeoutMs?: number): Promise<void>
}

const MAX_PER_MINUTE = 10
const DEDUPE_MS = 60_000

/** Null when no DSN is configured — the whole of the off switch. */
export const createErrorReporter = (options: SentryOptions | null): ErrorReporter | null => {
  if (!options) return null
  const send = options.send ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(5000) }))
  const now = options.now ?? Date.now
  const lastSeen = new Map<string, number>()
  const inFlight = new Set<Promise<unknown>>()
  let windowStartedAt = 0
  let sentInWindow = 0

  const admits = (signature: string): boolean => {
    const at = now()
    if (at - windowStartedAt >= 60_000) {
      windowStartedAt = at
      sentInWindow = 0
    }
    // Each key holds a scrubbed message; without this the map grows unbounded.
    for (const [key, seen] of lastSeen) if (at - seen >= DEDUPE_MS) lastSeen.delete(key)
    if (sentInWindow >= MAX_PER_MINUTE) return false
    const seen = lastSeen.get(signature)
    if (seen !== undefined && at - seen < DEDUPE_MS) return false
    lastSeen.set(signature, at)
    sentInWindow += 1
    return true
  }

  return {
    report(context, error) {
      const event = buildEvent(context, error, {
        environment: options.environment,
        release: options.release,
        eventId: randomBytes(16).toString('hex'),
        timestamp: Math.floor(now() / 1000),
      })
      const value = event.exception.values[0]
      if (!admits(`${event.logger}|${value.type}|${value.value}`)) return
      // Swallowed on purpose: a reporting backend that is down, rate-limiting or
      // unreachable must never be able to stop a solver from moving money.
      const posted = send(options.dsn.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-sentry-envelope',
          'x-sentry-auth': `Sentry sentry_version=7, sentry_client=intent-solver/1, sentry_key=${options.dsn.publicKey}`,
        },
        body: envelopeFor(event),
      }).catch(() => undefined)
      inFlight.add(posted)
      void posted.finally(() => inFlight.delete(posted))
    },
    async flush(timeoutMs = 2000) {
      if (inFlight.size === 0) return
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
      ])
    },
  }
}
