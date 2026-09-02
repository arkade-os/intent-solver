/**
 * The two Lightning legs, coupled — the seam neither corridor's own tests can
 * reach.
 *
 * A client quotes lightning:BTC->arkade:BTC, then arkade:BTC->lightning:BTC
 * against the bolt11 it was just handed. That second quote used to be refused
 * `quote_conflict`. Here both real services, both real stores, and one shared
 * Arkade "chain" fake drive the whole flow: they lock up, we pay out, they
 * claim, and we collect on the preimage their claim revealed.
 *
 * Deliberately NOT under `test/e2e`, which is excluded from `pnpm test` and
 * needs a live regtest stack. The point of this test is that it runs every
 * time.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { ArkAddress } from '@arkade-os/sdk'
import { SendSwapService, type ArkadeOps } from '@arkade-os/solver-corridors/send/orchestrator.js'
import { ReceiveSwapService } from '@arkade-os/solver-corridors/receive/orchestrator.js'
import type { ReceiveArkadeOps } from '@arkade-os/solver-corridors/receive/arkadeOps.js'
import { SwapStore } from '@arkade-os/solver-corridors/db/swaps.js'
import { ReceiveSwapStore } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { FakeLightningBackend } from '@arkade-os/solver-rails-fake/ln/fake/backend.js'
import { forgeInvoice } from '@arkade-os/solver-rails-fake/ln/fake/bolt11.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import type { FundedOutput } from '@arkade-os/solver-arkade/arkade/wallet.js'

const keyBytes = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))

/** The RFQ family requires a client refund pubkey on every quote. */
const CLIENT_REFUND_PUBKEY = hex.encode(keyBytes(11))
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program])

const providerPubkey = hex.encode(keyBytes(1))
const serverPubkey = hex.encode(keyBytes(2))
const emulatorPubkey = hex.encode(keyBytes(3))
const solverRefundPkScript = hex.encode(p2tr(keyBytes(4)))
const clientPayoutPubkey = hex.encode(keyBytes(5))
const DELAYS = { unilateralClaimDelay: 512, unilateralRefundDelay: 1024, unilateralRefundWithoutReceiverDelay: 1536 }
const HRP = 'tark'

/** A real, decodable address on THIS server — both legs validate against it. */
const clientAddress = (fill: number): string =>
  new CovenantSwapScript({
    receiver: keyBytes(fill),
    server: keyBytes(2),
    preimageHash: new Uint8Array(20).fill(9),
    refundLocktime: 1_800_000_000,
    claimDelay: 512,
    client: keyBytes(11),
    clientRefundDelay: 1024,
    refundWithoutServerDelay: 2048,
    nonInteractiveParameters: {
      emulatorPubkey: keyBytes(3),
      receiverPkScript: p2tr(keyBytes(13)),
      senderPkScript: p2tr(keyBytes(fill)),
    },
  })
    .address(HRP, keyBytes(2))
    .encode()

const CLIENT_PAYOUT_ADDRESS = clientAddress(6)
const CLIENT_REFUND_ADDRESS = clientAddress(7)

/** The client's preimage: they pick it, and only they know it until they claim. */
/** The sealed packet the client hands us; opaque to this test. */
const CLAIM_PACKET = 'ZWFsZWQtY2lwaGVydGV4dA=='

const P = new Uint8Array(32).fill(42)
const paymentHash = hex.encode(sha256(P))

/**
 * One Arkade ledger both legs read, keyed by pkScript — the fact that makes
 * this test worth more than the two unit suites: the send leg reads the very
 * outputs the receive leg funded, at the script the receive row derived.
 */
interface Chain {
  /** SPENDABLE outputs — what `findLockups` answers, empty once claimed. */
  outputs: Map<string, FundedOutput[]>
  /**
   * Every output a script EVER held, spent or not.
   *
   * Modelled separately on purpose: production's `findLockupOutpoints` reads
   * without `spendableOnly`, which is the whole reason it exists apart from
   * `findLockups` — the claim witness has to be readable at exactly the moment
   * the spendable read goes empty.
   */
  everOutputs: Map<string, FundedOutput[]>
  /** txid -> the preimage the transaction that spent it revealed. */
  revealed: Map<string, Uint8Array>
  fundCalls: { pkScript: string; amountSats: number; at: number }[]
  claimCalls: { rowId: string; preimage: string }[]
}

let now = 1_800_000_000
const clock = () => now
/** Monotonic tick counter, so ORDER can be asserted and not just end state. */
let step = 0

let chain: Chain
let payAttempts: number
let dir: string
let ln: FakeLightningBackend
let driver: ReturnType<typeof betterSqliteDriver>
let sendStore: SwapStore
let receiveStore: ReceiveSwapStore
let sendService: SendSwapService
let receiveService: ReceiveSwapService

