/**
 * The API contract, pinned.
 *
 * Every payload the HTTP surface can produce is asserted here by EXACT key set
 * and type — not by "contains the fields I remembered". These payloads are the
 * message-bus payloads byte for byte, so any diff in this file is a protocol
 * change and must be treated as one: version it, don't slip it.
 *
 * This file pins the per-STATE status shape: `rfq_status` must have one
 * schema in every lifecycle state, so a client can be written against it
 * without per-state casing. The quote and refusal pins live in rfq.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { SendSwapService, type ArkadeOps } from '@arkade-os/solver-corridors/send/orchestrator.js'
import { OnchainSendSwapService } from '@arkade-os/solver-corridors/send/onchainOrchestrator.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { SwapStore } from '@arkade-os/solver-corridors/db/swaps.js'
import { OnchainSendSwapStore } from '@arkade-os/solver-corridors/db/onchainSwaps.js'
import { ReceiveSwapStore } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import { FakeOnchainBackend } from '@arkade-os/solver-rails-fake/onchain/fake/backend.js'
import type { RfqState } from '@arkade-os/solver-corridors/wire/payloads.js'
import { ROUTE_CLTV_BUDGET_BLOCKS } from '@arkade-os/solver-core/core/send.js'
import { buildAppFrom } from '../support/transportFrom.js'

/** Enough of a lightning-receive quote to persist one; the corridor's own logic lives in its orchestrator tests. */
const receiveQuote = {
  id: 'receive-1',
  paymentHash: 'cc'.repeat(32),
  amountSats: 5_000,
  payoutSats: 4_950,
  invoice: 'lnbcrt50000n1...',
  invoiceExpiresAt: 1_734_607_455,
  payoutAddress: 'tark1payoutexample',
  payoutPkScript: '11'.repeat(34),
  payoutPubkey: '22'.repeat(32),
  claimPacket: 'ZWFsZWQtY2lwaGVydGV4dA==',
  refundLocktime: 1_734_613_955,
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

const INVOICE =
  'lnbc21u1pnk8larsp526g88ejh9ac0es9j6juxwenzdzvs6hcrphna5pp3jefpukmtk3hqpp5m206npk0fr6k45u8f90capqw48k3pzymlqhk0j98kyx4mz383pkqdz9235x2gr3w45kx6eqvfex7amwypnx77pqdf6k6urnyphhvetjyp6xsefqd3sh57fqv3hkwxqyp2xqcqz95rzjqv9ruzr6quwpsuwmyshlvenk0xm7djrtt8ugt2ja6cx3dkqtccdgvzzxeyqq28qqqqqqqqqqqqqqq9gq2y9qyysgqvu5k5w9q0xe62envhds058r9h8v5uak09hn3uzlw39sqkcuwh34j44gc53j6x6sg0u6yf6l0durxqqekytupxpf66zc7rc9cpav72ssqpcgv3p'
const PAYMENT_HASH = 'da9fa986cf48f56ad387495f8e840ea9ed10889bf82f67c8a7b10d5d8a27886c'
const INVOICE_TIMESTAMP = 1_734_606_755
const RFQ_ID = 'a1'.repeat(32)

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

const quoteViaHttp = async () => {
  const res = await app.request('/v1/swap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      v: 1,
      type: 'rfq_request',
      rfq_id: RFQ_ID,
      pair: 'arkade:BTC->lightning:BTC',
      amount_side: 'to',
      profile: { invoice: INVOICE, refund_address: REFUND_ADDRESS, client_refund_pubkey: key(20) },
    }),
  })
  if (res.status !== 201) throw new Error(`fixture quote failed: ${res.status}`)
}

/** { key: typeof value } shape signature, with null kept distinct. */
const shapeOf = (payload: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(payload)
      .map(([k, v]) => [k, v === null ? 'null' : typeof v])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  )

