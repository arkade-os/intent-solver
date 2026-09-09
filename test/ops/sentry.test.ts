import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { entropyToMnemonic, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { sentryOptionsFromEnv } from '@arkade-os/solver-app/config.js'
import {
  buildEvent,
  createErrorReporter,
  envelopeFor,
  framesFrom,
  parseSentryDsn,
  scrubText,
} from '@arkade-os/solver-app/ops/sentry.js'

const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const LONG_MNEMONIC = entropyToMnemonic(
  Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff),
  wordlist,
)

/** Shaped like the real `Config`, mnemonic nested as it is in `config.arkade`. */
const configShaped = {
  network: 'mainnet',
  arkade: { mnemonic: MNEMONIC, isMainnet: true, serverUrl: 'https://arkd.example' },
  lnd: { socket: '127.0.0.1:10009', macaroon: 'AgEDbG5kAvgBAwoQ' + 'a'.repeat(120) },
}

const DSN = 'https://abc123def456@o1234.ingest.sentry.io/7654321'

const capturing = () => {
  const bodies: string[] = []
  const headers: Record<string, string>[] = []
  const urls: string[] = []
  return {
    bodies,
    headers,
    urls,
    send: async (url: string, init: { headers: Record<string, string>; body: string }) => {
      urls.push(url)
      headers.push(init.headers)
      bodies.push(init.body)
    },
  }
}

describe('parseSentryDsn', () => {
  it('derives the envelope endpoint and keeps the public key', () => {
    expect(parseSentryDsn(DSN)).toEqual({
      endpoint: 'https://o1234.ingest.sentry.io/api/7654321/envelope/',
      publicKey: 'abc123def456',
    })
  })

  it('honours a path prefix, for a self-hosted Sentry behind a subdirectory', () => {
    expect(parseSentryDsn('https://key@sentry.example.com/on/prem/42').endpoint).toBe(
      'https://sentry.example.com/on/prem/api/42/envelope/',
    )
  })

  it('discards the deprecated secret half rather than echoing it back', () => {
    expect(parseSentryDsn('https://public:supersecret@host/9').publicKey).toBe('public')
  })

  it.each([
    ['not-a-url', 'SENTRY_DSN is not a URL'],
    ['ftp://key@host/1', 'SENTRY_DSN must be http(s)'],
    ['https://host/1', 'SENTRY_DSN has no public key'],
    ['https://key@host/notanumber', 'SENTRY_DSN has no numeric project id'],
    ['http://key@sentry.example.com/1', 'must use https off loopback'],
    ['http://key@127.evil.com/1', 'must use https off loopback'],
  ])('refuses %s rather than reporting nowhere', (raw, message) => {
    expect(() => parseSentryDsn(raw)).toThrow(message)
  })

  it.each(['http://key@127.0.0.1:9911/42', 'http://key@localhost/42', 'http://key@[::1]:9000/42'])(
    'allows plaintext to loopback: %s',
    (raw) => {
      expect(parseSentryDsn(raw).publicKey).toBe('key')
    },
  )
})

