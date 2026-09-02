import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { OpenRfqBidder, RelayIngress } from '@arkade-os/solver-transport/ingress/relay.js'
import type { BiddingStrategy } from '@arkade-os/solver-core/core/openRfq.js'
import { BID_VALIDITY } from '@arkade-os/solver-core/core/openRfq.js'
import { RFQ_PAIR_SEND } from '@arkade-os/solver-corridors/wire/payloads.js'
import { marketKeyForPair } from '@arkade-os/solver-core/core/marketKey.js'
import {
  decodeFrame,
  encodeFrame,
  eventId,
  matchesFilter,
  type RelayConnection,
  type RelayEvent,
  type RelayFilter,
} from '@arkade-os/solver-transport/relay/connection.js'
import { SendSwapService, type ArkadeOps } from '@arkade-os/solver-corridors/send/orchestrator.js'
import { OnchainSendSwapService } from '@arkade-os/solver-corridors/send/onchainOrchestrator.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { SwapStore } from '@arkade-os/solver-corridors/db/swaps.js'
import { OnchainSendSwapStore } from '@arkade-os/solver-corridors/db/onchainSwaps.js'
import { ReceiveSwapStore } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import { FakeOnchainBackend } from '@arkade-os/solver-rails-fake/onchain/fake/backend.js'
import { ROUTE_CLTV_BUDGET_BLOCKS } from '@arkade-os/solver-core/core/send.js'
import { relayIngressFrom } from '../support/transportFrom.js'

const INVOICE =
  'lnbc21u1pnk8larsp526g88ejh9ac0es9j6juxwenzdzvs6hcrphna5pp3jefpukmtk3hqpp5m206npk0fr6k45u8f90capqw48k3pzymlqhk0j98kyx4mz383pkqdz9235x2gr3w45kx6eqvfex7amwypnx77pqdf6k6urnyphhvetjyp6xsefqd3sh57fqv3hkwxqyp2xqcqz95rzjqv9ruzr6quwpsuwmyshlvenk0xm7djrtt8ugt2ja6cx3dkqtccdgvzzxeyqq28qqqqqqqqqqqqqqq9gq2y9qyysgqvu5k5w9q0xe62envhds058r9h8v5uak09hn3uzlw39sqkcuwh34j44gc53j6x6sg0u6yf6l0durxqqekytupxpf66zc7rc9cpav72ssqpcgv3p'
const PAYMENT_HASH = 'da9fa986cf48f56ad387495f8e840ea9ed10889bf82f67c8a7b10d5d8a27886c'
const INVOICE_TIMESTAMP = 1_734_606_755

const keyBytes = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
const key = (fill: number): string => hex.encode(keyBytes(fill))
const CLIENT_REFUND_PUBKEY = key(20)

const PROVIDER = key(1)
const CLIENT = key(7)

const REFUND_ADDRESS = new CovenantSwapScript({
  receiver: keyBytes(5),
  server: keyBytes(3),
  preimageHash: new Uint8Array(20).fill(9),
  refundLocktime: 1_800_000_000,
  claimDelay: 4096,
  client: keyBytes(11),
  clientRefundDelay: 1024,
  refundWithoutServerDelay: 2048,
  nonInteractiveParameters: {
    emulatorPubkey: keyBytes(9),
    receiverPkScript: Uint8Array.from([0x51, 0x20, ...keyBytes(13)]),
    senderPkScript: Uint8Array.from([0x51, 0x20, ...keyBytes(5)]),
  },
})
  .address('ark', keyBytes(3))
  .encode()

const arkade: ArkadeOps = {
  providerPubkey: PROVIDER,
  serverPubkey: key(3),
  emulatorPubkey: key(9),
  receiverPkScript: hex.encode(Uint8Array.from([0x51, 0x20, ...keyBytes(1)])),
  delays: { unilateralClaimDelay: 4096, unilateralRefundDelay: 4608, unilateralRefundWithoutReceiverDelay: 5120 },
  hrp: 'ark',
  findLockups: async () => [],
  lockupProvablySpent: async () => false,
  claim: async () => 'claim-txid',
  refund: async () => 'refund-txid',
}

