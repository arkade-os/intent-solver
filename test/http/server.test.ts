import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { SendSwapService, type ArkadeOps } from '@arkade-os/solver-corridors/send/orchestrator.js'
import { OnchainSendSwapService } from '@arkade-os/solver-corridors/send/onchainOrchestrator.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { SwapStore } from '@arkade-os/solver-corridors/db/swaps.js'
import { OnchainSendSwapStore } from '@arkade-os/solver-corridors/db/onchainSwaps.js'
import { FakeOnchainBackend } from '@arkade-os/solver-rails-fake/onchain/fake/backend.js'
import { ROUTE_CLTV_BUDGET_BLOCKS } from '@arkade-os/solver-core/core/send.js'
import { buildAppFrom } from '../support/transportFrom.js'

/** Same mainnet fixture as the orchestrator tests: 2100 sats, cltv 180. */
const INVOICE =
  'lnbc21u1pnk8larsp526g88ejh9ac0es9j6juxwenzdzvs6hcrphna5pp3jefpukmtk3hqpp5m206npk0fr6k45u8f90capqw48k3pzymlqhk0j98kyx4mz383pkqdz9235x2gr3w45kx6eqvfex7amwypnx77pqdf6k6urnyphhvetjyp6xsefqd3sh57fqv3hkwxqyp2xqcqz95rzjqv9ruzr6quwpsuwmyshlvenk0xm7djrtt8ugt2ja6cx3dkqtccdgvzzxeyqq28qqqqqqqqqqqqqqq9gq2y9qyysgqvu5k5w9q0xe62envhds058r9h8v5uak09hn3uzlw39sqkcuwh34j44gc53j6x6sg0u6yf6l0durxqqekytupxpf66zc7rc9cpav72ssqpcgv3p'
const PAYMENT_HASH = 'da9fa986cf48f56ad387495f8e840ea9ed10889bf82f67c8a7b10d5d8a27886c'
const INVOICE_TIMESTAMP = 1_734_606_755

const keyBytes = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
const key = (fill: number): string => hex.encode(keyBytes(fill))

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

const RFQ_ID = 'a1'.repeat(32)

const rfqRequest = (over: Record<string, unknown> = {}) => ({
  v: 1,
  type: 'rfq_request',
  rfq_id: RFQ_ID,
  pair: 'arkade:BTC->lightning:BTC',
  amount_side: 'to',
  profile: { invoice: INVOICE, refund_address: REFUND_ADDRESS, client_refund_pubkey: key(20) },
  ...over,
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

let clock: number
let store: SwapStore
let onchainStore: OnchainSendSwapStore
let service: SendSwapService
let app: ReturnType<typeof buildAppFrom>

beforeEach(async () => {
  clock = INVOICE_TIMESTAMP + 100
  store = await SwapStore.open(':memory:', () => clock)
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
  // same minimal-but-real pattern as the Lightning leg above, just enough to
  // satisfy buildApp's HttpDeps.
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
const get = (path: string) => app.request(path)

describe('POST /v1/swap', () => {
  it('rejects anything that is not an rfq_request', async () => {
    for (const bad of [
      {},
      { nope: true },
      { v: 2, type: 'rfq_request' },
      // The removed pre-RFQ shape is just another unsupported payload now.
      { v: 1, type: 'ln_send_request', invoice: INVOICE, refund_address: REFUND_ADDRESS },
    ]) {
      const res = await post(bad)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ type: 'rfq_refusal', reason: 'unsupported_payload' })
    }
  })

  it('serves an rfq_request through the shared handler', async () => {
    const res = await post(rfqRequest())
    expect(res.status).toBe(201)
    const quote = (await res.json()) as Record<string, unknown>
    expect(quote.type).toBe('rfq_quote')
    expect(quote.payment_hash).toBeUndefined() // the hash lives in profile
    expect((quote.profile as Record<string, unknown>).payment_hash).toBe(PAYMENT_HASH)
  })
})

describe('GET /v1/swap/:paymentHash — the removed status endpoint', () => {
  it('is gone: status is by rfq_id only, at /v1/rfq/:rfqId', async () => {
    expect((await get(`/v1/swap/${PAYMENT_HASH}`)).status).toBe(404)
  })
})

describe('a deployment with the Lightning-send corridor disabled', () => {
  // The service is simply absent from HttpDeps — the shape createServices
  // produces when LN_SEND_ENABLED=false. The refusal must name the pair, not
  // fail as an unparseable payload (a 500 would be strictly worse).
  const dark = () => buildAppFrom({ store, onchainStore, network: 'bitcoin' })

  it('refuses an rfq_request on the send pair as unsupported_pair', async () => {
    const res = await dark().request('/v1/swap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rfqRequest()),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ type: 'rfq_refusal', reason: 'unsupported_pair' })
  })

  it('still answers rfq status lookups — rows outlive the corridor that wrote them', async () => {
    const res = await dark().request(`/v1/rfq/${'e'.repeat(64)}`)
    expect(res.status).toBe(404)
  })
})

describe('healthz', () => {
  it('answers without touching any dependency', async () => {
    const res = await get('/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, network: 'bitcoin' })
  })
})
