import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { buildWorker, makeWorkerEntry, type DriveJob, type QueueMessageLike } from '@arkade-os/solver-app/worker.js'
import { SendSwapService, type ArkadeOps } from '@arkade-os/solver-corridors/send/orchestrator.js'
import { OnchainSendSwapService } from '@arkade-os/solver-corridors/send/onchainOrchestrator.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { SwapStore } from '@arkade-os/solver-corridors/db/swaps.js'
import { OnchainSendSwapStore } from '@arkade-os/solver-corridors/db/onchainSwaps.js'
import { FakeOnchainBackend } from '@arkade-os/solver-rails-fake/onchain/fake/backend.js'
import type { FundedOutput } from '@arkade-os/solver-arkade/arkade/wallet.js'
import type { OnchainSendBackend } from '@arkade-os/solver-core/ports/onchain.js'
import { ROUTE_CLTV_BUDGET_BLOCKS } from '@arkade-os/solver-core/core/send.js'

const INVOICE =
  'lnbc21u1pnk8larsp526g88ejh9ac0es9j6juxwenzdzvs6hcrphna5pp3jefpukmtk3hqpp5m206npk0fr6k45u8f90capqw48k3pzymlqhk0j98kyx4mz383pkqdz9235x2gr3w45kx6eqvfex7amwypnx77pqdf6k6urnyphhvetjyp6xsefqd3sh57fqv3hkwxqyp2xqcqz95rzjqv9ruzr6quwpsuwmyshlvenk0xm7djrtt8ugt2ja6cx3dkqtccdgvzzxeyqq28qqqqqqqqqqqqqqq9gq2y9qyysgqvu5k5w9q0xe62envhds058r9h8v5uak09hn3uzlw39sqkcuwh34j44gc53j6x6sg0u6yf6l0durxqqekytupxpf66zc7rc9cpav72ssqpcgv3p'
const INVOICE_TIMESTAMP = 1_734_606_755
const AMOUNT = 2100

const keyBytes = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
const key = (fill: number): string => hex.encode(keyBytes(fill))

/** The RFQ family requires a client refund pubkey on every quote. */
const CLIENT_REFUND_PUBKEY = hex.encode(keyBytes(11))

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

let clock: number
let store: SwapStore
let onchainStore: OnchainSendSwapStore
let service: SendSwapService
let onchainService: OnchainSendSwapService
let lockups: FundedOutput[]
let refundCalls: string[]

const arkade: ArkadeOps = {
  providerPubkey: key(1),
  serverPubkey: key(3),
  emulatorPubkey: key(9),
  receiverPkScript: hex.encode(Uint8Array.from([0x51, 0x20, ...keyBytes(1)])),
  delays: { unilateralClaimDelay: 4096, unilateralRefundDelay: 4608, unilateralRefundWithoutReceiverDelay: 5120 },
  hrp: 'ark',
  findLockups: async () => lockups,
  lockupProvablySpent: async () => false,
  claim: async () => 'claim-txid',
  refund: async (row) => {
    refundCalls.push(row.id)
    return 'refund-txid'
  },
}