const pkScriptOf = (address: string): string => hex.encode(ArkAddress.decode(address).pkScript)

const outpointsOf = (pkScript: string): { txid: string; vout: number }[] =>
  (chain.everOutputs.get(pkScript) ?? []).map((o) => ({ txid: o.txid, vout: o.vout }))

/** Credit an output to a script, in both views of the chain. */
const credit = (pkScript: string, output: FundedOutput): void => {
  chain.outputs.set(pkScript, [output])
  chain.everOutputs.set(pkScript, [...(chain.everOutputs.get(pkScript) ?? []), output])
}

/** Spend everything at a script: it leaves the spendable view, never history. */
const spend = (pkScript: string): void => {
  chain.outputs.delete(pkScript)
}

const receiveOps = (): ReceiveArkadeOps => ({
  solverPubkey: providerPubkey,
  serverPubkey,
  emulatorPubkey,
  solverRefundPkScript,
  delays: DELAYS,
  hrp: HRP,
  findLockups: async (pkScript) => chain.outputs.get(pkScript) ?? [],
  // History, not just what is still spendable: an output that left
  // `chain.outputs` is spent, and the receive leg has to keep seeing it.
  findLockupOutpoints: async (pkScript) => {
    const spendable = chain.outputs.get(pkScript) ?? []
    return (chain.everOutputs.get(pkScript) ?? []).map((o) => ({
      ...o,
      spent: !spendable.some((s) => s.txid === o.txid && s.vout === o.vout),
    }))
  },
  fund: async (address, amountSats) => {
    const pkScript = pkScriptOf(address)
    step += 1
    chain.fundCalls.push({ pkScript, amountSats, at: step })
    const txid = `payout-${chain.fundCalls.length}`
    credit(pkScript, { txid, vout: 0, value: amountSats })
    return txid
  },
  refund: async () => 'refund-txid',
  findClaimPreimage: async (outpoints, hash) => {
    for (const o of outpoints) {
      const found = chain.revealed.get(o.txid)
      if (found && hex.encode(sha256(found)) === hash) return found
    }
    return null
  },
})

const sendOps = (): ArkadeOps => ({
  providerPubkey,
  serverPubkey,
  emulatorPubkey,
  receiverPkScript: hex.encode(p2tr(keyBytes(1))),
  delays: DELAYS,
  hrp: HRP,
  findLockups: async (pkScript) => chain.outputs.get(pkScript) ?? [],
  lockupProvablySpent: async (pkScript) => (chain.outputs.get(pkScript) ?? []).length === 0,
  claim: async (row, _outputs, preimage) => {
    chain.claimCalls.push({ rowId: row.id, preimage })
    spend(row.pkScript)
    return 'send-claim-txid'
  },
  refund: async () => 'send-refund-txid',
})

beforeEach(async () => {
  now = 1_800_000_000
  step = 0
  chain = { outputs: new Map(), everOutputs: new Map(), revealed: new Map(), fundCalls: [], claimCalls: [] }
  dir = mkdtempSync(join(tmpdir(), 'coupling-'))
  ln = new FakeLightningBackend(join(dir, 'ln.json'), 'bcrt', clock)
  // Wrapped, not asserted through a property the backend does not have: the
  // "no payment ever happens" claim is the whole point of this flow, so it
  // needs an assertion that can actually fail.
  payAttempts = 0
  const realPay = ln.payInvoice.bind(ln)
  ln.payInvoice = async (params) => {
    payAttempts += 1
    return realPay(params)
  }
  driver = betterSqliteDriver(':memory:')
  receiveStore = await ReceiveSwapStore.open(driver, clock)
  sendStore = await SwapStore.open(':memory:', clock)

  receiveService = new ReceiveSwapService({
    acceptUnilateralGap: false,
    store: receiveStore,
    ln,
    arkade: receiveOps(),
    limits: { minSats: 1_000, maxSats: 1_000_000 },
    maxExposedSats: 1_000_000,
    totalCommitted: () => receiveStore.committedSats(),
    admission: new AdmissionControl(),
    now: clock,
    // Wired exactly as `createServices` wires them when both Lightning
    // corridors are enabled.
    coupledSendStore: sendStore,
  })

  sendService = new SendSwapService({
    store: sendStore,
    ln,
    arkade: sendOps(),
    limits: { minSats: 1_000, maxSats: 1_000_000 },
    invoicePrefix: 'bcrt',
    maxExposedSats: 1_000_000,
    totalCommitted: () => sendStore.committedSats(),
    admission: new AdmissionControl(),
    now: clock,
    coupling: {
      receiveStore,
      findLockupOutpoints: async (pkScript) => outpointsOf(pkScript),
      findClaimPreimage: async (outpoints, hash) => {
        for (const o of outpoints) {
          const found = chain.revealed.get(o.txid)
          if (found && hex.encode(sha256(found)) === hash) return found
        }
        return null
      },
    },
  })
})

