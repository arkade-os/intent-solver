import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import {
  SendSwapService,
  type ArkadeOps,
  type CoupledReceiveRow,
} from '@arkade-os/solver-corridors/send/orchestrator.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { scriptHashFromPaymentHash } from '@arkade-os/solver-core/core/preimage.js'
import { decodeInvoice } from '@arkade-os/solver-core/invoice/decode.js'
import { maxRoutingFeeSats } from '@arkade-os/solver-core/core/limits.js'
import { forgeInvoice, forgeInvoiceWithPreimage } from '@arkade-os/solver-rails-fake/ln/fake/bolt11.js'
import { SwapStore } from '@arkade-os/solver-corridors/db/swaps.js'
import {
  DEFAULT_LOCKUP_TIMEOUT,
  MIN_CLAIM_WINDOW,
  MIN_INVOICE_WINDOW,
  REFUND_SAFETY_MARGIN,
  ROUTE_CLTV_BUDGET_BLOCKS,
  UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS,
  SECONDS_PER_BLOCK,
  deadlineContainsHtlc,
  refundLocktimeFor,
  worstCaseHtlcBlocks,
} from '@arkade-os/solver-core/core/send.js'
import { QUOTE_RATE_LIMIT } from '@arkade-os/solver-core/core/rateLimit.js'
import { TickErrorTracker } from '../../src/ops/tickErrors.js'
import type { FundedOutput } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { PaymentHashRegistered } from '@arkade-os/solver-core/ports/lightning.js'
import type {
  HoldState,
  PayInvoiceParams,
  PaymentResult,
  SendHtlcState,
} from '@arkade-os/solver-core/ports/lightning.js'
import { ORPHANED_REGISTRATION_SECONDS } from '@arkade-os/solver-corridors/send/orchestrator.js'
import { rfqStateFromRow, rfqStatusPayload } from '@arkade-os/solver-corridors/wire/payloads.js'

/**
 * The CLTV terms, with no route hint and an enforcing backend unless stated.
 *
 * One hint argument, applied to BOTH totals: every case here is about the
 * selected value, and the selection itself (`hintCltvBlocks`) is pinned in
 * `test/core/send.test.ts`.
 */
const cltvOf = (
  minFinalCltvBlocks: number,
  routeHintCltvBlocks = 0,
  routeCltvBudgetBlocks = ROUTE_CLTV_BUDGET_BLOCKS,
  enforcesRouteCltv = true,
) => ({
  minFinalCltvBlocks,
  worstRouteHintCltvBlocks: routeHintCltvBlocks,
  bestRouteHintCltvBlocks: routeHintCltvBlocks,
  routeCltvBudgetBlocks,
  enforcesRouteCltv,
})

/**
 * A real mainnet invoice (same fixture the decode tests use): 2100 sats,
 * timestamp 1734606755, expiry 43200s, final CLTV 180 blocks.
 */
const INVOICE =
  'lnbc21u1pnk8larsp526g88ejh9ac0es9j6juxwenzdzvs6hcrphna5pp3jefpukmtk3hqpp5m206npk0fr6k45u8f90capqw48k3pzymlqhk0j98kyx4mz383pkqdz9235x2gr3w45kx6eqvfex7amwypnx77pqdf6k6urnyphhvetjyp6xsefqd3sh57fqv3hkwxqyp2xqcqz95rzjqv9ruzr6quwpsuwmyshlvenk0xm7djrtt8ugt2ja6cx3dkqtccdgvzzxeyqq28qqqqqqqqqqqqqqq9gq2y9qyysgqvu5k5w9q0xe62envhds058r9h8v5uak09hn3uzlw39sqkcuwh34j44gc53j6x6sg0u6yf6l0durxqqekytupxpf66zc7rc9cpav72ssqpcgv3p'
const PAYMENT_HASH = 'da9fa986cf48f56ad387495f8e840ea9ed10889bf82f67c8a7b10d5d8a27886c'
const AMOUNT = 2100
const INVOICE_TIMESTAMP = 1_734_606_755
const INVOICE_EXPIRES_AT = INVOICE_TIMESTAMP + 43_200

/**
 * A forged invoice whose preimage we KNOW. The orchestrator verifies the
 * backend's preimage against the invoice's payment hash before it will claim, so
 * a claim-path test cannot use an arbitrary preimage — it must be P for this
 * invoice's hash. (The real fixture above has an unknown preimage by design.)
 */
const FORGED = forgeInvoiceWithPreimage({
  network: 'bc',
  amountSats: AMOUNT,
  timestamp: INVOICE_TIMESTAMP,
  expirySeconds: 6 * 3600,
})
const FORGED_PREIMAGE = hex.encode(FORGED.preimage)

const keyBytes = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
const key = (fill: number): string => hex.encode(keyBytes(fill))

/** The RFQ family requires a client refund pubkey on every quote. */
const CLIENT_REFUND_PUBKEY = hex.encode(keyBytes(11))

// A real, decodable Arkade address for the client's refund destination.
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

class FakeLn {
  /**
   * Both settable, and they move together — a deployment does not acquire the
   * ability to cap a route without also changing what it budgets for one. The
   * rail-change test below flips the pair; everything else leaves them alone.
   */
  routeCltvBudgetBlocks: number = ROUTE_CLTV_BUDGET_BLOCKS
  enforcesRouteCltv = true
  payCalls: PayInvoiceParams[] = []
  payResult: PaymentResult = { id: 'pay-1', status: 'pending' }
  payments = new Map<string, PaymentResult>()
  /** When set, payInvoice blocks until the promise resolves. */
  payGate: Promise<void> | null = null
  /** When set, payInvoice throws it — the way a rejected RPC leaves the row. */
  payThrows: Error | null = null

  async payInvoice(params: PayInvoiceParams): Promise<PaymentResult> {
    this.payCalls.push(params)
    if (this.payGate) await this.payGate
    if (this.payThrows) throw this.payThrows
    return this.payResult
  }

  /**
   * The send-side HTLC probe (src/ln/port.ts). Null is the ordinary answer —
   * "nothing was ever committed for this hash" — which is what keeps every
   * pre-existing test in this file on the re-submit path.
   */
  sendHtlc: SendHtlcState | null = null
  sendHtlcCalls: string[] = []

  async getSendHtlcState(paymentHash: string): Promise<SendHtlcState | null> {
    this.sendHtlcCalls.push(paymentHash)
    return this.sendHtlc
  }

  getPaymentCalls: string[] = []

  async getPayment(id: string): Promise<PaymentResult> {
    this.getPaymentCalls.push(id)
    const result = this.payments.get(id)
    if (!result) throw new Error(`payment ${id} not found`)
    return result
  }

  /**
   * The self-payment probe (src/ln/port.ts). Null is the ordinary answer —
   * "not one of ours" — which is what keeps every pre-existing test in this
   * file on the ordinary terminal-failure path.
   */
  ownInvoiceState: HoldState | null = null
  ownInvoiceCalls: string[] = []

  async getOwnInvoiceState(paymentHash: string): Promise<HoldState | null> {
    this.ownInvoiceCalls.push(paymentHash)
    return this.ownInvoiceState
  }
}

interface FakeArkade extends ArkadeOps {
  lockups: FundedOutput[]
  /**
   * Whether the script's outputs are PROVABLY spent — set independently of
   * {@link lockups} going empty, because the two facts are exactly what the
   * refund sweep has to tell apart: money genuinely moved, versus a
   * `spendableOnly` read that is merely behind.
   */
  lockupsSpent: boolean
  claimCalls: { rowId: string; outputs: FundedOutput[]; preimage: string }[]
  refundCalls: { rowId: string; outputs: FundedOutput[] }[]
  /**
   * The COUPLED receive lockup — the one the client claims, revealing `P`.
   * Not part of `ArkadeOps`: the coupled path's reads are wired through the
   * `coupling` dep, so these are the data the fakes there close over.
   */
  receiveOutpoints: { txid: string; vout: number }[]
  /** The preimage a claim on those outpoints revealed; null until one lands. */
  receivePreimage: Uint8Array | null
}

const fakeArkade = (): FakeArkade => {
  const arkade: FakeArkade = {
    providerPubkey: key(1),
    serverPubkey: key(3),
    emulatorPubkey: key(9),
    receiverPkScript: hex.encode(Uint8Array.from([0x51, 0x20, ...keyBytes(1)])),
    delays: {
      unilateralClaimDelay: 4096,
      unilateralRefundDelay: 4608,
      unilateralRefundWithoutReceiverDelay: 5120,
    },
    hrp: 'ark',
    lockups: [],
    lockupsSpent: false,
    claimCalls: [],
    refundCalls: [],
    receiveOutpoints: [],
    receivePreimage: null,
    findLockups: async () => arkade.lockups,
    lockupProvablySpent: async () => arkade.lockupsSpent,
    claim: async (row, outputs, preimage) => {
      arkade.claimCalls.push({ rowId: row.id, outputs, preimage })
      return 'claim-txid'
    },
    refund: async (row, outputs) => {
      arkade.refundCalls.push({ rowId: row.id, outputs })
      return 'refund-txid'
    },
  }
  return arkade
}

let clock: number
let store: SwapStore
let ln: FakeLn
let arkade: FakeArkade
let service: SendSwapService

beforeEach(async () => {
  clock = INVOICE_TIMESTAMP + 100
  store = await SwapStore.open(':memory:', () => clock)
  ln = new FakeLn()
  arkade = fakeArkade()
  service = new SendSwapService({
    store,
    ln,
    arkade,
    limits: { minSats: 500, maxSats: 10_000 },
    invoicePrefix: 'bc',
    maxExposedSats: 5_000,
    totalCommitted: () => store.committedSats(),
    admission: new AdmissionControl(),
    now: () => clock,
  })
})
afterEach(() => store.close())

/** Quote the fixture invoice, asserting acceptance. */
const quoted = async () => {
  const outcome = await service.quote(INVOICE, REFUND_ADDRESS, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })
  if (!outcome.accepted) throw new Error(`fixture quote refused: ${outcome.reason}`)
  return outcome
}

describe('the solver spread', () => {
  /**
   * 100bps plus 50 flat against a 2100 sat invoice.
   *
   * 2172, not 2171, and the off-by-one is the point: the spread is charged on
   * what the client LOCKS, so it is solved backwards from the payout. At 2171
   * the fee is ceil(21.71) + 50 = 72, leaving 2099 — a sat short of the
   * invoice. At 2172 it is ceil(21.72) + 50 = 72, leaving exactly 2100.
   */
  const FEE = { bps: 100, flatSats: 50 }
  const EXPECTED_LOCKUP = 2172

  const withFee = () =>
    new SendSwapService({
      store,
      ln,
      arkade,
      limits: { minSats: 500, maxSats: 10_000 },
      invoicePrefix: 'bc',
      maxExposedSats: 50_000,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      now: () => clock,
      fee: FEE,
    })

  it('quotes a lockup of the invoice PLUS the fee', async () => {
    const outcome = await withFee().quote(INVOICE, REFUND_ADDRESS, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })
    if (!outcome.accepted) throw new Error(`refused: ${outcome.reason}`)
    const row = await store.get(outcome.swap.id)
    expect(row.amountSats).toBe(EXPECTED_LOCKUP)
    expect(row.amountSats).toBeGreaterThan(AMOUNT)
  })

  it('charges nothing when the fee is free, exactly as before it existed', async () => {
    const outcome = await quoted()
    expect((await store.get(outcome.swap.id)).amountSats).toBe(AMOUNT)
  })

  it('REFUSES a lockup funded for the invoice amount — that is underfunding by the fee', async () => {
    const svc = withFee()
    const outcome = await svc.quote(INVOICE, REFUND_ADDRESS, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })
    if (!outcome.accepted) throw new Error(`refused: ${outcome.reason}`)
    // What a client that ignored `from_amount` and funded the invoice would do.
    arkade.lockups = [{ txid: 'f'.repeat(64), vout: 0, value: AMOUNT }]
    clock += 60
    const row = await svc.tick(outcome.swap.id)
    expect(row.state).toBe('quoted')
    expect(ln.payCalls).toHaveLength(0)
  })

  it('accepts the quoted lockup and pays the invoice, keeping the difference', async () => {
    const svc = withFee()
    const outcome = await svc.quote(INVOICE, REFUND_ADDRESS, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })
    if (!outcome.accepted) throw new Error(`refused: ${outcome.reason}`)
    arkade.lockups = [{ txid: 'a'.repeat(64), vout: 0, value: EXPECTED_LOCKUP }]
    ln.payments.set('pay-1', { id: 'pay-1', status: 'pending' })
    await svc.tick(outcome.swap.id)
    // The payment is the INVOICE, whose amount is its own: the spread is the
    // difference between that and the lockup, and it stays with the solver.
    expect(ln.payCalls.length).toBeGreaterThan(0)
    expect(ln.payCalls[0]?.invoice).toBe(INVOICE)
    // And the routing cap is sized on what is being routed, not on the
    // fee-inflated lockup — otherwise our own spread would raise the ceiling
    // on what we are willing to pay away.
    expect(ln.payCalls[0]?.maxFeeSats).toBe(maxRoutingFeeSats(AMOUNT))
  })

  it('meters exposure against the lockup, which is what the solver is actually owed', async () => {
    const svc = new SendSwapService({
      store,
      ln,
      arkade,
      limits: { minSats: 500, maxSats: 10_000 },
      invoicePrefix: 'bc',
      // One sat short of the fee-inclusive lockup, so the cap must bite.
      maxExposedSats: EXPECTED_LOCKUP - 1,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      now: () => clock,
      fee: FEE,
    })
    const outcome = await svc.quote(INVOICE, REFUND_ADDRESS, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })
    expect(outcome.accepted).toBe(false)
    if (!outcome.accepted) expect(outcome.reason).toBe('provider_at_capacity')
  })
})