/**
 * In-memory relay: publish delivers synchronously to every matching subscriber.
 * This is the whole outbound loop with no socket — the provider's replies land
 * back in the same broker a client would read.
 */
class FakeRelay implements RelayConnection {
  published: RelayEvent[] = []
  private subs: { filter: RelayFilter; onEvent: (e: RelayEvent) => void | Promise<void> }[] = []

  async publish(event: RelayEvent): Promise<void> {
    this.published.push(event)
    for (const sub of this.subs) if (matchesFilter(event, sub.filter)) await sub.onEvent(event)
  }
  async subscribe(filter: RelayFilter, onEvent: (e: RelayEvent) => void | Promise<void>) {
    const entry = { filter, onEvent }
    this.subs.push(entry)
    return {
      close: async () => {
        this.subs = this.subs.filter((s) => s !== entry)
      },
    }
  }
  // Always reachable: this fake never disconnects.
  isConnected(): boolean {
    return true
  }
  async close(): Promise<void> {}

  /** Play a client: publish a request addressed to the provider. */
  async sendRequest(from: string, payload: unknown): Promise<void> {
    await this.publish({
      id: `${from}:${this.published.length}`,
      author: from,
      recipient: PROVIDER,
      // Stamped now, as a live client would: the ingress subscribes with a
      // freshness floor, so an epoch-stamped fixture is correctly ignored.
      createdAtMs: Date.now(),
      payload,
    })
  }

  /** The provider's replies addressed to a given client. */
  repliesTo(client: string): RelayEvent[] {
    return this.published.filter((e) => e.recipient === client && e.author === PROVIDER)
  }
}

/** Enough of a lightning-receive quote to persist one; the corridor's own logic lives in its orchestrator tests. */
const receiveQuote = {
  id: 'receive-1',
  paymentHash: 'cc'.repeat(32),
  amountSats: 5_000,
  payoutSats: 4_950,
  invoice: 'lnbcrt50000n1...',
  invoiceExpiresAt: INVOICE_TIMESTAMP + 700,
  payoutAddress: 'tark1payoutexample',
  payoutPkScript: '11'.repeat(34),
  payoutPubkey: '22'.repeat(32),
  claimPacket: 'ZWFsZWQtY2lwaGVydGV4dA==',
  refundLocktime: INVOICE_TIMESTAMP + 7200,
  solverPubkey: '33'.repeat(32),
  serverPubkey: '44'.repeat(32),
  claimDelay: 512,
  refundDelay: 1024,
  refundWithoutReceiverDelay: 1536,
  emulatorPubkey: '55'.repeat(33),
  pkScript: '66'.repeat(34),
  lockupAddress: 'tark1lockupexample',
  solverRefundPkScript: '77'.repeat(34),
  nonInteractiveParameters: true,
}

let clock: number
let store: SwapStore
let onchainStore: OnchainSendSwapStore
let relay: FakeRelay
let ingress: RelayIngress
let service: SendSwapService

