/**
 * The RFQ family over HTTP, and its contract pinned by exact shape.
 *
 * Same discipline as contract.test.ts: these payloads are the protocol
 * (docs/rfq-protocol.md); a diff here is a protocol change and must be
 * versioned, not slipped.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { SendSwapService, type ArkadeOps } from '@arkade-os/solver-corridors/send/orchestrator.js'
import { OnchainSendSwapService } from '@arkade-os/solver-corridors/send/onchainOrchestrator.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { SwapStore } from '@arkade-os/solver-corridors/db/swaps.js'
import { QUOTE_RATE_LIMIT } from '@arkade-os/solver-core/core/rateLimit.js'
import { OnchainSendSwapStore } from '@arkade-os/solver-corridors/db/onchainSwaps.js'
import { ReceiveSwapStore } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import { FakeOnchainBackend } from '@arkade-os/solver-rails-fake/onchain/fake/backend.js'
import { forgeInvoice } from '@arkade-os/solver-rails-fake/ln/fake/bolt11.js'
import { ROUTE_CLTV_BUDGET_BLOCKS } from '@arkade-os/solver-core/core/send.js'
import { buildAppFrom } from '../support/transportFrom.js'

const INVOICE =
  'lnbc21u1pnk8larsp526g88ejh9ac0es9j6juxwenzdzvs6hcrphna5pp3jefpukmtk3hqpp5m206npk0fr6k45u8f90capqw48k3pzymlqhk0j98kyx4mz383pkqdz9235x2gr3w45kx6eqvfex7amwypnx77pqdf6k6urnyphhvetjyp6xsefqd3sh57fqv3hkwxqyp2xqcqz95rzjqv9ruzr6quwpsuwmyshlvenk0xm7djrtt8ugt2ja6cx3dkqtccdgvzzxeyqq28qqqqqqqqqqqqqqq9gq2y9qyysgqvu5k5w9q0xe62envhds058r9h8v5uak09hn3uzlw39sqkcuwh34j44gc53j6x6sg0u6yf6l0durxqqekytupxpf66zc7rc9cpav72ssqpcgv3p'
const PAYMENT_HASH = 'da9fa986cf48f56ad387495f8e840ea9ed10889bf82f67c8a7b10d5d8a27886c'
const INVOICE_TIMESTAMP = 1_734_606_755

const RFQ_ID = 'a1'.repeat(32)
const OTHER_RFQ_ID = 'b2'.repeat(32)
const PAIR = 'arkade:BTC->lightning:BTC'

const keyBytes = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
const key = (fill: number): string => hex.encode(keyBytes(fill))

const CLIENT_REFUND_PUBKEY = key(20)

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

/** A second, distinct mainnet invoice — a different payment hash for conflicts. */
const SECOND_INVOICE = forgeInvoice({
  network: 'bc',
  amountSats: 2_100,
  paymentHash: sha256(new Uint8Array(32).fill(7)),
  timestamp: INVOICE_TIMESTAMP,
  expirySeconds: 86_400,
})