describe('quote', () => {
  it('persists the swap before returning the lockup address', async () => {
    const outcome = await quoted()
    const row = await store.get(outcome.swap.id)
    expect(row.state).toBe('quoted')
    expect(row.paymentHash).toBe(PAYMENT_HASH)
    expect(row.amountSats).toBe(AMOUNT)
    expect(row.invoiceExpiresAt).toBe(INVOICE_EXPIRES_AT)
    expect(row.lockupAddress).toMatch(/^ark1/)
    expect(row.pkScript).toMatch(/^5120/)
    // Everything needed to rebuild the script is on the row, not in memory.
    expect(row.claimDelay).toBe(4096)
    expect(row.senderPubkey).toBe(arkade.providerPubkey)
    expect(row.serverPubkey).toBe(arkade.serverPubkey)
  })

  it('quotes a refund deadline that outlasts the invoice CLTV window', async () => {
    const outcome = await quoted()
    // 180 (the invoice's final delta) + 81 (its route hint — CLTV the invoice
    // itself dictates, which the deadline has to cover) + 432 (the enforcing
    // backend's route budget) blocks at 600s, plus the 2h margin.
    const decoded = decodeInvoice(INVOICE)
    expect(decoded.worstRouteHintCltvBlocks).toBe(81)
    expect(outcome.swap.refundLocktime).toBe(clock + (180 + 81 + 432) * 600 + 2 * 3600)
  })

  it('refuses a second swap for the same invoice', async () => {
    await quoted()
    const second = await service.quote(INVOICE, REFUND_ADDRESS, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })
    expect(second.accepted).toBe(false)
    if (!second.accepted) expect(second.reason).toBe('duplicate_swap')
  })

  it('refuses a hash that is live in ANOTHER corridor’s store — the self-payment blind spot', async () => {
    // The hash belongs to a live receive swap of ours: paying its invoice
    // would be paying ourselves (issue #41). Each corridor's own store only
    // sees its own rows, so the check has to cross stores.
    const peer = {
      findLiveByPaymentHash: async (hash: string) => (hash === PAYMENT_HASH ? { id: 'receive-row' } : null),
    }
    const svc = new SendSwapService({
      store,
      ln,
      arkade,
      limits: { minSats: 500, maxSats: 10_000 },
      invoicePrefix: 'bc',
      maxExposedSats: 5_000,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      now: () => clock,
      peerStores: [peer],
    })
    const outcome = await svc.quote(INVOICE, REFUND_ADDRESS, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })
    expect(outcome).toEqual({ accepted: false, reason: 'duplicate_swap' })
    // Nothing persisted behind the refusal.
    expect(await store.findByPaymentHash(PAYMENT_HASH)).toBeNull()
  })

  it('refuses when concurrent exposure would exceed the cap', async () => {
    // A different swap is already exposed (mid-payment) for 3000 sats.
    await store.insertQuote({
      id: 'other',
      invoice: 'lnbc...',
      paymentHash: 'b'.repeat(64),
      amountSats: 3_000,
      invoiceExpiresAt: clock + 3600,
      refundLocktime: clock + 7200,
      senderPubkey: key(1),
      receiverPubkey: key(1),
      serverPubkey: key(3),
      claimDelay: 4096,
      refundDelay: 4608,
      refundWithoutReceiverDelay: 5120,
      pkScript: '5120' + 'ab'.repeat(32),
      lockupAddress: 'ark1qother',
      nonInteractiveParameters: true,
    })
    await store.transition('other', 'quoted', 'funded')
    await store.transition('other', 'funded', 'paying')

    // 3000 exposed + 2100 requested > 5000 cap.
    const outcome = await service.quote(INVOICE, REFUND_ADDRESS, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })
    expect(outcome).toEqual({ accepted: false, reason: 'provider_at_capacity' })
  })

  it('rate-limits new quotes from one requester key, and never meters keyless callers', async () => {
    // Distinct forged invoices (distinct payment hashes) at the minimum amount,
    // so the exposure cap — 5000 here — cannot fire before the quota does.
    const freshInvoice = () =>
      forgeInvoiceWithPreimage({
        network: 'bc',
        amountSats: 500,
        timestamp: INVOICE_TIMESTAMP,
        expirySeconds: 6 * 3600,
      }).invoice
    const freshQuote = () =>
      service.quote(freshInvoice(), REFUND_ADDRESS, {
        clientRefundPubkey: CLIENT_REFUND_PUBKEY,
        requesterKey: 'ip:attacker',
      })
    for (let i = 0; i < QUOTE_RATE_LIMIT; i++) {
      expect((await freshQuote()).accepted).toBe(true)
    }
    expect(await freshQuote()).toEqual({ accepted: false, reason: 'rate_limited' })

    // A different key keeps its own budget...
    expect(
      (
        await service.quote(freshInvoice(), REFUND_ADDRESS, {
          clientRefundPubkey: CLIENT_REFUND_PUBKEY,
          requesterKey: 'ip:client',
        })
      ).accepted,
    ).toBe(true)
    // ...and an operator-local call with no key is never metered at all.
    expect(
      (await service.quote(freshInvoice(), REFUND_ADDRESS, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })).accepted,
    ).toBe(true)
  })

  it('refuses an expired invoice', async () => {
    clock = INVOICE_EXPIRES_AT + 1
    const outcome = await service.quote(INVOICE, REFUND_ADDRESS, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })
    expect(outcome).toEqual({ accepted: false, reason: 'invoice_expired' })
  })

  it('refuses a refund address that does not decode or is for another network', async () => {
    expect(await service.quote(INVOICE, 'not-an-address', { clientRefundPubkey: CLIENT_REFUND_PUBKEY })).toEqual({
      accepted: false,
      reason: 'invalid_refund_address',
    })
    // A testnet-prefixed address must not become a mainnet commitment.
    expect(
      await service.quote(INVOICE, REFUND_ADDRESS.replace(/^ark1/, 'tark1'), {
        clientRefundPubkey: CLIENT_REFUND_PUBKEY,
      }),
    ).toEqual({
      accepted: false,
      reason: 'invalid_refund_address',
    })
  })

  it('refuses a refund address anchored to a different Arkade server', async () => {
    // Same HRP, well-formed, but the embedded server key is another
    // deployment's: a covenant refund would land where the client needs THAT
    // server's cooperation to ever move it again.
    const foreignServer = new CovenantSwapScript({
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
      .address('ark', keyBytes(4)) // key(4), not the provider's server key(3)
      .encode()
    expect(await service.quote(INVOICE, foreignServer, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })).toEqual({
      accepted: false,
      reason: 'invalid_refund_address',
    })
  })

  it('commits the covenant refund parameters to the row', async () => {
    const { swap } = await quoted()
    expect(swap.refundPkScript).toMatch(/^5120/)
    expect(swap.emulatorPubkey).toBe(key(9))
  })

  it('lets a client reproduce the lockup address from its own data plus two trusted fields', async () => {
    // The client-side rule: fund only your own derivation. From the quote a
    // client trusts exactly providerPubkey and refundLocktime; the invoice, the
    // Arkade server key, the emulator key and the refund destination are all
    // things the client already holds. If this derivation ever stops matching,
    // an honest server has broken the protocol — and against a dishonest one it
    // is the whole defence.
    const { swap } = await quoted()
    const decoded = decodeInvoice(INVOICE)
    const local = new CovenantSwapScript({
      receiver: hex.decode(swap.receiverPubkey), // trusted: provider key
      server: keyBytes(3), // client's own aspInfo
      preimageHash: scriptHashFromPaymentHash(decoded.paymentHash), // client's own invoice
      refundLocktime: swap.refundLocktime, // trusted: deadline
      claimDelay: 4096, // client's own aspInfo derivation
      client: keyBytes(11), // the client's OWN key, sent with the request
      clientRefundDelay: 5120, // client's own aspInfo derivation
      refundWithoutServerDelay: 4608, // client's own aspInfo derivation
      // Every quote the service issues now carries the full covenant suite;
      // matching that here is what makes the derived address agree with
      // `swap.lockupAddress`.
      nonInteractiveParameters: {
        emulatorPubkey: keyBytes(9), // client's own emulator fetch
        receiverPkScript: Uint8Array.from([0x51, 0x20, ...keyBytes(1)]), // returned by the quote
        senderPkScript: hex.decode(swap.refundPkScript!), // client's own address
      },
    })
    expect(local.address('ark', keyBytes(3)).encode()).toBe(swap.lockupAddress)
    expect(hex.encode(local.pkScript)).toBe(swap.pkScript)
  })
})

describe('tick: the full drive', () => {
  it('waits in quoted until the lockup is fully funded', async () => {
    const { swap } = await quoted()
    expect((await service.tick(swap.id)).state).toBe('quoted')

    arkade.lockups = [{ txid: 'f1', vout: 0, value: 1_000 }]
    // Partial funding is not funding.
    expect((await service.tick(swap.id)).state).toBe('quoted')
  })

  it('sums a lockup funded across several outputs', async () => {
    const { swap } = await quoted()
    ln.payments.set('pay-1', { id: 'pay-1', status: 'pending' })
    arkade.lockups = [
      { txid: 'f1', vout: 0, value: 1_000 },
      { txid: 'f2', vout: 1, value: 1_100 },
    ]
    const row = await service.tick(swap.id)
    expect(row.state).not.toBe('quoted')
    expect(row.lockupValue).toBe(2_100)
  })

  it('refuses an overfunded lockup rather than claim the excess', async () => {
    // The claim leaf sweeps whole vtxos, so paying an overfunded lockup would
    // keep the excess with no way for the client to recover it. Refusing routes
    // the WHOLE lockup to the refund path, so the client loses nothing.
    const { swap } = await quoted()
    arkade.lockups = [
      { txid: 'f1', vout: 0, value: AMOUNT },
      { txid: 'f2', vout: 1, value: AMOUNT }, // double-funded
    ]
    const row = await service.tick(swap.id)
    expect(row.state).toBe('refused')
    expect(row.failureReason).toContain('overfunded')
    expect(row.lockupValue).toBe(2 * AMOUNT) // whole lockup recorded for the refund
    expect(ln.payCalls).toHaveLength(0) // never paid
  })

  it('drives a funded swap through payment to paid in one tick', async () => {
    const { swap } = await quoted()
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    ln.payments.set('pay-1', { id: 'pay-1', status: 'pending' })

    const row = await service.tick(swap.id)
    expect(row.state).toBe('paid')
    expect(row.paymentId).toBe('pay-1')
    expect(ln.payCalls).toHaveLength(1)
    // The idempotency key is derived from the payment hash, so a retry from any
    // process produces the same key and cannot pay twice.
    expect(ln.payCalls[0]?.idempotencyKey).toBe(`swap-${PAYMENT_HASH}`)
    expect((await store.history(swap.id)).filter((e) => !e.detail).map((e) => e.to)).toEqual([
      'quoted',
      'funded',
      'paying',
      'paid',
    ])
  })

  it('claims once the preimage is known, in the same tick', async () => {
    const outcome = await service.quote(FORGED.invoice, REFUND_ADDRESS, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })
    if (!outcome.accepted) throw new Error(`forged quote refused: ${outcome.reason}`)
    const swap = outcome.swap
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    ln.payments.set('pay-1', { id: 'pay-1', status: 'succeeded', preimage: FORGED_PREIMAGE })

    const row = await service.tick(swap.id)
    expect(row.state).toBe('claimed')
    expect(row.claimArkTxid).toBe('claim-txid')
    // The preimage was committed to disk before the claim was attempted.
    expect(row.preimage).toBe(FORGED_PREIMAGE)
    expect(arkade.claimCalls).toHaveLength(1)
    expect(arkade.claimCalls[0]?.outputs).toHaveLength(1)
  })

  it('claims from the preimage payInvoice already returned, with no getPayment round trip', async () => {
    const outcome = await service.quote(FORGED.invoice, REFUND_ADDRESS, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })
    if (!outcome.accepted) throw new Error(`forged quote refused: ${outcome.reason}`)
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    // The pay call itself resolves P. Note `ln.payments` is deliberately left
    // empty: the fake throws on any getPayment, so a re-fetch here would fail
    // this test rather than pass it silently.
    ln.payResult = { id: 'pay-1', status: 'succeeded', preimage: FORGED_PREIMAGE }

    const row = await service.tick(outcome.swap.id)

    expect(row.state).toBe('claimed')
    expect(row.preimage).toBe(FORGED_PREIMAGE)
    expect(ln.getPaymentCalls).toEqual([])
    expect(arkade.claimCalls).toHaveLength(1)
    // The row still walked every state; only the redundant poll is gone.
    expect((await store.history(row.id)).filter((e) => !e.detail).map((e) => e.to)).toEqual([
      'quoted',
      'funded',
      'paying',
      'paid',
      'claiming',
      'claimed',
    ])
  })

  it('applies the payment-hash gate to a preimage that arrives on the payInvoice response', async () => {
    const { swap } = await quoted()
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    // Same wrong preimage as the polled case, delivered by the shortcut path.
    // The check must live where both callers reach it, not on the poll alone.
    ln.payResult = { id: 'pay-1', status: 'succeeded', preimage: 'aa'.repeat(32) }

    const row = await service.tick(swap.id)

    expect(row.state).toBe('stuck')
    expect(row.failureReason).toContain('does not match the payment hash')
    expect(arkade.claimCalls).toHaveLength(0)
  })

  it('routes to stuck if the backend hands back a preimage that does not match the payment hash', async () => {
    const { swap } = await quoted()
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    // A wrong preimage would fail every claim; catch it before claiming, not after.
    ln.payments.set('pay-1', { id: 'pay-1', status: 'succeeded', preimage: 'aa'.repeat(32) })

    const row = await service.tick(swap.id)
    expect(row.state).toBe('stuck')
    expect(row.failureReason).toContain('does not match the payment hash')
    expect(arkade.claimCalls).toHaveLength(0)
  })

  it('never pays while another tick is already driving the same swap', async () => {
    const { swap } = await quoted()
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]

    let release!: () => void
    ln.payGate = new Promise((resolve) => (release = resolve))

    const first = service.tick(swap.id)
    // Give the first tick time to reach the blocked payInvoice call.
    await new Promise((resolve) => setImmediate(resolve))
    const second = await service.tick(swap.id)

    expect(second.state).toBe('paying')
    expect(ln.payCalls).toHaveLength(1)

    release()
    ln.payments.set('pay-1', { id: 'pay-1', status: 'pending' })
    expect((await first).state).toBe('paid')
  })
})