describe('scrubText', () => {
  it('redacts a bare mnemonic', () => {
    expect(scrubText(`seed restored: ${MNEMONIC}`)).not.toContain('sausage')
  })

  it('redacts a mnemonic behind a key, which is how a serialised config carries it', () => {
    const scrubbed = scrubText(JSON.stringify(configShaped))
    expect(scrubbed).not.toContain('sausage')
    expect(scrubbed).not.toContain(MNEMONIC)
  })

  it.each([15, 18, 21, 24])('redacts a %i-word mnemonic too', (words) => {
    const phrase = Array.from({ length: words }, (_, i) => wordlist[i * 37]).join(' ')
    expect(scrubText(`recovered ${phrase} ok`)).toContain('<redacted>')
  })

  it('redacts a mnemonic buried mid-sentence, not just one standing alone', () => {
    expect(scrubText(`the operator pasted ${MNEMONIC} into the issue`)).not.toContain('sausage')
  })

  it.each([
    'could not find the swap row for the given payment hash because the record was missing',
    'the lightning backend refused to pay the invoice because the route was not found today',
    'unable to settle the batch since the server rejected our forfeit signature for this vtxo',
  ])('leaves an ordinary sentence alone: %s', (message) => {
    expect(scrubText(message)).toBe(message)
  })

  // The keyed rule used to eat one word, leaving 11 — under the threshold.
  it.each(['mnemonic=', 'seed: ', 'passphrase="'])('redacts a mnemonic behind %s', (prefix) => {
    expect(scrubText(`${prefix}${MNEMONIC}`)).not.toContain('sausage')
  })

  it.each([
    ['newlines', '\n'],
    ['tabs', '\t'],
    ['repeated spaces', '   '],
    ['CRLF', '\r\n'],
  ])('redacts a mnemonic separated by %s', (_name, gap) => {
    expect(scrubText(`recovered ${MNEMONIC.split(' ').join(gap)} ok`)).not.toContain('sausage')
  })

  it.each([
    ['a JSON array', JSON.stringify(MNEMONIC.split(' '))],
    ['a CSV line', MNEMONIC.split(' ').join(', ')],
    [
      'individually quoted words',
      MNEMONIC.split(' ')
        .map((w) => `"${w}"`)
        .join(' '),
    ],
    [
      'quoted words across lines',
      MNEMONIC.split(' ')
        .map((w) => `"${w}"`)
        .join(',\n'),
    ],
  ])('redacts a mnemonic written as %s', (_name, text) => {
    expect(scrubText(text)).not.toContain('sausage')
  })

  it.each([
    ['upper case', MNEMONIC.toUpperCase()],
    ['title case', MNEMONIC.replace(/\b[a-z]/g, (c) => c.toUpperCase())],
  ])('redacts a mnemonic in %s', (_name, text) => {
    expect(scrubText(text).toLowerCase()).not.toContain('sausage')
  })

  it.each([
    ['an object', JSON.stringify(JSON.stringify({ mnemonic: MNEMONIC }))],
    ['an array', JSON.stringify(JSON.stringify(MNEMONIC.split(' ')))],
  ])('redacts a mnemonic inside %s serialised twice', (_name, text) => {
    expect(scrubText(text)).not.toContain('sausage')
  })
  it('preserves an ordinary message rather than normalising its whitespace', () => {
    const message = 'line one\n\tindented\n  spaced'
    expect(scrubText(message)).toBe(message)
  })

  it('leaves a comma-separated ordinary sentence alone', () => {
    const message = 'could not settle, the server rejected our signature, and the batch was dropped'
    expect(scrubText(message)).toBe(message)
  })

  it.each([
    ['prose', 'estimate`). Anything that can answer "what will this one cost me" fits here.'],
    ['SQL DDL', '  market_key      TEXT PRIMARY KEY,\n  base            TEXT,\n  quote           TEXT,'],
  ])('leaves the longest BIP39 streak in this repo alone: %s', (_name, message) => {
    expect(scrubText(message)).toBe(message)
  })

  it.each([
    ['a numbered list', (w: string[]) => w.map((word, i) => `${i + 1}. ${word}`).join('\n')],
    ['a bulleted list', (w: string[]) => w.map((word) => `- ${word}`).join('\n')],
    ['semicolons', (w: string[]) => w.join('; ')],
    ['pipes', (w: string[]) => w.join(' | ')],
    ['inline indices', (w: string[]) => w.map((word, i) => `${i + 1}) ${word}`).join(' ')],
  ])('redacts a checksummed mnemonic written as %s, which the strict run rule refuses', (_name, shape) => {
    expect(scrubText(shape(MNEMONIC.split(' ')))).not.toContain('sausage')
    expect(scrubText(shape(LONG_MNEMONIC.split(' ')))).not.toContain(LONG_MNEMONIC.split(' ')[13])
  })

  it('keeps a payment hash, which is the only correlation key an operator has', () => {
    const hash = 'a'.repeat(64)
    expect(scrubText(`swap ${hash} failed`)).toContain(hash)
  })

  it('redacts credentials embedded in an RPC or relay URL', () => {
    expect(scrubText('dial wss://alice:hunter2@relay.example/ws failed')).toBe(
      'dial wss://<redacted>@relay.example/ws failed',
    )
  })

  it('redacts a macaroon-scale blob but not a hash-scale one', () => {
    expect(scrubText(`macaroon ${'b'.repeat(200)}`)).not.toContain('b'.repeat(100))
  })

  it('caps the text, because SDK errors carry serialised request bodies', () => {
    expect(scrubText('exception '.repeat(5_000))).toHaveLength(1024)
  })
})

