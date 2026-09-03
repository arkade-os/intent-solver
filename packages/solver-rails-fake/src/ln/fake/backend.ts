/**
 * Fake Lightning backend for end-to-end runs without a Lightning network.
 *
 * It honours the port's real contract rather than short-circuiting it: an
 * invoice is only "payable" if this backend forged it (and therefore knows the
 * preimage), paying returns exactly what the vendor returns — an id to poll and
 * eventually the preimage — and an unknown invoice fails terminally, the same
 * shape a no-route failure takes. Everything downstream (the swap script's
 * hash branch, the claim against a REAL Arkade server) runs unchanged.
 *
 * The send-side preimage map is a JSON file so the flow survives the CLI's
 * process-per-command model: `invoice` forges in one process, `send` pays in
 * another, recovery re-pays in a third. The receive-side hold-invoice state
 * lives in a SEPARATE file next to it (`${statePath}.holds.json`), for the
 * same cross-process-survival reason and to keep the two maps — one keyed by
 * a preimage WE chose, one by a hash a CLIENT chose and whose preimage we may
 * never learn — from ever being confused with each other.
 *
 * Implements the full {@link LightningBackend} (both legs), same as the real
 * adapters: production never runs a receive-only or send-only backend, so a
 * fake that only ever covered one leg would leave the other leg with no
 * regtest-able double.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { amountSatsOf, paymentHashOf } from '@arkade-os/solver-core/invoice/decode.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import { forgeInvoice, forgeInvoiceWithPreimage } from './bolt11.js'
import { ROUTE_CLTV_BUDGET_BLOCKS } from '@arkade-os/solver-core/core/send.js'
import type {
  Balance,
  CreateHoldInvoiceParams,
  EstimateSendFeeParams,
  HoldInvoice,
  HoldState,
  HoldStatus,
  LightningBackend,
  PayInvoiceParams,
  PaymentResult,
  SendFeeEstimate,
} from '@arkade-os/solver-core/ports/lightning.js'

/** One hold invoice's state, as this fake tracks it. */
interface HoldRecord {
  status: HoldStatus
  /** `E`, unix seconds. Only non-null once `armHold` has been called. */
  expiresAt: number | null
  amountSats: number
}

/**
 * How this fake answers {@link FakeLightningBackend.estimateSendFee}.
 *
 * A policy rather than a fixed number because the three things a test needs from a fee
 * estimator are all shape, not value: an exact figure it can assert on, a way to make the
 * backend decline to answer, and a way to make it mint a token. `null` in place of the
 * whole policy is the decline — the fake then behaves like a backend that has no routing
 * to price, which is the honest default for one that has no network.
 */
export interface FakeFeePolicy {
  /** Parts per million of the invoice's amount. */
  ppm: number
  /** Least it will ever report, in sats, so a tiny invoice still costs something. */
  floorSats: number
  /**
   * Mint a {@link SendFeeEstimate.feeHandle} and require it back at
   * {@link FakeLightningBackend.payInvoice}.
   *
   * Off by default, because the one real backend in this tree mints none and the default
   * fake should behave like the default rail. A test turns it on to exercise the
   * prepare-then-execute half of the port, which is otherwise unreachable here.
   */
  handle: boolean
}

/**
 * 0.1% with a one-sat floor: comfortably inside `maxRoutingFeeSats`' 0.5% cap and its
 * 25-sat floor, so a corridor that ever does price off this cannot quote itself into a
 * payment its own budget would refuse.
 */
export const DEFAULT_FAKE_FEE_POLICY: FakeFeePolicy = { ppm: 1000, floorSats: 1, handle: false }

/** Deterministic, and shaped like `maxRoutingFeeSats` so the two round the same way. */
export const fakeFeeSats = (amountSats: number, policy: FakeFeePolicy): number =>
  Math.max(policy.floorSats, Math.ceil((amountSats * policy.ppm) / 1_000_000))

/**
 * The token, derived rather than stored.
 *
 * Every other id this fake mints says `fake-` in it, and this one says what it is
 * committing to as well. Derivation is what lets it survive the CLI's
 * process-per-command model without a fourth state file: the process that pays can
 * recompute exactly what the process that estimated would have minted, so a token is
 * verifiable anywhere and a token for a different invoice or a different price cannot
 * pass.
 */
export const fakeFeeHandle = (paymentHash: string, feeSats: number): string => `fake-fee-${paymentHash}-${feeSats}`

export class FakeLightningBackend implements LightningBackend {
  /**
   * The enforcing budget. The fake pays its own forged invoices over no network
   * at all, so no route exists to exceed any ceiling; quoting the conservative
   * figure would only push regtest deadlines two weeks out for no gain.
   */
  // A getter, not a field: this is a constant property of the RAIL rather than
  // per-instance state, so it belongs on the prototype where it can be read
  // without standing up a wallet.
  get routeCltvBudgetBlocks(): number {
    return ROUTE_CLTV_BUDGET_BLOCKS
  }