describe('tick: refusals before money moves', () => {
  it('expires an unfunded quote after the lockup timeout', async () => {
    const { swap } = await quoted()
    clock += DEFAULT_LOCKUP_TIMEOUT + 1
    const row = await service.tick(swap.id)
    expect(row.state).toBe('refused')
    expect(row.failureReason).toBe('lockup timeout')
  })

  it('records a partial lockup when expiring, for the operator', async () => {
    const { swap } = await quoted()
    arkade.lockups = [{ txid: 'f1', vout: 0, value: 500 }]
    clock += DEFAULT_LOCKUP_TIMEOUT + 1
    const row = await service.tick(swap.id)
    expect(row.state).toBe('refused')
    expect(row.failureReason).toContain('partial 500')
  })

  it('never pays a lockup observed after the funding deadline', async () => {
    const { swap } = await quoted()
    // Full funding, but first seen well after the lockup deadline — the exact
    // shape of a drive-later or crash-recovery that an always-on watcher would
    // have timed out. refundLocktime is anchored at quote time, so paying now
    // would shrink the claim window we quoted against.
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    clock = swap.createdAt + 16 * 60

    const row = await service.tick(swap.id)
    expect(row.state).toBe('refused')
    expect(row.failureReason).toContain('after the funding deadline')
    expect(row.lockupValue).toBe(AMOUNT) // recorded so the sweep can refund it
    expect(ln.payCalls).toHaveLength(0)
  })

  it('clamps the CLTV ceiling to what is left of the deadline when funding was slow', async () => {
    // The deadline is absolute and set at QUOTE time; the ceiling handed to the
    // backend is a delta from the moment we PAY. A long funding window makes the
    // two diverge, and an unclamped ceiling would authorise an HTLC that outlives
    // the client's refund — refund the lockup, then settle the invoice, both
    // sides taken. A six-hour window is legal since #88 removed the cap.
    const svc = new SendSwapService({
      store,
      ln,
      arkade,
      limits: { minSats: 500, maxSats: 10_000 },
      invoicePrefix: 'bc',
      maxExposedSats: 5_000,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      lockupTimeout: 6 * 3600,
      now: () => clock,
    })
    const outcome = await svc.quote(INVOICE, REFUND_ADDRESS, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })
    if (!outcome.accepted) throw new Error(`quote refused: ${outcome.reason}`)

    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    clock = outcome.swap.createdAt + 4 * 3600
    const payAt = clock
    ln.payments.set('pay-1', { id: 'pay-1', status: 'pending' })
    await svc.tick(outcome.swap.id)

    const call = ln.payCalls[0]
    if (call === undefined) throw new Error('expected the payment to be attempted')
    const decoded = decodeInvoice(INVOICE)
    const unclamped = worstCaseHtlcBlocks(cltvOf(decoded.minFinalCltvBlocks, decoded.worstRouteHintCltvBlocks))
    expect(call.maxCltvBlocks).toBeLessThan(unclamped)
    // The invariant, stated as the thing that must be true rather than a number:
    // an HTLC living the whole ceiling still resolves a safety margin before the
    // client's refund opens.
    expect(payAt + call.maxCltvBlocks * SECONDS_PER_BLOCK + REFUND_SAFETY_MARGIN).toBeLessThanOrEqual(
      outcome.swap.refundLocktime,
    )
  })

  it('builds the ceiling from the same hint the deadline was sized on', async () => {
    // The third `HtlcCltv` literal, and the one no gate builds for it —
    // `submitPayment`'s own `cltv`, whose output IS `max_timeout_height`.
    //
    // A Wallet of Satoshi shape: hints of [40] and [40000], of which the fake
    // (an enforcing rail) is bound only by the 40. Had this site kept building
    // on the worst while the deadline moved to the best, `payableCltvBlocks`'
    // first term would go huge and the `min` would silently degrade to
    // `blocksLeft` — handing the backend everything remaining before the refund
    // deadline instead of the route budget. Inside the deadline, so no
    // double-collect, and exactly the disagreement between the two consumers
    // that `worstCaseHtlcBlocks` exists to prevent.
    const badAlternate = forgeInvoiceWithPreimage({
      network: 'bc',
      amountSats: AMOUNT,
      timestamp: INVOICE_TIMESTAMP,
      expirySeconds: 6 * 3600,
      minFinalCltvBlocks: 60,
      routeHints: [[40], [40_000]],
    })
    const outcome = await service.quote(badAlternate.invoice, REFUND_ADDRESS, {
      clientRefundPubkey: CLIENT_REFUND_PUBKEY,
    })
    if (!outcome.accepted) throw new Error(`quote refused: ${outcome.reason}`)

    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    ln.payments.set('pay-1', { id: 'pay-1', status: 'pending' })
    await service.tick(outcome.swap.id)

    const call = ln.payCalls[0]
    if (call === undefined) throw new Error('expected the payment to be attempted')
    expect(call.maxCltvBlocks).toBe(60 + 40 + ROUTE_CLTV_BUDGET_BLOCKS)
  })

  it('times a short invoice out at its own fitted deadline, not the full lockup timeout', async () => {
    // A ten-minute invoice is quoted now rather than refused, so its funding
    // window has to end where the invoice does — `expiry - MIN_INVOICE_WINDOW`,
    // five minutes before `DEFAULT_LOCKUP_TIMEOUT` would have. The reason
    // matters as much as the state: timing out later would let the lockup reach
    // `funded` and be refused by the PAYMENT gate for expiry, which is exactly
    // the "funded, then refused" outcome the window exists to make unreachable.
    const short = forgeInvoiceWithPreimage({
      network: 'bc',
      amountSats: AMOUNT,
      timestamp: clock,
      expirySeconds: 10 * 60,
    }).invoice
    const outcome = await service.quote(short, REFUND_ADDRESS, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })
    if (!outcome.accepted) throw new Error(`expected an accepted quote, got ${outcome.reason}`)
    expect(outcome.lockupDeadline).toBe(clock + 10 * 60 - MIN_INVOICE_WINDOW)

    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    clock = outcome.lockupDeadline + 1

    const row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('refused')
    expect(row.failureReason).toContain('after the funding deadline')
    expect(ln.payCalls).toHaveLength(0)
  })

  it('refuses to pay when the invoice expired between funding and payment', async () => {
    // Crafted funded row so the pre-payment gate itself is exercised: this is
    // the belt-and-suspenders expiry check that runs immediately before paying,
    // per the money rule that an expired BOLT11 is never funded.
    await store.insertQuote({
      id: 'expiring',
      invoice: INVOICE,
      paymentHash: 'f'.repeat(64),
      amountSats: AMOUNT,
      invoiceExpiresAt: clock + 5,
      refundLocktime: clock + 100_000,
      senderPubkey: key(1),
      receiverPubkey: key(1),
      serverPubkey: key(3),
      claimDelay: 4096,
      refundDelay: 4608,
      refundWithoutReceiverDelay: 5120,
      pkScript: '5120' + 'ef'.repeat(32),
      lockupAddress: 'ark1qexpiring',
      nonInteractiveParameters: true,
    })
    await store.transition('expiring', 'quoted', 'funded', { lockup_value: AMOUNT })
    clock += 10

    const row = await service.tick('expiring')
    expect(row.state).toBe('refused')
    expect(row.failureReason).toContain('invoice_expired')
    expect(ln.payCalls).toHaveLength(0)
  })

  it('refuses to pay too close to the refund deadline', async () => {
    // Crafted row rather than a quoted one: a quote can never produce a refund
    // deadline this tight, which is exactly why the payment gate re-checks it —
    // it guards against clock drift and rows written by older code.
    await store.insertQuote({
      id: 'tight',
      invoice: INVOICE,
      paymentHash: 'd'.repeat(64),
      amountSats: AMOUNT,
      invoiceExpiresAt: clock + 3600,
      refundLocktime: clock + MIN_CLAIM_WINDOW - 10,
      senderPubkey: key(1),
      receiverPubkey: key(1),
      serverPubkey: key(3),
      claimDelay: 4096,
      refundDelay: 4608,
      refundWithoutReceiverDelay: 5120,
      pkScript: '5120' + 'cd'.repeat(32),
      lockupAddress: 'ark1qtight',
      nonInteractiveParameters: true,
    })
    await store.transition('tight', 'quoted', 'funded', { lockup_value: AMOUNT })

    const row = await service.tick('tight')
    expect(row.state).toBe('refused')
    expect(row.failureReason).toContain('claim_window_too_short')
    expect(ln.payCalls).toHaveLength(0)
  })

  it('refuses to pay a lockup whose claim key is no longer the configured one', async () => {
    // Key rotation mid-flight: the row was quoted under key(7), the service now
    // runs key(1). Paying would buy a lockup the live key can never claim, so
    // the gate fails the swap (funded -> refused) and the lockup takes the
    // covenant refund path back to the client.
    await store.insertQuote({
      id: 'rotated',
      invoice: INVOICE,
      paymentHash: 'e'.repeat(64),
      amountSats: AMOUNT,
      invoiceExpiresAt: clock + 3600,
      refundLocktime: clock + 100_000,
      senderPubkey: key(7),
      receiverPubkey: key(7),
      serverPubkey: key(3),
      claimDelay: 4096,
      refundDelay: 4608,
      refundWithoutReceiverDelay: 5120,
      pkScript: '5120' + 'ab'.repeat(32),
      lockupAddress: 'ark1qrotated',
      nonInteractiveParameters: true,
    })
    await store.transition('rotated', 'quoted', 'funded', { lockup_value: AMOUNT })

    const row = await service.tick('rotated')
    expect(row.state).toBe('refused')
    expect(row.failureReason).toContain('provider key rotated')
    expect(ln.payCalls).toHaveLength(0)
  })
})