afterEach(async () => {
  await receiveStore.close()
  sendStore.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('self-payment refresh, both legs', () => {
  it('refreshes Arkade funds through a coupled receive+send pair', async () => {
    // 1. The client quotes lightning:BTC->arkade:BTC and gets a bolt11.
    const receiveQuote = await receiveService.quote({
      paymentHash,
      amountSats: 50_000,
      payoutAddress: CLIENT_PAYOUT_ADDRESS,
      payoutPubkey: clientPayoutPubkey,
      claimPacket: CLAIM_PACKET,
    })
    if (!receiveQuote.accepted) throw new Error(`receive quote refused: ${receiveQuote.reason}`)
    const receiveRow = receiveQuote.swap

    // 2. They quote arkade:BTC->lightning:BTC against that very invoice. This
    //    is the request that returned quote_conflict before the coupling existed.
    const sendQuote = await sendService.quote(receiveRow.invoice, CLIENT_REFUND_ADDRESS, {
      clientRefundPubkey: CLIENT_REFUND_PUBKEY,
    })
    if (!sendQuote.accepted) throw new Error(`send quote refused: ${sendQuote.reason}`)
    const sendRow = sendQuote.swap

    // The deadline invariant, on real numbers from both legs rather than a
    // fixture: our recourse on the payout must open a full claim window before
    // theirs on the lockup does.
    expect(sendRow.refundLocktime).toBeGreaterThan(receiveRow.refundLocktime)

    // 3. ORDER, asserted rather than assumed: while their lockup is unfunded we
    //    must not pay out. Drive the receive leg and watch it decline.
    step += 1
    expect((await receiveService.tick(receiveRow.id)).state).toBe('quoted')
    expect(chain.fundCalls).toHaveLength(0)

    // 4. The client funds their send lockup.
    step += 1
    credit(sendRow.pkScript, { txid: 'client-lockup', vout: 0, value: sendRow.amountSats })
    const fundedSendAt = step
    expect((await sendService.tick(sendRow.id)).state).toBe('funded')

    // 5. NOW the receive leg pays out — and not before.
    step += 1
    const paidOut = await receiveService.tick(receiveRow.id)
    expect(paidOut.state).toBe('funded')
    expect(chain.fundCalls).toHaveLength(1)
    expect(chain.fundCalls[0]?.at).toBeGreaterThan(fundedSendAt)
    // No htlc was ever involved: nothing armed this invoice, and nothing could.
    expect(paidOut.htlcExpiresAt).toBeNull()

    // 6. The client claims our payout, revealing P on-chain.
    const payoutTxid = chain.outputs.get(paidOut.pkScript)?.[0]?.txid
    if (!payoutTxid) throw new Error('the payout lockup is missing from the chain')
    chain.revealed.set(payoutTxid, P)
    // Their claim SPENDS our payout: the spendable read goes empty, but the
    // witness that revealed P stays readable. That distinction is the seam.
    spend(paidOut.pkScript)

    // 7. The send leg reads P back off that claim and collects.
    step += 1
    const collected = await sendService.tick(sendRow.id)
    expect(collected.state).toBe('claimed')
    expect(collected.preimage).toBe(hex.encode(P))
    expect(chain.claimCalls).toHaveLength(1)
    expect(chain.claimCalls[0]?.rowId).toBe(sendRow.id)

    // 8. The RECEIVE row has to finish too, and this is the step whose absence
    //    hid a bug: its invoice was cancelled back at coupling, so there is
    //    nothing to settle. Settling anyway throws, and the handler then reads
    //    the null `E` and fails the row — leaving every completed coupled swap
    //    looking like an incident, and its capital counted as exposed.
    let receiveFinal = paidOut
    for (let i = 0; i < 5 && receiveFinal.state !== 'settled'; i += 1) {
      step += 1
      receiveFinal = await receiveService.tick(receiveRow.id)
    }
    expect(receiveFinal.state).toBe('settled')
    expect(receiveFinal.preimage).toBe(hex.encode(P))

    // 9. The whole reason this flow exists: one node cannot pay its own
    //    invoice, and nothing on this path ever tried to.
    expect(payAttempts).toBe(0)
    // And the invoice was retired the moment the quotes concluded, so the
    // bolt11 the client is still holding cannot be paid by anyone — including
    // a third party they hand it to.
    await expect(ln.getHoldState(paymentHash)).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('never pays out when the client abandons their lockup', async () => {
    // The failure this ordering exists to make cheap: they quote both legs and
    // simply never fund. We must be out nothing.
    const receiveQuote = await receiveService.quote({
      paymentHash,
      amountSats: 50_000,
      payoutAddress: CLIENT_PAYOUT_ADDRESS,
      payoutPubkey: clientPayoutPubkey,
      claimPacket: CLAIM_PACKET,
    })
    if (!receiveQuote.accepted) throw new Error(`receive quote refused: ${receiveQuote.reason}`)
    const sendQuote = await sendService.quote(receiveQuote.swap.invoice, CLIENT_REFUND_ADDRESS, {
      clientRefundPubkey: CLIENT_REFUND_PUBKEY,
    })
    if (!sendQuote.accepted) throw new Error(`send quote refused: ${sendQuote.reason}`)

    for (let i = 0; i < 3; i += 1) {
      now += 60
      await receiveService.tick(receiveQuote.swap.id)
    }

    expect(chain.fundCalls).toHaveLength(0)
    expect(chain.claimCalls).toHaveLength(0)
    expect(payAttempts).toBe(0)
  })

  // The fund-loss this whole pair of gates exists for: 49k sats, in the
  // ordinary receive-then-send direction.
  it('does not pay a 50k receive against a 1k send lockup on the same hash', async () => {
    const receiveQuote = await receiveService.quote({
      paymentHash,
      amountSats: 50_000,
      payoutAddress: CLIENT_PAYOUT_ADDRESS,
      payoutPubkey: clientPayoutPubkey,
      claimPacket: CLAIM_PACKET,
    })
    if (!receiveQuote.accepted) throw new Error(`receive quote refused: ${receiveQuote.reason}`)

    const smallInvoice = forgeInvoice({
      network: 'bcrt',
      amountSats: 1_000,
      paymentHash: hex.decode(paymentHash),
      timestamp: now,
      expirySeconds: 7200,
    })
    const sendQuote = await sendService.quote(smallInvoice, CLIENT_REFUND_ADDRESS, {
      clientRefundPubkey: CLIENT_REFUND_PUBKEY,
    })
    // Driven all the way through on purpose. Remove the identity gate and this
    // quote is accepted, these two ticks run, and `fundCalls` becomes 1 — the
    // 50k payout genuinely moves. That is what makes the assertion below mean
    // something rather than merely restate the refusal.
    if (sendQuote.accepted) {
      credit(sendQuote.swap.pkScript, { txid: 'client-lockup', vout: 0, value: sendQuote.swap.amountSats })
      await sendService.tick(sendQuote.swap.id)
      await receiveService.tick(receiveQuote.swap.id)
    }

    expect(chain.fundCalls).toHaveLength(0)
    expect(sendQuote).toEqual({ accepted: false, reason: 'coupled_invoice_mismatch' })
  })

  // The same loss, approached from the other side — and the identity gate
  // above is blind to it, because a send quote raised before any receive row
  // exists never enters its coupling branch at all.
  it('does not pay a 50k receive quoted AFTER a 1k send on the same hash', async () => {
    const smallInvoice = forgeInvoice({
      network: 'bcrt',
      amountSats: 1_000,
      paymentHash: hex.decode(paymentHash),
      timestamp: now,
      expirySeconds: 7200,
    })
    // An ORDINARY send row: there is no receive row yet, so the quote-time
    // coupling branch — and the identity gate inside it — is never entered.
    const sendQuote = await sendService.quote(smallInvoice, CLIENT_REFUND_ADDRESS, {
      clientRefundPubkey: CLIENT_REFUND_PUBKEY,
    })
    if (!sendQuote.accepted) throw new Error(`send quote refused: ${sendQuote.reason}`)
    step += 1
    credit(sendQuote.swap.pkScript, { txid: 'client-lockup', vout: 0, value: sendQuote.swap.amountSats })

    // Quoted BEFORE the send leg is ticked, which is what makes the ordering
    // work: `whenFunded` re-reads the receive store on every tick, so a
    // receive row that appears now turns that ordinary row into a coupling
    // retroactively. It then rests in `funded` waiting to collect — exactly
    // the state `whenQuoted` pays out against.
    const receiveQuote = await receiveService.quote({
      paymentHash,
      amountSats: 50_000,
      payoutAddress: CLIENT_PAYOUT_ADDRESS,
      payoutPubkey: clientPayoutPubkey,
      claimPacket: CLAIM_PACKET,
    })
    // Remove the guard and this is accepted, these two ticks run in this
    // order, and `fundCalls` becomes 1: the 50k payout moves against a 1k
    // lockup, with nothing on the send side having ever compared the two.
    if (receiveQuote.accepted) {
      await sendService.tick(sendQuote.swap.id)
      await receiveService.tick(receiveQuote.swap.id)
    }

    expect(chain.fundCalls).toHaveLength(0)
    expect(receiveQuote).toEqual({ accepted: false, reason: 'duplicate_swap' })
  })
})
