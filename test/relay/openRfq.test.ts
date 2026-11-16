import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenRfqBidder } from '@arkade-os/solver-transport/ingress/openRfq.js'
import { RfqOpen } from '@arkade-os/solver-core/core/rfqProtocol.js'
import { buildSolverCard, signSolverCard, verifyCardSig } from '@arkade-os/solver-core/core/registryCard.js'
import { nostrCodec } from '@arkade-os/solver-transport/relay/nostr.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  matchesFilter,
  type RelayConnection,
  type RelayEvent,
  type RelayFilter,
} from '@arkade-os/solver-transport/relay/connection.js'

const secret = new Uint8Array(32).fill(1)
const provider = bytesToHex(schnorr.getPublicKey(secret))
const client = bytesToHex(schnorr.getPublicKey(new Uint8Array(32).fill(2)))
const pair = 'arkade:bitcoin/slip44:0~bolt11:bitcoin/slip44:0'
const now = 1_800_000_000_000
const request = (over: Record<string, unknown> = {}) => ({
  v: 1,
  type: 'rfq_open',
  open_id: 'ab'.repeat(32),
  pair,
  amount_side: 'from',
  amount: '10000',
  bids_until: now / 1000 + 5,
  ...over,
})

class Relay implements RelayConnection {
  events: RelayEvent[] = []
  subscriptions: { filter: RelayFilter; callback: (event: RelayEvent) => void | Promise<void> }[] = []
  async publish(event: RelayEvent) {
    this.events.push(event)
    for (const entry of this.subscriptions) if (matchesFilter(event, entry.filter)) await entry.callback(event)
  }
  async subscribe(filter: RelayFilter, callback: (event: RelayEvent) => void | Promise<void>) {
    const entry = { filter, callback }
    this.subscriptions.push(entry)
    return {
      close: async () => {
        this.subscriptions = this.subscriptions.filter((item) => item !== entry)
      },
    }
  }
  isConnected() {
    return true
  }
  close = vi.fn(async () => {})
  async open(payload: unknown = request(), over: Partial<RelayEvent> = {}) {
    await this.publish({ id: 'cd'.repeat(32), author: client, topic: pair, createdAtMs: now, payload, ...over })
  }
}