describe('tick: failure and recovery', () => {
  it('CLOSES a terminally failed payment once the client has been refunded', async () => {
    const { swap } = await quoted()
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    ln.payResult = { id: 'pay-1', status: 'failed' }

    const row = await service.tick(swap.id)

    // `refused`, not `stuck`. Lightning fails often, and a `stuck` queue full of
    // rows that need nothing is one an operator learns to skim — burying the
    // rows that do. The only risk that would justify the flag is an in-flight
    // payment settling AFTER the refund, and `toPaymentStatus` forecloses it:
    // `failed` comes from a three-status allowlist and everything unrecognised
    // stays `pending`, so a `failed` verdict means terminal.
    expect(row.state).toBe('refused')
    expect(row.failureReason).toContain('refunded')
    // The payment id is still recorded so the failure can be verified later.
    expect(row.paymentId).toBe('pay-1')
    // The probe ANSWERED "not ours" — which is what makes closing it safe, as
    // distinct from a probe that could not be asked (see the self-payment
    // exception below, which still parks).
    expect(ln.ownInvoiceCalls).toEqual([PAYMENT_HASH])
    expect(arkade.refundCalls).toHaveLength(1)
  })

  it('still parks in stuck when the refund could NOT be pushed', async () => {
    const { swap } = await quoted()
    // Funded, then nothing at the script when the refund runs: the client is
    // not whole, and only a human can work out why.
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    ln.payResult = { id: 'pay-1', status: 'pending' }
    ln.payments.set('pay-1', { id: 'pay-1', status: 'pending' })
    await service.tick(swap.id)
    arkade.lockups = []
    ln.payments.set('pay-1', { id: 'pay-1', status: 'failed' })

    const row = await service.tick(swap.id)

    expect(row.refundOutcome).toBeNull()
    expect(row.state).toBe('stuck')
  })

  it('records that the automatic refund was pushed, not just that it happened', async () => {
    const { swap } = await quoted()
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    ln.payResult = { id: 'pay-1', status: 'failed' }

    const row = await service.tick(swap.id)
    expect(row.refundAttempt).toBe('pushed')
  })

  /**
   * The most dangerous line this column can carry: `failed:` against a refund
   * that actually broadcast. `stuck` means a human reads the row and acts on
   * what it says, so a note that inverts the truth is worse than no note.
   *
   * It was reachable because the post-broadcast `patch` sat inside the same
   * `try` as the push, so a transient store fault was written up as a refund
   * failure.
   */
  it('never writes off a refund that broadcast as a refund that failed', async () => {
    const { swap } = await quoted()
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    ln.payResult = { id: 'pay-1', status: 'failed' }
    const realPatch = store.patch.bind(store)
    const reported: string[] = []
    service.onTickError = (_id, error) => reported.push(error instanceof Error ? error.message : String(error))
    // Only the bookkeeping write fails. The push itself succeeded.
    store.patch = async (id, patch) => {
      if ('refund_outcome' in patch) throw new Error('SQLITE_BUSY')
      return realPatch(id, patch)
    }

    const row = await service.tick(swap.id)
    expect(arkade.refundCalls).toHaveLength(1)
    // Nothing claims the refund failed.
    expect(row.refundAttempt ?? '').not.toContain('failed')
    // And the txid reaches the operator by the only other durable route.
    expect(reported.join(' ')).toContain('broadcast but could not be recorded')
  })

  it('does not call an empty script a broken refund when it is the STORE that broke', async () => {
    // `nothing-at-script` sat inside the try too, so a store fault on that write
    // was recorded as `failed: SQLITE_BUSY` against a script that was simply
    // empty — the opposite of what happened.
    const { swap } = await quoted()
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    ln.payResult = { id: 'pay-1', status: 'failed' }
    const realFind = arkade.findLockups.bind(arkade)
    let reads = 0
    arkade.findLockups = async (pkScript: string) => (++reads === 1 ? realFind(pkScript) : [])
    const realPatch = store.patch.bind(store)
    store.patch = async (id, patch) => {
      if (patch.refund_attempt === 'nothing-at-script') throw new Error('SQLITE_BUSY')
      return realPatch(id, patch)
    }

    const row = await service.tick(swap.id)
    expect(row.state).toBe('stuck')
    // The write was lost, which is bad — but it does not invent a refund
    // failure that never happened, and it never touches the one-way door.
    expect(row.refundAttempt ?? '').not.toContain('failed')
    expect(row.refundOutcome).toBeNull()
  })

  it('records a refund that THREW, instead of leaving the row silent', async () => {
    // The gap this closes, observed on mainnet: a 50,151-sat row parked in
    // `stuck` with a funded lockup, `refundOutcome` null, and the only evidence
    // in a log line that had scrolled away. `stuck` is excluded from
    // `findRefundable` on purpose — a false "failed" verdict plus an automatic
    // refund is a double payout — so nothing retries it and the OPERATOR is the
    // retry. They cannot be, if the row will not say what happened.
    const { swap } = await quoted()
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    ln.payResult = { id: 'pay-1', status: 'failed' }
    arkade.refund = async () => {
      throw new Error('arkade unreachable')
    }

    const row = await service.tick(swap.id)
    expect(row.state).toBe('stuck')
    // Says it was tried, and why it did not land.
    expect(row.refundAttempt).toContain('failed')
    expect(row.refundAttempt).toContain('arkade unreachable')
    // And still NOT recorded as refunded: `refundOutcome` is the one-way door
    // that tells the client their money came back, and it did not.
    expect(row.refundOutcome).toBeNull()
    expect(row.refundArkTxid).toBeNull()
  })

  it('distinguishes an empty script from a refund never attempted', async () => {
    // The lockup has to FUND for the swap to reach `paying` at all, and then be
    // gone by the time the refund reads it — a script already swept between the
    // two reads, which is the only way this branch is reachable in the wild.
    const { swap } = await quoted()
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    ln.payResult = { id: 'pay-1', status: 'failed' }
    const realFind = arkade.findLockups.bind(arkade)
    let reads = 0
    arkade.findLockups = async (pkScript: string) => (++reads === 1 ? realFind(pkScript) : [])

    const row = await service.tick(swap.id)
    expect(row.refundAttempt).toBe('nothing-at-script')
    // Still not `refunded`: one empty read is not proof the sats moved, which
    // is exactly why `refundOutcome` is left alone here.
    expect(row.refundOutcome).toBeNull()
  })

  // The same terminal fact, discovered one tick later. A payment that goes in
  // flight before it dies leaves `submitPayment` behind, so only the poll ever
  // sees the failure — and #46 wired the ordinary refund into the immediate
  // path alone. Without this the client waits out `refundLocktime` for a swap
  // the solver already knows is dead, which is the exact case #46 set out to
  // end.
  it('refunds a terminally failed payment the POLL discovered, exactly as the immediate one', async () => {
    const { swap } = await quoted()
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    // Inconclusive on the way out, terminal on the poll: the tick loop chains
    // through both, so the whole arc still lands in one call.
    ln.payResult = { id: 'pay-1', status: 'pending' }
    ln.payments.set('pay-1', { id: 'pay-1', status: 'failed' })

    const row = await service.tick(swap.id)
    // `stuck` for the same reason the immediate path uses it: `paid` is
    // EXPOSED, so an operator should still see that a payment died, even
    // though the client is now whole.
    // `refused` now: the client is whole and a `failed` verdict is terminal by
    // construction, so nothing is left for a human — see settleTerminalFailure.
    expect(row.state).toBe('refused')
    // The probe was asked and said "not ours", so this is the ORDINARY refund
    // rule rather than the self-payment exception.
    expect(ln.ownInvoiceCalls).toEqual([PAYMENT_HASH])
    expect(arkade.refundCalls).toHaveLength(1)
  })

  /**
   * Issue #41: paying an invoice OUR OWN node minted. The payment fails
   * terminally (LND will not route to itself), and the one place the sats
   * could have ended up is ours — so when our own node says it was never
   * paid, the lockup is refunded immediately through the non-interactive
   * covenant leaf instead of parking in `stuck` until `refundLocktime`.
   */
  describe('the self-payment exception', () => {
    /** Quote via the RFQ family (clientRefundPubkey present) — the extended, eight-leaf script. */
    const quotedExtended = async () => {
      const outcome = await service.quote(INVOICE, REFUND_ADDRESS, { clientRefundPubkey: key(7) })
      if (!outcome.accepted) throw new Error(`fixture quote refused: ${outcome.reason}`)
      return outcome
    }

    it('refunds the lockup IMMEDIATELY when our own node says it was never paid', async () => {
      const { swap } = await quotedExtended()
      arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
      ln.payResult = { id: 'pay-1', status: 'failed' }
      ln.ownInvoiceState = { status: 'pending', expiresAt: null, amountSats: AMOUNT }

      const row = await service.tick(swap.id)
      expect(row.state).toBe('refused')
      expect(row.failureReason).toContain('self-payment')
      expect(arkade.refundCalls).toHaveLength(1)
      expect(row.refundOutcome).toBe('pushed')
      expect(row.refundArkTxid).toBe('refund-txid')
    })

    it('applies on the POLLED failure path too, not just the immediate one', async () => {
      const { swap } = await quotedExtended()
      arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
      // The immediate answer is inconclusive; the poll is what turns failed —
      // and the tick loop chains straight through it, so the whole arc lands
      // in one call.
      ln.payResult = { id: 'pay-1', status: 'pending' }
      ln.payments.set('pay-1', { id: 'pay-1', status: 'failed' })
      ln.ownInvoiceState = { status: 'pending', expiresAt: null, amountSats: AMOUNT }

      const row = await service.tick(swap.id)
      expect(row.state).toBe('refused')
      expect(row.failureReason).toContain('self-payment')
      expect(arkade.refundCalls).toHaveLength(1)
      expect(row.refundOutcome).toBe('pushed')
    })

    it('stays stuck when the status is UNKNOWN — the probe vouches for nothing', async () => {
      const { swap } = await quotedExtended()
      arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
      ln.payResult = { id: 'pay-1', status: 'failed' }
      // A backend reporting a status this build has never compiled against.
      // This side's fail-safe is to WITHHOLD, and it needs no branch for the
      // value: the refund is released only on an exact `pending` or
      // `cancelled`, so anything else suppresses it. Pinned because that is
      // half of why `HoldStatus` can afford to refuse to guess — the other half
      // is the receive path, which acts only on an exact `armed`.
      ln.ownInvoiceState = { status: 'unknown', expiresAt: clock + 3600, amountSats: AMOUNT }

      const row = await service.tick(swap.id)
      expect(row.state).toBe('stuck')
      expect(arkade.refundCalls).toHaveLength(0)
    })

    it('stays stuck when our node holds an ARMED htlc — money may still be in play', async () => {
      const { swap } = await quotedExtended()
      arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
      ln.payResult = { id: 'pay-1', status: 'failed' }
      ln.ownInvoiceState = { status: 'armed', expiresAt: clock + 3600, amountSats: AMOUNT }

      const row = await service.tick(swap.id)
      expect(row.state).toBe('stuck')
      // Zero is a VETO, not merely the self-payment path declining. An armed
      // htlc against our own invoice may still settle, and the payer-side
      // "failed" cannot see it — so this is the one case where the probe
      // suppresses the ordinary terminal-failure refund as well. Refunding
      // here would hand back the lockup on a swap we might yet collect.
      expect(arkade.refundCalls).toHaveLength(0)
    })

    // The veto has to reach the POLLED path too, and that is newly load-bearing:
    // while the polled failure had no ordinary refund of its own, there was
    // nothing there for an armed htlc to suppress. Now that it refunds like the
    // immediate path, a veto that failed to apply here would hand back the
    // lockup on a swap our own node may yet settle — paying the client twice.
    it('vetoes the ordinary refund on the POLLED path too when an htlc is ARMED', async () => {
      const { swap } = await quotedExtended()
      arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
      ln.payResult = { id: 'pay-1', status: 'pending' }
      ln.payments.set('pay-1', { id: 'pay-1', status: 'failed' })
      ln.ownInvoiceState = { status: 'armed', expiresAt: clock + 3600, amountSats: AMOUNT }

      const row = await service.tick(swap.id)
      expect(row.state).toBe('stuck')
      expect(arkade.refundCalls).toHaveLength(0)
    })

    it('stays stuck when our node says the invoice SETTLED — a contradiction a human must read', async () => {
      const { swap } = await quotedExtended()
      arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
      ln.payResult = { id: 'pay-1', status: 'failed' }
      ln.ownInvoiceState = { status: 'settled', expiresAt: null, amountSats: AMOUNT }

      const row = await service.tick(swap.id)
      expect(row.state).toBe('stuck')
      // Vetoed for the same reason, and harder: our own node says this invoice
      // was PAID while the payer side says the payment failed. Exactly one of
      // those is wrong, and refunding the lockup on the strength of the losing
      // one would pay the client twice. A human reads it instead.
      expect(arkade.refundCalls).toHaveLength(0)
    })

    it('stays stuck when the probe cannot be asked — the verdict alone was never enough', async () => {
      const { swap } = await quotedExtended()
      arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
      ln.payResult = { id: 'pay-1', status: 'failed' }
      ln.getOwnInvoiceState = async () => {
        throw new Error('node unreachable')
      }

      const row = await service.tick(swap.id)
      // No `refused`: an unreachable probe vouches for nothing, so the narrow
      // self-payment exception stays shut.
      expect(row.state).toBe('stuck')
      // It does NOT veto the ordinary refund either. A probe that could not be
      // asked learned nothing about an htlc on our side — unlike the armed and
      // settled cases above, there is no positive evidence to withhold on, and
      // the payer-side proof stands on its own.
      expect(arkade.refundCalls).toHaveLength(1)
    })
  })

  it('refunds the client immediately instead of leaving them to wait out the deadline', async () => {
    const { swap } = await quoted()
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    ln.payResult = { id: 'pay-1', status: 'failed' }

    const row = await service.tick(swap.id)

    // The whole point: the sats go back NOW. `status: 'failed'` only ever comes
    // from LND's own terminal state, so the payment provably did not leave and
    // cannot later — there is nothing to wait for.
    expect(arkade.refundCalls).toHaveLength(1)
    expect(arkade.refundCalls[0]?.rowId).toBe(swap.id)
    expect(row.refundOutcome).toBe('pushed')
    expect(row.refundArkTxid).toBe('refund-txid')
    // Still stuck: the client is whole, but a terminal payment failure is an
    // operator's business.
    // `refused` now: the client is whole and a `failed` verdict is terminal by
    // construction, so nothing is left for a human — see settleTerminalFailure.
    expect(row.state).toBe('refused')
  })

  it('reports that swap to the CLIENT as refunded, not stuck', async () => {
    const { swap } = await quoted()
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    ln.payResult = { id: 'pay-1', status: 'failed' }
    await service.tick(swap.id)

    // Telling someone their swap is stuck when their money is already back is
    // the answer most likely to make them act on a problem they do not have.
    expect(rfqStateFromRow(await store.get(swap.id))).toBe('refunded')
  })

  it('reports a POLLED failure to the client as refunded too', async () => {
    const { swap } = await quoted()
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    ln.payResult = { id: 'pay-1', status: 'pending' }
    ln.payments.set('pay-1', { id: 'pay-1', status: 'failed' })
    await service.tick(swap.id)

    // The client's question is only ever "where is my money", and the answer is
    // the same whichever call spotted the failure.
    expect(rfqStateFromRow(await store.get(swap.id))).toBe('refunded')
  })

  describe('what the rail said about the fill', () => {
    it('records the backend’s verdict on the row', async () => {
      const { swap } = await quoted()
      arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
      ln.payResult = { id: 'pay-1', status: 'pending' }
      ln.payments.set('pay-1', { id: 'pay-1', status: 'pending', evidence: 'in_flight' })

      await service.tick(swap.id)
      expect((await store.get(swap.id)).paymentEvidence).toBe('in_flight')
    })

    // The distinction the operator actually needed: "nobody could route to them"
    // and "someone else had already settled this invoice" are the same row, in
    // the same state, carrying the same failure sentence. Only the rail can tell
    // them apart, and it was being thrown away.
    it('records WHY the rail failed, separately from our own account of it', async () => {
      const { swap } = await quoted()
      arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
      ln.payResult = { id: 'pay-1', status: 'pending' }
      ln.payments.set('pay-1', {
        id: 'pay-1',
        status: 'failed',
        evidence: 'terminal',
        failureReason: 'rejected_by_destination',
      })
      await service.tick(swap.id)

      const row = await store.get(swap.id)
      expect(row.paymentFailureReason).toBe('rejected_by_destination')
      // Ours stays ours. They are facts about different things — what the rail
      // reported about the payment, and what we concluded about the swap — and
      // collapsing them into one column loses a diagnosis.
      expect(row.failureReason).toContain('lightning payment failed terminally')
    })

    it('carries both to the client WITHOUT inventing a new lifecycle state', async () => {
      const { swap } = await quoted()
      arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
      ln.payResult = { id: 'pay-1', status: 'pending' }
      ln.payments.set('pay-1', {
        id: 'pay-1',
        status: 'failed',
        evidence: 'terminal',
        failureReason: 'rejected_by_destination',
      })
      await service.tick(swap.id)

      const payload = rfqStatusPayload(await store.get(swap.id), 'rfq-1')
      const profile = payload.profile as Record<string, unknown>
      // § 8's vocabulary is shared by every corridor and clients switch on it,
      // so this rides in the profile where an older client ignores it.
      // `refunded` because the polled terminal failure now refunds.
      expect(payload.state).toBe('refunded')
      expect(profile.payment_evidence).toBe('terminal')
      expect(profile.payment_failure_reason).toBe('rejected_by_destination')
    })

    it('says nothing a backend never offered', async () => {
      const { swap } = await quoted()
      arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
      ln.payResult = { id: 'pay-1', status: 'pending' }
      ln.payments.set('pay-1', { id: 'pay-1', status: 'pending' })
      await service.tick(swap.id)

      const profile = rfqStatusPayload(await store.get(swap.id), 'rfq-1').profile as Record<string, unknown>
      expect('payment_evidence' in profile).toBe(false)
      expect('payment_failure_reason' in profile).toBe(false)
    })
  })

  it('does not claim a refund it could not push', async () => {
    const { swap } = await quoted()
    // Funded per the row, but nothing spendable at the script by the time we
    // look — the one-way-door case refundSweep documents. Recording `pushed`
    // here would tell a client they were refunded when they were not.
    arkade.lockups = []
    await store.transition(swap.id, 'quoted', 'funded', { lockup_value: AMOUNT })
    ln.payResult = { id: 'pay-1', status: 'failed' }

    const row = await service.tick(swap.id)
    expect(row.state).toBe('stuck')
    expect(row.refundOutcome).toBeNull()
    expect(arkade.refundCalls).toHaveLength(0)
  })

  it('still records the failure when the refund push throws', async () => {
    const { swap } = await quoted()
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    arkade.refund = async () => {
      throw new Error('emulator unreachable')
    }
    ln.payResult = { id: 'pay-1', status: 'failed' }

    // Best effort: a refund that cannot be pushed must not stop the row being
    // recorded, or a transient emulator outage would leave the swap in `paying`
    // and re-attempt the payment forever.
    const row = await service.tick(swap.id)
    expect(row.state).toBe('stuck')
    expect(row.refundOutcome).toBeNull()
  })

  it('resumes a swap that died mid-payment by reusing the idempotency key', async () => {
    // Simulate the worst crash: state committed to `paying`, process died
    // before the backend's response was recorded. No payment id on disk.
    const { swap } = await quoted()
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    await store.transition(swap.id, 'quoted', 'funded', { lockup_value: AMOUNT })
    await store.transition(swap.id, 'funded', 'paying', {
      pay_attempted_at: clock,
      idempotency_key: `swap-${PAYMENT_HASH}`,
    })
    ln.payments.set('pay-1', { id: 'pay-1', status: 'pending' })

    const row = await service.tick(swap.id)
    expect(row.state).toBe('paid')
    expect(ln.payCalls).toHaveLength(1)
    expect(ln.payCalls[0]?.idempotencyKey).toBe(`swap-${PAYMENT_HASH}`)
  })

  it('refuses to re-submit a mid-payment row after the rail lost its CLTV ceiling', async () => {
    // The crash-recovery door into the rail-change hole. `whenFunded` asks
    // `evaluateSendPayment` before committing to `paying`; `whenPaying` asks
    // nothing — it re-submits — so a row that died between the transition and
    // `payInvoice` is paid by whatever backend the process came back up with.
    // A crash is exactly when a deployment gets restarted, and a restart is
    // when LN_BACKEND changes.
    //
    // Quoted while the rail could cap the route, so the deadline was sized off
    // the BEST hint of a Wallet of Satoshi shape.
    const badAlternate = forgeInvoiceWithPreimage({
      network: 'bc',
      amountSats: AMOUNT,
      timestamp: INVOICE_TIMESTAMP,
      expirySeconds: 6 * 3600,
      minFinalCltvBlocks: 60,
      routeHints: [[40], [800]],
    })
    const outcome = await service.quote(badAlternate.invoice, REFUND_ADDRESS, {
      clientRefundPubkey: CLIENT_REFUND_PUBKEY,
    })
    if (!outcome.accepted) throw new Error(`quote refused: ${outcome.reason}`)
    const swap = outcome.swap
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    await store.transition(swap.id, 'quoted', 'funded', { lockup_value: AMOUNT })
    await store.transition(swap.id, 'funded', 'paying', { idempotency_key: `swap-${swap.paymentHash}` })

    // The deployment comes back on a rail that caps nothing.
    ln.enforcesRouteCltv = false
    ln.routeCltvBudgetBlocks = UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS
    // Non-vacuous: the deadline this row carries cannot hold what that rail may
    // now build, which is the whole reason re-submitting is unsafe.
    expect(
      deadlineContainsHtlc(cltvOf(60, 800, UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS, false), swap.refundLocktime, clock),
    ).toBe(false)

    // What this test is actually for: the rail changed under the row, so it
    // must NOT re-submit. That is `payCalls`, and it is unchanged.
    //
    // The disposal is `refused` rather than `stuck` because this backend HAS a
    // probe and it answered "nothing committed" — see the test below, and the
    // one after it for the backend that cannot be asked and so still parks.
    const row = await service.tick(swap.id)
    expect(row.state).toBe('refused')
    expect(row.failureReason).toContain('uncapped_route_deadline_too_short')
    expect(ln.payCalls).toHaveLength(0)
  })

  it('refunds a route-deadline refusal the probe proves was never submitted', async () => {
    // `whenPaying` reaches `submitPayment` only AFTER `getSendHtlcState` has
    // answered "nothing committed" for this hash, so a refusal here provably
    // paid nothing out. `store.fail`'s EXPOSED rule parked it in `stuck`
    // anyway, and `findRefundable` excludes `stuck` — so the one refusal that
    // is least ambiguous was the one nothing ever refunded.
    const badAlternate = forgeInvoiceWithPreimage({
      network: 'bc',
      amountSats: AMOUNT,
      timestamp: INVOICE_TIMESTAMP,
      expirySeconds: 6 * 3600,
      minFinalCltvBlocks: 60,
      routeHints: [[40], [800]],
    })
    const outcome = await service.quote(badAlternate.invoice, REFUND_ADDRESS, {
      clientRefundPubkey: CLIENT_REFUND_PUBKEY,
    })
    if (!outcome.accepted) throw new Error(`quote refused: ${outcome.reason}`)
    const swap = outcome.swap
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    await store.transition(swap.id, 'quoted', 'funded', { lockup_value: AMOUNT })
    await store.transition(swap.id, 'funded', 'paying', { idempotency_key: `swap-${swap.paymentHash}` })

    ln.enforcesRouteCltv = false
    ln.routeCltvBudgetBlocks = UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS
    // The fact that makes the refund safe, set explicitly rather than relied on
    // as a default: the probe RAN and found nothing committed.
    ln.sendHtlc = null

    const row = await service.tick(swap.id)
    expect(ln.sendHtlcCalls).toEqual([swap.paymentHash])
    expect(row.state).toBe('refused')
    expect(row.failureReason).toContain('uncapped_route_deadline_too_short')
    expect(ln.payCalls).toHaveLength(0)

    // The point of the whole change: the sweep takes it unattended, with no
    // operator and no wait for `refundLocktime`.
    expect(clock).toBeLessThan(row.refundLocktime)
    expect(await service.refundSweep()).toEqual([row.id])
    expect((await store.get(row.id)).refundOutcome).toBe('pushed')
  })

  it('still parks a route-deadline refusal on a backend that has no probe', async () => {
    // The other half of `nothingCommitted`, and why it is the CALLER's fact
    // rather than one read off the row. A backend with no `getSendHtlcState`
    // has contradicted nothing — its silence is not "holds nothing" — so the
    // attempt that died may well have paid, and refunding on that would be the
    // empty read recorded as a refund. Keeps `lnd` and `fake` where they were.
    const withoutProbe = {
      routeCltvBudgetBlocks: UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS,
      enforcesRouteCltv: false,
      payInvoice: (p: PayInvoiceParams) => ln.payInvoice(p),
      getPayment: (id: string) => ln.getPayment(id),
      getOwnInvoiceState: (h: string) => ln.getOwnInvoiceState(h),
    }
    const svc = new SendSwapService({
      store,
      ln: withoutProbe,
      arkade,
      limits: { minSats: 500, maxSats: 10_000 },
      invoicePrefix: 'bc',
      maxExposedSats: 5_000,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      now: () => clock,
    })

    // Quoted on the CAPPING rail, so the deadline is sized short; ticked on the
    // uncapped one, which is the rail-change this gate exists for.
    const badAlternate = forgeInvoiceWithPreimage({
      network: 'bc',
      amountSats: AMOUNT,
      timestamp: INVOICE_TIMESTAMP,
      expirySeconds: 6 * 3600,
      minFinalCltvBlocks: 60,
      routeHints: [[40], [800]],
    })
    const outcome = await service.quote(badAlternate.invoice, REFUND_ADDRESS, {
      clientRefundPubkey: CLIENT_REFUND_PUBKEY,
    })
    if (!outcome.accepted) throw new Error(`quote refused: ${outcome.reason}`)
    const swap = outcome.swap
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    await store.transition(swap.id, 'quoted', 'funded', { lockup_value: AMOUNT })
    await store.transition(swap.id, 'funded', 'paying', { idempotency_key: `swap-${swap.paymentHash}` })

    const row = await svc.tick(swap.id)
    expect(row.state).toBe('stuck')
    expect(row.failureReason).toContain('uncapped_route_deadline_too_short')
    expect(ln.payCalls).toHaveLength(0)
    // And the sweep leaves it exactly there, for a human.
    expect(await svc.refundSweep()).toEqual([])
    expect(arkade.refundCalls).toHaveLength(0)
  })

  it('re-submits a mid-payment row on a rail that still caps the route', async () => {
    // The other side of the same gate, so it cannot be read as "recovery is
    // refused when the deadline is tight". Nothing changed under this row, and
    // the ceiling is enforced, so the crash-recovery path pays exactly as it did.
    const outcome = await service.quote(FORGED.invoice, REFUND_ADDRESS, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })
    if (!outcome.accepted) throw new Error(`forged quote refused: ${outcome.reason}`)
    const swap = outcome.swap
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    await store.transition(swap.id, 'quoted', 'funded', { lockup_value: AMOUNT })
    await store.transition(swap.id, 'funded', 'paying', { idempotency_key: `swap-${swap.paymentHash}` })
    ln.payments.set('pay-1', { id: 'pay-1', status: 'pending' })

    expect((await service.tick(swap.id)).state).toBe('paid')
    expect(ln.payCalls).toHaveLength(1)
  })

  it('resumes a swap that died after payment by polling the recorded id', async () => {
    const outcome = await service.quote(FORGED.invoice, REFUND_ADDRESS, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })
    if (!outcome.accepted) throw new Error(`forged quote refused: ${outcome.reason}`)
    const swap = outcome.swap
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    await store.transition(swap.id, 'quoted', 'funded', { lockup_value: AMOUNT })
    await store.transition(swap.id, 'funded', 'paying', { idempotency_key: `swap-${swap.paymentHash}` })
    await store.patch(swap.id, { payment_id: 'pay-9' })
    ln.payments.set('pay-9', { id: 'pay-9', status: 'succeeded', preimage: FORGED_PREIMAGE })

    const row = await service.tick(swap.id)
    expect(row.state).toBe('claimed')
    // Recovered via getPayment, never a second payInvoice.
    expect(ln.payCalls).toHaveLength(0)
  })

  /** Put a swap in `claiming` with a preimage, at the given clock. */
  const claiming = async () => {
    const { swap } = await quoted()
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    await store.transition(swap.id, 'quoted', 'funded', { lockup_value: AMOUNT })
    await store.transition(swap.id, 'funded', 'paying', { idempotency_key: 'k' })
    await store.transition(swap.id, 'paying', 'paid', { payment_id: 'pay-1' })
    await store.transition(swap.id, 'paid', 'claiming', { preimage: 'cc'.repeat(32) })
    return store.get(swap.id)
  }

  it('never records claimed from an empty script — we hold no claim txid to prove it', async () => {
    // The loss the review found: findLockups returns [] for a swept, renewed or
    // lagging vtxo just as it does after our own spend, so "empty" is not proof
    // our claim landed. Booking it `claimed` (no txid) buries a full-amount loss.
    // Empty-while-claiming always routes to `stuck` for a human, at any clock.
    const row = await claiming()
    arkade.lockups = []
    expect(clock).toBeLessThan(row.refundLocktime) // even BEFORE the deadline

    const done = await service.tick(row.id)
    expect(done.state).toBe('stuck')
    expect(done.claimArkTxid).toBeNull()
    expect(done.failureReason).toContain('no claim txid')
    expect(arkade.claimCalls).toHaveLength(0)
  })

  it('records claimed only with our own claim txid in hand', async () => {
    // The one path that reaches `claimed`: funds present, the collaborative
    // claim runs and returns a txid.
    const row = await claiming()
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]

    const done = await service.tick(row.id)
    expect(done.state).toBe('claimed')
    expect(done.claimArkTxid).toBe('claim-txid')
    expect(arkade.claimCalls).toHaveLength(1)
  })

  it('keeps retrying a failing claim BEFORE the deadline', async () => {
    const row = await claiming()
    arkade.claim = async () => {
      throw new Error('arkade server briefly unreachable')
    }
    const errors: string[] = []
    service.onTickError = (id) => errors.push(id)

    await service.tickAll()
    // Still claiming, error surfaced, will retry next sweep.
    expect((await store.get(row.id)).state).toBe('claiming')
    expect(errors).toEqual([row.id])
  })

  it('escalates a claim that keeps failing PAST the deadline to stuck', async () => {
    // No server-independent exit exists, so looping the collaborative claim past
    // the deadline cannot win the race with the client refund. Surface it.
    const row = await claiming()
    clock = row.refundLocktime + 1
    arkade.claim = async () => {
      throw new Error('arkade server censoring the claim')
    }
    const done = await service.tick(row.id)
    expect(done.state).toBe('stuck')
    expect(done.failureReason).toContain('past the refund deadline')
  })
})

