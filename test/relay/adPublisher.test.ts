import { describe, it, expect, vi, afterEach } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hexToBytes } from '@noble/hashes/utils.js'
import {
  buildSolverCard,
  signSolverCard,
  verifyCardSig,
  type SolverCard,
} from '@arkade-os/solver-core/core/registryCard.js'
import {
  AdPublisher,
  AD_HEARTBEAT_SECONDS,
  startAdPublishing,
  type AdPublishMode,
} from '@arkade-os/solver-transport/relay/adPublisher.js'
import type { RelayEvent } from '@arkade-os/solver-transport/relay/connection.js'

const SECRET = hexToBytes('b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef')
const PUBKEY = 'dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659'

/** Signed afresh per call: noble draws new aux randomness, so equal content still differs in `sig`. */
const signedCard = (maxSats = 50_000): Promise<SolverCard> =>
  signSolverCard(
    buildSolverCard({
      name: 'test-solver',
      network: 'mutinynet',
      discoveryPubkey: PUBKEY,
      relays: ['wss://relay.example'],
      corridors: {
        'arkade:BTC->lightning:BTC': { limits: { minSats: 1_000, maxSats }, fee: { bps: 30, flatSats: 0 } },
      },
    }),
    async (digest) => schnorr.sign(digest, SECRET),
  )

const publisherWith = (
  mode: AdPublishMode,
  opts: {
    build?: () => Promise<SolverCard>
    publish?: (card: SolverCard) => Promise<void>
    now?: () => number
  } = {},
) =>
  new AdPublisher({
    mode,
    buildAd: opts.build ?? (() => signedCard()),
    publish: opts.publish ?? vi.fn(async () => {}),
    now: opts.now ?? (() => 1_800_000_000),
    heartbeatSeconds: AD_HEARTBEAT_SECONDS,
  })

