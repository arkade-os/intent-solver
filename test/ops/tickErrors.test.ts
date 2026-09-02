import { describe, it, expect } from 'vitest'
import { signatureOf, TickErrorTracker } from '../../src/ops/tickErrors.js'

/**
 * Both halves of what was observed on mainnet: 98 identical lines in 28s from a
 * backend that could not be reached, and 96 from a fee estimate that could not
 * change between ticks a quarter-second apart.
 */
const clock = (start = 1_000_000) => {
  let now = start
  return { now: () => now, advance: (ms: number) => (now += ms) }
}

describe('TickErrorTracker', () => {
  it('reports the first failure immediately', () => {
    const tracker = new TickErrorTracker(clock().now)
    expect(tracker.record('swap-1', new Error('backend unreachable')).line).toBe('backend unreachable')
  })

  it('collapses the repeats that made 98 lines out of one fact', () => {
    const c = clock()
    const tracker = new TickErrorTracker(c.now)
    const err = new Error('maxFeeSats does not cover fee estimate')

    let printed = 0
    for (let i = 0; i < 98; i++) {
      if (tracker.record('swap-1', err).line) printed += 1
      c.advance(290) // the observed cadence
    }
    // One per doubling rather than one per tick: enough to know it is ongoing.
    expect(printed).toBeGreaterThan(0)
    expect(printed).toBeLessThan(15)
  })

  it('carries the count, so a collapsed line still says how bad it is', () => {
    const c = clock()
    const tracker = new TickErrorTracker(c.now)
    const err = new Error('boom')
    tracker.record('swap-1', err)
    const second = tracker.record('swap-1', err)
    expect(second.line).toContain('2 consecutive')
  })

  it('holds the swap off, and lets it through once the delay passes', () => {
    const c = clock()
    const tracker = new TickErrorTracker(c.now)
    const { backoffMs } = tracker.record('swap-1', new Error('boom'))

    expect(tracker.shouldSkip('swap-1')).toBe(true)
    c.advance(backoffMs)
    expect(tracker.shouldSkip('swap-1')).toBe(false)
  })

  it('backs off further each time, up to a cap', () => {
    const c = clock()
    const tracker = new TickErrorTracker(c.now)
    const err = new Error('boom')

    const first = tracker.record('swap-1', err).backoffMs
    const second = tracker.record('swap-1', err).backoffMs
    expect(second).toBeGreaterThan(first)

    for (let i = 0; i < 40; i++) tracker.record('swap-1', err)
    // Capped: a fault that never clears must still be reported periodically.
    expect(tracker.record('swap-1', err).backoffMs).toBe(60_000)
  })

  it('reports a CHANGED failure at once, and restarts the backoff', () => {
    const c = clock()
    const tracker = new TickErrorTracker(c.now)
    for (let i = 0; i < 20; i++) tracker.record('swap-1', new Error('unreachable'))

    // A swap failing differently is making progress of a kind. Suppressing it
    // behind the previous cause's count is how a new fault goes unseen.
    const changed = tracker.record('swap-1', new Error('fee estimate too low'))
    expect(changed.line).toBe('fee estimate too low')
    expect(changed.backoffMs).toBe(500)
  })

  it('never holds one swap off because another is failing', () => {
    const tracker = new TickErrorTracker(clock().now)
    tracker.record('swap-1', new Error('boom'))
    expect(tracker.shouldSkip('swap-2')).toBe(false)
  })

  it('forgets a swap that recovers, so its next fault is reported at once', () => {
    const c = clock()
    const tracker = new TickErrorTracker(c.now)
    for (let i = 0; i < 20; i++) tracker.record('swap-1', new Error('boom'))

    tracker.clear('swap-1')
    expect(tracker.shouldSkip('swap-1')).toBe(false)
    const after = tracker.record('swap-1', new Error('boom'))
    expect(after.line).toBe('boom')
    expect(after.backoffMs).toBe(500)
  })

  it('lists what is failing, for the console', () => {
    const tracker = new TickErrorTracker(clock().now)
    tracker.record('swap-1', new Error('boom'))
    tracker.record('swap-1', new Error('boom'))
    expect(tracker.failing).toEqual([{ id: 'swap-1', message: 'boom', count: 2 }])
  })

  /**
   * `clear` covers the swap that recovers. This covers the other ending: one
   * that goes terminal, or parks in `stuck`, and is never ticked again. Nothing
   * would ever remove it, so the Map grew for the life of the process and the
   * console's panel filled with swaps that stopped mattering hours ago.
   */
  it('forgets a swap that stopped failing without ever recovering', () => {
    const c = clock()
    const tracker = new TickErrorTracker(c.now)
    tracker.record('gone', new Error('boom'))
    expect(tracker.failing).toHaveLength(1)

    // Well past the longest backoff, so nothing still being ticked can be here.
    c.advance(5 * 60_000 + 1)
    expect(tracker.failing).toEqual([])
  })

  it('keeps a swap that is still failing, however long the outage runs', () => {
    const c = clock()
    const tracker = new TickErrorTracker(c.now)
    // A real outage records at least once per 60s cap; ten minutes of that must
    // not prune the entry that is the whole reason to look at the panel.
    for (let elapsed = 0; elapsed < 10 * 60_000; elapsed += 60_000) {
      tracker.record('live', new Error('backend unreachable'))
      c.advance(60_000)
    }
    expect(tracker.failing.map((f) => f.id)).toEqual(['live'])
  })

  it('puts the most recent failure first, so a long list stays useful', () => {
    const c = clock()
    const tracker = new TickErrorTracker(c.now)
    tracker.record('older', new Error('a'))
    c.advance(1_000)
    tracker.record('newer', new Error('b'))
    expect(tracker.failing.map((f) => f.id)).toEqual(['newer', 'older'])
  })

  /**
   * SDK errors routinely carry a serialised request and response, and this
   * getter ships in the overview response on every console load.
   */
  it('caps the error text it hands the console', () => {
    const tracker = new TickErrorTracker(clock().now)
    tracker.record('swap-1', new Error('x'.repeat(5_000)))
    expect(tracker.failing[0]?.message).toHaveLength(200)
  })
})