describe('contract: rfq_status', () => {
  /**
   * One shape in every state, so a client can be written against a single
   * schema: the profile's nullable fields are always present as null, and
   * `preimage` appears in exactly one state.
   */
  const BASE_PROFILE_SHAPE = {
    claim_txid: 'null',
    failure_reason: 'null',
    lockup_address: 'string',
    payment_hash: 'string',
    receiver_pk_script: 'string',
    refund_txid: 'null',
  }

  /** Drive the store row into each RFQ-observable state. */
  const drive: Record<string, () => Promise<void>> = {
    refused: async () => {
      const row = (await store.findByPaymentHash(PAYMENT_HASH))!
      await store.fail(row.id, 'quoted', 'test refusal')
    },
    quoted: async () => {},
    expired: async () => {
      const row = (await store.findByPaymentHash(PAYMENT_HASH))!
      await store.fail(row.id, 'quoted', 'lockup timeout')
    },
    funded: async () => {
      const row = (await store.findByPaymentHash(PAYMENT_HASH))!
      await store.transition(row.id, 'quoted', 'funded', { lockup_value: 2100 })
    },
    filling: async () => {
      await drive.funded!()
      const row = (await store.findByPaymentHash(PAYMENT_HASH))!
      await store.transition(row.id, 'funded', 'paying', { idempotency_key: 'k' })
    },
    filled: async () => {
      await drive.filling!()
      const row = (await store.findByPaymentHash(PAYMENT_HASH))!
      await store.transition(row.id, 'paying', 'paid', { payment_id: 'p' })
    },
    settled: async () => {
      await drive.filled!()
      const row = (await store.findByPaymentHash(PAYMENT_HASH))!
      await store.transition(row.id, 'paid', 'claiming', { preimage: 'aa'.repeat(32) })
      await store.transition(row.id, 'claiming', 'claimed', { claim_ark_txid: 'c' })
    },
    refunded: async () => {
      const row = (await store.findByPaymentHash(PAYMENT_HASH))!
      await store.fail(row.id, 'quoted', 'lockup timeout with partial 100 sats')
      await store.patch(row.id, { refund_outcome: 'pushed', refund_ark_txid: 'r' })
    },
    stuck: async () => {
      await drive.filling!()
      const row = (await store.findByPaymentHash(PAYMENT_HASH))!
      await store.fail(row.id, 'paying', 'test stuck')
    },
  }

  it.each(Object.keys(drive))('shape in state %s', async (state) => {
    await quoteViaHttp()
    await drive[state]!()
    const res = await app.request(`/v1/rfq/${RFQ_ID}`)
    expect(res.status).toBe(200)
    const payload = (await res.json()) as Record<string, unknown>
    expect(payload.state).toBe(state as RfqState)
    expect(shapeOf(payload)).toEqual({
      profile: 'object',
      rfq_id: 'string',
      state: 'string',
      type: 'string',
      updated_at: 'number',
      v: 'number',
    })

    const expectedProfile: Record<string, string> = { ...BASE_PROFILE_SHAPE }
    if (state === 'settled') {
      expectedProfile.claim_txid = 'string'
      expectedProfile.preimage = 'string'
    }
    if (state === 'refunded') expectedProfile.refund_txid = 'string'
    if (state === 'refused' || state === 'stuck' || state === 'expired' || state === 'refunded') {
      expectedProfile.failure_reason = 'string'
    }
    expect(shapeOf(payload.profile as Record<string, unknown>)).toEqual(expectedProfile)
  })

  it('not_found payload shape', async () => {
    const res = await app.request(`/v1/rfq/${'e'.repeat(64)}`)
    expect(res.status).toBe(404)
    expect(shapeOf((await res.json()) as Record<string, unknown>)).toEqual({ type: 'string', v: 'number' })
  })
})

/**
 * The same per-state pin for `lightning:BTC->arkade:BTC`. Driven through the
 * store rather than the orchestrator: this route is read-only, and what is
 * pinned here is the WIRE shape, not how a row reaches a state.
 *
 * The row states do not map onto the RFQ states one-for-one on this leg — the
 * roles are inverted, so `armed` reports as funded and `funded` as filling
 * (lightningReceiveRfqStateFromRow). That inversion is the reason to pin it:
 * a client reads the RFQ vocabulary and never sees the row state.
 */
describe('contract: rfq_status, lightning receive', () => {
  const RECEIVE_RFQ_ID = 'c3'.repeat(32)
  const PROFILE_SHAPE = {
    failure_reason: 'null',
    lockup_address: 'string',
    payment_hash: 'string',
    refund_txid: 'null',
  }

  let receiveStore: ReceiveSwapStore
  let receiveApp: ReturnType<typeof buildAppFrom>

  beforeEach(async () => {
    receiveStore = await ReceiveSwapStore.open(':memory:', () => clock)
    receiveApp = buildAppFrom({ store, onchainStore, receiveStore, network: 'bitcoin' })
  })
  afterEach(async () => {
    await receiveStore.close()
  })

  const row = async () => (await receiveStore.findByRfqId(RECEIVE_RFQ_ID))!

  /** rfq state -> the row transitions that reach it. */
  const drive: Record<string, () => Promise<void>> = {
    quoted: async () => {},
    funded: async () => {
      await receiveStore.transition((await row()).id, 'quoted', 'armed', { htlc_expires_at: clock + 5400 })
    },
    filling: async () => {
      await drive.funded!()
      await receiveStore.transition((await row()).id, 'armed', 'funded', { arkade_lockup_txid: 'l' })
    },
    filled: async () => {
      await drive.filling!()
      await receiveStore.transition((await row()).id, 'funded', 'claimed', { preimage: 'aa'.repeat(32) })
    },
    settled: async () => {
      await drive.filled!()
      await receiveStore.transition((await row()).id, 'claimed', 'settled', {})
    },
    refunded: async () => {
      await drive.filling!()
      await receiveStore.transition((await row()).id, 'funded', 'refunding', {})
      await receiveStore.transition((await row()).id, 'refunding', 'refunded', { refund_ark_txid: 'r' })
    },
    stuck: async () => {
      await drive.filling!()
      await receiveStore.fail((await row()).id, 'funded', 'test stuck')
    },
    refused: async () => {
      await receiveStore.fail((await row()).id, 'quoted', 'test refusal')
    },
    expired: async () => {
      await receiveStore.fail((await row()).id, 'quoted', 'invoice expired')
    },
  }

  it.each(Object.keys(drive))('shape in state %s', async (state) => {
    await receiveStore.insertQuote({ ...receiveQuote, rfqId: RECEIVE_RFQ_ID })
    await drive[state]!()

    const res = await receiveApp.request(`/v1/rfq/${RECEIVE_RFQ_ID}`)
    expect(res.status).toBe(200)
    const payload = (await res.json()) as Record<string, unknown>
    expect(payload.state).toBe(state as RfqState)
    expect(shapeOf(payload)).toEqual({
      profile: 'object',
      rfq_id: 'string',
      state: 'string',
      type: 'string',
      updated_at: 'number',
      v: 'number',
    })

    const expectedProfile: Record<string, string> = { ...PROFILE_SHAPE }
    if (state === 'settled') expectedProfile.preimage = 'string'
    if (state === 'refunded') expectedProfile.refund_txid = 'string'
    if (state === 'refused' || state === 'stuck' || state === 'expired') expectedProfile.failure_reason = 'string'
    expect(shapeOf(payload.profile as Record<string, unknown>)).toEqual(expectedProfile)
  })
})