describe('refundSweep', () => {
  /** Drive a quoted fixture swap into `refused` with money still at the script. */
  const refusedWithLockup = async () => {
    const { swap } = await quoted()
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    clock = INVOICE_EXPIRES_AT + 1
    const row = await service.tick(swap.id)
    expect(row.state).toBe('refused')
    return row
  }

  it('sweeps an EXTENDED row immediately — its refund leaf carries no timelock', async () => {
    // A pre-payment refusal provably paid nothing out, and the RFQ family's
    // non-interactive leaf (server + receiver + emulator) has no CLTV to wait
    // for. Deferring it to `refundLocktime` parked the client's sats for days
    // on the one failure that is least ambiguous — while a failure AFTER a
    // payment attempt already refunds at once (`refundAfterTerminalFailure`).
    const outcome = await service.quote(INVOICE, REFUND_ADDRESS, { clientRefundPubkey: key(7) })
    if (!outcome.accepted) throw new Error(`fixture quote refused: ${outcome.reason}`)
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    clock = INVOICE_EXPIRES_AT + 1
    const row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('refused')

    // Nowhere near the deadline — that is the whole point.
    expect(clock).toBeLessThan(row.refundLocktime)
    expect(await service.refundSweep()).toEqual([row.id])
    expect(arkade.refundCalls).toHaveLength(1)
    expect((await store.get(row.id)).refundOutcome).toBe('pushed')
  })

  it('pushes the covenant refund, records the txid, and never pushes twice', async () => {
    // The deadline half of this test is gone with the base three-leaf script.
    // It asserted that a refused row waits for `refundLocktime` — true only of
    // the legacy shape, whose refund leaf carried a CLTV. Every row is now the
    // extended shape, whose non-interactive leaf has no timelock, so the sweep
    // takes it at once; that is pinned by "sweeps an EXTENDED row immediately"
    // above. What still needs pinning is what the push RECORDS, and that it
    // happens exactly once.
    const row = await refusedWithLockup()

    expect(await service.refundSweep()).toEqual([row.id])
    expect(arkade.refundCalls).toHaveLength(1)
    expect((await store.get(row.id)).refundArkTxid).toBe('refund-txid')

    // and never twice
    expect(await service.refundSweep()).toEqual([])
    expect(arkade.refundCalls).toHaveLength(1)
  })

  it('closes the row without a push when someone else already moved the funds', async () => {
    const row = await refusedWithLockup()
    clock = row.refundLocktime + 1
    arkade.lockups = []
    // The spend is readable — that is what makes this an external refund
    // rather than a read that is merely behind.
    arkade.lockupsSpent = true
    expect(await service.refundSweep()).toEqual([])
    expect(arkade.refundCalls).toHaveLength(0)
    const closed = await store.get(row.id)
    // The outcome discriminator records it; the txid column never carries a sentinel.
    expect(closed.refundOutcome).toBe('external')
    expect(closed.refundArkTxid).toBeNull()
  })

  it('leaves the row alone when the lockup reads empty but no spend is provable', async () => {
    const row = await refusedWithLockup()
    clock = row.refundLocktime + 1
    // ONE STALE READ and nothing else wrong: the `spendableOnly` view answers
    // empty while every sat is still at the script, so no spend is provable.
    arkade.lockups = []
    arkade.lockupsSpent = false

    expect(await service.refundSweep()).toEqual([])
    expect(arkade.refundCalls).toHaveLength(0)

    // NOT written off. `findRefundable` filters `refund_outcome IS NULL`, so
    // an `external` here would be a one-way door — the row would never be
    // looked at again, and `rfqStateFromRow` would report the swap `refunded`
    // to a client whose money never moved.
    const after = await store.get(row.id)
    expect(after.refundOutcome).toBeNull()
    expect(after.refundArkTxid).toBeNull()
  })

  it('pushes the refund on the next sweep once the stale read resolves', async () => {
    const row = await refusedWithLockup()
    clock = row.refundLocktime + 1
    const lockups = arkade.lockups
    arkade.lockups = []
    expect(await service.refundSweep()).toEqual([])

    // The view catches up and the money is exactly where it always was. The
    // row must still be ELIGIBLE for this to be reachable at all — which is
    // the half of the defect the store's filter owns.
    arkade.lockups = lockups
    expect(await service.refundSweep()).toEqual([row.id])
    expect(arkade.refundCalls).toHaveLength(1)
    expect((await store.get(row.id)).refundOutcome).toBe('pushed')
  })

  it('keeps retrying when the push fails, rather than marking anything', async () => {
    const row = await refusedWithLockup()
    clock = row.refundLocktime + 1
    arkade.refund = async () => {
      throw new Error('FORFEIT_CLOSURE_LOCKED')
    }
    const errors: string[] = []
    service.onTickError = (id) => errors.push(id)

    expect(await service.refundSweep()).toEqual([])
    expect(errors).toEqual([row.id])
    expect((await store.get(row.id)).refundArkTxid).toBeNull()
  })

  it('ignores swaps that never had a lockup', async () => {
    const { swap } = await quoted()
    clock += 16 * 60 // lockup timeout, nothing funded
    await service.tick(swap.id)
    expect((await store.get(swap.id)).state).toBe('refused')

    clock = (await store.get(swap.id)).refundLocktime + 1
    expect(await service.refundSweep()).toEqual([])
    expect(arkade.refundCalls).toHaveLength(0)
  })

  it('never auto-refunds a stuck swap — it may have been paid', async () => {
    // A stuck swap reached failure THROUGH an exposed state (its invoice may
    // have been paid). Pushing its refund would hand the client the lockup on a
    // swap the provider could still claim — a certain double loss. It goes to a
    // human, never the automatic sweep.
    const { swap } = await quoted()
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    await store.transition(swap.id, 'quoted', 'funded', { lockup_value: AMOUNT })
    await store.transition(swap.id, 'funded', 'paying', { idempotency_key: 'k' })
    await store.transition(swap.id, 'paying', 'paid', { payment_id: 'p' })
    await store.fail(swap.id, 'paid', 'claim blocked by an arkade outage') // -> stuck
    expect((await store.get(swap.id)).state).toBe('stuck')

    clock = (await store.get(swap.id)).refundLocktime + 1
    expect(await service.refundSweep()).toEqual([])
    expect(arkade.refundCalls).toHaveLength(0)
  })
})