beforeEach(async () => {
  clock = INVOICE_TIMESTAMP + 100
  store = await SwapStore.open(':memory:', () => clock)
  relay = new FakeRelay()
  service = new SendSwapService({
    store,
    ln: {
      routeCltvBudgetBlocks: ROUTE_CLTV_BUDGET_BLOCKS,
      enforcesRouteCltv: true,
      payInvoice: async () => ({ id: 'p', status: 'pending' as const }),
      getPayment: async () => ({ id: 'p', status: 'pending' as const }),
    },
    arkade,
    limits: { minSats: 500, maxSats: 10_000 },
    invoicePrefix: 'bc',
    maxExposedSats: 5_000,
    totalCommitted: () => store.committedSats(),
    admission: new AdmissionControl(),
    now: () => clock,
  })
  // Not exercised by this file's tests — real store + fake chain backend,
  // just enough to satisfy RelayIngressDeps.
  onchainStore = await OnchainSendSwapStore.open(':memory:', () => clock)
  const onchainService = new OnchainSendSwapService({
    store: onchainStore,
    onchain: new FakeOnchainBackend(),
    arkade,
    limits: { minSats: 500, maxSats: 10_000 },
    network: 'bitcoin',
    maxExposedSats: 5_000,
    totalCommitted: () => store.committedSats(),
    admission: new AdmissionControl(),
    signer: { sign: async (tx) => tx }, // never invoked — no test in this suite drives refunding_onchain
    refundDestinationScript: Uint8Array.from([0x51, 0x20, ...new Uint8Array(32).fill(1)]),
    now: () => clock,
  })
  ingress = relayIngressFrom({
    connection: relay,
    service,
    store,
    onchainService,
    onchainStore,
    providerPubkey: PROVIDER,
    now: () => clock * 1000,
  })
  await ingress.start()
})
afterEach(async () => {
  await ingress.stop()
  await store.close()
  await onchainStore.close()
})

