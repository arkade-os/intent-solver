/**
 * Crash reporting to Sentry, built as an ALLOWLIST rather than a filter.
 *
 * This process holds a mnemonic. The rule `cli.ts` and `admin/server.ts` state —
 * errors travel as messages, never as objects, because config objects carry
 * mnemonics — is why this hand-builds the event field by field rather than hand
 * an error to an SDK, whose Node defaults capture console breadcrumbs, outbound
 * request URLs, source context and module lists. The scrubber is the last line,
 * not the only one.
 */

import { randomBytes } from 'node:crypto'
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

/**
 * `{PROTOCOL}://{PUBLIC_KEY}@{HOST}{PATH}/{PROJECT_ID}`. The deprecated
 * `:{SECRET_KEY}` half is accepted and DISCARDED rather than echoed back.
 */
export const parseSentryDsn = (raw: string): SentryDsn => {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('SENTRY_DSN is not a URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('SENTRY_DSN must be http(s)')
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
const BIP39_MIN_WORDS = 12
const LOWERCASE_RUN = /[a-z]+(?: [a-z]+)*/g

/**
 * Consecutive words that are all IN the BIP39 list — membership, not word shape.
 * A shape rule ("twelve lowercase words of 3-8 letters") eats ordinary messages:
 * `could not find the swap row for the given payment hash…` is sixteen of those.
 * Measured on real solver messages the longest membership streak is two, against
 * twelve for the shortest mnemonic, so the threshold sits in a wide gap.
 */
const redactMnemonics = (text: string): string =>
  text.replace(LOWERCASE_RUN, (run) => {
    const out: string[] = []
    let streak: string[] = []
    const flush = (): void => {
      out.push(...(streak.length >= BIP39_MIN_WORDS ? [REDACTED] : streak))
      streak = []
    }
    for (const word of run.split(' ')) {
      if (BIP39.has(word)) streak.push(word)
      else {
        flush()
        out.push(word)
      }
    }
    flush()
    return out.join(' ')
  })
/** `key: "value"` and `key=value` for anything whose name says it is a secret. */
const SECRET_KEY = 'mnemonic|seed|macaroon|passphrase|password|secret|private_?key|priv_?key|api_?key|token|auth'
const QUOTED_SECRET = new RegExp(`("?(?:${SECRET_KEY})"?\\s*[:=]\\s*)"[^"]*"`, 'gi')
const BARE_SECRET = new RegExp(`("?(?:${SECRET_KEY})"?\\s*[:=]\\s*)[^\\s,;}\\]]+`, 'gi')
/** `scheme://user:pass@host` — an RPC or relay URL with its credentials inline. */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi
/**
 * Certificate, macaroon and xprv scale. 80 rather than 64 deliberately: a
 * payment hash is 64 hex and is the operator's only correlation key.
 */
const LONG_BLOB = /[A-Za-z0-9+/=_-]{80,}/g

/** @see DISPLAY_CHARS in tickErrors.ts — the discriminating part is the start. */
const MAX_TEXT = 1024

export const scrubText = (text: string): string =>
  redactMnemonics(
    text
      .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
      .replace(QUOTED_SECRET, `$1"${REDACTED}"`)
      .replace(BARE_SECRET, `$1${REDACTED}`)
      .replace(LONG_BLOB, REDACTED),
  ).slice(0, MAX_TEXT)

export interface SentryFrame {
  filename: string
  function?: string
  lineno?: number
  colno?: number
  in_app: boolean
}

const FRAME = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/

/**
 * Frames carry a LOCATION and nothing else. Sentry's frame schema also has
 * `vars`, `context_line`, `pre_context`, `post_context` and `abs_path` — locals,
 * source text and the operator's home directory — and this never emits them.
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
          type: scrubText(isError ? error.name : typeof error),
          value: scrubText(isError ? error.message : String(error)),
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