  /**
   * Enforcing, for the reason the budget above already is: there is no network,
   * so no route exists to exceed any ceiling. It also puts regtest corridor
   * runs on the best-hint path rather than leaving it to unit tests.
   */
  get enforcesRouteCltv(): boolean {
    return true
  }

  constructor(
    private readonly statePath: string,
    /** bech32 currency prefix forged invoices carry, e.g. 'bcrt'. */
    private readonly network: string,
    private readonly now: () => number = nowSeconds,
    /** null makes this a backend that never estimates — see {@link FakeFeePolicy}. */
    private readonly feePolicy: FakeFeePolicy | null = DEFAULT_FAKE_FEE_POLICY,
  ) {}

  private load(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.statePath, 'utf8')) as Record<string, string>
    } catch {
      return {}
    }
  }

  private save(map: Record<string, string>): void {
    mkdirSync(dirname(this.statePath), { recursive: true })
    writeFileSync(this.statePath, JSON.stringify(map, null, 2))
  }

  private get holdStatePath(): string {
    return `${this.statePath}.holds.json`
  }

  private loadHolds(): Record<string, HoldRecord> {
    try {
      return JSON.parse(readFileSync(this.holdStatePath, 'utf8')) as Record<string, HoldRecord>
    } catch {
      return {}
    }
  }

  private saveHolds(map: Record<string, HoldRecord>): void {
    mkdirSync(dirname(this.holdStatePath), { recursive: true })
    writeFileSync(this.holdStatePath, JSON.stringify(map, null, 2))
  }

  /** Forge a payable invoice; the preimage is persisted, never returned here. */
  forgeInvoice(amountSats: number, expirySeconds = 7200): { invoice: string; paymentHash: string } {
    const forged = forgeInvoiceWithPreimage({
      network: this.network,
      amountSats,
      timestamp: this.now(),
      expirySeconds,
    })
    const map = this.load()
    const paymentHash = hex.encode(forged.paymentHash)
    map[paymentHash] = hex.encode(forged.preimage)
    this.save(map)
    return { invoice: forged.invoice, paymentHash }
  }

  /**
   * A deterministic routing fee for an invoice nothing will actually route.
   *
   * Obviously fake and openly so: the figure is a pure function of the amount, the token
   * says `fake-` in it, and no network is consulted. What it is FOR is the plumbing —
   * a caller can assert an exact number, exercise the null branch by being constructed
   * without a policy, and carry a token through to `payInvoice`.
   *
   * `timeoutMs` is ignored, as the port permits a backend that cannot express the
   * ceiling to do: there is nothing here that takes time, so there is nothing to bound.
   *
   * Null for an amountless invoice rather than a throw. The send leg never holds one
   * (`decodeInvoice` refuses it), so reaching this means a caller asked about something
   * outside the corridor, and "no estimate for this payment" is the honest answer to a
   * payment whose amount is not decided yet.
   */
  async estimateSendFee(params: EstimateSendFeeParams): Promise<SendFeeEstimate | null> {
    if (this.feePolicy === null) return null
    let amountSats: number
    try {
      amountSats = amountSatsOf(params.invoice)
    } catch {
      return null
    }
    const feeSats = fakeFeeSats(amountSats, this.feePolicy)
    if (!this.feePolicy.handle) return { feeSats }
    return { feeSats, feeHandle: fakeFeeHandle(paymentHashOf(params.invoice), feeSats) }
  }

  async payInvoice(params: PayInvoiceParams): Promise<PaymentResult> {
    const paymentHash = paymentHashOf(params.invoice)
    // The execute half of prepare-then-execute, and the only implementation of it in the
    // tree. An absent handle leaves every existing caller exactly as it was; a handle
    // this backend would not have minted THROWS rather than paying anyway, which is what
    // the port requires — a caller that priced its quote off a token it turns out cannot
    // spend must not have that quietly become a payment at some other price.
    if (params.feeHandle !== undefined) {
      const estimate = await this.estimateSendFee({ invoice: params.invoice, timeoutMs: 0 })
      if (estimate?.feeHandle !== params.feeHandle) {
        throw new Error(`fake payInvoice: fee handle ${params.feeHandle} is not one this backend minted`)
      }
    }
    const preimage = this.load()[paymentHash]
    // An invoice we did not forge is unroutable here — terminal failure, the
    // same allowlisted shape the real adapter reports.
    if (!preimage) return { id: `fake-${paymentHash}`, status: 'failed' }
    if (hex.encode(sha256(hex.decode(preimage))) !== paymentHash) {
      throw new Error('fake ln state corrupt: preimage does not match its hash')
    }
    return { id: `fake-${paymentHash}`, status: 'succeeded', preimage }
  }

  async getPayment(id: string): Promise<PaymentResult> {
    const paymentHash = id.replace(/^fake-/, '')
    const preimage = this.load()[paymentHash]
    if (!preimage) return { id, status: 'failed' }
    return { id, status: 'succeeded', preimage }
  }

  async getBalance(): Promise<Balance> {
    return { availableSats: Number.MAX_SAFE_INTEGER, incomingSats: 0 }
  }

  /**
   * Mint a BOLT11 for a hash a CLIENT chose, not one this backend forged.
   *
   * Unlike {@link forgeInvoice}, this never learns — and must never learn — the
   * preimage: the whole point of the receive leg is that the provider only
   * sees `P` once it is already public in a claim witness. The hold starts
   * `pending`; nothing is armed until a test calls {@link armHold}, which is
   * the fake's stand-in for a real payer's HTLC arriving.
   */
  async createHoldInvoice(params: CreateHoldInvoiceParams): Promise<HoldInvoice> {
    const invoice = forgeInvoice({
      network: this.network,
      amountSats: params.amountSats,
      paymentHash: hex.decode(params.paymentHash),
      timestamp: this.now(),
      expirySeconds: params.expirySeconds,
      ...(params.minFinalCltvBlocks === undefined ? {} : { minFinalCltvBlocks: params.minFinalCltvBlocks }),
    })
    const holds = this.loadHolds()
    holds[params.paymentHash] = { status: 'pending', expiresAt: null, amountSats: params.amountSats }
    this.saveHolds(holds)
    return {
      id: `fake-hold-${params.paymentHash}`,
      invoice,
      paymentHash: params.paymentHash,
      // Forged whole, never wrapped: what it asks is what it asks.
      payableSats: params.amountSats,
    }
  }

  /**
   * Read a hold's status and `E`.
   *
   * Throws for a payment hash this backend never issued a hold invoice for —
   * matching the real adapters, which ask their backend for a specific
   * invoice/HTLC record and get a not-found error back rather than a default
   * "pending", so a caller that mistypes or races a hash sees the mistake
   * instead of a plausible-looking fake status.
   */
  async getHoldState(paymentHash: string): Promise<HoldState> {
    const hold = this.loadHolds()[paymentHash]
    if (!hold) throw new Error(`fake getHoldState: no hold invoice issued for payment hash ${paymentHash}`)
    return { status: hold.status, expiresAt: hold.expiresAt, amountSats: hold.amountSats }
  }

  /**
   * The self-payment probe (see the port's contract). Unlike
   * {@link getHoldState} this returns null rather than throwing for an
   * unknown hash: "not ours" is a normal answer here, not a caller mistake.
   */
  async getOwnInvoiceState(paymentHash: string): Promise<HoldState | null> {
    const hold = this.loadHolds()[paymentHash]
    if (!hold) return null
    return { status: hold.status, expiresAt: hold.expiresAt, amountSats: hold.amountSats }
  }

  /**
   * Settle a held HTLC by revealing its preimage.
   *
   * Rejects unless a hold for the matching payment hash is currently `armed`
   * — the same "NOT_FOUND until actually held" contract the real adapters
   * document (`LndLightningBackendAdapter.settleHold`), so a caller retrying
   * too early sees the same shape of failure it would see against a real
   * backend.
   */
  async settleHold(preimage: string): Promise<void> {
    const paymentHash = hex.encode(sha256(hex.decode(preimage)))
    const holds = this.loadHolds()
    const hold = holds[paymentHash]
    if (!hold || hold.status !== 'armed') {
      throw new Error(`fake settleHold: no armed hold for payment hash ${paymentHash}`)
    }
    hold.status = 'settled'
    this.saveHolds(holds)
  }

  /**
   * Retire an unpaid invoice. Idempotent, per the port: an unknown or
   * already-cancelled hash is a no-op.
   *
   * Refuses an ARMED hold rather than cancelling it, because the port promises
   * nothing about armed invoices and a fake that is more permissive than the
   * contract lets a caller violate it with the suite still green.
   */
  async cancelHold(paymentHash: string): Promise<void> {
    const holds = this.loadHolds()
    const hold = holds[paymentHash]
    if (!hold || hold.status === 'cancelled' || hold.status === 'settled') return
    if (hold.status === 'armed') {
      throw new Error(`fake cancelHold: refusing to cancel an armed hold for payment hash ${paymentHash}`)
    }
    hold.status = 'cancelled'
    this.saveHolds(holds)
  }

  // -- test control surface, not part of ReceiveBackend --
  //
  // Nothing in the real port can arm a hold early (see port.ts's "deliberately
  // no cancelHold" note) or arm one at all without a real payer — so a test
  // needs its own way to simulate "an incoming HTLC just arrived and is being
  // held", with a caller-chosen `E` so the funding-safety gates
  // (`evaluateReceiveFunding`) have something real to react to.

  /** Simulate an incoming HTLC arriving and being held against a hold invoice this fake issued. */
  armHold(paymentHash: string, expiresAt: number): void {
    const holds = this.loadHolds()
    const hold = holds[paymentHash]
    if (!hold) throw new Error(`fake armHold: no hold invoice issued for payment hash ${paymentHash}`)
    hold.status = 'armed'
    hold.expiresAt = expiresAt
    this.saveHolds(holds)
  }
}