describe('RelayIngress', () => {
  const RFQ_ID = 'c3'.repeat(32)
  const rfqRequest = (over: Record<string, unknown> = {}) => ({
    v: 1,
    type: 'rfq_request',
    rfq_id: RFQ_ID,
    pair: 'arkade:BTC->lightning:BTC',
    amount_side: 'to',
    profile: { invoice: INVOICE, refund_address: REFUND_ADDRESS, client_refund_pubkey: CLIENT_REFUND_PUBKEY },
    ...over,
  })

  it('quotes a request read off the relay and publishes the quote back to the sender', async () => {
    await relay.sendRequest(CLIENT, rfqRequest())

    const replies = relay.repliesTo(CLIENT)
    expect(replies).toHaveLength(1)
    const quote = replies[0]!.payload as Record<string, unknown>
    expect(quote.type).toBe('rfq_quote')
    expect(quote.rfq_id).toBe(RFQ_ID)
    expect(quote.solver_pubkey).toBe(PROVIDER)
    expect((quote.profile as Record<string, unknown>).lockup_address).toMatch(/^ark1/)
    // The swap is persisted exactly as the HTTP path persists it.
    expect((await store.findByPaymentHash(PAYMENT_HASH))!.state).toBe('quoted')
    expect((await store.findByPaymentHash(PAYMENT_HASH))!.rfqId).toBe(RFQ_ID)
  })

  it('publishes a refusal for an undecodable invoice, with the closed reason', async () => {
    await relay.sendRequest(
      CLIENT,
      rfqRequest({
        profile: { invoice: 'lnbc1nope', refund_address: REFUND_ADDRESS, client_refund_pubkey: CLIENT_REFUND_PUBKEY },
      }),
    )
    const reply = relay.repliesTo(CLIENT)[0]!.payload as Record<string, unknown>
    expect(reply).toEqual({ v: 1, type: 'rfq_refusal', rfq_id: RFQ_ID, reason: 'unsupported_payload' })
  })

  it('REFUSES rather than going silent when the backend throws mid-quote', async () => {
    // Observed on mainnet: a Lightning-receive quote died inside
    // `createHoldInvoice` on a transport fault, `handle` logged it and
    // returned, and the client got nothing back — waiting out its own 30s
    // timeout for an answer that was never coming. An honest, immediate
    // decline costs the client nothing and lets it retry or go elsewhere.
    const boom = new FakeRelay()
    const thrower = relayIngressFrom({
      connection: boom,
      store,
      onchainStore,
      providerPubkey: PROVIDER,
      now: () => clock * 1000,
      service: {
        quote: () => {
          throw new Error('service provider error: promise resolved to unexpected type')
        },
      } as never,
    })
    await thrower.start()
    try {
      await boom.sendRequest(CLIENT, rfqRequest())

      const reply = boom.repliesTo(CLIENT)[0]!.payload as Record<string, unknown>
      expect(reply.type).toBe('rfq_refusal')
      expect(reply.rfq_id).toBe(RFQ_ID)
      // A closed-set reason, not the exception text: the vocabulary is the
      // client's contract, and a backend message is neither stable nor theirs.
      expect(reply.reason).toBe('pricing_unavailable')
    } finally {
      await thrower.stop()
    }
  })

  it('refuses the send pair by name when the Lightning-send corridor is not served', async () => {
    // LN_SEND_ENABLED=false reaches the ingress as simply: no service. Its
    // own relay instance, so the suite's main ingress (which HAS the service)
    // cannot also answer and make the assertion order-dependent.
    const darkRelay = new FakeRelay()
    const dark = relayIngressFrom({
      connection: darkRelay,
      store,
      onchainStore,
      providerPubkey: PROVIDER,
      now: () => clock * 1000,
    })
    await dark.start()
    try {
      await darkRelay.sendRequest(CLIENT, rfqRequest())
      const replies = darkRelay.repliesTo(CLIENT)
      expect(replies).toHaveLength(1)
      expect(replies[0]!.payload).toEqual({ v: 1, type: 'rfq_refusal', rfq_id: RFQ_ID, reason: 'unsupported_pair' })
      // And nothing was quoted behind the refusal.
      expect(await store.findByPaymentHash(PAYMENT_HASH)).toBeNull()
    } finally {
      await dark.stop()
    }
  })

  it('re-emits the existing quote when a request is redelivered, never a duplicate swap', async () => {
    await relay.sendRequest(CLIENT, rfqRequest())
    await relay.sendRequest(CLIENT, rfqRequest()) // redelivery / client retry

    const replies = relay.repliesTo(CLIENT)
    expect(replies).toHaveLength(2)
    // Both replies are quotes for the SAME swap — not a quote_conflict refusal —
    // and byte-identical: the deadline is derived from the row, not zeroed.
    const [first, second] = replies.map((r) => r.payload as Record<string, unknown>)
    expect(first!.type).toBe('rfq_quote')
    expect(second!).toEqual(first!)
    // And only one swap exists.
    expect((await store.findRecoverable()).length).toBe(1)
  })

  it('refuses a same-invoice retry naming a DIFFERENT refund_address, never a stale re-emit', async () => {
    // The covenant pins its refund output to refund_address; re-emitting the
    // first attempt's quote to a retry naming a different one would silently
    // point that retry's eventual refund at somebody else's script.
    const otherRefundAddress = new CovenantSwapScript({
      receiver: keyBytes(5),
      server: keyBytes(3),
      preimageHash: new Uint8Array(20).fill(9),
      refundLocktime: 1_800_000_000,
      claimDelay: 4096,
      client: keyBytes(11),
      clientRefundDelay: 1024,
      refundWithoutServerDelay: 2048,
      nonInteractiveParameters: {
        emulatorPubkey: keyBytes(9),
        receiverPkScript: Uint8Array.from([0x51, 0x20, ...keyBytes(13)]),
        senderPkScript: Uint8Array.from([0x51, 0x20, ...keyBytes(6)]),
      },
    })
      .address('ark', keyBytes(3))
      .encode()
    await relay.sendRequest(CLIENT, rfqRequest())
    await relay.sendRequest(
      CLIENT,
      rfqRequest({
        profile: { invoice: INVOICE, refund_address: otherRefundAddress, client_refund_pubkey: CLIENT_REFUND_PUBKEY },
      }),
    )

    const last = relay.repliesTo(CLIENT).at(-1)!.payload as Record<string, unknown>
    expect(last).toEqual({ v: 1, type: 'rfq_refusal', rfq_id: RFQ_ID, reason: 'quote_conflict' })
  })

  it('refuses, never re-emits, once the swap has left the quoted state', async () => {
    // A fundable-looking payload for a funded/paying/terminal swap would invite
    // the client to fund a script nothing will drive.
    await relay.sendRequest(CLIENT, rfqRequest())
    const row = (await store.findByPaymentHash(PAYMENT_HASH))!
    await store.transition(row.id, 'quoted', 'funded', { lockup_value: 2100 })

    await relay.sendRequest(CLIENT, rfqRequest())
    const last = relay.repliesTo(CLIENT).at(-1)!.payload as Record<string, unknown>
    expect(last).toEqual({ v: 1, type: 'rfq_refusal', rfq_id: RFQ_ID, reason: 'quote_conflict' })
  })

  it('refuses a malformed rfq_request instead of dropping it silently', async () => {
    // An event that claims our type but fails the schema (here an extra field
    // trips strict) gets a refusal so the client is not left waiting out its
    // timeout.
    await relay.sendRequest(CLIENT, rfqRequest({ extra: 'x' }))
    const reply = relay.repliesTo(CLIENT).at(-1)!.payload as Record<string, unknown>
    expect(reply).toEqual({ v: 1, type: 'rfq_refusal', rfq_id: RFQ_ID, reason: 'unsupported_payload' })
  })

  it('still ignores events that are not our request type', async () => {
    await relay.publish({
      id: 'x',
      author: CLIENT,
      recipient: PROVIDER,
      createdAtMs: Date.now(),
      payload: { v: 1, type: 'ln_receive_request' },
    })
    expect(relay.repliesTo(CLIENT)).toHaveLength(0)
  })

  it('quotes a FRESH swap when the prior one was refused', async () => {
    // A refused swap never moved money; the still-valid invoice is re-quotable
    // and the client gets a new, live quote rather than a dead re-emit.
    await relay.sendRequest(CLIENT, rfqRequest())
    const first = (await store.findByPaymentHash(PAYMENT_HASH))!
    await store.fail(first.id, 'quoted', 'lockup timeout')

    await relay.sendRequest(CLIENT, rfqRequest())
    const last = relay.repliesTo(CLIENT).at(-1)!.payload as Record<string, unknown>
    expect(last.type).toBe('rfq_quote')
    // A NEW live row: the refused one is terminal, so exactly one recoverable
    // row exists and it is not the first swap.
    const recoverable = await store.findRecoverable()
    expect(recoverable).toHaveLength(1)
    expect(recoverable[0]!.id).not.toBe(first.id)
  })

  it('ignores events that are not requests — its own replies echoed back, other types', async () => {
    // A reply the provider itself published, redelivered by a chatty relay.
    await relay.publish({
      id: 'echo',
      author: PROVIDER,
      recipient: PROVIDER,
      createdAtMs: Date.now(),
      payload: { v: 1, type: 'rfq_quote' },
    })
    await relay.publish({
      id: 'other',
      author: CLIENT,
      recipient: PROVIDER,
      createdAtMs: Date.now(),
      payload: { v: 1, type: 'ln_receive_request' },
    })
    // Neither produced a reply, and no swap was created.
    expect(relay.repliesTo(CLIENT)).toHaveLength(0)
    expect((await store.findRecoverable()).length).toBe(0)
  })

  it('never lets one bad request stop the loop', async () => {
    await relay.sendRequest(
      CLIENT,
      rfqRequest({
        profile: { invoice: 'lnbc1nope', refund_address: REFUND_ADDRESS, client_refund_pubkey: CLIENT_REFUND_PUBKEY },
      }),
    )
    await relay.sendRequest(CLIENT, rfqRequest())
    const types = relay.repliesTo(CLIENT).map((r) => (r.payload as Record<string, unknown>).type)
    expect(types).toEqual(['rfq_refusal', 'rfq_quote'])
  })

  it('answers rfq_status_request from the row, and refuses an unknown rfq_id', async () => {
    await relay.sendRequest(CLIENT, rfqRequest())
    await relay.sendRequest(CLIENT, { v: 1, type: 'rfq_status_request', rfq_id: RFQ_ID })
    const status = relay.repliesTo(CLIENT).at(-1)!.payload as Record<string, unknown>
    expect(status.type).toBe('rfq_status')
    expect(status.state).toBe('quoted')

    await relay.sendRequest(CLIENT, { v: 1, type: 'rfq_status_request', rfq_id: 'd4'.repeat(32) })
    const unknown = relay.repliesTo(CLIENT).at(-1)!.payload as Record<string, unknown>
    expect(unknown.type).toBe('rfq_refusal')
    expect(unknown.reason).toBe('unsupported_payload')
  })

  /**
   * Status is read-only, so a receive corridor answers from its STORE alone —
   * no service, which is also what a corridor switched off after quoting looks
   * like. Before the receive stores were wired in, this answered rfq_refusal.
   */
  it('answers rfq_status_request for a receive swap the send stores know nothing about', async () => {
    // Its own relay, same reason the dark-corridor test above uses one.
    const receiveRelay = new FakeRelay()
    const receiveStore = await ReceiveSwapStore.open(':memory:', () => clock)
    const withReceive = relayIngressFrom({
      connection: receiveRelay,
      store,
      onchainStore,
      receiveStore,
      providerPubkey: PROVIDER,
      now: () => clock * 1000,
    })
    await withReceive.start()
    try {
      const rfqId = 'e5'.repeat(32)
      await receiveStore.insertQuote({ ...receiveQuote, rfqId })
      await receiveRelay.sendRequest(CLIENT, { v: 1, type: 'rfq_status_request', rfq_id: rfqId })
      const status = receiveRelay.repliesTo(CLIENT).at(-1)!.payload as Record<string, unknown>
      expect(status.type).toBe('rfq_status')
      expect(status.state).toBe('quoted')
      expect((status.profile as Record<string, unknown>).lockup_address).toBe(receiveQuote.lockupAddress)
    } finally {
      await withReceive.stop()
      await receiveStore.close()
    }
  })
})