beforeEach(async () => {
  clock = INVOICE_TIMESTAMP + 100
  lockups = []
  refundCalls = []
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
  // just enough to satisfy WorkerDeps.
  onchainStore = await OnchainSendSwapStore.open(':memory:', () => clock)
  onchainService = new OnchainSendSwapService({
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
})
afterEach(async () => {
  await store.close()
  await onchainStore.close()
})

const quoted = async () => {
  const outcome = await service.quote(INVOICE, REFUND_ADDRESS, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })
  if (!outcome.accepted) throw new Error(`refused: ${outcome.reason}`)
  return outcome.swap
}

describe('fetch', () => {
  it('serves the same API the Node host does', async () => {
    const worker = buildWorker({ service, store, onchainService, onchainStore, network: 'bitcoin' })
    const res = await worker.fetch(new Request('http://worker/healthz'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, network: 'bitcoin' })
  })
})

describe('scheduled, inline (no queue binding)', () => {
  it('drives every recoverable swap and sweeps refunds in one firing', async () => {
    const swap = await quoted()
    lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    const worker = buildWorker({ service, store, onchainService, onchainStore, network: 'bitcoin' })

    await worker.scheduled()
    expect((await store.get(swap.id)).state).toBe('paid')
  })

  it('pushes covenant refunds for failed swaps past their deadline', async () => {
    const swap = await quoted()
    lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    clock = (await store.get(swap.id)).invoiceExpiresAt + 1
    const worker = buildWorker({ service, store, onchainService, onchainStore, network: 'bitcoin' })

    await worker.scheduled() // refuses (invoice expired after funding observed late)
    expect((await store.get(swap.id)).state).toBe('refused')

    clock = (await store.get(swap.id)).refundLocktime + 1
    await worker.scheduled()
    expect(refundCalls).toEqual([swap.id])
    expect((await store.get(swap.id)).refundArkTxid).toBe('refund-txid')
  })

  it('does not let a failed deposit-settlement sweep fail the whole cron firing', async () => {
    // Everything but settleReceiveAddress is unreachable with an empty store
    // (tickAll/refundSweep have nothing to iterate) — throwing keeps that
    // assumption honest instead of silently passing if it ever stops holding.
    const unreachable = async (): Promise<never> => {
      throw new Error('not exercised by this test')
    }
    const explodingOnchain: OnchainSendBackend = {
      fund: unreachable,
      findOutputs: async () => [],
      findSpendWitness: async () => null,
      broadcastRaw: unreachable,
      estimateFeeRate: unreachable,
      getBalance: unreachable,
      newReceiveAddress: unreachable,
      settleReceiveAddress: async () => {
        throw new Error('backend outage')
      },
    }
    const explodingOnchainService = new OnchainSendSwapService({
      store: onchainStore,
      onchain: explodingOnchain,
      arkade,
      limits: { minSats: 500, maxSats: 10_000 },
      network: 'bitcoin',
      maxExposedSats: 5_000,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      signer: { sign: unreachable },
      refundDestinationScript: Uint8Array.from([0x51, 0x20, ...new Uint8Array(32).fill(1)]),
      now: () => clock,
    })
    const worker = buildWorker({
      service,
      store,
      onchainService: explodingOnchainService,
      onchainStore,
      network: 'bitcoin',
    })

    await expect(worker.scheduled()).resolves.toBeUndefined()
  })
})

describe('scheduled, with a queue binding', () => {
  it('fans out one job per swap plus a sweep job, and does no inline work', async () => {
    const swap = await quoted()
    lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    const sent: DriveJob[] = []
    const worker = buildWorker({
      service,
      store,
      onchainService,
      onchainStore,
      network: 'bitcoin',
      driveQueue: { send: async (job) => void sent.push(job) },
    })

    await worker.scheduled()
    expect(sent).toEqual([
      { v: 1, type: 'tick_swap', leg: 'lightning', swap_id: swap.id },
      { v: 1, type: 'refund_sweep' },
    ])
    // Fan-out means the cron does not drive the swap itself.
    expect((await store.get(swap.id)).state).toBe('quoted')
  })
})

describe('queue consumer', () => {
  const message = (body: DriveJob): QueueMessageLike<DriveJob> & { acked: boolean; retried: boolean } => {
    const m = {
      body,
      acked: false,
      retried: false,
      ack: () => void (m.acked = true),
      retry: () => void (m.retried = true),
    }
    return m
  }

  it('processes a tick job and acks it', async () => {
    const swap = await quoted()
    lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    const worker = buildWorker({ service, store, onchainService, onchainStore, network: 'bitcoin' })

    const m = message({ v: 1, type: 'tick_swap', leg: 'lightning', swap_id: swap.id })
    await worker.queue({ messages: [m] })
    expect(m.acked).toBe(true)
    expect(m.retried).toBe(false)
    expect((await store.get(swap.id)).state).toBe('paid')
  })

  it('retries a failing tick instead of dropping it — a dropped tick is a forgotten claim', async () => {
    const swap = await quoted()
    const failingArkade = {
      ...arkade,
      findLockups: async (): Promise<FundedOutput[]> => Promise.reject(new Error('indexer down')),
    }
    const failing = new SendSwapService({
      store,
      ln: {
        routeCltvBudgetBlocks: ROUTE_CLTV_BUDGET_BLOCKS,
        enforcesRouteCltv: true,
        payInvoice: async () => ({ id: 'p', status: 'pending' as const }),
        getPayment: async () => ({ id: 'p', status: 'pending' as const }),
      },
      arkade: failingArkade,
      limits: { minSats: 500, maxSats: 10_000 },
      invoicePrefix: 'bc',
      maxExposedSats: 5_000,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      now: () => clock,
    })
    const worker = buildWorker({ service: failing, store, onchainService, onchainStore, network: 'bitcoin' })

    const m = message({ v: 1, type: 'tick_swap', leg: 'lightning', swap_id: swap.id })
    await worker.queue({ messages: [m] })
    expect(m.retried).toBe(true)
    expect(m.acked).toBe(false)
    // The row kept its state; redelivery resumes from it.
    expect((await store.get(swap.id)).state).toBe('quoted')
  })
})

describe('makeWorkerEntry', () => {
  it('builds deps once per isolate and reuses them across handlers', async () => {
    let built = 0
    const entry = makeWorkerEntry(async () => {
      built += 1
      return { service, store, onchainService, onchainStore, network: 'bitcoin' }
    })
    const env = {}
    expect((await entry.fetch(new Request('http://worker/healthz'), env)).status).toBe(200)
    await entry.scheduled(undefined, env)
    await entry.queue({ messages: [] }, env)
    expect(built).toBe(1)
  })

  it('retries init after a failed first attempt instead of caching the rejection', async () => {
    // One transient blip during the first invocation must not brick the isolate
    // until the platform recycles it — the money-driver would stop ticking.
    let attempts = 0
    const entry = makeWorkerEntry(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('arkade server briefly unreachable')
      return { service, store, onchainService, onchainStore, network: 'bitcoin' }
    })
    const env = {}
    await expect(entry.fetch(new Request('http://worker/healthz'), env)).rejects.toThrow('briefly')
    // Next invocation retries and succeeds.
    expect((await entry.fetch(new Request('http://worker/healthz'), env)).status).toBe(200)
    expect(attempts).toBe(2)
  })
})