describe('the BIP39 checksum widens redaction and never gates it', () => {
  const swapped = (words: string[], a: number, b: number): string[] => {
    const out = [...words]
    ;[out[a], out[b]] = [out[b]!, out[a]!]
    return out
  }

  // Runs of twelve-plus whose checksum does NOT hold, all still brute-forceable.
  it.each([
    ['a run of twelve list words that is no mnemonic', Array.from({ length: 12 }, () => 'abandon')],
    ['a phrase cut by a length cap', LONG_MNEMONIC.split(' ').slice(0, 12)],
    ['a phrase with two words transposed', swapped(MNEMONIC.split(' '), 3, 4)],
    ['a phrase with its last word mistyped as another list word', [...MNEMONIC.split(' ').slice(0, 11), 'zebra']],
    ['a phrase reassembled with a stray list word', [...MNEMONIC.split(' '), 'true']],
  ])('still redacts %s', (_name, words) => {
    expect(validateMnemonic(words.join(' '), wordlist)).toBe(false)
    const scrubbed = scrubText(`restored ${words.join(' ')} ok`)
    expect(scrubbed).toContain('<redacted>')
    for (const word of words) expect(scrubbed).not.toContain(word)
  })

  it('agrees with @scure/bip39 about which twelve-word runs carry a valid checksum', () => {
    const gapTheStrictRuleRefuses = '; '
    let valid = 0
    let invalid = 0
    for (let i = 0; i < 400; i++) {
      const words = Array.from({ length: 12 }, (_, k) => wordlist[(i * 977 + k * 613) % 2048]!)
      const holds = validateMnemonic(words.join(' '), wordlist)
      expect(scrubText(words.join(gapTheStrictRuleRefuses)).includes('<redacted>')).toBe(holds)
      if (holds) valid += 1
      else invalid += 1
    }
    expect(valid).toBeGreaterThan(0)
    expect(invalid).toBeGreaterThan(0)
  })
})

describe('framesFrom', () => {
  const framesOfARealError = (): ReturnType<typeof framesFrom> => {
    const inner = (): never => {
      throw new Error('boom')
    }
    try {
      inner()
    } catch (error) {
      return framesFrom((error as Error).stack)
    }
    throw new Error('unreachable')
  }

  it('carries a location and nothing that could hold state', () => {
    const frames = framesOfARealError()
    expect(frames.length).toBeGreaterThan(0)
    for (const frame of frames) {
      expect(frame).not.toHaveProperty('vars')
      expect(frame).not.toHaveProperty('context_line')
      expect(frame).not.toHaveProperty('pre_context')
      expect(frame).not.toHaveProperty('post_context')
      expect(frame).not.toHaveProperty('abs_path')
    }
  })

  it('reduces a filename to its repo-relative tail, never the operator home directory', () => {
    const frames = framesFrom('Error: x\n    at fn (/home/alice/srv/packages/solver-app/src/cli.ts:10:5)')
    expect(frames[0]?.filename).toBe('packages/solver-app/src/cli.ts')
  })

  it('marks node_modules as not in_app', () => {
    const frames = framesFrom('Error: x\n    at q (/srv/node_modules/lib/index.js:1:1)')
    expect(frames[0]?.in_app).toBe(false)
  })
})