describe('relay frame codec', () => {
  it('round-trips every frame kind', () => {
    const event: RelayEvent = { id: 'a', author: PROVIDER, recipient: CLIENT, createdAtMs: 5, payload: { v: 1 } }
    for (const frame of [
      { op: 'sub' as const, id: 's1', filter: { recipient: PROVIDER } },
      { op: 'unsub' as const, id: 's1' },
      { op: 'event' as const, event },
    ]) {
      expect(decodeFrame(encodeFrame(frame))).toEqual(frame)
    }
  })

  it('rejects a malformed event frame rather than passing a half-event upward', () => {
    expect(() => decodeFrame(JSON.stringify({ op: 'event', event: { author: 'x' } }))).toThrow(/malformed/)
    expect(() => decodeFrame(JSON.stringify({ op: 'nonsense' }))).toThrow(/unknown/)
  })

  it('filters by recipient and since', () => {
    const e: RelayEvent = { id: 'a', author: CLIENT, recipient: PROVIDER, createdAtMs: 100, payload: {} }
    expect(matchesFilter(e, { recipient: PROVIDER })).toBe(true)
    expect(matchesFilter(e, { recipient: CLIENT })).toBe(false)
    expect(matchesFilter(e, { sinceMs: 50 })).toBe(true)
    expect(matchesFilter(e, { sinceMs: 200 })).toBe(false)
  })

  it('filters by topic exactly, and a directed event never matches a topic subscription', () => {
    const e: RelayEvent = { id: 'a', author: CLIENT, topic: 'arkade:btc/lightning:btc', createdAtMs: 100, payload: {} }
    expect(matchesFilter(e, { topic: 'arkade:btc/lightning:btc' })).toBe(true)
    expect(matchesFilter(e, { topic: 'arkade:btc/arkade:usdt' })).toBe(false)
    expect(matchesFilter({ ...e, topic: undefined }, { topic: 'arkade:btc/lightning:btc' })).toBe(false)
  })

  it('mints unique ids for same-ms, same-shape payloads (a relay dedups by id)', () => {
    // Two refusals in the same millisecond serialise to equal length; length
    // alone collided, so a deduping relay dropped one client's reply.
    const a = eventId(PROVIDER, { v: 1, type: 'rfq_refusal', reason: 'quote_conflict' }, 1000)
    const b = eventId(PROVIDER, { v: 1, type: 'rfq_refusal', reason: 'quote_conflict' }, 1000)
    expect(a).not.toBe(b)
  })
})