describe('tickHot', () => {
  it('drives a swap waiting on its preimage but leaves one waiting on the client', async () => {
    // A: funded and ready to pay, but waiting on client action — the full
    // sweep's job, not the hot loop's.
    const waiting = await quoted()
    // B: already paying, so the provider is exposed until it claims.
    const exposed = await service.quote(FORGED.invoice, REFUND_ADDRESS, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })
    if (!exposed.accepted) throw new Error(`forged quote refused: ${exposed.reason}`)
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    ln.payments.set('pay-1', { id: 'pay-1', status: 'pending' })
    expect((await service.tick(exposed.swap.id)).state).toBe('paid')

    // The preimage lands between sweeps: the hot loop must not wait for one.
    ln.payments.set('pay-1', { id: 'pay-1', status: 'succeeded', preimage: FORGED_PREIMAGE })
    const driven = await service.tickHot()

    expect(driven.map((r) => r.id)).toEqual([exposed.swap.id])
    expect((await store.get(exposed.swap.id)).state).toBe('claimed')
    // A never moved, despite its lockup being visible and payable.
    expect((await store.get(waiting.swap.id)).state).toBe('quoted')
  })

  it('costs nothing when no swap has money in flight', async () => {
    await quoted()
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]

    expect(await service.tickHot()).toEqual([])
    expect(ln.payCalls).toHaveLength(0)
    expect(arkade.claimCalls).toHaveLength(0)
  })
})

/**
 * The tracker and the loop it is supposed to slow down, driven TOGETHER.
 *
 * `test/ops/tickErrors.test.ts` proves `TickErrorTracker` escalates in
 * isolation. Nothing proved it escalated once wired to an orchestrator, and it
 * did not: `driveRows` returns rows that were held off and rows whose tick
 * THREW alongside rows that advanced, so the host's clear loop deleted the
 * backoff that had just been recorded. The whole feature was inert, and every
 * test passed.
 */
describe('a swap that fails identically on every hot tick', () => {
  const HOT_TICK_MS = 250
  /** The mainnet observation this exists for: 96 lines in 36 seconds. */
  const RUN_MS = 28_000

  /**
   * A `paid` row whose backend cannot answer — the first mainnet fault
   * verbatim. Nothing about the row changes, so the hot loop re-selects it
   * every 250ms for as long as the outage lasts.
   */
  const wedgedOnBackend = async (): Promise<{ id: string; attempts: () => number }> => {
    const exposed = await service.quote(FORGED.invoice, REFUND_ADDRESS, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })
    if (!exposed.accepted) throw new Error(`forged quote refused: ${exposed.reason}`)
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    ln.payments.set('pay-1', { id: 'pay-1', status: 'pending' })
    expect((await service.tick(exposed.swap.id)).state).toBe('paid')

    let attempts = 0
    ln.getPayment = async () => {
      attempts += 1
      throw new Error('BackendSdkError: authentication error: network error')
    }
    return { id: exposed.swap.id, attempts: () => attempts }
  }

  it('is asked once per backoff step, not once per tick', async () => {
    const { attempts } = await wedgedOnBackend()

    // The tracker's own clock, in ms. The service clock is in seconds and
    // deliberately frozen: the row must stay `paid` for the whole run.
    let nowMs = 0
    const tracker = new TickErrorTracker(() => nowMs)
    const lines: string[] = []
    service.onTickError = (id, error) => {
      const { line } = tracker.record(id, error)
      if (line !== null) lines.push(line)
    }
    service.onTickSuccess = (id) => tracker.clear(id)
    service.shouldSkipTick = (id) => tracker.shouldSkip(id)

    for (let elapsed = 0; elapsed < RUN_MS; elapsed += HOT_TICK_MS) {
      await service.tickHot()
      nowMs += HOT_TICK_MS
    }

    // 112 tick opportunities. The ladder lets six through — at 0, 500, 1500,
    // 3500, 7500 and 15500ms — because each failure doubles the delay before
    // the next is allowed.
    expect(attempts()).toBe(6)
    // And it says so three times, not ninety-six: reported on the 1st, 2nd and
    // 4th consecutive failure, each line carrying the count since the last.
    expect(lines).toHaveLength(3)
  })

  /**
   * The hold-off is for the SWEEP, which re-asks on a timer. A human who has
   * just fixed the backend and pressed `recheck` is not re-asking on a timer,
   * and must not be told to come back in a minute.
   */
  it('still ticks on demand while the sweep is holding the swap off', async () => {
    const { id, attempts } = await wedgedOnBackend()

    let nowMs = 0
    const tracker = new TickErrorTracker(() => nowMs)
    service.onTickError = (swapId, error) => void tracker.record(swapId, error)
    service.onTickSuccess = (swapId) => tracker.clear(swapId)
    service.shouldSkipTick = (swapId) => tracker.shouldSkip(swapId)

    await service.tickHot()
    expect(attempts()).toBe(1)
    expect(tracker.shouldSkip(id)).toBe(true)

    // The sweep declines, as it should.
    nowMs += HOT_TICK_MS
    await service.tickHot()
    expect(attempts()).toBe(1)

    // The operator does not. This is `actions.ts`'s recheck, the lockup-watcher
    // callback, and a one-shot CLI tick — all of which call `tick` directly.
    await expect(service.tick(id)).rejects.toThrow('authentication error')
    expect(attempts()).toBe(2)
  })
})

describe('tickAll', () => {
  it('drives every non-terminal swap and survives one of them throwing', async () => {
    const { swap } = await quoted()
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    // A second, corrupt swap whose arkade lookups explode.
    await store.insertQuote({
      id: 'broken',
      invoice: 'lnbc...',
      paymentHash: 'e'.repeat(64),
      amountSats: 500,
      invoiceExpiresAt: clock + 3600,
      refundLocktime: clock + 7200,
      senderPubkey: key(1),
      receiverPubkey: key(1),
      serverPubkey: key(3),
      claimDelay: 4096,
      refundDelay: 4608,
      refundWithoutReceiverDelay: 5120,
      pkScript: 'not-a-script',
      lockupAddress: 'ark1qbroken',
      nonInteractiveParameters: true,
    })
    const originalFind = arkade.findLockups
    arkade.findLockups = async (pkScript) => {
      if (pkScript === 'not-a-script') throw new Error('indexer choked')
      return originalFind(pkScript)
    }
    ln.payments.set('pay-1', { id: 'pay-1', status: 'pending' })

    const errors: string[] = []
    service.onTickError = (id) => errors.push(id)
    const rows = await service.tickAll()

    expect(rows.find((r) => r.id === swap.id)?.state).toBe('paid')
    // The broken one kept its state and was reported, not silently dropped.
    expect(rows.find((r) => r.id === 'broken')?.state).toBe('quoted')
    expect(errors).toEqual(['broken'])
  })

  it('honors a configured sweepConcurrency instead of the hardcoded default', async () => {
    const localService = new SendSwapService({
      store,
      ln,
      arkade,
      limits: { minSats: 500, maxSats: 10_000 },
      invoicePrefix: 'bc',
      maxExposedSats: 50_000,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      now: () => clock,
      sweepConcurrency: 2,
    })
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    // Four independent swaps, all sitting in `paying` — tickAll's next step
    // for every one of them is ln.payInvoice, so the sweep must fan out across
    // all four, capped at sweepConcurrency rather than the module's default of 8.
    for (let i = 0; i < 4; i++) {
      const forged = forgeInvoiceWithPreimage({
        network: 'bc',
        amountSats: AMOUNT,
        timestamp: INVOICE_TIMESTAMP,
        expirySeconds: 6 * 3600,
      })
      const outcome = await localService.quote(forged.invoice, REFUND_ADDRESS, {
        clientRefundPubkey: CLIENT_REFUND_PUBKEY,
      })
      if (!outcome.accepted) throw new Error(`fixture quote refused: ${outcome.reason}`)
      await store.transition(outcome.swap.id, 'quoted', 'funded', { lockup_value: AMOUNT })
      await store.transition(outcome.swap.id, 'funded', 'paying', {
        idempotency_key: `swap-${outcome.swap.paymentHash}`,
      })
    }

    let inFlight = 0
    let maxInFlight = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    ln.payInvoice = async (params) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await gate
      inFlight--
      return { id: `pay-${params.idempotencyKey}`, status: 'pending' }
    }

    const sweep = localService.tickAll()
    await vi.waitFor(() => expect(inFlight).toBe(2))
    // Give any excess (incorrect) fan-out a chance to happen before asserting
    // the ceiling held — a bug here would show up as a THIRD call landing.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(inFlight).toBe(2)

    release()
    await sweep

    expect(maxInFlight).toBe(2)
  })
})

