import { describe, it, expect, vi } from 'vitest'
import { GiveUp, poll } from '@arkade-os/solver-core/util/poll.js'

describe('poll', () => {
  it('returns the first value a probe yields', async () => {
    const probe = vi.fn(async () => 'found')
    await expect(poll(probe, { attempts: 3, intervalMs: 1, whenExhausted: 'never' })).resolves.toBe('found')
    expect(probe).toHaveBeenCalledOnce()
  })

  it('treats a falsy-but-present value as an answer, not as "keep waiting"', async () => {
    // `null`/`undefined` is the sentinel, per the signature. Zero is an
    // ordinary vout — the onchain adapter's funding lookup returns exactly
    // this, and reading it as "not yet" would spin the whole attempt budget and
    // then throw about a value the first probe already had.
    const probe = vi.fn(async () => 0)
    await expect(poll(probe, { attempts: 3, intervalMs: 1, whenExhausted: 'never' })).resolves.toBe(0)
    expect(probe).toHaveBeenCalledOnce()
  })

  it('keeps waiting through null, then returns', async () => {
    let calls = 0
    const probe = async () => (++calls < 3 ? null : 'found')
    await expect(poll(probe, { attempts: 5, intervalMs: 1, whenExhausted: 'never' })).resolves.toBe('found')
    expect(calls).toBe(3)
  })

  it('retries a probe that throws, because one dropped packet must not abandon a claim', async () => {
    let calls = 0
    const probe = async () => {
      if (++calls < 3) throw new Error('connection reset')
      return 'found'
    }
    await expect(poll(probe, { attempts: 5, intervalMs: 1, whenExhausted: 'never' })).resolves.toBe('found')
  })

  it('stops immediately on GiveUp, and surfaces its message', async () => {
    const probe = vi.fn(async () => {
      throw new GiveUp('not retryable')
    })
    await expect(poll(probe, { attempts: 5, intervalMs: 1, whenExhausted: 'never' })).rejects.toThrow('not retryable')
    expect(probe).toHaveBeenCalledOnce()
  })

  it('reports the last error alongside the exhaustion message', async () => {
    const probe = async () => {
      throw new Error('indexer down')
    }
    await expect(poll(probe, { attempts: 2, intervalMs: 1, whenExhausted: 'gave up' })).rejects.toThrow(
      /gave up; last error: indexer down/,
    )
  })
})