describe('OpenRfqBidder (§ 4.6)', () => {
  const MARKET_KEY = 'arkade:btc/lightning:btc'
  const OPEN_ID = 'ab'.repeat(32)
  const open = (over: Record<string, unknown> = {}) => ({
    v: 1,
    type: 'rfq_open',
    open_id: OPEN_ID,
    pair: RFQ_PAIR_SEND,
    amount_side: 'to',
    amount: 5000,
    ...over,
  })
  const broadcast = async (payload: unknown) =>
    relay.publish({
      id: `b${relay.published.length}`,
      author: CLIENT,
      topic: MARKET_KEY,
      createdAtMs: clock * 1000,
      payload,
    })

  // No SendSwapService, no SwapStore: bidding touches no swap state.
  let bidder: OpenRfqBidder | undefined
  const startBidding = async (
    maxBidsPerMinute: number,
    fee?: { bps: number; flatSats: number },
    bidding?: BiddingStrategy,
  ): Promise<void> => {
    bidder = new OpenRfqBidder({
      bidding,
      connection: relay,
      providerPubkey: PROVIDER,
      pair: RFQ_PAIR_SEND,
      limits: { minSats: 500, maxSats: 10_000 },
      fee,
      maxBidsPerMinute,
      now: () => clock * 1000,
    })
    await bidder.start()
  }
  afterEach(async () => {
    await bidder?.stop()
    bidder = undefined
  })

  it('publishes a bid to the broadcast author, with the configured terms', async () => {
    await startBidding(30)
    await broadcast(open())
    const replies = relay.repliesTo(CLIENT)
    expect(replies).toHaveLength(1)
    expect(replies[0]!.payload).toEqual({
      v: 1,
      type: 'rfq_bid',
      open_id: OPEN_ID,
      pair: RFQ_PAIR_SEND,
      fee_bps: 0,
      min: 500,
      max: 10_000,
      valid_until: clock + BID_VALIDITY,
    })
    // A broadcast creates no solver state (§ 4.6).
    expect((await store.findRecoverable()).length).toBe(0)
  })

  it('bids when the corridor charges a flat fee, carrying both price components', async () => {
    // The guard this replaces was silent: setting LN_SEND_FEE_FLAT_SATS simply
    // stopped the corridor bidding, with nothing in the logs to say so.
    await startBidding(30, { bps: 25, flatSats: 50 })
    await broadcast(open())
    const replies = relay.repliesTo(CLIENT)
    expect(replies).toHaveLength(1)
    expect(replies[0]!.payload).toMatchObject({ fee_bps: 25, fee_flat: 50 })
  })

  it('serves, validates and bids on the INJECTED pair, not a hardcoded one', async () => {
    // A second bidder for a different market must subscribe to that market's
    // topic and stamp that pair on its bids. Pins the pair as a real
    // parameter: hardcoding any of the three sites again fails here.
    const other = 'arkade:BTC->arkade:USDT'
    bidder = new OpenRfqBidder({
      connection: relay,
      providerPubkey: PROVIDER,
      pair: other,
      limits: { minSats: 500, maxSats: 10_000 },
      maxBidsPerMinute: 30,
      now: () => clock * 1000,
    })
    await bidder.start()

    // An open on the send pair is now UNSERVED by this bidder...
    await broadcast(open())
    expect(relay.repliesTo(CLIENT)).toHaveLength(0)

    // ...and one on its own market, arriving on that market's topic, is bid on.
    await relay.publish({
      id: 'b-other',
      author: CLIENT,
      topic: marketKeyForPair(other),
      createdAtMs: clock * 1000,
      payload: open({ pair: other }),
    })
    const bid = relay.repliesTo(CLIENT).at(-1)!.payload as Record<string, unknown>
    expect(bid.type).toBe('rfq_bid')
    expect(bid.pair).toBe(other)
  })

  it('is silent — never a refusal — on malformed, unserved and out-of-range opens', async () => {
    await startBidding(30)
    await broadcast(open({ surprise: true })) // unknown field
    await broadcast(open({ pair: 'lightning:BTC->arkade:BTC' })) // receive leg is not served
    await broadcast(open({ amount: 100 })) // below the floor
    await broadcast(open({ bids_until: clock - 1 })) // window already lapsed
    expect(relay.repliesTo(CLIENT)).toHaveLength(0)
  })

  it('stops bidding at the rate cap', async () => {
    await startBidding(2)
    for (const fill of ['aa', 'bb', 'cc']) await broadcast(open({ open_id: fill.repeat(32) }))
    expect(relay.repliesTo(CLIENT)).toHaveLength(2)
  })

  it('without a bidder, broadcasts get silence — the directed ingress never answers them', async () => {
    await broadcast(open())
    expect(relay.repliesTo(CLIENT)).toHaveLength(0)
  })

  it('leaves the directed path untouched while bidding', async () => {
    await startBidding(30)
    await broadcast(open())
    await relay.sendRequest(CLIENT, {
      v: 1,
      type: 'rfq_request',
      rfq_id: 'c3'.repeat(32),
      pair: 'arkade:BTC->lightning:BTC',
      amount_side: 'to',
      profile: { invoice: INVOICE, refund_address: REFUND_ADDRESS, client_refund_pubkey: CLIENT_REFUND_PUBKEY },
    })
    const types = relay.repliesTo(CLIENT).map((r) => (r.payload as Record<string, unknown>).type)
    expect(types).toEqual(['rfq_bid', 'rfq_quote'])
  })

  /**
   * Bidding is where a solver competes, so it is the knob most likely to be
   * replaced — and the two rules around it are the ones a replacement is most
   * likely to break, because neither is expressible in the return type.
   */
  describe('a custom BiddingStrategy', () => {
    it('bids on terms the default would never produce', async () => {
      const undercut: BiddingStrategy = {
        decide: () => ({ kind: 'bid', fee_bps: 1, fee_flat: 0, min: 1, max: 1_000_000, valid_until: 9_999_999 }),
      }
      await startBidding(30, undefined, undercut)
      await broadcast(open())
      const replies = relay.repliesTo(CLIENT)
      expect(replies).toHaveLength(1)
      expect(replies[0]!.payload).toMatchObject({ fee_bps: 1, min: 1, max: 1_000_000 })
    })

    /**
     * § 4.6 inverts § 4's refusal rule: an open this solver cannot serve is
     * answered with SILENCE. `skip` is the only way to decline, and the host —
     * not the strategy — is what turns it into saying nothing.
     */
    it('says NOTHING when it skips, rather than publishing a refusal', async () => {
      const never: BiddingStrategy = { decide: () => ({ kind: 'skip', why: 'not today' }) }
      await startBidding(30, undefined, never)
      await broadcast(open())
      expect(relay.repliesTo(CLIENT)).toHaveLength(0)
    })

    /**
     * The rate limit is the OPERATOR's budget, not the strategy's. A strategy
     * that wants to bid on everything does not get to outspend it.
     */
    it('cannot bid past maxBidsPerMinute however eager it is', async () => {
      const always: BiddingStrategy = {
        decide: () => ({ kind: 'bid', fee_bps: 1, fee_flat: 0, min: 1, max: 1_000_000, valid_until: 9_999_999 }),
      }
      await startBidding(1, undefined, always)
      await broadcast(open())
      await broadcast(open({ open_id: 'cd'.repeat(32) }))
      expect(relay.repliesTo(CLIENT)).toHaveLength(1)
    })
  })
})