/**
 * The self-payment refresh — see
 * docs/superpowers/specs/2026-08-12-self-payment-refresh-design.md.
 *
 * A client who quotes lightning:BTC->arkade:BTC and then arkade:BTC->lightning:BTC
 * against that same bolt11 is refreshing Arkade funds through us. Its hash is
 * live in our own receive store, which the cross-corridor guard above refuses.
 * That refusal stays right for every OTHER corridor; this is the one exception.
 */
describe('coupling a self-payment at quote time', () => {
  /** `Ds`: what a quote taken at `clock` commits to, on the fixture invoice. */
  const sendRefundLocktime = (): number =>
    refundLocktimeFor(cltvOf(180, decodeInvoice(INVOICE).worstRouteHintCltvBlocks), 4096, clock)

  /** Hashes the coupled store was asked about — proof the path ran at all. */
  let consulted: string[]
  beforeEach(() => {
    consulted = []
  })

  const withCoupledReceive = (row: CoupledReceiveRow | null): SendSwapService =>
    new SendSwapService({
      store,
      ln,
      arkade,
      limits: { minSats: 500, maxSats: 10_000 },
      invoicePrefix: 'bc',
      maxExposedSats: 5_000,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      now: () => clock,
      coupling: {
        receiveStore: {
          findLiveByPaymentHash: async (hash) => {
            consulted.push(hash)
            return hash === PAYMENT_HASH ? row : null
          },
        },
        findLockupOutpoints: async () => arkade.receiveOutpoints,
        findClaimPreimage: async () => arkade.receivePreimage,
      },
    })

  /** A receive row whose `Dr` sits exactly one claim window below our `Ds`. */
  const safeRow = (over: Partial<CoupledReceiveRow> = {}): CoupledReceiveRow => ({
    state: 'quoted',
    // The bolt11 THIS row minted, and the one every quote below is made
    // against: a coupling is our own invoice handed back, so a fake carrying
    // any other string would be modelling a request the gate now refuses.
    invoice: INVOICE,
    refundLocktime: sendRefundLocktime() - MIN_CLAIM_WINDOW,
    pkScript: hex.encode(Uint8Array.from([0x51, 0x20, ...keyBytes(7)])),
    htlcExpiresAt: null,
    ...over,
  })

  it('couples a live, still-quoted receive row on the same hash', async () => {
    // The request that returned quote_conflict before this existed.
    const outcome = await withCoupledReceive(safeRow()).quote(INVOICE, REFUND_ADDRESS, {
      clientRefundPubkey: CLIENT_REFUND_PUBKEY,
    })
    expect(outcome.accepted).toBe(true)
    // Asserted because acceptance ALONE is what an unwired dep produces: with
    // no peer store set this quote is accepted whether or not the coupling
    // path exists. Consulting the store is the part only the feature does.
    expect(consulted).toContain(PAYMENT_HASH)
  })

  it('still refuses once the receive row has armed', async () => {
    // An armed row took a REAL htlc from somewhere: a genuine conflict, not a
    // self-payment. Coupling must never override it.
    const outcome = await withCoupledReceive(safeRow({ state: 'armed' })).quote(INVOICE, REFUND_ADDRESS, {
      clientRefundPubkey: CLIENT_REFUND_PUBKEY,
    })
    expect(outcome).toEqual({ accepted: false, reason: 'duplicate_swap' })
  })

  it('refuses a coupling against a bolt11 we did not mint', async () => {
    // The hash is NOT proof of a coupling. On the receive corridor `H` is
    // client-chosen, so the client knows `P` from the start and can mint an
    // invoice on that hash for any amount they like. Cheaper than the receive
    // quote is the whole exploit: we fund their payout in full and the only
    // thing left to collect is a lockup sized to this invoice instead.
    //
    // Same hash, same final CLTV — so the deadline gate is satisfied and the
    // ONLY thing left to refuse on is that this is not our bolt11.
    const cheap = forgeInvoice({
      network: 'bc',
      amountSats: 600,
      paymentHash: hex.decode(PAYMENT_HASH),
      timestamp: INVOICE_TIMESTAMP,
      expirySeconds: 43_200,
      minFinalCltvBlocks: 180,
    })
    const outcome = await withCoupledReceive(safeRow()).quote(cheap, REFUND_ADDRESS, {
      clientRefundPubkey: CLIENT_REFUND_PUBKEY,
    })
    // Its own reason, so a log says WHICH coupling gate refused. What the
    // client is told is unchanged: `toRfqReason` folds this and
    // `duplicate_swap` alike to `quote_conflict` — asserted in
    // `test/wire/rfqRefusalReason.test.ts` so the two cannot drift apart.
    expect(outcome).toEqual({ accepted: false, reason: 'coupled_invoice_mismatch' })
  })

  it('refuses a coupling whose deadlines do not clear the claim window', async () => {
    // One second short: the client could refund their lockup the moment Ds
    // opens and only THEN claim our payout, still before Dr — both sides.
    const row = safeRow({ refundLocktime: sendRefundLocktime() - MIN_CLAIM_WINDOW + 1 })
    const outcome = await withCoupledReceive(row).quote(INVOICE, REFUND_ADDRESS, {
      clientRefundPubkey: CLIENT_REFUND_PUBKEY,
    })
    // Not `duplicate_swap`: the request was legitimate, and the deadline — not
    // a conflict — is the reason it cannot be served.
    expect(outcome).toEqual({ accepted: false, reason: 'coupled_deadline_unsafe' })
  })

  it('still refuses a hash live in an opaque peer store', async () => {
    // The guard's original job, untouched: `peerStores` cannot say WHICH
    // corridor answered, so every hit it reports stays a refusal.
    const svc = new SendSwapService({
      store,
      ln,
      arkade,
      limits: { minSats: 500, maxSats: 10_000 },
      invoicePrefix: 'bc',
      maxExposedSats: 5_000,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      now: () => clock,
      coupling: {
        receiveStore: { findLiveByPaymentHash: async () => null },
        findLockupOutpoints: async () => arkade.receiveOutpoints,
        findClaimPreimage: async () => arkade.receivePreimage,
      },
      peerStores: [{ findLiveByPaymentHash: async () => ({ id: 'onchain-row' }) }],
    })
    expect(await svc.quote(INVOICE, REFUND_ADDRESS, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })).toEqual({
      accepted: false,
      reason: 'duplicate_swap',
    })
  })
})

/**
 * The collect half of a coupled self-payment.
 *
 * No Lightning payment happens on this flow, so the backend never hands us a
 * preimage. `P` becomes visible only when the client claims the payout we made
 * on the RECEIVE leg — and we read it back off that Arkade claim witness.
 */
describe('claiming a coupled self-payment', () => {
  const FORGED_DECODED = decodeInvoice(FORGED.invoice)
  const FORGED_HASH = FORGED_DECODED.paymentHash
  const RECEIVE_PKSCRIPT = hex.encode(Uint8Array.from([0x51, 0x20, ...keyBytes(7)]))

  /** The coupled receive row, mutated across a test as its own leg advances. */
  let receiveRow: CoupledReceiveRow
  beforeEach(() => {
    receiveRow = {
      state: 'quoted',
      // The bolt11 this row minted — the forged one, because that is what the
      // quotes below are made against and a coupling is only ever our own
      // invoice handed back.
      invoice: FORGED.invoice,
      // Exactly one claim window below what THIS invoice's quote commits to, so
      // the coupling is accepted. Derived from the forged invoice's own final
      // CLTV rather than the fixture's — the two differ.
      refundLocktime: refundLocktimeFor(cltvOf(FORGED_DECODED.minFinalCltvBlocks), 4096, clock) - MIN_CLAIM_WINDOW,
      pkScript: RECEIVE_PKSCRIPT,
      htlcExpiresAt: null,
    }
  })

  const coupledService = (): SendSwapService =>
    new SendSwapService({
      store,
      ln,
      arkade,
      limits: { minSats: 500, maxSats: 10_000 },
      invoicePrefix: 'bc',
      maxExposedSats: 5_000,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      now: () => clock,
      coupling: {
        receiveStore: { findLiveByPaymentHash: async () => receiveRow },
        findLockupOutpoints: async () => arkade.receiveOutpoints,
        findClaimPreimage: async () => arkade.receivePreimage,
      },
    })

  /** Quote the forged invoice coupled, then fund its lockup. */
  const fundedCoupledSwap = async (svc: SendSwapService): Promise<string> => {
    const outcome = await svc.quote(FORGED.invoice, REFUND_ADDRESS, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })
    if (!outcome.accepted) throw new Error(`coupled quote refused: ${outcome.reason}`)
    // The client's lockup lands; their receive leg has been paid out by now.
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    receiveRow = { ...receiveRow, state: 'funded' }
    return outcome.swap.id
  }

  it('claims the send lockup with the preimage revealed on our payout', async () => {
    const svc = coupledService()
    const id = await fundedCoupledSwap(svc)
    arkade.receiveOutpoints = [{ txid: 'r1', vout: 0 }]
    arkade.receivePreimage = FORGED.preimage

    const row = await svc.tick(id)

    expect(row.state).toBe('claimed')
    expect(row.preimage).toBe(FORGED_PREIMAGE)
    expect(arkade.claimCalls).toHaveLength(1)
    // The whole point of the flow: no payment was made, or could be.
    expect(ln.payCalls).toHaveLength(0)
    expect(FORGED_HASH).toBe(row.paymentHash)
  })

  it('waits in funded while nothing has claimed our payout yet', async () => {
    const svc = coupledService()
    const id = await fundedCoupledSwap(svc)
    arkade.receiveOutpoints = [{ txid: 'r1', vout: 0 }]
    // Routine on every tick before the client acts — not an error.
    arkade.receivePreimage = null

    const row = await svc.tick(id)

    expect(row.state).toBe('funded')
    expect(arkade.claimCalls).toHaveLength(0)
    expect(ln.payCalls).toHaveLength(0)
  })

  it('never claims with a preimage that does not open the script', async () => {
    // Unreachable through the real adapter — `findClaimPreimage` verifies and
    // returns null instead — so this is defence against a swapped one.
    const svc = coupledService()
    const id = await fundedCoupledSwap(svc)
    arkade.receiveOutpoints = [{ txid: 'r1', vout: 0 }]
    arkade.receivePreimage = new Uint8Array(32).fill(7)

    const row = await svc.tick(id)

    expect(row.state).not.toBe('claiming')
    expect(row.state).not.toBe('claimed')
    expect(arkade.claimCalls).toHaveLength(0)
  })

  it('does not collect when the receive took a real lightning payment', async () => {
    const svc = coupledService()
    const id = await fundedCoupledSwap(svc)
    receiveRow = { ...receiveRow, htlcExpiresAt: clock + 3600 }
    arkade.receiveOutpoints = [{ txid: 'r1', vout: 0 }]
    arkade.receivePreimage = FORGED.preimage

    const row = await svc.tick(id)

    expect(row.state).toBe('refused')
    expect(arkade.claimCalls).toHaveLength(0)
    expect(ln.payCalls).toHaveLength(0)
  })
})

/**
 * The failure mode where the backend's commitment outlives the id that names it.
 *
 * A rail's pay call can commit our funds against the payment hash BEFORE the
 * call that mints the request id — observed in production — with that first
 * step keyed on the hash rather than on our idempotency key, so it is not
 * replayable. A failure in between leaves sats committed with nothing on disk
 * naming them, and re-submitting can only ever hit ALREADY_EXISTS.
 */
describe('a payment whose commitment outlived its id', () => {
  /** Drive a swap to `paying` with no payment id, the way a throwing payInvoice leaves it. */
  const wedgedInPaying = async () => {
    const outcome = await service.quote(FORGED.invoice, REFUND_ADDRESS, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })
    if (!outcome.accepted) throw new Error(`forged quote refused: ${outcome.reason}`)
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    ln.payThrows = new Error('ALREADY_EXISTS: preimage request already exists for paymentHash')
    await expect(service.tick(outcome.swap.id)).rejects.toThrow(/ALREADY_EXISTS/)
    const row = await store.get(outcome.swap.id)
    expect(row.state).toBe('paying')
    expect(row.paymentId).toBeNull()
    return row
  }

  it('claims on the preimage the backend already holds instead of re-submitting', async () => {
    const wedged = await wedgedInPaying()
    ln.sendHtlc = { status: 'settled', preimage: FORGED_PREIMAGE }
    const submitted = ln.payCalls.length

    const row = await service.tick(wedged.id)

    expect(row.state).toBe('claimed')
    expect(row.preimage).toBe(FORGED_PREIMAGE)
    expect(arkade.claimCalls).toHaveLength(1)
    // The whole point: no second submit. That call cannot succeed, and making
    // it is what kept this row spinning.
    expect(ln.payCalls).toHaveLength(submitted)
  })

  it('refunds when the backend says the commitment was returned', async () => {
    const wedged = await wedgedInPaying()
    ln.sendHtlc = { status: 'returned' }

    const row = await service.tick(wedged.id)

    // Returned means the leaves came back: the sats provably did not leave, so
    // the client gets their lockup back now rather than waiting out the deadline.
    expect(row.state).toBe('stuck')
    expect(row.refundOutcome).toBe('pushed')
    expect(arkade.refundCalls).toHaveLength(1)
  })

  it('parks a settled commitment that carries NO preimage, and refunds nothing', async () => {
    const wedged = await wedgedInPaying()
    // Settled means the sats left. Without a preimage there is nothing to claim
    // with, so this is the one branch where the row must go to a human — and
    // above all must NOT refund, because the client was already paid.
    ln.sendHtlc = { status: 'settled' }
    const submitted = ln.payCalls.length

    const row = await service.tick(wedged.id)

    expect(row.state).toBe('stuck')
    expect(row.failureReason).toMatch(/no preimage/i)
    expect(arkade.refundCalls).toHaveLength(0)
    expect(arkade.claimCalls).toHaveLength(0)
    expect(ln.payCalls).toHaveLength(submitted)
  })

  it('waits, without re-submitting, while the commitment is still undecided', async () => {
    const wedged = await wedgedInPaying()
    ln.sendHtlc = { status: 'committed' }
    const submitted = ln.payCalls.length

    const row = await service.tick(wedged.id)

    // Undecided: the sats are committed and the SSP may still reveal. Nothing
    // may be pushed on that, but re-submitting is still pointless.
    expect(row.state).toBe('paying')
    expect(arkade.refundCalls).toHaveLength(0)
    expect(arkade.claimCalls).toHaveLength(0)
    expect(ln.payCalls).toHaveLength(submitted)
  })

  it('still re-submits when the backend never heard of the hash', async () => {
    const wedged = await wedgedInPaying()
    // Null is "nothing was committed" â€” the crash-before-the-call case, where
    // re-submitting is exactly right and is the only way to learn the id.
    ln.sendHtlc = null
    ln.payThrows = null
    ln.payResult = { id: 'pay-2', status: 'pending' }
    ln.payments.set('pay-2', { id: 'pay-2', status: 'pending' })

    const row = await service.tick(wedged.id)

    expect(row.state).toBe('paid')
    expect(row.paymentId).toBe('pay-2')
  })
})