const arkade: ArkadeOps = {
  providerPubkey: key(1),
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
let app: ReturnType<typeof buildAppFrom>

beforeEach(async () => {
  clock = INVOICE_TIMESTAMP + 100
  store = await SwapStore.open(':memory:', () => clock)
  const service = new SendSwapService({
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
  // just enough to satisfy buildApp's HttpDeps.
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
  app = buildAppFrom({ service, store, onchainService, onchainStore, network: 'bitcoin' })
})
afterEach(async () => {
  await store.close()
  await onchainStore.close()
})

const post = (payload: unknown) =>
  app.request('/v1/swap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

const rfqRequest = (over: Record<string, unknown> = {}) => ({
  v: 1,
  type: 'rfq_request',
  rfq_id: RFQ_ID,
  pair: PAIR,
  amount_side: 'to',
  profile: { invoice: INVOICE, refund_address: REFUND_ADDRESS, client_refund_pubkey: CLIENT_REFUND_PUBKEY },
  ...over,
})

const shapeOf = (payload: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(payload)
      .map(([k, v]) => [k, v === null ? 'null' : typeof v])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  )

describe('POST /v1/swap with rfq_request', () => {
  it('quotes: binding fields top-level, compare-only fields in profile, exact key set', async () => {
    const res = await post(rfqRequest())
    expect(res.status).toBe(201)
    const quote = (await res.json()) as Record<string, unknown>
    expect(quote.type).toBe('rfq_quote')
    expect(quote.rfq_id).toBe(RFQ_ID)
    expect(quote.pair).toBe(PAIR)
    expect(quote.from_amount).toBe(2100)
    expect(quote.to_amount).toBe(2100)
    expect(quote.solver_pubkey).toBe(key(1))
    expect(typeof quote.refund_locktime).toBe('number')
    expect(typeof quote.valid_until).toBe('number')
    const profile = quote.profile as Record<string, unknown>
    expect(profile.payment_hash).toBe(PAYMENT_HASH)
    expect(profile.lockup_address).toMatch(/^ark1/)
    // Pinned: any new field is a protocol change.
    expect(shapeOf(quote)).toEqual({
      from_amount: 'number',
      pair: 'string',
      profile: 'object',
      refund_locktime: 'number',
      rfq_id: 'string',
      solver_pubkey: 'string',
      to_amount: 'number',
      type: 'string',
      v: 'number',
      valid_until: 'number',
    })
    expect(shapeOf(profile)).toEqual({ lockup_address: 'string', payment_hash: 'string', receiver_pk_script: 'string' })
    // The row carries the correlation id.
    expect((await store.findByPaymentHash(PAYMENT_HASH))!.rfqId).toBe(RFQ_ID)
  })

  it('rejects unknown fields anywhere — envelope and profile — as unsupported_payload', async () => {
    for (const bad of [
      rfqRequest({ extra: true }),
      rfqRequest({ profile: { invoice: INVOICE, refund_address: REFUND_ADDRESS, extra: true } }),
      rfqRequest({ rfq_id: 'not-hex' }),
      rfqRequest({ v: 2 }),
    ]) {
      const res = await post(bad)
      expect(res.status).toBe(400)
      const refusal = (await res.json()) as Record<string, unknown>
      expect(refusal.type).toBe('rfq_refusal')
      expect(refusal.reason).toBe('unsupported_payload')
    }
  })

  it('refuses a pair it does not serve with unsupported_pair', async () => {
    const res = await post(rfqRequest({ pair: 'lightning:BTC->arkade:BTC' }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as Record<string, unknown>).reason).toBe('unsupported_pair')
  })

  it('forces exact-out for the BOLT11 profile and cross-checks a supplied amount', async () => {
    const exactIn = await post(rfqRequest({ amount_side: 'from' }))
    expect(((await exactIn.json()) as Record<string, unknown>).reason).toBe('unsupported_payload')

    const mismatched = await post(rfqRequest({ amount: 2101 }))
    expect(((await mismatched.json()) as Record<string, unknown>).reason).toBe('unsupported_payload')

    const matched = await post(rfqRequest({ amount: 2100 }))
    expect(matched.status).toBe(201)
  })

  it('maps internal refusal reasons onto the closed RFQ set', async () => {
    // invoice_expires_too_soon → invoice_expired: jump the clock near expiry.
    clock = INVOICE_TIMESTAMP + 86_400 - 60
    const res = await post(rfqRequest())
    expect(res.status).toBe(422)
    expect(((await res.json()) as Record<string, unknown>).reason).toBe('invoice_expired')
  })

  it('re-emits the identical quote for a duplicate request — same rfq_id, same content', async () => {
    const first = (await (await post(rfqRequest())).json()) as Record<string, unknown>
    const again = await post(rfqRequest())
    expect(again.status).toBe(201)
    expect(await again.json()).toEqual(first)
  })

  it('refuses a same-invoice retry carrying a DIFFERENT client_refund_pubkey as quote_conflict, not a stale re-emit', async () => {
    // The reference trader library generates a fresh client_refund_pubkey per
    // attempt (examples/lib/swap-client.mjs) — this is the ordinary shape of
    // a retry, not a contrived one. Re-emitting the first attempt's quote here
    // would hand the second attempt a lockup_address baked around a covenant
    // key it never supplied and cannot spend from.
    await post(rfqRequest())
    const res = await post(
      rfqRequest({
        rfq_id: OTHER_RFQ_ID,
        profile: { invoice: INVOICE, refund_address: REFUND_ADDRESS, client_refund_pubkey: key(21) },
      }),
    )
    expect(res.status).toBe(422)
    expect(((await res.json()) as Record<string, unknown>).reason).toBe('quote_conflict')
  })

  // REMOVED with the base three-leaf script: this covered a live row quoted
  // WITHOUT a client refund pubkey, which `rfqQuotePayload` could not re-emit
  // because it omits `receiver_pk_script` for such a row. No code path can
  // create one any more — the RFQ schema requires the key and the CLI
  // self-tests now generate one — so the fixture is unconstructable and the
  // test could only be made to "pass" by giving the row a key, which is the
  // opposite of what it asserted.

  it('refuses an rfq_id reused with different content as quote_conflict', async () => {
    await post(rfqRequest())
    const res = await post(
      rfqRequest({
        profile: {
          invoice: SECOND_INVOICE,
          refund_address: REFUND_ADDRESS,
          client_refund_pubkey: CLIENT_REFUND_PUBKEY,
        },
      }),
    )
    expect(res.status).toBe(422)
    expect(((await res.json()) as Record<string, unknown>).reason).toBe('quote_conflict')
  })

  it('refuses a duplicate for a funded swap — never a fundable-looking payload for a driven script', async () => {
    await post(rfqRequest())
    const row = (await store.findByPaymentHash(PAYMENT_HASH))!
    await store.transition(row.id, 'quoted', 'funded', { lockup_value: 2100 })
    const res = await post(rfqRequest())
    expect(res.status).toBe(422)
    expect(((await res.json()) as Record<string, unknown>).reason).toBe('quote_conflict')
  })

  it('never leaks a non-spec reason string onto the RFQ wire', async () => {
    const res = await post(
      rfqRequest({
        profile: {
          invoice: 'lnbc1notvalid',
          refund_address: REFUND_ADDRESS,
          client_refund_pubkey: CLIENT_REFUND_PUBKEY,
        },
      }),
    )
    expect(res.status).toBe(400)
    // The decoder's own reason ('malformed') stays internal; RFQ closes over it.
    expect(((await res.json()) as Record<string, unknown>).reason).toBe('unsupported_payload')
  })
})

describe('GET /v1/rfq/:rfqId', () => {
  it('reports the RFQ state vocabulary with receipts only in settled', async () => {
    await post(rfqRequest())
    let status = (await (await app.request(`/v1/rfq/${RFQ_ID}`)).json()) as Record<string, unknown>
    expect(status.type).toBe('rfq_status')
    expect(status.state).toBe('quoted')
    expect(shapeOf(status)).toEqual({
      profile: 'object',
      rfq_id: 'string',
      state: 'string',
      type: 'string',
      updated_at: 'number',
      v: 'number',
    })

    const row = (await store.findByPaymentHash(PAYMENT_HASH))!
    await store.transition(row.id, 'quoted', 'funded', { lockup_value: 2100 })
    await store.transition(row.id, 'funded', 'paying', { idempotency_key: 'k' })
    status = (await (await app.request(`/v1/rfq/${RFQ_ID}`)).json()) as Record<string, unknown>
    expect(status.state).toBe('filling')
    expect((status.profile as Record<string, unknown>).preimage).toBeUndefined()

    await store.transition(row.id, 'paying', 'paid', { payment_id: 'p' })
    await store.transition(row.id, 'paid', 'claiming', { preimage: 'aa'.repeat(32) })
    status = (await (await app.request(`/v1/rfq/${RFQ_ID}`)).json()) as Record<string, unknown>
    expect(status.state).toBe('filled')
    expect((status.profile as Record<string, unknown>).preimage).toBeUndefined()

    await store.transition(row.id, 'claiming', 'claimed', { claim_ark_txid: 'c' })
    status = (await (await app.request(`/v1/rfq/${RFQ_ID}`)).json()) as Record<string, unknown>
    expect(status.state).toBe('settled')
    const profile = status.profile as Record<string, unknown>
    expect(profile.preimage).toBe('aa'.repeat(32))
    expect(profile.claim_txid).toBe('c')
  })

  it('refines refused into expired for a quote that timed out', async () => {
    await post(rfqRequest())
    const row = (await store.findByPaymentHash(PAYMENT_HASH))!
    await store.fail(row.id, 'quoted', 'lockup timeout')
    const status = (await (await app.request(`/v1/rfq/${RFQ_ID}`)).json()) as Record<string, unknown>
    expect(status.state).toBe('expired')
  })

  it('refines refused into refunded once a refund outcome is recorded', async () => {
    await post(rfqRequest())
    const row = (await store.findByPaymentHash(PAYMENT_HASH))!
    await store.fail(row.id, 'quoted', 'lockup timeout with partial 100 sats')
    await store.patch(row.id, { refund_outcome: 'pushed', refund_ark_txid: 'r' })
    const status = (await (await app.request(`/v1/rfq/${RFQ_ID}`)).json()) as Record<string, unknown>
    expect(status.state).toBe('refunded')
    expect((status.profile as Record<string, unknown>).refund_txid).toBe('r')
  })

  it('rejects a malformed id and 404s an unknown one', async () => {
    expect((await app.request('/v1/rfq/nope')).status).toBe(400)
    expect((await app.request(`/v1/rfq/${OTHER_RFQ_ID}`)).status).toBe(404)
  })

  /**
   * The route is read-only, so a receive corridor answers from its STORE alone
   * — no service, which is also what a deployment that has since switched the
   * corridor off looks like.
   */
  it('answers for a lightning receive swap the send stores know nothing about', async () => {
    const receiveStore = await ReceiveSwapStore.open(':memory:', () => clock)
    try {
      await receiveStore.insertQuote({ ...receiveQuote, rfqId: OTHER_RFQ_ID })
      const withReceive = buildAppFrom({ store, onchainStore, receiveStore, network: 'bitcoin' })
      const res = await withReceive.request(`/v1/rfq/${OTHER_RFQ_ID}`)
      expect(res.status).toBe(200)
      const status = (await res.json()) as Record<string, unknown>
      expect(status.type).toBe('rfq_status')
      expect(status.state).toBe('quoted')
      expect((status.profile as Record<string, unknown>).lockup_address).toBe(receiveQuote.lockupAddress)
    } finally {
      await receiveStore.close()
    }
  })

  it('404s the same id when the receive store is not wired in', async () => {
    expect((await app.request(`/v1/rfq/${OTHER_RFQ_ID}`)).status).toBe(404)
  })
})

describe('quote admission control', () => {
  it('meters per clientKey and emits rate_limited from the closed set once the quota is spent', async () => {
    const keyed = buildAppFrom({
      service: new SendSwapService({
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
      }),
      store,
      onchainStore,
      network: 'bitcoin',
      clientKey: () => 'ip:one-client',
    })
    // Distinct rfq_id AND payment hash per request — anything shared hits
    // quote_conflict before the quota is what answers. 500-sat invoices keep
    // the exposure cap from answering first either.
    const spamQuote = (n: number) =>
      keyed.request('/v1/swap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          rfqRequest({
            rfq_id: hex.encode(sha256(new Uint8Array(32).fill(0x40 + n))),
            profile: {
              invoice: forgeInvoice({
                network: 'bc',
                amountSats: 500,
                paymentHash: sha256(new Uint8Array(32).fill(n)),
                timestamp: INVOICE_TIMESTAMP,
                expirySeconds: 86_400,
              }),
              refund_address: REFUND_ADDRESS,
              client_refund_pubkey: CLIENT_REFUND_PUBKEY,
            },
          }),
        ),
      })

    for (let i = 1; i <= QUOTE_RATE_LIMIT; i++) {
      expect((await spamQuote(i)).status).toBe(201)
    }
    const refused = await spamQuote(QUOTE_RATE_LIMIT + 1)
    expect(refused.status).toBe(422)
    expect(((await refused.json()) as Record<string, unknown>).reason).toBe('rate_limited')
  })
})