describe('the reporter', () => {
  it('is null when no DSN is configured, which is the whole off switch', () => {
    expect(createErrorReporter(null)).toBeNull()
  })

  it('sends nothing anywhere when unconfigured', () => {
    const reporter = createErrorReporter(null)
    expect(() => reporter?.report('ctx', new Error('boom'))).not.toThrow()
  })

  const reporterWith = (capture: ReturnType<typeof capturing>) =>
    createErrorReporter({ dsn: parseSentryDsn(DSN), environment: 'mainnet', send: capture.send })

  it('never puts a mnemonic on the wire, however the error carries one', async () => {
    const capture = capturing()
    const reporter = reporterWith(capture)!

    // The three ways a config object reaches an error.
    reporter.report('load', new Error(`config invalid: ${JSON.stringify(configShaped)}`))
    reporter.report('boot', Object.assign(new Error('wallet failed'), { config: configShaped }))
    reporter.report('start', new Error('arkade unreachable', { cause: configShaped }))
    await reporter.flush()

    expect(capture.bodies).toHaveLength(3)
    for (const body of capture.bodies) {
      expect(body).not.toContain(MNEMONIC)
      expect(body).not.toContain('sausage')
      expect(body).not.toContain('AgEDbG5kAvgBAwoQ')
    }
    // Absence alone would also pass for a reporter that sent an empty body.
    expect(capture.bodies[1]).toContain('wallet failed')
    expect(capture.bodies[2]).toContain('arkade unreachable')
  })

  it('posts an allowlisted body: no env, no modules, no hostname, no breadcrumbs', async () => {
    const capture = capturing()
    const reporter = reporterWith(capture)!
    reporter.report('ctx', new Error('boom'))
    await reporter.flush()

    const event = JSON.parse(capture.bodies[0]!.split('\n')[2]!) as Record<string, unknown>
    expect(Object.keys(event).sort()).toEqual([
      'environment',
      'event_id',
      'exception',
      'level',
      'logger',
      'platform',
      'timestamp',
    ])
  })

  it('authenticates in the header, so the captured body carries no credential', async () => {
    const capture = capturing()
    const reporter = reporterWith(capture)!
    reporter.report('ctx', new Error('boom'))
    await reporter.flush()

    expect(capture.urls[0]).toBe('https://o1234.ingest.sentry.io/api/7654321/envelope/')
    expect(capture.headers[0]?.['x-sentry-auth']).toContain('sentry_key=abc123def456')
    expect(capture.bodies[0]).not.toContain('abc123def456')
  })

  it('survives a reporting backend that is down', async () => {
    const reporter = createErrorReporter({
      dsn: parseSentryDsn(DSN),
      environment: 'mainnet',
      send: async () => {
        throw new Error('sentry unreachable')
      },
    })!
    reporter.report('ctx', new Error('boom'))
    await expect(reporter.flush()).resolves.toBeUndefined()
  })

  it('reports a fault again once the dedupe window has passed', async () => {
    const capture = capturing()
    let clock = 1_000_000
    const reporter = createErrorReporter({
      dsn: parseSentryDsn(DSN),
      environment: 'mainnet',
      send: capture.send,
      now: () => clock,
    })!
    reporter.report('tick', new Error('backend unreachable'))
    clock += 60_001
    reporter.report('tick', new Error('backend unreachable'))
    await reporter.flush()
    expect(capture.bodies).toHaveLength(2)
  })

  it('collapses a repeat, so a 250ms tick loop cannot flood the project', async () => {
    const capture = capturing()
    let clock = 1_000_000
    const reporter = createErrorReporter({
      dsn: parseSentryDsn(DSN),
      environment: 'mainnet',
      send: capture.send,
      now: () => clock,
    })!
    for (let i = 0; i < 50; i++) {
      reporter.report('tick', new Error('backend unreachable'))
      clock += 250
    }
    await reporter.flush()
    expect(capture.bodies).toHaveLength(1)
  })

  it('caps distinct faults per minute too', async () => {
    const capture = capturing()
    let clock = 1_000_000
    const reporter = createErrorReporter({
      dsn: parseSentryDsn(DSN),
      environment: 'mainnet',
      send: capture.send,
      now: () => clock,
    })!
    for (let i = 0; i < 50; i++) {
      reporter.report('tick', new Error(`distinct fault ${i}`))
      clock += 100
    }
    await reporter.flush()
    expect(capture.bodies).toHaveLength(10)
  })
})