describe('AdPublisher', () => {
  it('publishes once in auto, and not again for a card that was only re-signed', async () => {
    const built: SolverCard[] = []
    const publish = vi.fn(async () => {})
    const p = publisherWith('auto', {
      build: async () => {
        const card = await signedCard()
        built.push(card)
        return card
      },
      publish,
    })
    await p.publishIfDue()
    await p.publishIfDue()
    expect(built[0]!.sig).not.toBe(built[1]!.sig)
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('publishes again when the card changes', async () => {
    let maxSats = 50_000
    const publish = vi.fn(async () => {})
    const p = publisherWith('auto', { build: () => signedCard(maxSats), publish })
    await p.publishIfDue()
    maxSats = 60_000
    await p.publishIfDue()
    expect(publish).toHaveBeenCalledTimes(2)
  })

  // A failed publish must not be recorded as success, or the next trigger
  // believes the relay has a copy it does not have.
  it('does not advance the published digest when publishing fails', async () => {
    const publish = vi.fn(async () => {
      throw new Error('relay down')
    })
    const p = publisherWith('auto', { publish })
    // Swallowed here, not in the publisher: `publishIfDue` deliberately
    // propagates so the scheduler decides what a relay outage means. The
    // behaviour under test is that the digest did not advance — the SECOND
    // call still attempts a publish — not how the error surfaces.
    await p.publishIfDue().catch(() => {})
    await p.publishIfDue().catch(() => {})
    expect(publish).toHaveBeenCalledTimes(2)
    expect(p.state().lastError).toContain('relay down')
  })

  it('publishes nothing in manual until asked, then publishNow works', async () => {
    const publish = vi.fn(async () => {})
    const p = publisherWith('manual', { publish })
    await p.publishIfDue()
    expect(publish).not.toHaveBeenCalled()
    await p.publishNow()
    expect(publish).toHaveBeenCalledTimes(1)
  })

  // `off` means do not touch Nostr. If publishNow worked here the setting
  // would be advisory, and an operator who set it has no guarantee.
  it('refuses publishNow when off', async () => {
    const publish = vi.fn(async () => {})
    const p = publisherWith('off', { publish })
    await expect(p.publishNow()).rejects.toThrow(/off/i)
    expect(publish).not.toHaveBeenCalled()
  })

  it('records a card that cannot be built as the publish error, and sends nothing', async () => {
    const publish = vi.fn(async () => {})
    const p = publisherWith('auto', {
      build: async () => {
        throw new Error('SOLVER_NAME is not set')
      },
      publish,
    })
    await expect(p.publishIfDue()).rejects.toThrow(/SOLVER_NAME/)
    expect(p.state().lastError).toContain('SOLVER_NAME')
    await expect(p.publishNow()).rejects.toThrow(/SOLVER_NAME/)
    expect(publish).not.toHaveBeenCalled()
    expect(p.state().lastPublishedAt).toBeNull()
  })

  it('re-sends in manual exactly the card the operator published, once the heartbeat is due', async () => {
    let now = 1_800_000_000
    let maxSats = 50_000
    const sent: SolverCard[] = []
    const p = publisherWith('manual', {
      build: () => signedCard(maxSats),
      publish: async (card) => void sent.push(card),
      now: () => now,
    })
    now += AD_HEARTBEAT_SECONDS
    await p.publishIfDue()
    expect(sent).toHaveLength(0)

    await p.publishNow()
    maxSats = 60_000
    now += AD_HEARTBEAT_SECONDS - 1
    await p.publishIfDue()
    expect(sent).toHaveLength(1)
    now += 1
    await p.publishIfDue()
    expect(sent).toHaveLength(2)
    expect(JSON.stringify(sent[1])).toBe(JSON.stringify(sent[0]))
    expect(p.state().lastPublishedAt).toBe(now)

    await p.publishNow()
    expect(sent[2]!.markets[0]).toMatchObject({ max_quote_amount: '60000' })
  })
})

describe('startAdPublishing', () => {
  afterEach(() => vi.useRealTimers())

  const start = (
    mode: AdPublishMode,
    opts: { connected?: { value: boolean }; build?: () => Promise<SolverCard>; onError?: (e: unknown) => void } = {},
  ) => {
    let clock = 1_800_000_000_000
    const published: RelayEvent[] = []
    const connected = opts.connected ?? { value: true }
    const connection = {
      publish: vi.fn(async (event: RelayEvent) => void published.push(event)),
      isConnected: () => connected.value,
    }
    const handle = startAdPublishing({
      mode,
      connection,
      author: 'solver',
      network: 'mutinynet',
      buildAd: opts.build ?? (() => signedCard()),
      onError: opts.onError ?? (() => {}),
      nowMs: () => clock,
    })
    return { handle, published, advance: (ms: number) => ((clock += ms), vi.advanceTimersByTimeAsync(ms)) }
  }

  it('constructs nothing when off', () => {
    vi.useFakeTimers()
    expect(start('off').handle).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('publishes the signed card as kind 38859, d-tagged with its network', async () => {
    vi.useFakeTimers()
    const { handle, published } = start('manual')
    await handle!.publisher.publishNow()
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({ author: 'solver', replaceable: { kind: 38859, d: 'mutinynet' } })
    expect(verifyCardSig(published[0]!.payload as SolverCard)).toBe(true)
    expect(published[0]!.recipient ?? published[0]!.topic).toBeUndefined()
  })

  it('refuses to count a publish while disconnected as published', async () => {
    const { handle, published } = start('manual', { connected: { value: false } })
    await expect(handle!.publisher.publishNow()).rejects.toThrow(/not connected/)
    expect(published).toHaveLength(0)
    expect(handle!.publisher.state().lastPublishedAt).toBeNull()
  })

  it('publishes in auto while connected, again when the heartbeat is due, and stops on stop()', async () => {
    vi.useFakeTimers()
    const connected = { value: false }
    const { handle, published, advance } = start('auto', { connected })
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

  it('keeps a manual card alive with the same bytes, and never sends a rebuilt one', async () => {
    vi.useFakeTimers()
    let maxSats = 50_000
    const { handle, published, advance } = start('manual', { build: () => signedCard(maxSats) })
    await advance(AD_HEARTBEAT_SECONDS * 2000)
    expect(published).toHaveLength(0)

    await handle!.publisher.publishNow()
    maxSats = 60_000
    await advance(AD_HEARTBEAT_SECONDS * 1000)
    expect(published).toHaveLength(2)
    expect(JSON.stringify(published[1]!.payload)).toBe(JSON.stringify(published[0]!.payload))
    expect(published[1]!.createdAtMs).toBeGreaterThan(published[0]!.createdAtMs)

    handle!.stop()
    await advance(AD_HEARTBEAT_SECONDS * 2000)
    expect(published).toHaveLength(2)
  })

  it('survives a card that cannot be built: the reason is reported, and a later tick publishes', async () => {
    vi.useFakeTimers()
    let ready = false
    const errors: unknown[] = []
    const { handle, published, advance } = start('auto', {
      build: async () => {
        if (!ready) throw new Error('SOLVER_NAME is not set')
        return signedCard()
      },
      onError: (error) => errors.push(error),
    })
    await advance(1_000)
    expect(errors).toHaveLength(1)
    expect(handle!.publisher.state().lastError).toContain('SOLVER_NAME')

    ready = true
    await advance(30_000)
    expect(published).toHaveLength(1)
    expect(handle!.publisher.state().lastError).toBeNull()
  })

  it('reports a failure repeating every tick once, and again only when it changes or after a clean tick', async () => {
    vi.useFakeTimers()
    let failure: string | null = 'SOLVER_NAME is not set'
    const errors: unknown[] = []
    const { advance } = start('auto', {
      build: async () => {
        if (failure) throw new Error(failure)
        return signedCard()
      },
      onError: (error) => errors.push(error),
    })
    await advance(5 * 30_000)
    expect(errors).toHaveLength(1)
    failure = 'no corridor is enabled'
    await advance(30_000)
    expect(errors).toHaveLength(2)
    failure = null
    await advance(30_000)
    failure = 'no corridor is enabled'
    await advance(30_000)
    expect(errors).toHaveLength(3)
  })
})
