import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  AdPublisher,
  AD_HEARTBEAT_SECONDS,
  startAdPublishing,
  type AdPublishMode,
} from '@arkade-os/solver-transport/relay/adPublisher.js'
import type { RelayEvent } from '@arkade-os/solver-transport/relay/connection.js'

const ad = { v: 1 as const, type: 'solver_ad' as const, pairs: [{ pair: 'a', min: 1, max: 2 }], relays: ['wss://r'] }

const publisherWith = (mode: 'off' | 'manual' | 'auto', publish = vi.fn(async () => {})) =>
  new AdPublisher({ mode, buildAd: () => ad, publish, now: () => 1_800_000_000, heartbeatSeconds: 1800 })

describe('AdPublisher', () => {
  it('publishes once on start in auto, and not again while the ad is unchanged', async () => {
    const publish = vi.fn(async () => {})
    const p = publisherWith('auto', publish)
    await p.publishIfDue()
    await p.publishIfDue()
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('publishes again when the ad changes', async () => {
    const publish = vi.fn(async () => {})
    let current = ad
    const p = new AdPublisher({
      mode: 'auto',
      buildAd: () => current,
      publish,
      now: () => 1_800_000_000,
      heartbeatSeconds: 1800,
    })
    await p.publishIfDue()
    current = { ...ad, relays: ['wss://other'] }
    await p.publishIfDue()
    expect(publish).toHaveBeenCalledTimes(2)
  })

  // A failed publish must not be recorded as success, or the next trigger
  // believes the relay has a copy it does not have.
  it('does not advance the published digest when publishing fails', async () => {
    const publish = vi.fn(async () => {
      throw new Error('relay down')
    })
    const p = publisherWith('auto', publish)
    // Swallowed here, not in the publisher: `publishIfDue` deliberately
    // propagates so the scheduler decides what a relay outage means. The
    // behaviour under test is that the digest did not advance — the SECOND
    // call still attempts a publish — not how the error surfaces.
    await p.publishIfDue().catch(() => {})
    await p.publishIfDue().catch(() => {})
    expect(publish).toHaveBeenCalledTimes(2)
    expect(p.state().lastError).toContain('relay down')
  })

  it('publishes nothing in manual, but publishNow works', async () => {
    const publish = vi.fn(async () => {})
    const p = publisherWith('manual', publish)
    await p.publishIfDue()
    expect(publish).not.toHaveBeenCalled()
    await p.publishNow()
    expect(publish).toHaveBeenCalledTimes(1)
  })

  // `off` means do not touch Nostr. If publishNow worked here the setting
  // would be advisory, and an operator who set it has no guarantee.
  it('refuses publishNow when off', async () => {
    const publish = vi.fn(async () => {})
    const p = publisherWith('off', publish)
    await expect(p.publishNow()).rejects.toThrow(/off/i)
    expect(publish).not.toHaveBeenCalled()
  })
})

describe('startAdPublishing', () => {
  afterEach(() => vi.useRealTimers())

  const start = (mode: AdPublishMode, connected = { value: true }) => {
    let clock = 1_800_000_000_000
    const published: RelayEvent[] = []
    const connection = {
      publish: vi.fn(async (event: RelayEvent) => void published.push(event)),
      isConnected: () => connected.value,
    }
    const handle = startAdPublishing({
      mode,
      connection,
      author: 'solver',
      buildAd: () => ad,
      onError: () => {},
      nowMs: () => clock,
    })
    return { handle, published, advance: (ms: number) => ((clock += ms), vi.advanceTimersByTimeAsync(ms)) }
  }

  it('constructs nothing when off', () => {
    vi.useFakeTimers()
    expect(start('off').handle).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('publishes in manual only when asked, as the replaceable kind-38859 ad', async () => {
    vi.useFakeTimers()
    const { handle, published, advance } = start('manual')
    await advance(AD_HEARTBEAT_SECONDS * 2000)
    expect(published).toHaveLength(0)
    await handle!.publisher.publishNow()
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({ author: 'solver', payload: ad, replaceable: { kind: 38859, d: 'rfq1' } })
    expect(published[0]!.recipient ?? published[0]!.topic).toBeUndefined()
  })

  it('refuses to count a publish while disconnected as published', async () => {
    const { handle, published } = start('manual', { value: false })
    await expect(handle!.publisher.publishNow()).rejects.toThrow(/not connected/)
    expect(published).toHaveLength(0)
    expect(handle!.publisher.state().lastPublishedAt).toBeNull()
  })

  it('publishes in auto while connected, again when the heartbeat is due, and stops on stop()', async () => {
    vi.useFakeTimers()
    const connected = { value: false }
    const { handle, published, advance } = start('auto', connected)
    await advance(60_000)
    expect(published).toHaveLength(0)
    connected.value = true
    await advance(30_000)
    expect(published).toHaveLength(1)
    await advance(60_000)
    expect(published).toHaveLength(1)
    await advance(AD_HEARTBEAT_SECONDS * 1000)
    expect(published).toHaveLength(2)
    handle!.stop()
    await advance(AD_HEARTBEAT_SECONDS * 2000)
    expect(published).toHaveLength(2)
  })
})