describe('sentryOptionsFromEnv', () => {
  const KEYS = ['SENTRY_DSN', 'SENTRY_ENVIRONMENT', 'SENTRY_RELEASE', 'SWAP_NETWORK'] as const
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
    for (const key of KEYS) delete process.env[key]
  })
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('is null when SENTRY_DSN is unset, and null again when it is blank', () => {
    expect(sentryOptionsFromEnv()).toBeNull()
    process.env.SENTRY_DSN = '   '
    expect(sentryOptionsFromEnv()).toBeNull()
  })

  it('falls back to the swap network for the environment tag', () => {
    process.env.SENTRY_DSN = DSN
    process.env.SWAP_NETWORK = 'regtest'
    expect(sentryOptionsFromEnv()).toMatchObject({ environment: 'regtest', release: undefined })
  })

  it('prefers an explicit environment and carries a release', () => {
    process.env.SENTRY_DSN = DSN
    process.env.SWAP_NETWORK = 'regtest'
    process.env.SENTRY_ENVIRONMENT = 'staging'
    process.env.SENTRY_RELEASE = 'v1.2.3'
    expect(sentryOptionsFromEnv()).toMatchObject({ environment: 'staging', release: 'v1.2.3' })
  })

  it('throws on a malformed DSN rather than silently reporting nowhere', () => {
    process.env.SENTRY_DSN = 'https://no-project-id@example.com'
    expect(() => sentryOptionsFromEnv()).toThrow('SENTRY_DSN')
  })
})

describe('the envelope', () => {
  it('is three newline-delimited lines Sentry can ingest', () => {
    const event = buildEvent('ctx', new Error('boom'), {
      environment: 'regtest',
      eventId: 'f'.repeat(32),
      timestamp: 1_700_000_000,
    })
    const [header, item, payload] = envelopeFor(event).split('\n')
    expect(JSON.parse(header!)).toMatchObject({ event_id: 'f'.repeat(32) })
    expect(JSON.parse(item!)).toMatchObject({ type: 'event', content_type: 'application/json' })
    expect(JSON.parse(item!).length).toBe(Buffer.byteLength(payload!))
  })

  it.each([
    ['a null-prototype object', Object.create(null)],
    [
      'a value whose toString throws',
      {
        toString: () => {
          throw new Error('nope')
        },
      },
    ],
  ])('converts %s instead of throwing inside the panic handler', (_name, value) => {
    const event = buildEvent('ctx', value, { environment: 'e', eventId: 'a'.repeat(32), timestamp: 1 })
    expect(event.exception.values[0].value).toBe('<unprintable>')
  })

  it('reports a thrown non-Error without inventing a stack', () => {
    const event = buildEvent('ctx', 'plain string failure', {
      environment: 'regtest',
      eventId: 'a'.repeat(32),
      timestamp: 1,
    })
    expect(event.exception.values[0].value).toBe('plain string failure')
    expect(event.exception.values[0].stacktrace.frames).toEqual([])
  })
})