/**
 * The contradiction that identified the orphaned registration, and that nothing
 * acted on for six days.
 *
 * The probe says the backend holds NOTHING for this hash. The pay call says it
 * refuses BECAUSE something already exists for this hash. Both cannot be true
 * of a healthy backend: together they mean a registration with no commitment
 * behind it, which permanently blocks the hash and which no retry can clear.
 *
 * It parks the row. It does NOT refund: on the real incident `queryHTLC`
 * answered null from every role while a request demonstrably existed, so the
 * probe's null is not proof that nothing moved — only transfer arithmetic was.
 * Moving money on this evidence is the mistake, so a human is handed the row.
 */
describe('a hash the backend blocks but holds nothing for', () => {
  const blocked = () => new PaymentHashRegistered('preimage request already exists for paymentHash 2ffe1de3')

  /** Funded, wedged on the contradiction, with the clock at the pay attempt. */
  const wedged = async () => {
    const outcome = await service.quote(FORGED.invoice, REFUND_ADDRESS, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })
    if (!outcome.accepted) throw new Error(`forged quote refused: ${outcome.reason}`)
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    ln.sendHtlc = null // the probe: nothing committed
    ln.payThrows = blocked() // the pay call: the hash is taken
    await expect(service.tick(outcome.swap.id)).rejects.toThrow(PaymentHashRegistered)
    return outcome.swap.id
  }

  it('keeps retrying while the contradiction could still be transient', async () => {
    const id = await wedged()
    clock += ORPHANED_REGISTRATION_SECONDS - 1

    await expect(service.tick(id)).rejects.toThrow(PaymentHashRegistered)

    // Still live: a backend that has not caught up yet must not be called dead.
    expect((await store.get(id)).state).toBe('paying')
  })

  it('parks the row once the contradiction has outlasted any transient', async () => {
    const id = await wedged()
    clock += ORPHANED_REGISTRATION_SECONDS

    const row = await service.tick(id)

    expect(row.state).toBe('stuck')
    expect(row.failureReason).toMatch(/orphan/i)
  })

  it('does NOT refund on the probe’s word alone', async () => {
    const id = await wedged()
    clock += ORPHANED_REGISTRATION_SECONDS
    await service.tick(id)

    // The evidence that settles refund-versus-claim is transfer arithmetic, not
    // this probe — which answered null on mainnet while a request existed.
    expect(arkade.refundCalls).toHaveLength(0)
    expect(arkade.claimCalls).toHaveLength(0)
  })

  it('stops calling the backend once parked', async () => {
    const id = await wedged()
    clock += ORPHANED_REGISTRATION_SECONDS
    await service.tick(id)
    const spent = ln.payCalls.length

    clock += 86_400
    await service.tickAll()

    // `stuck` is terminal and outside the sweep: the six-day storm ends here.
    expect(ln.payCalls).toHaveLength(spent)
  })

  it('leaves a row alone when the backend DOES hold a commitment', async () => {
    const id = await wedged()
    // No contradiction any more — the probe found it, so the recovery path owns
    // this row and the bound must not pre-empt it.
    ln.sendHtlc = { status: 'committed' }
    clock += ORPHANED_REGISTRATION_SECONDS

    const row = await service.tick(id)

    expect(row.state).toBe('paying')
    expect(row.failureReason).toBeNull()
  })

  it('does NOT park a backend that cannot be asked, even on the same error', async () => {
    // Guard 1, pinned. A backend with no `getSendHtlcState` has contradicted
    // nothing — its silence is not "holds nothing" — so the bound must not fire
    // there however long the error persists. That is what keeps every rail
    // without the probe, `lnd` and `fake` included, untouched by a rule written
    // for the one rail that has it.
    const withoutProbe = {
      routeCltvBudgetBlocks: ln.routeCltvBudgetBlocks,
      enforcesRouteCltv: ln.enforcesRouteCltv,
      payInvoice: (p: PayInvoiceParams) => ln.payInvoice(p),
      getPayment: (id: string) => ln.getPayment(id),
      getOwnInvoiceState: (h: string) => ln.getOwnInvoiceState(h),
    }
    const svc = new SendSwapService({
      store,
      ln: withoutProbe,
      arkade,
      limits: { minSats: 500, maxSats: 10_000 },
      invoicePrefix: 'bc',
      maxExposedSats: 5_000,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      now: () => clock,
    })
    const outcome = await svc.quote(FORGED.invoice, REFUND_ADDRESS, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })
    if (!outcome.accepted) throw new Error('refused')
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    ln.payThrows = blocked()
    await expect(svc.tick(outcome.swap.id)).rejects.toThrow(PaymentHashRegistered)

    clock += ORPHANED_REGISTRATION_SECONDS * 5
    await expect(svc.tick(outcome.swap.id)).rejects.toThrow(PaymentHashRegistered)

    expect((await store.get(outcome.swap.id)).state).toBe('paying')
  })

  it('does not park on an ordinary error, however long it persists', async () => {
    const outcome = await service.quote(FORGED.invoice, REFUND_ADDRESS, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })
    if (!outcome.accepted) throw new Error('refused')
    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    ln.payThrows = new Error('service provider error: network error')
    await expect(service.tick(outcome.swap.id)).rejects.toThrow(/network/)

    clock += ORPHANED_REGISTRATION_SECONDS * 10
    await expect(service.tick(outcome.swap.id)).rejects.toThrow(/network/)

    // An unreachable backend is not a blocked hash. Only the specific
    // contradiction parks a row.
    expect((await store.get(outcome.swap.id)).state).toBe('paying')
  })
})

/**
 * The route-hint scid denylist, driven end to end on the rail it exists for.
 *
 * A Wallet of Satoshi invoice carries hints of `[40]` and `[40000]`. Hints are
 * alternatives, so every real payer settles it on the 40 — but on a rail that
 * cannot cap the route it picks the solver is bound by the worst and refuses
 * the invoice. Where the operator has CONFIRMED that the 40000 hint's channel
 * cannot route (never inferred from the scid — see docs/runbook.md), listing it
 * stops a refund deadline being priced against a route nobody can take.
 *
 * Three things are pinned here that no unit test can be: the invoice is quoted
 * rather than refused, the deadline is sized off the route a payer can actually
 * take, and — the reason the denylist is threaded into every decode of the
 * row's string rather than only the quote — the row still pays when the pay-time
 * gates re-decode it.
 */
describe('a denylisted route hint', () => {
  const DENIED = 'aaaaaaaaaaaaaaaa'
  const KEPT = '0102030405060708'

  /** The WoS shape: an ordinary hint and an unroutable alternative. */
  const wosInvoice = () =>
    forgeInvoiceWithPreimage({
      network: 'bc',
      amountSats: AMOUNT,
      timestamp: INVOICE_TIMESTAMP,
      expirySeconds: 6 * 3600,
      minFinalCltvBlocks: 60,
      routeHints: [[{ cltv: 40, scid: KEPT }], [{ cltv: 40_000, scid: DENIED }]],
    })

  /** A service on a rail that caps nothing, where the worst hint binds. */
  const uncapped = (denylist?: ReadonlySet<string>) => {
    ln.enforcesRouteCltv = false
    ln.routeCltvBudgetBlocks = UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS
    return new SendSwapService({
      store,
      ln,
      arkade,
      limits: { minSats: 500, maxSats: 10_000 },
      invoicePrefix: 'bc',
      maxExposedSats: 5_000,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      sendHintScidDenylist: denylist,
      now: () => clock,
    })
  }

  it('refuses the invoice with no denylist set, which is the status quo', async () => {
    // Non-vacuous: everything below turns on this refusal, and it must stay the
    // answer for a deployment that has not listed the scid — which is every
    // deployment until an operator has authoritative grounds to list one.
    const outcome = await uncapped().quote(wosInvoice().invoice, REFUND_ADDRESS, {
      clientRefundPubkey: CLIENT_REFUND_PUBKEY,
    })
    expect(outcome).toMatchObject({ accepted: false, reason: 'cltv_too_large' })
  })

  it('quotes it once the hint is denylisted, against the route a payer can take', async () => {
    const service = uncapped(new Set([DENIED]))
    const dropped: unknown[] = []
    service.onDroppedRouteHints = (event) => dropped.push(event)

    const invoice = wosInvoice()
    const outcome = await service.quote(invoice.invoice, REFUND_ADDRESS, {
      clientRefundPubkey: CLIENT_REFUND_PUBKEY,
    })
    if (!outcome.accepted) throw new Error(`quote refused: ${outcome.reason}`)

    // The deadline is the point, not merely acceptance. It holds an HTLC built
    // on the surviving 40 and NOT one built on the 40000 — which is what
    // "priced against the real route" means, stated as the two readings.
    const surviving = cltvOf(60, 40, UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS, false)
    const denied = cltvOf(60, 40_000, UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS, false)
    expect(deadlineContainsHtlc(surviving, outcome.swap.refundLocktime, clock)).toBe(true)
    expect(deadlineContainsHtlc(denied, outcome.swap.refundLocktime, clock)).toBe(false)
    // And stated as the difference from an otherwise identical invoice with no
    // hints at all: 40 blocks of extra deadline, not 40000. Accepting the WoS
    // shape by widening the deadline to cover the dropped hint would have been a
    // ~292-day refund clock — a quote nobody wants and the outcome the
    // acceptance gate refuses rather than produces.
    const hintless = await service.quote(
      forgeInvoiceWithPreimage({
        network: 'bc',
        amountSats: AMOUNT,
        timestamp: INVOICE_TIMESTAMP,
        expirySeconds: 6 * 3600,
        minFinalCltvBlocks: 60,
      }).invoice,
      REFUND_ADDRESS,
      { clientRefundPubkey: CLIENT_REFUND_PUBKEY },
    )
    if (!hintless.accepted) throw new Error(`hintless quote refused: ${hintless.reason}`)
    expect(outcome.swap.refundLocktime - hintless.swap.refundLocktime).toBe(40 * SECONDS_PER_BLOCK)

    // Logged, because a filter nobody can see is a filter nobody can audit.
    expect(dropped).toEqual([
      {
        paymentHash: hex.encode(invoice.paymentHash),
        dropped: [{ scid: DENIED, cltv: 40_000 }],
        worstRouteHintCltvBlocks: 40,
      },
    ])
  })

  it('pays the row it quoted, rather than refusing it when the pay gates re-decode', async () => {
    // THE regression the threading exists to close. `whenFunded` and
    // `submitPayment` each re-decode `row.invoice` — deliberately, so no second
    // copy can go stale against `refundLocktime` — and a raw reading there
    // would put the 40000 back, fail `deadlineContainsHtlc` against the
    // deadline this row was quoted with, and refuse
    // `uncapped_route_deadline_too_short`: the exact refusal the denylist was
    // added to remove, arriving one state later with the client's funds
    // already locked up.
    const service = uncapped(new Set([DENIED]))
    const outcome = await service.quote(wosInvoice().invoice, REFUND_ADDRESS, {
      clientRefundPubkey: CLIENT_REFUND_PUBKEY,
    })
    if (!outcome.accepted) throw new Error(`quote refused: ${outcome.reason}`)

    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    ln.payments.set('pay-1', { id: 'pay-1', status: 'pending' })
    const row = await service.tick(outcome.swap.id)

    expect(row.state).toBe('paid')
    expect(row.failureReason).toBeNull()
    // The ceiling handed to the backend is built on the surviving hint too, so
    // the deadline and the ceiling agree about which route is being paid for.
    expect(ln.payCalls[0]?.maxCltvBlocks).toBe(60 + 40 + UNENFORCED_ROUTE_CLTV_BUDGET_BLOCKS)
  })

  it('re-submits it on the crash-recovery path, where no pay-time gate ran before', async () => {
    // `whenPaying` re-submits without re-asking `evaluateSendPayment`, so
    // `submitPayment` carries the uncapped invariant itself. That is the second
    // of the two pay-time decodes, and it is reached only from here — a row
    // that committed intent and died before `payInvoice`.
    const service = uncapped(new Set([DENIED]))
    const outcome = await service.quote(wosInvoice().invoice, REFUND_ADDRESS, {
      clientRefundPubkey: CLIENT_REFUND_PUBKEY,
    })
    if (!outcome.accepted) throw new Error(`quote refused: ${outcome.reason}`)
    const swap = outcome.swap

    arkade.lockups = [{ txid: 'f1', vout: 0, value: AMOUNT }]
    await store.transition(swap.id, 'quoted', 'funded', { lockup_value: AMOUNT })
    await store.transition(swap.id, 'funded', 'paying', { idempotency_key: `swap-${swap.paymentHash}` })
    ln.payments.set('pay-1', { id: 'pay-1', status: 'pending' })

    const row = await service.tick(swap.id)
    expect(row.state).toBe('paid')
    expect(row.failureReason).toBeNull()
    expect(ln.payCalls).toHaveLength(1)
  })
})