describe('open RFQ boundary', () => {
  it('keeps cross-asset amounts exact and rejects unbounded or noncanonical inputs', () => {
    expect(RfqOpen.parse(request({ amount: '100000000000000000001' })).amount).toBe('100000000000000000001')
    for (const amount of [10000, '0', '01', '1e8', '1.2', '1'.repeat(129)]) {
      expect(RfqOpen.safeParse(request({ amount })).success).toBe(false)
    }
    expect(RfqOpen.safeParse(request({ invoice: 'private' })).success).toBe(false)
    expect(RfqOpen.safeParse(request({ pair: 'arkade:BTC->lightning:BTC' })).success).toBe(false)
    expect(RfqOpen.safeParse(request({ v: 2 })).success).toBe(false)
    expect(RfqOpen.safeParse(request({ size_bucket: { min: '1', max: '2' } })).success).toBe(false)
  })

  let bidder: OpenRfqBidder | undefined
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  })
  afterEach(async () => {
    await bidder?.stop()
    bidder = undefined
    vi.useRealTimers()
  })

  const setup = async (
    opts: {
      relay?: Relay
      clock?: () => number
      pairs?: () => Promise<readonly string[]>
      preview?: () => Promise<{ from_amount: string; to_amount: string; valid_until: number } | undefined>
      rate?: number
      onError?: (context: string, error: unknown) => void
    } = {},
  ) => {
    const relay = opts.relay ?? new Relay()
    const card = await signSolverCard(
      buildSolverCard({
        name: 'bidder',
        network: 'bitcoin',
        discoveryPubkey: provider,
        relays: ['wss://relay.example'],
        corridors: {
          'arkade:BTC->lightning:BTC': { limits: { minSats: 1, maxSats: 100000 }, fee: { bps: 0, flatSats: 0 } },
        },
      }),
      async (digest) => schnorr.sign(digest, secret),
    )
    const preview = vi.fn(
      opts.preview ?? (async () => ({ from_amount: '10000', to_amount: '9950', valid_until: now / 1000 + 30 })),
    )
    bidder = new OpenRfqBidder({
      connection: relay,
      providerPubkey: provider,
      pairs: opts.pairs ?? (async () => [pair]),
      card: async () => card,
      preview,
      maxBidsPerMinute: opts.rate ?? 30,
      now: opts.clock ?? (() => now),
      onError: opts.onError,
    })
    await bidder.start()
    return { relay, card, preview }
  }

  it('replies privately with a signed card, exact price and event correlation', async () => {
    const { relay, card, preview } = await setup()
    await relay.open()
    expect(preview).toHaveBeenCalledOnce()
    expect(relay.events[1]).toMatchObject({
      author: provider,
      recipient: client,
      replyTo: 'cd'.repeat(32),
      payload: {
        v: 1,
        type: 'rfq_bid',
        open_id: 'ab'.repeat(32),
        pair,
        amount_side: 'from',
        from_amount: '10000',
        to_amount: '9950',
        valid_until: now / 1000 + 30,
        card,
      },
    })
    await bidder!.stop()
    expect(relay.subscriptions).toHaveLength(0)
    expect(relay.close).not.toHaveBeenCalled()
  })

  it('round trips authenticated public intent and sealed bid through the actual Nostr codecs', async () => {
    const { relay } = await setup()
    const clientCodec = nostrCodec({ secretKey: new Uint8Array(32).fill(2), pubkey: client })
    const serverCodec = nostrCodec({ secretKey: secret, pubkey: provider })
    const [, broadcast] = JSON.parse(
      clientCodec.encodeEvent({ id: '', author: client, topic: pair, createdAtMs: now, payload: request() }),
    )
    const received = serverCodec.decodeEvent(JSON.stringify(['EVENT', 'open', broadcast]))
    expect(received).not.toBeNull()
    await relay.publish(received!)
    const [, sealed] = JSON.parse(serverCodec.encodeEvent(relay.events[1]!))
    expect(sealed.tags).toEqual([
      ['p', client],
      ['e', broadcast.id],
    ])
    expect(sealed.content).not.toContain('rfq_bid')
    const bid = clientCodec.decodeEvent(JSON.stringify(['EVENT', 'bid', sealed]))
    expect(bid?.replyTo).toBe(broadcast.id)
    expect(verifyCardSig((bid!.payload as { card: Awaited<ReturnType<typeof signSolverCard>> }).card)).toBe(true)
  })

  it('drops mismatched topics, recipients, expired windows and future stamps before pricing', async () => {
    const { relay, preview } = await setup()
    await relay.open(request(), { recipient: provider })
    await relay.open(request({ pair: pair.split('~').reverse().join('~') }))
    await relay.open(request({ bids_until: now / 1000 }))
    await relay.open(request(), { createdAtMs: now + 6000 })
    expect(preview).not.toHaveBeenCalled()
  })

  it('deduplicates a signed open and bounds work before a price fetch', async () => {
    const { relay, preview } = await setup({ rate: 1 })
    await relay.open()
    await relay.open()
    await relay.open(request({ open_id: 'ef'.repeat(32) }), { id: 'ef'.repeat(32) })
    expect(preview).toHaveBeenCalledOnce()
    expect(relay.events.filter((event) => event.recipient === client)).toHaveLength(1)
  })

  it('keeps active replay keys when the bounded cache fills, then reclaims expired slots', async () => {
    let clock = now
    const { relay } = await setup({ rate: 2000, clock: () => clock })
    const id = (index: number) => index.toString(16).padStart(64, '0')
    for (let index = 0; index < 1025; index++) {
      await relay.open(request({ open_id: id(index) }), { id: id(index) })
    }
    await relay.open(request({ open_id: id(0) }), { id: id(0) })
    expect(relay.events.filter((event) => event.recipient === client)).toHaveLength(1024)
    clock += 6000
    await relay.open(request({ open_id: id(1025), bids_until: clock / 1000 + 5 }), {
      id: id(1025),
      createdAtMs: clock,
    })
    expect(relay.events.filter((event) => event.recipient === client)).toHaveLength(1025)
  })

  it('refreshes subscriptions when advertised directions change', async () => {
    let pairs = [pair]
    const { relay } = await setup({ pairs: async () => pairs })
    expect(relay.subscriptions).toHaveLength(1)
    pairs = []
    await bidder!.refresh()
    expect(relay.subscriptions).toHaveLength(0)
    pairs = [pair]
    await bidder!.refresh()
    expect(relay.subscriptions).toHaveLength(1)
  })

  it.each(['pairs', 'subscribe'])('recovers when the initial %s call fails temporarily', async (failure) => {
    const relay = new Relay()
    const pairs = vi.fn(async () => [pair])
    const onError = vi.fn()
    if (failure === 'pairs') pairs.mockRejectedValueOnce(new Error('temporary failure'))
    else vi.spyOn(relay, 'subscribe').mockRejectedValueOnce(new Error('temporary failure'))
    await setup({ relay, pairs, onError })
    expect(relay.subscriptions).toHaveLength(0)
    expect(onError).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(relay.subscriptions).toHaveLength(1)
    await relay.open()
    expect(relay.events.filter((event) => event.recipient === client)).toHaveLength(1)
  })

  it('cleans partial startup subscriptions and stops retrying after stop', async () => {
    const relay = new Relay()
    const subscribe = relay.subscribe.bind(relay)
    const attempt = vi
      .spyOn(relay, 'subscribe')
      .mockImplementationOnce(subscribe)
      .mockRejectedValueOnce(new Error('unavailable'))
    const pairs = vi.fn(async () => [pair, pair.split('~').reverse().join('~')])
    await setup({ relay, pairs })
    expect(relay.subscriptions).toHaveLength(1)
    await bidder!.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(relay.subscriptions).toHaveLength(0)
    expect(pairs).toHaveBeenCalledOnce()
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(relay.close).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps retrying once per refresh interval through a longer startup outage', async () => {
    let attempts = 0
    const pairs = vi.fn(async () => {
      if (++attempts < 5) throw new Error('unavailable')
      return [pair]
    })
    const { relay } = await setup({ pairs })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(pairs).toHaveBeenCalledTimes(5)
    expect(relay.subscriptions).toHaveLength(1)
  })

  it('does not publish after stop while a price preview is in flight', async () => {
    let finish!: (price: { from_amount: string; to_amount: string; valid_until: number }) => void
    const { relay } = await setup({
      preview: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    })
    const pending = relay.open()
    await bidder!.stop()
    finish({ from_amount: '10000', to_amount: '9950', valid_until: now / 1000 + 30 })
    await pending
    expect(relay.events).toHaveLength(1)
  })

  it('refuses a card signed under a different discovery identity', async () => {
    const { relay, card } = await setup()
    card.discovery_pubkey = client
    await relay.open()
    expect(relay.events).toHaveLength(1)
  })

  it('contains a failed price fetch and continues serving later opens', async () => {
    let attempts = 0
    const { relay } = await setup({
      preview: async () => {
        if (++attempts === 1) throw new Error('feed unavailable')
        return { from_amount: '10000', to_amount: '9950', valid_until: now / 1000 + 30 }
      },
    })
    await relay.open()
    await relay.open(request({ open_id: 'ef'.repeat(32) }), { id: 'ef'.repeat(32) })
    expect(relay.events.filter((event) => event.recipient === client)).toHaveLength(1)
  })

  it('drops a late preview after expiry or stop, and refuses changed requested amounts', async () => {
    let clock = now
    const { relay } = await setup({
      clock: () => clock,
      preview: async () => {
        clock += 6000
        return { from_amount: '10000', to_amount: '9950', valid_until: now / 1000 + 30 }
      },
    })
    await relay.open()
    expect(relay.events).toHaveLength(1)
    await bidder!.stop()
    clock = now
    const second = await setup({
      preview: async () => ({ from_amount: '10001', to_amount: '9950', valid_until: now / 1000 + 30 }),
    })
    await second.relay.open()
    expect(second.relay.events).toHaveLength(1)
  })

  it('rechecks expiry and stop after the final asynchronous serve-list lookup', async () => {
    let clock = now
    let lookups = 0
    const { relay } = await setup({
      clock: () => clock,
      pairs: async () => {
        if (++lookups === 2) clock += 6000
        return [pair]
      },
    })
    await relay.open()
    expect(relay.events).toHaveLength(1)
    await bidder!.stop()
    const second = await setup({
      pairs: async () => {
        if (++lookups === 4) await bidder!.stop()
        return [pair]
      },
    })
    await second.relay.open()
    expect(second.relay.events).toHaveLength(1)
  })
})