/**
 * The failure that outlived the fix: a message carrying a value that CHANGES
 * every attempt.
 *
 * A backend SDK that appends its own request context to every error — including
 * a `serverTraceId` unique per call — is the case that produced it. Keyed on the
 * raw text, every retry is a "different" failure, so the backoff resets to 500ms
 * forever and nothing is ever collapsed. Swap d69041e8 retried on mainnet for
 * SIX DAYS this way.
 */
describe('a message carrying per-attempt context', () => {
  const tracedError = (trace: string) =>
    new Error(
      'Failed to initiate preimage swap: /vendor.PaymentService/initiate_preimage_swap ALREADY_EXISTS: ' +
        'preimage request already exists for paymentHash 2ffe1de3 ' +
        `[operation: initiate_preimage_swap, clientEnv: js-vendor-sdk/0.9.0, serverTraceId: ${trace}, idPubKey: 039ab]`,
    )

  it('treats a trace-id-only difference as the SAME failure', () => {
    const c = clock()
    const tracker = new TickErrorTracker(c.now)

    tracker.record('swap-1', tracedError('aaaaaaaa'))
    const second = tracker.record('swap-1', tracedError('bbbbbbbb'))

    // Same fault, so the backoff must grow rather than restart.
    expect(second.backoffMs).toBeGreaterThan(500)
  })

  it('escalates to the ceiling instead of resetting every attempt', () => {
    const c = clock()
    const tracker = new TickErrorTracker(c.now)

    let last = 0
    for (let i = 0; i < 12; i++) {
      last = tracker.record('swap-1', tracedError(`trace-${i}`)).backoffMs
      c.advance(last)
    }

    // Six days of 500ms retries is what the old keying produced.
    expect(last).toBe(60_000)
  })

  it('collapses the log instead of printing every attempt', () => {
    const c = clock()
    const tracker = new TickErrorTracker(c.now)

    let printed = 0
    for (let i = 0; i < 40; i++) {
      if (tracker.record('swap-1', tracedError(`trace-${i}`)).line !== null) printed += 1
      c.advance(1000)
    }

    expect(printed).toBeLessThan(10)
  })

  it('still reports a GENUINELY different failure immediately', () => {
    const c = clock()
    const tracker = new TickErrorTracker(c.now)

    tracker.record('swap-1', tracedError('aaaaaaaa'))
    const different = tracker.record('swap-1', new Error('maxFeeSats does not cover fee estimate [value: 10]'))

    // A swap whose failure CHANGES is making progress of a kind — the whole
    // reason the tracker keys on the message at all.
    expect(different.line).toContain('maxFeeSats')
    expect(different.backoffMs).toBe(500)
  })
})

/**
 * Direct cover for the normalisation itself. It is exported, it decides what
 * counts as "the same failure", and it walks a cursor by hand — so its edges
 * are worth pinning rather than inferring from the tracker's behaviour.
 */
describe('signatureOf', () => {
  it('leaves a message with no volatile keys untouched', () => {
    expect(signatureOf('plain failure, nothing to blank')).toBe('plain failure, nothing to blank')
  })

  it('blanks the value but keeps the surrounding context intact', () => {
    expect(signatureOf('boom [operation: pay, serverTraceId: abc123, idPubKey: 039ab]')).toBe(
      'boom [operation: pay, serverTraceId: <volatile>, idPubKey: 039ab]',
    )
  })

  it('handles the key at the very end, with no trailing delimiter', () => {
    // The cursor walk runs to the end of the string rather than off it.
    expect(signatureOf('boom serverTraceId: abc123')).toBe('boom serverTraceId: <volatile>')
  })

  it('blanks EVERY occurrence, not just the first', () => {
    expect(signatureOf('a serverTraceId: one, b serverTraceId: two]')).toBe(
      'a serverTraceId: <volatile>, b serverTraceId: <volatile>]',
    )
  })

  it('blanks each configured key independently', () => {
    expect(signatureOf('[traceId: aaa, requestId: bbb, correlationId: ccc]')).toBe(
      '[traceId: <volatile>, requestId: <volatile>, correlationId: <volatile>]',
    )
  })

  it('does NOT blank a payment hash or an amount', () => {
    // The whole reason for matching by key name: these are what SHOULD tell one
    // fault from another, and a hex-run rule would have swallowed them.
    const message = 'no route for paymentHash 2ffe1de3 [field: maxFeeSats, value: 10, expected: 11 sats]'
    expect(signatureOf(message)).toBe(message)
  })

  it('collapses two messages that differ ONLY in the volatile value', () => {
    const of = (trace: string) => `same fault [operation: pay, serverTraceId: ${trace}]`
    expect(signatureOf(of('aaa'))).toBe(signatureOf(of('zzz')))
  })

  it('keeps two genuinely different faults apart', () => {
    expect(signatureOf('fault A [serverTraceId: x]')).not.toBe(signatureOf('fault B [serverTraceId: x]'))
  })
})
