import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { ArkAddress } from '@arkade-os/sdk'
import {
  EMPTY_LOCKUP_GRACE,
  REFUND_CENSORSHIP_GRACE,
  ReceiveSwapService,
  receiveCovenantRowFor,
  type CoupledSendRow,
} from '@arkade-os/solver-corridors/receive/orchestrator.js'
import { ReceiveSwapStore } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import { SwapStore } from '@arkade-os/solver-corridors/db/swaps.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { FakeLightningBackend } from '@arkade-os/solver-rails-fake/ln/fake/backend.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { scriptHashFromPaymentHash } from '@arkade-os/solver-core/core/preimage.js'
import {
  evaluateReceiveFunding,
  MAX_FINAL_CLTV_BLOCKS,
  MAX_REFUND_HORIZON,
  MIN_SETTLE_WINDOW,
} from '@arkade-os/solver-core/core/receive.js'
import { decodeInvoice } from '@arkade-os/solver-core/invoice/decode.js'
import { MIN_CLAIM_WINDOW } from '@arkade-os/solver-core/core/send.js'
import { covenantScriptFromRow } from '@arkade-os/solver-corridors/send/arkadeOps.js'
import type { ReceiveArkadeOps } from '@arkade-os/solver-corridors/receive/arkadeOps.js'
import type { CovclaimdClient } from '@arkade-os/solver-corridors/receive/covclaimd.js'
import type { FundedOutput } from '@arkade-os/solver-arkade/arkade/wallet.js'

const keyBytes = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program])

const solverPubkey = hex.encode(keyBytes(1))
const serverPubkey = hex.encode(keyBytes(2))
const emulatorPubkey = hex.encode(keyBytes(3))
const solverRefundPkScript = hex.encode(p2tr(keyBytes(4)))
const clientPayoutPubkey = hex.encode(keyBytes(5))
const DELAYS = { unilateralClaimDelay: 512, unilateralRefundDelay: 1024, unilateralRefundWithoutReceiverDelay: 1536 }
const HRP = 'tark'

// A real, decodable Arkade address for the client's payout destination — same
// construction test/send/orchestrator.test.ts's REFUND_ADDRESS uses.
const CLIENT_PAYOUT_ADDRESS = new CovenantSwapScript({
  receiver: keyBytes(6),
  server: keyBytes(2),
  preimageHash: new Uint8Array(20).fill(9),
  refundLocktime: 1_800_000_000,
  claimDelay: 512,
  client: keyBytes(11),
  clientRefundDelay: 1024,
  refundWithoutServerDelay: 2048,
  nonInteractiveParameters: {
    emulatorPubkey: keyBytes(3),
    receiverPkScript: Uint8Array.from([0x51, 0x20, ...keyBytes(13)]),
    senderPkScript: p2tr(keyBytes(6)),
  },
})
  .address(HRP, keyBytes(2))
  .encode()

let now = 1_800_000_000
const clock = () => now

const P = new Uint8Array(32).fill(42)
const paymentHash = hex.encode(sha256(P))

interface FakeArkadeState {
  outputs: FundedOutput[]
  /**
   * Outputs this script HELD and no longer does — the half of the chain a
   * `spendableOnly` view cannot see. Kept separate from `outputs` (rather than
   * flagged inside it) so a test spells out which view it is setting up, and
   * so every existing test that assigns `outputs` still describes exactly the
   * spendable world it meant to.
   */
  spentOutputs: FundedOutput[]
  fundCalls: { address: string; amountSats: number }[]
  refundCalls: number
  claimPreimage: Uint8Array | null
  /**
   * WHICH outpoint the claim actually spent, when a test cares.
   *
   * Left null by default so every test that only sets `claimPreimage` keeps
   * the old unconditional behaviour. Set it and the fake starts answering the
   * way the real helper does — `findClaimPreimage` is `getVtxos({ outpoints })`
   * (src/arkade/wallet.ts), so it can only recover `P` from an outpoint it was
   * actually given, and a caller that searches a narrower set than the
   * script's full history finds nothing.
   */
  claimOn: { txid: string; vout: number } | null
}

const buildFakeArkade = (): { ops: ReceiveArkadeOps; state: FakeArkadeState } => {
  const state: FakeArkadeState = {
    outputs: [],
    spentOutputs: [],
    fundCalls: [],
    refundCalls: 0,
    claimPreimage: null,
    claimOn: null,
  }
  const ops: ReceiveArkadeOps = {
    solverPubkey,
    serverPubkey,
    emulatorPubkey,
    solverRefundPkScript,
    delays: DELAYS,
    hrp: HRP,
    findLockups: async () => state.outputs,
    // The unfiltered view: everything still spendable, plus everything already
    // spent. The real helper answers from one indexer read; the fake keeps the
    // two lists apart and unions them here.
    findLockupOutpoints: async () => [
      ...state.outputs.map((o) => ({ ...o, spent: false })),
      ...state.spentOutputs.map((o) => ({ ...o, spent: true })),
    ],
    fund: async (address, amountSats) => {
      state.fundCalls.push({ address, amountSats })
      // ONE txid for both the created output and the return value: the
      // orchestrator confirms its funding by matching the txid `fund()` handed
      // back against what the indexer reports, so a fake that invented two
      // different ids would defeat exactly the check under test.
      const txid = `fund-${state.fundCalls.length}`
      state.outputs = [{ txid, vout: 0, value: amountSats }]
      return txid
    },
    // Mirrors the REAL receiveArkadeOpsFromContext (src/receive/arkadeOps.ts):
    // rebuild the covenant from the row, then refuse to sign against a lockup
    // whose script does not re-derive from it. Without this the fake accepts
    // any row at all, which is exactly what hid a row whose refund_locktime no
    // longer derived the funded pkScript — the solver's own refund refused,
    // its capital stranded in the lockup.
    refund: async (row) => {
      const script = covenantScriptFromRow(row)
      const derived = hex.encode(script.pkScript)
      if (derived !== row.pkScript) {
        throw new Error(`script rebuilt from row ${row.id} derives ${derived}, lockup is at ${row.pkScript}`)
      }
      state.refundCalls += 1
      state.outputs = []
      return 'refund-ark-txid'
    },
    findClaimPreimage: async (outpoints) => {
      // Only outpoint-aware once a test says where the claim landed; see
      // `claimOn`. Without that the caller's search set is irrelevant, which
      // is what every pre-existing test in this file assumes.
      if (!state.claimOn) return state.claimPreimage
      const found = outpoints.some((o) => o.txid === state.claimOn?.txid && o.vout === state.claimOn?.vout)
      return found ? state.claimPreimage : null
    },
  }
  return { ops, state }
}

interface FakeCovclaimdState {
  revealCalls: number
  shouldFail: boolean
  lastParams: unknown
}

const buildFakeCovclaimd = (): { client: CovclaimdClient; state: FakeCovclaimdState } => {
  const state: FakeCovclaimdState = { revealCalls: 0, shouldFail: false, lastParams: undefined }
  const client: CovclaimdClient = {
    getPubKeys: async () => ({ covclaimdPubKey: 'aa', emulatorPubKey: 'bb' }),
    reveal: async (params) => {
      state.revealCalls += 1
      state.lastParams = params
      if (state.shouldFail) throw new Error('covclaimd unreachable')
    },
  }
  return { client, state }
}

let dir: string
let ln: FakeLightningBackend
let driver: ReturnType<typeof betterSqliteDriver>
let store: ReceiveSwapStore
let arkade: ReturnType<typeof buildFakeArkade>
let covclaimd: ReturnType<typeof buildFakeCovclaimd>
let service: ReceiveSwapService

const LIMITS = { minSats: 1_000, maxSats: 1_000_000 }

beforeEach(async () => {
  now = 1_800_000_000
  dir = mkdtempSync(join(tmpdir(), 'receive-orchestrator-'))
  ln = new FakeLightningBackend(join(dir, 'ln.json'), 'bcrt', clock)
  // Driver kept, not just a path: one test writes a column combination no
  // store method can produce, to prove a guard against it.
  driver = betterSqliteDriver(':memory:')
  store = await ReceiveSwapStore.open(driver, clock)
  arkade = buildFakeArkade()
  covclaimd = buildFakeCovclaimd()
  service = new ReceiveSwapService({
    acceptUnilateralGap: false,
    store,
    ln,
    arkade: arkade.ops,
    covclaimd: covclaimd.client,
    limits: LIMITS,
    maxExposedSats: 1_000_000,
    totalCommitted: () => store.committedSats(),
    admission: new AdmissionControl(),
    now: clock,
  })
})

afterEach(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

const quoteRequest = (over: Partial<Parameters<ReceiveSwapService['quote']>[0]> = {}) => ({
  paymentHash,
  amountSats: 5_000,
  payoutAddress: CLIENT_PAYOUT_ADDRESS,
  payoutPubkey: clientPayoutPubkey,
  claimPacket: 'ZWFsZWQtY2lwaGVydGV4dA==',
  ...over,
})

describe('ReceiveSwapService.quote', () => {
  it('accepts a valid request, mints a hold invoice, and persists a quoted row', async () => {
    const outcome = await service.quote(quoteRequest())
    expect(outcome.accepted).toBe(true)
    if (!outcome.accepted) throw new Error('expected acceptance')
    expect(outcome.swap.state).toBe('quoted')
    expect(outcome.swap.paymentHash).toBe(paymentHash)
    expect(outcome.swap.invoice).toMatch(/^lnbcrt/)
    // The hold invoice really exists against the fake backend under this hash.
    await expect(ln.getHoldState(paymentHash)).resolves.toMatchObject({ status: 'pending' })
  })

  it('stamps refund_locktime and valid_until from one clock read', async () => {
    // Against a clock that advances on every call — two reads leave a margin of
    // `MIN_CLAIM_WINDOW - 1`, which breaks the equality the derived window's
    // comment states unconditionally.
    let ticking = 1_800_000_000
    const advancing = new ReceiveSwapService({
      acceptUnilateralGap: false,
      store,
      ln,
      arkade: arkade.ops,
      covclaimd: covclaimd.client,
      limits: LIMITS,
      maxExposedSats: 1_000_000,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      now: () => ticking++,
    })
    const outcome = await advancing.quote(quoteRequest())
    if (!outcome.accepted) throw new Error(`quote refused: ${outcome.reason}`)
    expect(outcome.swap.refundLocktime - outcome.validUntil).toBe(MIN_CLAIM_WINDOW)
  })

  it('refuses amount_out_of_range', async () => {
    const outcome = await service.quote(quoteRequest({ amountSats: 10 }))
    expect(outcome).toEqual({ accepted: false, reason: 'amount_out_of_range' })
  })

  it('refuses invalid_payout_address for an undecodable address', async () => {
    const outcome = await service.quote(quoteRequest({ payoutAddress: 'not-an-address' }))
    expect(outcome).toEqual({ accepted: false, reason: 'invalid_payout_address' })
  })

  it('refuses invalid_payout_address for the wrong network HRP', async () => {
    // Decodable, but not a `tark1...` address — same wrong-network guard the
    // send leg's refund_address validation applies.
    const wrongHrp = new CovenantSwapScript({
      receiver: keyBytes(6),
      server: keyBytes(2),
      preimageHash: new Uint8Array(20).fill(9),
      refundLocktime: 1_800_000_000,
      claimDelay: 512,
      client: keyBytes(11),
      clientRefundDelay: 1024,
      refundWithoutServerDelay: 2048,
      nonInteractiveParameters: {
        emulatorPubkey: keyBytes(3),
        receiverPkScript: Uint8Array.from([0x51, 0x20, ...keyBytes(13)]),
        senderPkScript: p2tr(keyBytes(6)),
      },
    })
      .address('ark', keyBytes(2))
      .encode()
    const outcome = await service.quote(quoteRequest({ payoutAddress: wrongHrp }))
    expect(outcome).toEqual({ accepted: false, reason: 'invalid_payout_address' })
  })

  it('refuses duplicate_swap when a live swap already exists for the hash', async () => {
    await service.quote(quoteRequest())
    const outcome = await service.quote(quoteRequest())
    expect(outcome).toEqual({ accepted: false, reason: 'duplicate_swap' })
  })

  it('refuses a hash live in ANOTHER corridor’s store BEFORE minting the hold invoice', async () => {
    // A hash a live send swap of ours is paying: minting a hold invoice on it
    // would loop that payment back to ourselves (issue #41). The refusal must
    // precede the mint — the external side effect — not follow it.
    const crossChecked = new ReceiveSwapService({
      acceptUnilateralGap: false,
      store,
      ln,
      arkade: arkade.ops,
      limits: LIMITS,
      maxExposedSats: 1_000_000,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      now: clock,
      peerStores: [{ findLiveByPaymentHash: async () => ({ id: 'send-row' }) }],
    })
    const outcome = await crossChecked.quote(quoteRequest())
    expect(outcome).toEqual({ accepted: false, reason: 'duplicate_swap' })
    // The fake throws for a hash it never issued a hold for — proof the mint
    // never happened.
    await expect(ln.getHoldState(paymentHash)).rejects.toThrow()
  })

  it('refuses a hash already live on the SEND store BEFORE minting the hold invoice', async () => {
    // The check above, for the one store coupling took out of `peerStores`.
    // Removing it there was right; not re-asking it here was not.
    //
    // A coupling runs receive-then-send, so a send row that already exists at
    // this moment cannot be the coupled leg — nothing has been minted for it
    // to quote against yet. Left unasked, it let the ordering run backwards:
    // quote send cheap on this hash, fund that small lockup, then quote
    // receive large here. `whenQuoted` reads ANY live send row as a coupling,
    // so it would arm against the small lockup and pay out the large payout.
    const coupled = new ReceiveSwapService({
      acceptUnilateralGap: false,
      store,
      ln,
      arkade: arkade.ops,
      limits: LIMITS,
      maxExposedSats: 1_000_000,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      now: clock,
      coupledSendStore: {
        findLiveByPaymentHash: async () => ({
          state: 'quoted',
          pkScript: hex.encode(p2tr(keyBytes(11))),
          amountSats: 1_000,
        }),
      },
    })
    const outcome = await coupled.quote(quoteRequest())
    expect(outcome).toEqual({ accepted: false, reason: 'duplicate_swap' })
    // Same proof as the sibling test above: no hold was ever issued.
    await expect(ln.getHoldState(paymentHash)).rejects.toThrow()
  })

  it('refuses provider_at_capacity once the exposure cap is reached', async () => {
    const capped = new ReceiveSwapService({
      acceptUnilateralGap: false,
      store,
      ln,
      arkade: arkade.ops,
      covclaimd: covclaimd.client,
      limits: LIMITS,
      maxExposedSats: 1_000,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      now: clock,
    })
    const outcome = await capped.quote(quoteRequest({ amountSats: 5_000 }))
    // limits.maxSats is 1_000_000 here, so 5000 passes the amount check —
    // the exposure cap (1_000) is what actually refuses it.
    expect(outcome).toEqual({ accepted: false, reason: 'provider_at_capacity' })
  })

  it('counts a live send row against the house cap', async () => {
    // 50k lives in another corridor's notebook. The house cap must see it.
    const sendStore = await SwapStore.open(':memory:', clock)
    try {
      await sendStore.insertQuote({
        id: 'send-1',
        invoice: 'lnbcrt',
        paymentHash: 'aa'.repeat(32),
        amountSats: 50_000,
        invoiceExpiresAt: now + 3600,
        refundLocktime: now + 7200,
        senderPubkey: '01'.repeat(32),
        receiverPubkey: '02'.repeat(32),
        serverPubkey: '03'.repeat(32),
        claimDelay: 512,
        refundDelay: 1024,
        refundWithoutReceiverDelay: 1536,
        pkScript: '5120' + 'ab'.repeat(32),
        lockupAddress: 'ark1qexample',
        nonInteractiveParameters: true,
      })
      const capped = new ReceiveSwapService({
        acceptUnilateralGap: false,
        store,
        ln,
        arkade: arkade.ops,
        covclaimd: covclaimd.client,
        limits: LIMITS,
        maxExposedSats: 60_000,
        totalCommitted: async () => (await sendStore.committedSats()) + (await store.committedSats()),
        admission: new AdmissionControl(),
        now: clock,
      })
      const outcome = await capped.quote(quoteRequest({ amountSats: 20_000 }))
      expect(outcome).toEqual({ accepted: false, reason: 'provider_at_capacity' })
    } finally {
      await sendStore.close()
    }
  })

  describe('the corridor fee', () => {
    // 100bps plus 50 flat against a 5_000 sat hold invoice: the client pays
    // 5_000, the solver funds 5_000 - ceil(50) - 50 = 4_900.
    const FEE = { bps: 100, flatSats: 50 }

    const withFee = () =>
      new ReceiveSwapService({
        acceptUnilateralGap: false,
        store,
        ln,
        arkade: arkade.ops,
        covclaimd: covclaimd.client,
        limits: LIMITS,
        maxExposedSats: 1_000_000,
        totalCommitted: () => store.committedSats(),
        admission: new AdmissionControl(),
        now: clock,
        fee: FEE,
      })

    it('mints the hold invoice in full but persists the payout MINUS the fee', async () => {
      const outcome = await withFee().quote(quoteRequest())
      if (!outcome.accepted) throw new Error(`refused: ${outcome.reason}`)
      expect(outcome.swap.amountSats).toBe(5_000)
      expect(outcome.swap.payoutSats).toBe(4_900)
      // What the client is asked to pay is the full amount — the fee comes
      // out of what the solver delivers, not on top of what it charges.
      await expect(ln.getHoldState(paymentHash)).resolves.toMatchObject({ status: 'pending', amountSats: 5_000 })
    })

    it('quotes what the WRAPPED invoice asks, while pricing the payout off the hold', async () => {
      // A backend that wraps its hold invoice hands out one asking slightly
      // more — a routing reserve the payer covers. `from_amount` is read off
      // that invoice, or the client gets a quote their own invoice contradicts.
      // The payout is untouched: the reserve is the wrapper's, never ours to
      // fund against.
      const wrapping = {
        createHoldInvoice: async (params: Parameters<typeof ln.createHoldInvoice>[0]) => ({
          ...(await ln.createHoldInvoice(params)),
          payableSats: params.amountSats + 7,
        }),
        getHoldState: ln.getHoldState.bind(ln),
        settleHold: ln.settleHold.bind(ln),
      }
      const svc = new ReceiveSwapService({
        acceptUnilateralGap: false,
        store,
        ln: wrapping,
        arkade: arkade.ops,
        covclaimd: covclaimd.client,
        limits: LIMITS,
        maxExposedSats: 1_000_000,
        totalCommitted: () => store.committedSats(),
        admission: new AdmissionControl(),
        now: clock,
        fee: FEE,
      })

      const outcome = await svc.quote(quoteRequest())
      if (!outcome.accepted) throw new Error(`refused: ${outcome.reason}`)
      expect(outcome.swap.amountSats).toBe(5_007)
      expect(outcome.swap.payoutSats).toBe(4_900)
      // And the HTLC we hold is still the un-wrapped amount.
      await expect(ln.getHoldState(paymentHash)).resolves.toMatchObject({ amountSats: 5_000 })
    })

    it('funds the lockup with the persisted payout, not the invoice amount', async () => {
      const svc = withFee()
      const outcome = await svc.quote(quoteRequest())
      if (!outcome.accepted) throw new Error(`refused: ${outcome.reason}`)
      ln.armHold(paymentHash, now + 4 * 3600)
      const row = await svc.tick(outcome.swap.id)
      expect(row.state).toBe('funded')
      expect(arkade.state.fundCalls).toEqual([{ address: row.lockupAddress, amountSats: 4_900 }])
      expect(row.arkadeLockupValue).toBe(4_900)
    })

    it('refuses fee_consumes_swap when the fee eats the whole amount', async () => {
      // A 200-sat flat fee against a 150-sat swap leaves a negative payout.
      // Distinct from amount_out_of_range: 150 is inside the corridor's
      // range — it just cannot be priced.
      const greedy = new ReceiveSwapService({
        acceptUnilateralGap: false,
        store,
        ln,
        arkade: arkade.ops,
        limits: { minSats: 100, maxSats: 1_000_000 },
        maxExposedSats: 1_000_000,
        totalCommitted: () => store.committedSats(),
        admission: new AdmissionControl(),
        now: clock,
        fee: { bps: 0, flatSats: 200 },
      })
      const outcome = await greedy.quote(quoteRequest({ amountSats: 150 }))
      expect(outcome).toEqual({ accepted: false, reason: 'fee_consumes_swap' })
    })

    it('charges nothing when the fee is free, exactly as before it existed', async () => {
      const outcome = await service.quote(quoteRequest())
      if (!outcome.accepted) throw new Error(`refused: ${outcome.reason}`)
      expect(outcome.swap.payoutSats).toBe(outcome.swap.amountSats)
    })

    it('exact-out: solves the give up from the fee so the payout is exactly the request', async () => {
      // Asking to RECEIVE 4_900 at {100bps + 50 flat} prices the give at
      // exactly 5_000 — the same numbers the exact-in test above reads off.
      const outcome = await withFee().quote(quoteRequest({ amountSats: 4_900, amountSide: 'to' }))
      if (!outcome.accepted) throw new Error(`refused: ${outcome.reason}`)
      expect(outcome.swap.amountSats).toBe(5_000) // what the client pays
      expect(outcome.swap.payoutSats).toBe(4_900) // what the solver funds — exactly the request
      // The hold invoice is minted for the give, not the requested payout.
      await expect(ln.getHoldState(paymentHash)).resolves.toMatchObject({ status: 'pending', amountSats: 5_000 })
    })

    it('exact-out: the limits still bound the GIVE, including the solved fee on top', async () => {
      const capped = new ReceiveSwapService({
        acceptUnilateralGap: false,
        store,
        ln,
        arkade: arkade.ops,
        limits: { minSats: 100, maxSats: 5_000 },
        maxExposedSats: 1_000_000,
        totalCommitted: () => store.committedSats(),
        admission: new AdmissionControl(),
        now: clock,
        fee: FEE,
      })
      // Receiving 4_950 prices the give at 5_050 — over the corridor's 5_000 cap.
      const outcome = await capped.quote(quoteRequest({ amountSats: 4_950, amountSide: 'to' }))
      expect(outcome).toEqual({ accepted: false, reason: 'amount_out_of_range' })
    })
  })

  it('a quoted row carries a conservative refund_locktime upper bound (now + MAX_REFUND_HORIZON)', async () => {
    const outcome = await service.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    expect(outcome.swap.refundLocktime).toBe(now + MAX_REFUND_HORIZON)
  })

  it('the derived pkScript actually pins to the CLIENT payout destination, not the solver', async () => {
    const outcome = await service.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    // Independently re-derive the covenant the way a client (or covclaimd)
    // would: receiver = client's own payout key, client(param) = solver's own
    // key. If the orchestrator's role mapping were swapped (e.g. receiver and
    // client transposed), this would NOT match row.pkScript.
    const independentlyDerived = new CovenantSwapScript({
      receiver: hex.decode(clientPayoutPubkey),
      server: hex.decode(serverPubkey),
      preimageHash: scriptHashFromPaymentHash(paymentHash),
      refundLocktime: outcome.swap.refundLocktime,
      claimDelay: DELAYS.unilateralClaimDelay,
      client: hex.decode(solverPubkey),
      clientRefundDelay: DELAYS.unilateralRefundWithoutReceiverDelay,
      refundWithoutServerDelay: DELAYS.unilateralRefundDelay,
      // Every quote the service issues now carries the full covenant suite;
      // matching that here is what makes this agree with
      // `outcome.swap.pkScript`.
      nonInteractiveParameters: {
        emulatorPubkey: hex.decode(emulatorPubkey),
        receiverPkScript: ArkAddress.decode(CLIENT_PAYOUT_ADDRESS).pkScript,
        senderPkScript: hex.decode(solverRefundPkScript),
      },
    })
    expect(outcome.swap.pkScript).toBe(hex.encode(independentlyDerived.pkScript))
    expect(outcome.swap.lockupAddress).toBe(independentlyDerived.address(HRP, keyBytes(2)).encode())
  })

  it('receiveCovenantRowFor reconstructs the EXACT script the quote committed to', async () => {
    // This is what revealToCovclaimd and whenRefunding actually run at claim
    // and refund time — unlike the previous test (which re-derives the
    // script from raw request/dep values independently), this exercises the
    // real row-mapping function this orchestrator uses, closing a gap a
    // revert-verify pass found: a fake ReceiveArkadeOps doesn't call
    // covenantScriptFromRow the way the real receiveArkadeOpsFromContext
    // does, so a role-mapping bug in receiveCovenantRowFor is otherwise
    // invisible to every other test in this file.
    const outcome = await service.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    const rebuilt = covenantScriptFromRow(receiveCovenantRowFor(outcome.swap))
    expect(hex.encode(rebuilt.pkScript)).toBe(outcome.swap.pkScript)
  })

  /**
   * The QUOTE row re-deriving its own script proves nothing about the rows
   * `revealToCovclaimd` and `whenRefunding` actually see — those only ever run
   * on a row that has already been through `armed -> funded`, and the clock
   * has moved on by then. Funding is a separate tick from quoting in every
   * real deployment, so a row that only re-derives while `now` is frozen is a
   * row that re-derives only in tests.
   *
   * The funded pkScript is an immutable fact about money already on Arkade:
   * whatever the row carries afterwards, the covenant must still rebuild THAT
   * script or nothing can ever spend it again.
   */
  /**
   * The receive half of why `HoldStatus` can afford an `'unknown'` value.
   *
   * `'armed'` is the ONLY status this path acts on, so a status the build does
   * not recognise funds nothing — no branch for the value required. That is
   * what lets the port refuse to guess: guessing `'armed'` here would fund an
   * Arkade payout against an HTLC that may already be dead, which is paying out
   * while unable to collect.
   *
   * The HTLC is genuinely live in this test — `armHold` really armed it — and
   * only the reported STATUS is unrecognised. So this pins the fail-safe, not
   * merely the absence of an HTLC.
   */
  it('funds nothing when the backend reports a status this build does not know', async () => {
    const outcome = await service.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    ln.armHold(paymentHash, now + 4 * 3600)
    const armed = await ln.getHoldState(paymentHash)
    expect(armed.status).toBe('armed')
    // Same live hold, reported under a name a future SDK might add.
    ln.getHoldState = async () => ({ ...armed, status: 'unknown' as const })

    const row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('quoted')
    expect(arkade.state.fundCalls).toEqual([])
  })

  it('the FUNDED row still reconstructs the funded script after the clock advances between quote and funding', async () => {
    const outcome = await service.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    const quoted = outcome.swap

    // The gap a real deployment always has: quote on one tick, fund on a
    // later one. `refundLocktime` is second-granular, so a single second would
    // already diverge; five only keeps the intent obvious.
    now += 5
    ln.armHold(paymentHash, now + 4 * 3600)
    const funded = await service.tick(quoted.id)
    expect(funded.state).toBe('funded')

    // The lockup that actually holds the solver's sats is the quote-time one.
    expect(funded.pkScript).toBe(quoted.pkScript)
    expect(funded.lockupAddress).toBe(quoted.lockupAddress)
    // ...so the row must still derive it.
    const rebuilt = covenantScriptFromRow(receiveCovenantRowFor(funded))
    expect(hex.encode(rebuilt.pkScript)).toBe(funded.pkScript)
    expect(funded.refundLocktime).toBe(quoted.refundLocktime)
  })
})

describe('ReceiveSwapService.tick — funding gate reuse (evaluateReceiveFunding)', () => {
  it('does not fund when armed with too short a settle window — settle_window_too_short', async () => {
    const outcome = await service.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    ln.armHold(paymentHash, now + MIN_SETTLE_WINDOW - 1)

    const row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('refused')
    expect(arkade.state.fundCalls).toHaveLength(0)
  })

  it('does not fund an armed HTLC against an already-expired invoice', async () => {
    const outcome = await service.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    now = outcome.swap.invoiceExpiresAt + 1
    ln.armHold(paymentHash, now + 4 * 3600)

    const row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('refused')
    expect(arkade.state.fundCalls).toHaveLength(0)
  })

  it('funds once armed with a comfortable settle window, and LEAVES refund_locktime exactly as quoted', async () => {
    const outcome = await service.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    const e = now + 4 * 3600
    ln.armHold(paymentHash, e)

    const row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('funded')
    expect(arkade.state.fundCalls).toHaveLength(1)
    expect(arkade.state.fundCalls[0]).toEqual({ address: row.lockupAddress, amountSats: 5_000 })
    expect(row.refundLocktime).toBeLessThan(e)
    // The gate CHECKS the committed deadline; it does not hand back one to
    // record. The quoted value is what the lockup script commits to, so it is
    // the only value this row may ever carry.
    const decision = evaluateReceiveFunding({
      acceptUnilateralGap: false,
      invoiceExpiresAt: outcome.swap.invoiceExpiresAt,
      htlcExpiresAt: e,
      refundLocktime: outcome.swap.refundLocktime,
      unilateralRefundWithoutReceiverDelay: outcome.swap.refundWithoutReceiverDelay,
      now,
    })
    expect(decision).toEqual({ fund: true })
    expect(row.refundLocktime).toBe(outcome.swap.refundLocktime)
    expect(row.arkadeLockupTxid).toBeTruthy()
  })

  /**
   * Gate (c) reaching the orchestrator: a short-dated `E` that still clears the
   * settle-window check leaves the already-committed 2h deadline stranded past
   * `E`. Nothing can move that deadline — the lockup script is built from it —
   * so the swap must be refused BEFORE any of the provider's own capital moves.
   */
  it('refuses to fund when the committed refund deadline would land past E', async () => {
    const outcome = await service.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    // Clears MIN_SETTLE_WINDOW, but sits inside the quoted refund deadline.
    const e = now + MIN_SETTLE_WINDOW
    expect(e).toBeLessThan(outcome.swap.refundLocktime)
    ln.armHold(paymentHash, e)

    const row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('refused')
    expect(row.failureReason).toMatch(/refund_deadline_too_late/)
    // The defining assertion: no exposure was ever created.
    expect(arkade.state.fundCalls).toHaveLength(0)
  })
})

describe('ReceiveSwapService.tick — crash recovery: no double-funding', () => {
  it('adopts an already-funded output instead of calling fund() again', async () => {
    const outcome = await service.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    ln.armHold(paymentHash, now + 4 * 3600)

    // Simulate a prior crashed attempt: the funding output already exists at
    // the derived script, but the row is still `armed` (the transition never
    // made it to disk).
    arkade.state.outputs = [{ txid: 'already-funded', vout: 0, value: 5_000 }]

    const row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('funded')
    expect(row.arkadeLockupTxid).toBe('already-funded')
    // The defining assertion: fund() must NOT have been called a second time.
    expect(arkade.state.fundCalls).toHaveLength(0)
  })

  it('ignores a stray dust payment to the lockup address and still funds for real', async () => {
    const outcome = await service.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    ln.armHold(paymentHash, now + 4 * 3600)
    arkade.state.outputs = [{ txid: 'dust', vout: 0, value: 10 }]

    const row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('funded')
    expect(arkade.state.fundCalls).toHaveLength(1)
  })

  /**
   * Issue #97. The pre-fund guard used to read `findLockups`, which is
   * `spendableOnly`: a first funding that had already been CLAIMED was
   * invisible to it, so a row still sitting at `armed` funded the same lockup a
   * second time — out of the provider's own pocket, into a script whose one
   * possible claim had already been spent. The spend-aware read is what closes
   * it.
   */
  it('does not fund again when the prior funding was already CLAIMED', async () => {
    const outcome = await service.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    ln.armHold(paymentHash, now + 4 * 3600)

    // Nothing spendable — the claim took it — but the outpoint is still there
    // in the unfiltered view.
    arkade.state.outputs = []
    arkade.state.spentOutputs = [{ txid: 'claimed-funding', vout: 1, value: 5_000 }]

    const row = await service.tick(outcome.swap.id)

    // The defining assertion: the provider's capital moved exactly once.
    expect(arkade.state.fundCalls).toHaveLength(0)
    // And the claimed outpoint is what the row records, so `whenFunded` and
    // `whenRefunding` both have something to act on.
    expect(row.state).toBe('funded')
    expect(row.arkadeLockupTxid).toBe('claimed-funding')
    expect(row.arkadeLockupVout).toBe(1)
    expect(row.arkadeLockupValue).toBe(5_000)
  })

  it('settles the adopted-claimed row once the preimage is readable from that spend', async () => {
    const outcome = await service.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    ln.armHold(paymentHash, now + 4 * 3600)
    arkade.state.outputs = []
    arkade.state.spentOutputs = [{ txid: 'claimed-funding', vout: 0, value: 5_000 }]

    const funded = await service.tick(outcome.swap.id)
    expect(funded.state).toBe('funded')

    arkade.state.claimPreimage = P
    const settled = await service.tick(funded.id)
    expect(settled.state).toBe('settled')
    expect(settled.preimage).toBe(hex.encode(P))
  })

  it('waits at funded — no second fund(), no failure — while the claim is spent but unreadable', async () => {
    const outcome = await service.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    ln.armHold(paymentHash, now + 4 * 3600)
    arkade.state.outputs = []
    arkade.state.spentOutputs = [{ txid: 'claimed-funding', vout: 0, value: 5_000 }]
    // The spend is visible; the spending transaction is not readable yet. That
    // is ordinary indexer lag, not an anomaly.
    arkade.state.claimPreimage = null

    const funded = await service.tick(outcome.swap.id)
    expect(funded.state).toBe('funded')
    const still = await service.tick(funded.id)
    expect(still.state).toBe('funded')
    expect(arkade.state.fundCalls).toHaveLength(0)
  })

  it('neither adopts nor is blocked by a SPENT dust outpoint', async () => {
    const outcome = await service.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    ln.armHold(paymentHash, now + 4 * 3600)
    // The lockup address is public from quote time. A third party paying it a
    // sat and claiming/sweeping that sat back must not be able to convince this
    // leg that it already funded — that would block the swap from ever funding.
    arkade.state.spentOutputs = [{ txid: 'spent-dust', vout: 0, value: 1 }]
    arkade.state.outputs = [{ txid: 'live-dust', vout: 0, value: 10 }]

    const row = await service.tick(outcome.swap.id)

    expect(row.state).toBe('funded')
    expect(arkade.state.fundCalls).toHaveLength(1)
    expect(row.arkadeLockupValue).toBe(5_000)
    expect(row.arkadeLockupTxid).toBe('fund-1')
  })

  /**
   * Adoption runs BEFORE the funding gates, and this is why. A crash between
   * `fund()` and the transition can easily outlive the invoice; failing the row
   * at `armed` for `invoice_expired` would leave the provider's capital in a
   * lockup no state machine is watching, with no outpoint recorded for the
   * refund path to target. The gates decide whether to CREATE exposure —
   * existing exposure is adopted regardless.
   */
  it('adopts a prior funding even when the invoice has since expired', async () => {
    const outcome = await service.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    ln.armHold(paymentHash, now + 4 * 3600)
    arkade.state.outputs = [{ txid: 'pre-crash-funding', vout: 0, value: 5_000 }]
    now = outcome.swap.invoiceExpiresAt + 1

    const row = await service.tick(outcome.swap.id)

    expect(row.state).toBe('funded')
    expect(row.arkadeLockupTxid).toBe('pre-crash-funding')
    expect(arkade.state.fundCalls).toHaveLength(0)
  })
})

describe('ReceiveSwapService.tick — reveal to covclaimd', () => {
  it('reveals once funded, with the script-derived arkadeScript and taptree', async () => {
    const outcome = await service.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    ln.armHold(paymentHash, now + 4 * 3600)

    const row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('funded')
    expect(row.revealedAt).toBe(now)
    expect(covclaimd.state.revealCalls).toBe(1)
    expect(covclaimd.state.lastParams).toMatchObject({ swapAddress: row.lockupAddress })
  })

  it('retries reveal on the next tick after a failure, without re-funding', async () => {
    covclaimd.state.shouldFail = true
    const outcome = await service.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    ln.armHold(paymentHash, now + 4 * 3600)

    // tick() propagates a reveal() failure rather than swallowing it — an
    // operator's onTickError hook needs to see covclaimd is unreachable, the
    // same way any other tick-time fault surfaces (see send/orchestrator.ts's
    // tickAll doc comment).
    await expect(service.tick(outcome.swap.id)).rejects.toThrow(/covclaimd unreachable/)
    const row = await store.get(outcome.swap.id)
    expect(row.state).toBe('funded')
    expect(row.revealedAt).toBeNull()
    expect(covclaimd.state.revealCalls).toBe(1)
    expect(arkade.state.fundCalls).toHaveLength(1)

    covclaimd.state.shouldFail = false
    const second = await service.tick(row.id)
    expect(second.revealedAt).toBe(now)
    expect(covclaimd.state.revealCalls).toBe(2)
    // Still exactly one fund() call across both ticks.
    expect(arkade.state.fundCalls).toHaveLength(1)
  })

  /**
   * covclaimd is OPTIONAL. Configured with none, the solver funds the lockup
   * and then simply waits for the CLIENT to claim it — which the client can,
   * holding the covenant's `receiver` key. This is the path the corridor
   * actually depends on today: `covclaimd:v0.0.1-rc.1` accepts a reveal
   * against this covenant and then silently never claims.
   */
  it('funds and waits without a covclaimd, then settles on the client’s own claim', async () => {
    const solo = new ReceiveSwapService({
      acceptUnilateralGap: false,
      store,
      ln,
      arkade: arkade.ops,
      limits: LIMITS,
      maxExposedSats: 1_000_000,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      now: clock,
    })
    const outcome = await solo.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    ln.armHold(paymentHash, now + 4 * 3600)

    const funded = await solo.tick(outcome.swap.id)
    expect(funded.state).toBe('funded')
    // Nothing was revealed, and nothing threw for the want of a covclaimd.
    expect(funded.revealedAt).toBeNull()
    expect(covclaimd.state.revealCalls).toBe(0)
    expect(arkade.state.fundCalls).toHaveLength(1)

    // The client claims the lockup itself; the solver reads P off that spend
    // exactly as it would off covclaimd's.
    arkade.state.outputs = []
    arkade.state.claimPreimage = P
    const settled = await solo.tick(funded.id)
    expect(settled.state).toBe('settled')
    expect(settled.preimage).toBe(hex.encode(P))
  })

  it('still reaches refunding once the deadline passes, even while covclaimd stays down', async () => {
    covclaimd.state.shouldFail = true
    const outcome = await service.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    ln.armHold(paymentHash, now + 4 * 3600)
    await expect(service.tick(outcome.swap.id)).rejects.toThrow()
    const funded = await store.get(outcome.swap.id)

    now = funded.refundLocktime
    const row = await service.tick(funded.id)
    expect(row.state).toBe('refunded')
    expect(arkade.state.refundCalls).toBe(1)
  })

  it('does not call reveal again once already revealed', async () => {
    const outcome = await service.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    ln.armHold(paymentHash, now + 4 * 3600)
    await service.tick(outcome.swap.id)
    expect(covclaimd.state.revealCalls).toBe(1)

    // Nothing claimed yet, still funded — a second tick must not re-reveal.
    await service.tick(outcome.swap.id)
    expect(covclaimd.state.revealCalls).toBe(1)
  })
})

describe('ReceiveSwapService.tick — claim detection and settlement', () => {
  const armAndFund = async () => {
    const outcome = await service.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    ln.armHold(paymentHash, now + 4 * 3600)
    return service.tick(outcome.swap.id)
  }

  it('transitions to claimed once findClaimPreimage reports a verified preimage, and on to settled', async () => {
    const funded = await armAndFund()
    expect(funded.state).toBe('funded')

    arkade.state.outputs = [] // covclaimd's claim landed
    arkade.state.claimPreimage = P

    const row = await service.tick(funded.id)
    expect(row.state).toBe('settled')
    expect(row.preimage).toBe(hex.encode(P))
    await expect(ln.getHoldState(paymentHash)).resolves.toMatchObject({ status: 'settled' })
  })

  /**
   * The false-negative `stuck` the TLA+ model names in
   * `spec/tla/LightningReceive_SettleNotIdempotent.cfg`.
   *
   * `settleHold` runs BEFORE the claimed->settled compare-and-swap, and the two
   * are separate writes. A process that dies in between leaves no memory that
   * the sats were collected, so the next tick calls `settleHold` again — and on
   * a backend that treats a repeat as an error rather than a no-op, that error
   * is indistinguishable from a settle that never worked. Past `E` the row
   * escalates to `stuck`: terminal, no outgoing edge, for a swap that WAS paid.
   *
   * The model expects GREEN on this configuration precisely because no money
   * invariant fires. The money is fine; the row lies.
   */
  it('does not strand a settled hold in stuck when the repeat settle errors', async () => {
    const funded = await armAndFund()
    arkade.state.outputs = []
    arkade.state.claimPreimage = P

    // First tick settles for real. Then rewind the row to `claimed` with the
    // attempt already recorded — the state a crash between the two writes
    // leaves behind.
    const settledRow = await service.tick(funded.id)
    expect(settledRow.state).toBe('settled')
    await driver.run(`UPDATE receive_swap SET state = 'claimed' WHERE id = ?`, [funded.id])

    // The backend is not idempotent: the hold is already settled, so settling
    // it again throws. And we are past E, which is what used to force `stuck`.
    ln.settleHold = async () => {
      throw new Error('hold already settled')
    }
    now = (await store.get(funded.id)).htlcExpiresAt! + 1

    const row = await service.tick(funded.id)
    // Resolved from the backend's own answer rather than guessed: the hold
    // reads `settled`, which is the fact the transition records.
    expect(row.state).toBe('settled')
    expect(row.settleAttemptedAt).not.toBeNull()
  })

  it('still escalates when the hold did NOT settle, repeat or not', async () => {
    // The other direction, and the one that must not regress: a genuine settle
    // failure past E is still a human's problem. Reading the hold state must
    // resolve the AMBIGUOUS case, never manufacture a settlement.
    const funded = await armAndFund()
    arkade.state.outputs = []
    arkade.state.claimPreimage = P
    await service.tick(funded.id)
    await driver.run(`UPDATE receive_swap SET state = 'claimed' WHERE id = ?`, [funded.id])

    ln.settleHold = async () => {
      throw new Error('backend unreachable')
    }
    ln.getHoldState = async () => ({ status: 'armed' as const, amountSats: 5_000, expiresAt: null })
    now = (await store.get(funded.id)).htlcExpiresAt! + 1

    const row = await service.tick(funded.id)
    expect(row.state).toBe('stuck')
    expect(row.failureReason).toContain('settle failing past E')
  })

  /**
   * The third corner, which arkana's review of #163 named as the one the other
   * two miss: a REPEAT attempt that errors, the hold reading non-settled, and
   * `E` still in the future.
   *
   * It is the safe direction — no money moves and no terminal state is entered
   * — but "safe" is a claim about code nobody had executed. The row must stay
   * `claimed` and be retried, rather than escalating early on the strength of
   * one bad answer from the backend: before `E` there is still time for the
   * settle to succeed, and `stuck` has no way back.
   */
  it('keeps retrying a repeat settle failure while E is still ahead', async () => {
    const funded = await armAndFund()
    arkade.state.outputs = []
    arkade.state.claimPreimage = P
    await service.tick(funded.id)
    await driver.run(`UPDATE receive_swap SET state = 'claimed' WHERE id = ?`, [funded.id])

    ln.settleHold = async () => {
      throw new Error('backend unreachable')
    }
    ln.getHoldState = async () => ({ status: 'armed' as const, amountSats: 5_000, expiresAt: null })
    // The one thing that differs from the escalation test above: E is ahead.
    now = (await store.get(funded.id)).htlcExpiresAt! - 60

    await expect(service.tick(funded.id)).rejects.toThrow('backend unreachable')
    const row = await store.get(funded.id)
    expect(row.state).toBe('claimed')
    // And the attempt stays recorded, so the next tick still takes the repeat
    // path rather than treating itself as a first try.
    expect(row.settleAttemptedAt).not.toBeNull()
  })

  /**
   * The same sibling-outpoint case `whenRefunding` has (see the refund-path
   * suite), on the path that reaches it FIRST. `whenFunded` searches every
   * historical outpoint for exactly the same reason — an adopted row can carry
   * more than one, and the preimage only has to appear in one of their spends.
   *
   * Worth its own test rather than trusting the refund-path one: this branch
   * runs on every ordinary claim, so narrowing it here would strand a completed
   * swap at `funded` until the deadline pushed it down the refund path, turning
   * a settled swap into a refund race it should never have entered.
   */
  it('settles a claim that landed on a sibling outpoint, not the one the row recorded', async () => {
    const funded = await armAndFund()
    const row0 = await store.get(funded.id)
    const recorded = { txid: row0.arkadeLockupTxid!, vout: row0.arkadeLockupVout! }
    const sibling = { txid: 'crashed-earlier-fund', vout: 0, value: row0.payoutSats }
    expect(sibling.txid).not.toBe(recorded.txid)

    arkade.state.outputs = []
    arkade.state.spentOutputs = [{ ...recorded, value: row0.payoutSats }, sibling]
    arkade.state.claimOn = sibling
    arkade.state.claimPreimage = P

    const row = await service.tick(funded.id)
    expect(row.state).toBe('settled')
    expect(row.preimage).toBe(hex.encode(P))
    await expect(ln.getHoldState(paymentHash)).resolves.toMatchObject({ status: 'settled' })
  })

  it('waits (does not escalate) when the lockup looks spent but no preimage is found yet, before the refund deadline', async () => {
    const funded = await armAndFund()
    arkade.state.outputs = []
    arkade.state.claimPreimage = null

    const row = await service.tick(funded.id)
    expect(row.state).toBe('funded')
  })

  /**
   * Places a row directly into `claimed` via the store, bypassing tick()'s
   * own chaining (which — correctly — would drive a `claimed` row with a
   * WORKING settleHold all the way to `settled` in the same call, exactly
   * like send/orchestrator.ts's "a fully-ready swap goes quoted -> claimed in
   * a single call"). These tests want to isolate whenClaimed's own settleHold
   * failure handling, not exercise the chain that leads up to it.
   */
  const putInClaimedState = async (): Promise<{ id: string; htlcExpiresAt: number | null }> => {
    const funded = await armAndFund()
    const row = await store.get(funded.id)
    await store.transition(row.id, 'funded', 'claimed', { preimage: hex.encode(P) })
    return { id: row.id, htlcExpiresAt: row.htlcExpiresAt }
  }

  it('settleHold failing before E propagates for retry, leaving the row claimed', async () => {
    const claimed = await putInClaimedState()
    // A fresh backend that never armed/knows this payment hash — settleHold
    // rejects, the same shape a real backend rejects an unrecognised preimage.
    const brokenLn = new FakeLightningBackend(join(dir, 'broken.json'), 'bcrt', clock)
    const brokenService = new ReceiveSwapService({
      acceptUnilateralGap: false,
      store,
      ln: brokenLn,
      arkade: arkade.ops,
      covclaimd: covclaimd.client,
      limits: LIMITS,
      maxExposedSats: 1_000_000,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      now: clock,
    })
    await expect(brokenService.tick(claimed.id)).rejects.toThrow()
    expect((await store.get(claimed.id)).state).toBe('claimed')
  })

  it('settleHold failing past E escalates to stuck', async () => {
    const claimed = await putInClaimedState()
    now = claimed.htlcExpiresAt! + 1
    const brokenLn = new FakeLightningBackend(join(dir, 'broken2.json'), 'bcrt', clock)
    const brokenService = new ReceiveSwapService({
      acceptUnilateralGap: false,
      store,
      ln: brokenLn,
      arkade: arkade.ops,
      covclaimd: covclaimd.client,
      limits: LIMITS,
      maxExposedSats: 1_000_000,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      now: clock,
    })
    const row = await brokenService.tick(claimed.id)
    expect(row.state).toBe('stuck')
  })

  it('escalates rather than retrying forever when E was never recorded', async () => {
    // Unreachable by construction — `claimed` is only reached through `armed`,
    // which always records E. But without this guard a null E means the
    // past-E escalation can never fire, so a failing settleHold re-throws on
    // every tick with no deadline that could ever end it. Driven through the
    // raw driver because no store method can produce this combination.
    const claimed = await putInClaimedState()
    await driver.run('UPDATE receive_swap SET htlc_expires_at = NULL WHERE id = ?', [claimed.id])
    const brokenLn = new FakeLightningBackend(join(dir, 'broken3.json'), 'bcrt', clock)
    const brokenService = new ReceiveSwapService({
      acceptUnilateralGap: false,
      store,
      ln: brokenLn,
      arkade: arkade.ops,
      covclaimd: covclaimd.client,
      limits: LIMITS,
      maxExposedSats: 1_000_000,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      now: clock,
    })
    const row = await brokenService.tick(claimed.id)
    expect(row.state).toBe('stuck')
    expect(row.failureReason).toMatch(/no htlcExpiresAt recorded/)
  })
})

describe('ReceiveSwapService.tick — refund path', () => {
  const armAndFund = async () => {
    const outcome = await service.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    ln.armHold(paymentHash, now + 4 * 3600)
    return service.tick(outcome.swap.id)
  }

  it('pushes the solver refund once refund_locktime passes with no claim observed', async () => {
    const funded = await armAndFund()
    const row0 = await store.get(funded.id)
    now = row0.refundLocktime

    const row = await service.tick(funded.id)
    expect(row.state).toBe('refunded')
    expect(arkade.state.refundCalls).toBe(1)
  })

  it('recovers to claimed (and on to settled) on a late-but-valid claim, instead of refunding', async () => {
    const funded = await armAndFund()
    const row0 = await store.get(funded.id)
    now = row0.refundLocktime
    arkade.state.claimPreimage = P

    // tick() chains straight through claimed -> settled once recovered (the
    // same "drive as far as it can go" contract every other state enjoys) —
    // the point of this test is that it got there via `claimed`, never via a
    // pushed refund.
    const row = await service.tick(funded.id)
    expect(row.state).toBe('settled')
    expect(arkade.state.refundCalls).toBe(0)
    const history = (await store.history(funded.id)).map((e) => e.to)
    expect(history).toContain('claimed')
    expect(history).not.toContain('refunded')
  })

  /**
   * The money-losing case, and the reason the fake's `refund` above re-derives
   * the script the way the real ops layer does: `assertScriptMatchesRow`
   * (src/receive/arkadeOps.ts) refuses to sign a refund whose covenant does not
   * rebuild the funded pkScript. A row mutated after funding therefore cannot
   * refund AT ALL — the solver's own capital sits in a lockup it can no longer
   * spend, on every swap that took a second or more to fund.
   */
  it('the solver can still refund when funding landed seconds after the quote', async () => {
    const outcome = await service.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    now += 5
    ln.armHold(paymentHash, now + 4 * 3600)
    const funded = await service.tick(outcome.swap.id)
    expect(funded.state).toBe('funded')

    now = funded.refundLocktime
    const row = await service.tick(funded.id)
    expect(row.state).toBe('refunded')
    expect(arkade.state.refundCalls).toBe(1)
  })

  /**
   * The read race this state exists to survive, and the reason the empty-lockup
   * branch below is on a clock rather than on a single observation.
   *
   * The two reads `whenRefunding` makes do not become true at the same instant.
   * `findLockups` is `getVtxos({ spendableOnly: true })`, so it reports the
   * lockup gone the moment the claim marks the vtxo spent; `findClaimPreimage`
   * has to see `spentBy`/`settledBy` populated AND fetch the spending virtual
   * transaction before it can recover `P`. There is therefore a window where
   * the lockup reads empty and the claim is not readable yet — ordinary read
   * lag, on a swap that in fact COMPLETED. Failing there is terminal (`stuck`
   * has no outgoing edge), so it throws away a swap the solver could still
   * settle, while the hold invoice is still unsettled.
   */
  it('rides out the lag between the lockup emptying and the claim becoming readable', async () => {
    const funded = await armAndFund()
    const row0 = await store.get(funded.id)
    now = row0.refundLocktime
    // The claim HAS landed — the lockup is spent, so `findLockups` is already
    // empty — but the transaction that spent it is not readable yet.
    arkade.state.outputs = []
    arkade.state.claimPreimage = null

    const waiting = await service.tick(funded.id)
    expect(waiting.state).toBe('refunding')
    expect(waiting.failureReason).toBeNull()

    // The indexer catches up a beat later, exactly as `whenFunded`'s own
    // read-lag comment says it will.
    arkade.state.claimPreimage = P
    const row = await service.tick(funded.id)
    expect(row.state).toBe('settled')
    expect(row.preimage).toBe(hex.encode(P))
    expect(arkade.state.refundCalls).toBe(0)
  })

  /**
   * The adoption case, which is what makes `whenRefunding` search ALL of the
   * script's outpoints rather than the one the row happens to record.
   *
   * A funding attempt that crashed after paying but before recording leaves a
   * second output on the same script (#97). `whenArmed` adopts one of them and
   * writes THAT outpoint to the row — so the row's recorded outpoint and the
   * outpoint a client's claim actually spends need not be the same one. Search
   * only the recorded outpoint and the claim is invisible: the refund is pushed
   * against a lockup that was already collected, or, once the lockup reads
   * empty, the row is escalated to terminal `stuck` on a swap that COMPLETED.
   *
   * The fake is outpoint-exact here (`claimOn`) precisely so this test fails if
   * the search narrows — the real `findClaimPreimage` is
   * `getVtxos({ outpoints })` and can only ever answer about what it was given.
   */
  it('recovers a late claim that landed on a sibling outpoint, instead of refunding', async () => {
    const funded = await armAndFund()
    const row0 = await store.get(funded.id)
    const recorded = { txid: row0.arkadeLockupTxid!, vout: row0.arkadeLockupVout! }
    const sibling = { txid: 'crashed-earlier-fund', vout: 0, value: row0.payoutSats }
    // The premise: they are different outpoints on the same script.
    expect(sibling.txid).not.toBe(recorded.txid)

    // Past the deadline with the lockup spent and nothing readable yet — the
    // row lands in `refunding`, same as the read-lag case above.
    now = row0.refundLocktime
    arkade.state.outputs = []
    arkade.state.claimPreimage = null
    expect((await service.tick(funded.id)).state).toBe('refunding')

    // Now the spend becomes readable, and it is on the SIBLING: the claim
    // spent the output the crashed attempt created, not the one adopted into
    // the row.
    arkade.state.spentOutputs = [{ ...recorded, value: row0.payoutSats }, sibling]
    arkade.state.claimOn = sibling
    arkade.state.claimPreimage = P

    const row = await service.tick(funded.id)
    expect(row.state).toBe('settled')
    expect(row.preimage).toBe(hex.encode(P))
    expect(arkade.state.refundCalls).toBe(0)
    expect((await store.history(funded.id)).map((e) => e.to)).not.toContain('stuck')
  })

  it('escalates to stuck if the lockup is gone and no claim can be found once past the refund deadline', async () => {
    const funded = await armAndFund()
    const row0 = await store.get(funded.id)
    now = row0.refundLocktime
    // Nothing left, and no explanation for it — arkade.refund() would find
    // nothing to spend either.
    arkade.state.outputs = []
    arkade.state.claimPreimage = null

    // Read lag gets a bounded grace first (the test above), so this state has
    // to PERSIST to be judged inexplicable rather than merely early.
    expect((await service.tick(funded.id)).state).toBe('refunding')
    now += EMPTY_LOCKUP_GRACE

    const row = await service.tick(funded.id)
    expect(row.state).toBe('stuck')
    expect(row.failureReason).toMatch(/no matching claim found/)
    expect(arkade.state.refundCalls).toBe(0)
  })

  it('still escalates to stuck when the claim never becomes readable, however many ticks it takes', async () => {
    const funded = await armAndFund()
    const row0 = await store.get(funded.id)
    now = row0.refundLocktime
    arkade.state.outputs = []
    arkade.state.claimPreimage = null

    // Ticking inside the grace must not be able to postpone the escalation
    // indefinitely: the clock runs from the row's own entry into `refunding`,
    // not from the last attempt, so polling it cannot starve the human.
    for (let elapsed = 0; elapsed < EMPTY_LOCKUP_GRACE; elapsed += 10) {
      now = row0.refundLocktime + elapsed
      expect((await service.tick(funded.id)).state).toBe('refunding')
    }
    now = row0.refundLocktime + EMPTY_LOCKUP_GRACE
    expect((await service.tick(funded.id)).state).toBe('stuck')
  })

  /**
   * TLA+ finding F5 (#38). `LightningReceive_Censored.cfg` reports a Liveness
   * violation for a row whose refund can never be co-signed: it retries for
   * ever and never reaches a terminal state, so nothing tells an operator the
   * server has stopped answering.
   *
   * The deadline is `refundLocktime` rather than an arbitrary grace, and BOTH
   * directions matter. Before it, a failure is expected — the covenant's refund
   * leaf is timelocked, so a push gets `FORFEIT_CLOSURE_LOCKED` until
   * median-time-past catches up, which the runbook records as normal, not an
   * incident. Escalating on those would park healthy rows for a condition that
   * resolves itself.
   */
  describe('a refund the Arkade server will not co-sign', () => {
    const censored = async () => {
      const funded = await armAndFund()
      const row0 = await store.get(funded.id)
      now = row0.refundLocktime
      arkade.state.outputs = [{ txid: row0.arkadeLockupTxid!, vout: row0.arkadeLockupVout!, value: row0.payoutSats }]
      arkade.state.claimPreimage = null
      // `ops`, not the fake itself — that is what the service was built with.
      arkade.ops.refund = async () => {
        throw new Error('server refused to co-sign')
      }
      return { id: funded.id, row0 }
    }

    /**
     * The direction that must not regress, and the one that caught a real
     * defect in the first draft of this guard.
     *
     * A row only ENTERS `refunding` at or past `row.refundLocktime`, so a guard
     * written as `now >= refundLocktime` is always true here — it escalated on
     * the very first failed push, with no retry at all. That parks a healthy
     * row on a momentary arkd blip, which is strictly worse than the loop it
     * replaces. The grace is measured from entry into the state instead.
     */
    it('keeps retrying while the grace is still running', async () => {
      const { id } = await censored()
      // Deep inside the deadline-passed region, so only the GRACE can be what
      // holds the row — if the guard read the deadline this would escalate.
      now += 60

      await expect(service.tick(id)).rejects.toThrow('server refused to co-sign')
      expect((await store.get(id)).state).toBe('refunding')
    })

    it('escalates once the grace runs out, instead of retrying for ever', async () => {
      const { id } = await censored()
      // First tick enters `refunding` and stamps `updated_at`; the grace runs
      // from there.
      await expect(service.tick(id)).rejects.toThrow('server refused to co-sign')
      const entered = await store.get(id)
      expect(entered.state).toBe('refunding')

      now = entered.updatedAt + REFUND_CENSORSHIP_GRACE
      const row = await service.tick(id)
      expect(row.state).toBe('stuck')
      // The cause is carried through: "which server said what" is the first
      // thing an operator needs, and the log line will have scrolled.
      expect(row.failureReason).toContain('server refused to co-sign')
    })
  })
})

describe('ReceiveSwapService.tickAll', () => {
  it('drives every non-terminal row forward', async () => {
    const a = await service.quote(quoteRequest())
    const b = await service.quote(quoteRequest({ paymentHash: hex.encode(sha256(new Uint8Array(32).fill(7))) }))
    if (!a.accepted || !b.accepted) throw new Error('expected acceptance')
    ln.armHold(a.swap.paymentHash, now + 4 * 3600)
    ln.armHold(b.swap.paymentHash, now + 4 * 3600)

    const rows = await service.tickAll()
    expect(rows.map((r) => r.state).sort()).toEqual(['funded', 'funded'])
  })
})

/**
 * The pay half of a coupled self-payment.
 *
 * No Lightning htlc will ever arrive on an invoice we minted and will never
 * pay, so this leg cannot wait for one. It funds against the client's SEND
 * lockup instead — and only once that lockup is funded and holds what it
 * promised, so the solver is never the one exposed first.
 */
describe('ReceiveSwapService.tick — coupled self-payment funding', () => {
  const SEND_PKSCRIPT = hex.encode(p2tr(keyBytes(11)))
  const SEND_AMOUNT = 5_200

  let sendRow: CoupledSendRow | null
  let sendLockups: FundedOutput[]

  beforeEach(() => {
    // No send row AT QUOTE TIME, because that is the only state a coupling is
    // ever quoted from: the receive leg mints the bolt11 first and the send
    // leg quotes against it second. `quote` now refuses a hash the send store
    // already holds, so every test below sets `sendRow` after its quote — the
    // ordering the real flow has.
    sendRow = null
    sendLockups = []
  })

  const coupledService = (): ReceiveSwapService => {
    const ops: ReceiveArkadeOps = {
      ...arkade.ops,
      // Script-aware: this path reads the OTHER leg's lockup, so the fake has
      // to tell the two scripts apart rather than answering the same list.
      findLockups: async (pkScriptHex) => (pkScriptHex === SEND_PKSCRIPT ? sendLockups : arkade.state.outputs),
      findLockupOutpoints: async (pkScriptHex) =>
        (pkScriptHex === SEND_PKSCRIPT ? sendLockups : arkade.state.outputs)
          .map((o) => ({ ...o, spent: false }))
          .concat(pkScriptHex === SEND_PKSCRIPT ? [] : arkade.state.spentOutputs.map((o) => ({ ...o, spent: true }))),
    }
    return new ReceiveSwapService({
      acceptUnilateralGap: false,
      store,
      ln,
      arkade: ops,
      covclaimd: covclaimd.client,
      limits: LIMITS,
      maxExposedSats: 1_000_000,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      now: clock,
      coupledSendStore: { findLiveByPaymentHash: async () => sendRow },
    })
  }

  const quotedCoupled = async (svc: ReceiveSwapService) => {
    const outcome = await svc.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    return outcome.swap
  }

  it('does not fund while the coupled send lockup is unfunded', async () => {
    const svc = coupledService()
    const swap = await quotedCoupled(svc)
    // Their leg has not been funded yet: we must not go first.
    sendRow = { state: 'quoted', pkScript: SEND_PKSCRIPT, amountSats: SEND_AMOUNT }

    const row = await svc.tick(swap.id)

    expect(row.state).toBe('quoted')
    expect(arkade.state.fundCalls).toHaveLength(0)
  })

  it('refuses to fund when the coupled send lockup cannot cover the payout', async () => {
    // Unreachable from outside: the send corridor couples only against the
    // bolt11 we minted, so both legs are priced off one amount. Asserted here
    // because that is an argument living in another file, and this is the leg
    // that actually pays — it refuses to pay short on its own evidence.
    const svc = coupledService()
    const swap = await quotedCoupled(svc)
    expect(swap.payoutSats).toBe(5_000)
    // Funded, and holding exactly what it promised: every pre-existing gate on
    // this path is satisfied. Only the two amounts are wrong against each other.
    sendRow = { state: 'funded', pkScript: SEND_PKSCRIPT, amountSats: 1_000 }
    sendLockups = [{ txid: 's1', vout: 0, value: 1_000 }]

    const row = await svc.tick(swap.id)

    expect(row.state).toBe('refused')
    expect(row.failureReason).toContain('cannot cover')
    expect(arkade.state.fundCalls).toHaveLength(0)
  })

  it('refuses at the funding step too, not only at the quote-time check', async () => {
    // The two copies of the coupled gate are kept symmetric on purpose, and
    // this drives the second one — the copy that sits immediately before
    // `fund`. The store answers nothing to `quote`, healthy to `whenQuoted`
    // and short to `whenArmed`, which no real store does today: the point is
    // that the funding step does not inherit a conclusion reached minutes
    // earlier.
    let answered = 0
    const svc = new ReceiveSwapService({
      acceptUnilateralGap: false,
      store,
      ln,
      arkade: {
        ...arkade.ops,
        findLockups: async (pkScriptHex) => (pkScriptHex === SEND_PKSCRIPT ? sendLockups : arkade.state.outputs),
      },
      covclaimd: covclaimd.client,
      limits: LIMITS,
      maxExposedSats: 1_000_000,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      now: clock,
      coupledSendStore: {
        findLiveByPaymentHash: async () => {
          answered += 1
          // Call 1 is `quote` itself, which consults this store now too and
          // has to see nothing: a coupling is always quoted before its send
          // leg exists. Then `whenQuoted`, then `whenArmed`.
          if (answered === 1) return null
          return { state: 'funded', pkScript: SEND_PKSCRIPT, amountSats: answered === 2 ? SEND_AMOUNT : 1_000 }
        },
      },
    })
    const swap = await quotedCoupled(svc)
    sendLockups = [{ txid: 's1', vout: 0, value: SEND_AMOUNT }]

    const row = await svc.tick(swap.id)

    // Past the quote's own call, so both copies of the gate were consulted,
    // and the second one is what stopped this.
    expect(answered).toBeGreaterThan(2)
    expect(row.state).toBe('refused')
    expect(row.failureReason).toContain('cannot cover')
    expect(arkade.state.fundCalls).toHaveLength(0)
  })

  it('funds once the coupled send lockup is funded and holds the quoted amount', async () => {
    const svc = coupledService()
    const swap = await quotedCoupled(svc)
    sendRow = { state: 'funded', pkScript: SEND_PKSCRIPT, amountSats: SEND_AMOUNT }
    sendLockups = [{ txid: 's1', vout: 0, value: SEND_AMOUNT }]

    const row = await svc.tick(swap.id)

    expect(row.state).toBe('funded')
    expect(arkade.state.fundCalls).toHaveLength(1)
    // Funded with no htlc anywhere: nothing armed this invoice, and nothing will.
    expect(row.htlcExpiresAt).toBeNull()
  })

  it('does not fund when the coupled send lockup holds the wrong amount', async () => {
    const svc = coupledService()
    const swap = await quotedCoupled(svc)
    sendRow = { state: 'funded', pkScript: SEND_PKSCRIPT, amountSats: SEND_AMOUNT }
    // A sat short is not a smaller swap — it is a swap whose collect leg would
    // not cover this payout.
    sendLockups = [{ txid: 's1', vout: 0, value: SEND_AMOUNT - 1 }]

    const row = await svc.tick(swap.id)

    expect(row.state).toBe('quoted')
    expect(arkade.state.fundCalls).toHaveLength(0)
  })

  it('still waits for an htlc on an UNCOUPLED row', async () => {
    // The ordinary path, unchanged: no coupling, no armed htlc, no funding.
    const svc = coupledService()
    const swap = await quotedCoupled(svc)
    sendRow = null

    const row = await svc.tick(swap.id)

    expect(row.state).toBe('quoted')
    expect(arkade.state.fundCalls).toHaveLength(0)
  })

  it('retires the vestigial invoice once the quotes are concluded', async () => {
    // It is our bolt11, and anyone can pay a bolt11. Left open, a client could
    // hand it to a third party and have us settle an htlc AND claim their
    // lockup — twice off one preimage.
    const svc = coupledService()
    const swap = await quotedCoupled(svc)
    sendRow = { state: 'funded', pkScript: SEND_PKSCRIPT, amountSats: SEND_AMOUNT }
    sendLockups = [{ txid: 's1', vout: 0, value: SEND_AMOUNT }]

    expect((await ln.getHoldState(paymentHash)).status).toBe('pending')
    const row = await svc.tick(swap.id)

    expect(row.state).toBe('funded')
    expect((await ln.getHoldState(paymentHash)).status).toBe('cancelled')
  })

  it('still pays out when the backend cannot cancel', async () => {
    // `cancelHold` is optional on the port — not every rail has one — and this is
    // housekeeping, not a money step. An absent cancel must not cost the payout.
    // Spelled out rather than spread: the methods live on the prototype, so a
    // spread would drop them all and test nothing. This is the shape of an
    // adapter that implements the required three and no more.
    const noCancel = {
      createHoldInvoice: ln.createHoldInvoice.bind(ln),
      getHoldState: ln.getHoldState.bind(ln),
      settleHold: ln.settleHold.bind(ln),
    }
    const svc = new ReceiveSwapService({
      acceptUnilateralGap: false,
      store,
      ln: noCancel,
      arkade: {
        ...arkade.ops,
        findLockups: async (pkScriptHex) => (pkScriptHex === SEND_PKSCRIPT ? sendLockups : arkade.state.outputs),
      },
      covclaimd: covclaimd.client,
      limits: LIMITS,
      maxExposedSats: 1_000_000,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      now: clock,
      coupledSendStore: { findLiveByPaymentHash: async () => sendRow },
    })
    const swap = await quotedCoupled(svc)
    sendRow = { state: 'funded', pkScript: SEND_PKSCRIPT, amountSats: SEND_AMOUNT }
    sendLockups = [{ txid: 's1', vout: 0, value: SEND_AMOUNT }]

    const row = await svc.tick(swap.id)

    expect(row.state).toBe('funded')
    expect(arkade.state.fundCalls).toHaveLength(1)
  })

  it('pays out even when the cancel itself fails', async () => {
    // Same reasoning: a failed cancel leaves the invoice open, which past this
    // point only means a late htlc fails back at E instead of immediately.
    const svc = coupledService()
    const swap = await quotedCoupled(svc)
    sendRow = { state: 'funded', pkScript: SEND_PKSCRIPT, amountSats: SEND_AMOUNT }
    sendLockups = [{ txid: 's1', vout: 0, value: SEND_AMOUNT }]
    ln.cancelHold = async () => {
      throw new Error('backend unreachable')
    }

    const row = await svc.tick(swap.id)

    expect(row.state).toBe('funded')
    expect(arkade.state.fundCalls).toHaveLength(1)
  })

  it('does NOT retire the invoice while the send lockup is still unfunded', async () => {
    // Until they have committed, paying this invoice the ordinary way is still
    // a legitimate thing for the client to do.
    const svc = coupledService()
    const swap = await quotedCoupled(svc)
    sendRow = { state: 'quoted', pkScript: SEND_PKSCRIPT, amountSats: SEND_AMOUNT }

    await svc.tick(swap.id)

    expect((await ln.getHoldState(paymentHash)).status).toBe('pending')
  })

  it('takes the ordinary armed path when a coupled row somehow arms', async () => {
    // A real htlc always wins. Coupling must never override one, or a row could
    // be funded against a send lockup while an htlc it must settle is also live.
    const svc = coupledService()
    const swap = await quotedCoupled(svc)
    sendRow = { state: 'funded', pkScript: SEND_PKSCRIPT, amountSats: SEND_AMOUNT }
    sendLockups = [{ txid: 's1', vout: 0, value: SEND_AMOUNT }]
    const e = now + 4 * 3600
    ln.armHold(paymentHash, e)

    const row = await svc.tick(swap.id)

    expect(row.state).toBe('funded')
    // The htlc's own deadline was recorded, which only the ordinary path does.
    expect(row.htlcExpiresAt).toBe(e)
  })
})

/**
 * Gate (d) — the solver's own unilateral recourse against `E` (#69) — at the
 * ORCHESTRATOR level rather than the core level.
 *
 * `test/core/receive.test.ts` already pins the arithmetic at both boundaries.
 * What it cannot show is that a real row reaches the gate at all, refuses in
 * the state the operator will read, and — the part that costs money if it is
 * wrong — funds nothing on its way out. Both refusals below are reachable only
 * through a deployment's own exit delay, so neither is exercised by any test
 * that uses the ordinary DELAYS.
 */
describe("ReceiveSwapService — the solver's own recourse window", () => {
  /** The same service, with only the operator's exit delay — and stance on it — changed. */
  const serviceWithExitDelay = (unilateralRefundWithoutReceiverDelay: number, acceptUnilateralGap = false) =>
    new ReceiveSwapService({
      acceptUnilateralGap,
      store,
      ln,
      arkade: { ...arkade.ops, delays: { ...DELAYS, unilateralRefundWithoutReceiverDelay } },
      covclaimd: covclaimd.client,
      limits: LIMITS,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      maxExposedSats: 1_000_000,
      now: clock,
    })

  it('refuses the quote outright when no payable E can satisfy the gate, and mints nothing', async () => {
    // 301056s (588 x 512, the covenant's required granularity) is just past the
    // ~3.5-day ceiling the runbook names. The window it forces is 301056 +
    // UNILATERAL_RECOURSE_MARGIN = 302856s, or 2020 blocks against a
    // MAX_FINAL_CLTV_BLOCKS of 2016. An invoice asking that much is beyond a
    // stock payer's max_cltv_expiry, so it would simply never be paid.
    const outcome = await serviceWithExitDelay(301_056).quote(quoteRequest())
    expect(outcome).toEqual({ accepted: false, reason: 'recourse_window_unservable' })

    // Refused BEFORE the mint. A hold invoice left behind by a declined quote
    // is payable by anyone, which is the whole reason this check sits where it
    // does. `getOwnInvoiceState` answers null for an unknown hash rather than
    // throwing, so this asserts absence rather than catching an error.
    await expect(ln.getOwnInvoiceState(paymentHash)).resolves.toBeNull()
  })

  it('refuses to fund an armed row whose E lands inside the recourse window, without funding', async () => {
    // 10752s (21 x 512) is short enough to quote — 84 blocks — but long enough
    // to bind before gates (b) and (c): with E at now+10800, gate (b) wants 5400
    // and gate (c) wants 8100 — both satisfied — while gate (d) wants 10752 +
    // 1800 = 12552 and is the only one that fails. Isolating it is the point; a
    // shorter E would refuse settle_window_too_short and prove nothing.
    const svc = serviceWithExitDelay(10_752)
    const outcome = await svc.quote(quoteRequest())
    if (!outcome.accepted) throw new Error(`expected acceptance, got ${outcome.reason}`)

    ln.armHold(paymentHash, now + 3 * 3600)
    // One tick, not two: `tick` drives as far as the row can go, so it arms on
    // the real htlc and then meets the gate in the same call. The row passing
    // THROUGH `armed` is what makes this the orchestrator's gate rather than
    // the quote's — checked on the history below.
    const row = await svc.tick(outcome.swap.id)
    expect(row.state).toBe('refused')
    expect((await store.history(row.id)).map((e) => e.to)).toContain('armed')
    expect(row.failureReason).toBe('refused to fund: unilateral_recourse_after_htlc')
    // The assertion that costs money if it fails: refused means nothing moved.
    expect(arkade.state.fundCalls).toHaveLength(0)
  })

  /**
   * The same two refusals with the operator's consent given — the wiring, not
   * the arithmetic.
   *
   * `test/core/receive.test.ts` proves `minFinalCltvBlocksFor` and
   * `evaluateReceiveFunding` answer differently when the gap is accepted. What
   * it cannot prove is that the flag REACHES them: it is read at two separate
   * call sites in this class, one per gate, and a `false` literal left at either
   * would leave a deployment that believes it accepted the window still refusing
   * every swap. Both paths below are the same scenarios as above, inverted.
   */
  describe('with the operator accepting the window', () => {
    it('quotes the delay that was unservable, and mints an invoice a payer would honour', async () => {
      // Same 301056s that refuses outright above. Accepted, the gate (d) term
      // drops out and gates (b)/(c) set the delta instead — an ordinary short
      // window, not merely one under the ceiling.
      const outcome = await serviceWithExitDelay(301_056, true).quote(quoteRequest())
      expect(outcome.accepted).toBe(true)
      if (!outcome.accepted) throw new Error(`expected acceptance, got ${outcome.reason}`)
      // The mint really happened this time — the refusal above asserts its absence.
      await expect(ln.getHoldState(paymentHash)).resolves.toMatchObject({ status: 'pending' })
      // Reaching the quote gate is not enough on its own: a flag threaded to the
      // chooser but not the invoice would still ask for an unpayable delta. Read
      // off the BOLT11 the corridor actually published rather than a test-only
      // accessor, since the delta is what a payer will judge it by.
      expect(decodeInvoice(outcome.swap.invoice).minFinalCltvBlocks).toBeLessThanOrEqual(MAX_FINAL_CLTV_BLOCKS)
    })

    it('funds an armed row whose E lands inside the recourse window', async () => {
      // The second call site. Same 10752s exit delay and same E as the refusal
      // above, so gate (d) is still the only gate that would fail — meaning a
      // fund here can only mean the flag reached `evaluateReceiveFunding`.
      const svc = serviceWithExitDelay(10_752, true)
      const outcome = await svc.quote(quoteRequest())
      if (!outcome.accepted) throw new Error(`expected acceptance, got ${outcome.reason}`)

      ln.armHold(paymentHash, now + 3 * 3600)
      const row = await svc.tick(outcome.swap.id)
      expect(row.failureReason).toBeNull()
      expect(row.state).not.toBe('refused')
      // The inverse of the assertion above, and the one that proves the wiring:
      // consent given, the lockup is actually funded.
      expect(arkade.state.fundCalls).toHaveLength(1)
    })
  })
})

/**
 * Issue #99 — a minted hold invoice must not outlive the quote that minted it.
 *
 * `createHoldInvoice` runs BEFORE the row is inserted, so a quote that fails
 * after the mint leaves an invoice on the backend that nothing on our side will
 * ever settle or expire. LND holds every unpaid invoice against
 * `maxpendinginvoices` (default 1000) until it is settled, cancelled or
 * expires, so quotes nobody pays are a slow way to fill that table — and none
 * of them has to be malicious.
 *
 * The duplicate case is the exception, and it is the one that nearly went in
 * wrong: an invoice is keyed BY PAYMENT HASH, so a duplicate insert means
 * another LIVE row owns this hash and a cancel would close ITS invoice.
 */
describe('retiring a hold invoice the quote never used (#99)', () => {
  it('cancels the mint when the insert fails for any reason but uniqueness', async () => {
    const quoted = await service.quote(quoteRequest())
    expect(quoted.accepted).toBe(true)
    expect((await ln.getHoldState(paymentHash)).status).toBe('pending')

    // A non-uniqueness failure: the hash is exclusively ours, so the mint is
    // pure litter and there is nothing to protect.
    const otherHash = hex.encode(sha256(new Uint8Array(32).fill(21)))
    store.insertQuote = async () => {
      throw new Error('database is locked')
    }
    await expect(service.quote(quoteRequest({ paymentHash: otherHash }))).rejects.toThrow('database is locked')
    expect((await ln.getHoldState(otherHash)).status).toBe('cancelled')
  })

  it('does NOT cancel when the insert loses a RACE on the payment hash', async () => {
    // The bug this test exists to prevent, and it only exists in the race.
    // An ordinary duplicate is refused before the mint (see the comment at the
    // findLiveByPaymentHash check), so the UNIQUE branch in the catch is
    // reachable ONLY when two quotes both pass that check and one loses at the
    // insert. Then the winner owns the hash, its invoice is live, and
    // cancelling would close a quote the client may still pay.
    const quoted = await service.quote(quoteRequest())
    if (!quoted.accepted) throw new Error('first quote refused')

    // Simulate the loser: past the pre-check, refused by the index.
    store.findLiveByPaymentHash = async () => null
    store.insertQuote = async () => {
      throw new Error('UNIQUE constraint failed: receive_swap.payment_hash')
    }
    const loser = await service.quote(quoteRequest())
    expect(loser.accepted).toBe(false)
    if (!loser.accepted) expect(loser.reason).toBe('duplicate_swap')

    // The winner's invoice is untouched.
    expect((await ln.getHoldState(paymentHash)).status).toBe('pending')
  })
  it('cancels the mint when an unpaid quote expires', async () => {
    const quoted = await service.quote(quoteRequest())
    if (!quoted.accepted) throw new Error('quote refused')

    now = (await store.get(quoted.swap.id)).invoiceExpiresAt + 1
    const row = await service.tick(quoted.swap.id)

    expect(row.state).toBe('refused')
    expect((await ln.getHoldState(paymentHash)).status).toBe('cancelled')
  })
})

/**
 * BLOCK-TYPED TIMELOCKS, through the orchestrator rather than the arithmetic.
 *
 * The unit test in `test/core/blockTimelocks.test.ts` proves the two functions
 * answer differently. This is where using the wrong one actually moves money:
 * a freshly funded block-typed row has a `refund_locktime` of a few hundred,
 * and the clock is 1.8 billion. Anything that asks "has it opened?" against the
 * clock says yes, immediately, and refunds a swap that is minutes old.
 */
describe('ReceiveSwapService — block-typed timelocks', () => {
  const BLOCK_DELAYS = {
    unilateralClaimDelay: 20,
    unilateralRefundDelay: 20,
    unilateralRefundWithoutReceiverDelay: 28,
  }
  const TIP = 800

  /** A tip a test can advance, which is what "mining" is on this side. */
  const movableTip = (start: number) => {
    let height = start
    return { provider: { height: async () => height }, mine: (n: number) => (height += n) }
  }

  const blockService = (chainTip?: { height(): Promise<number> }) =>
    new ReceiveSwapService({
      acceptUnilateralGap: false,
      store,
      ln,
      arkade: { ...arkade.ops, delays: BLOCK_DELAYS },
      covclaimd: covclaimd.client,
      limits: LIMITS,
      maxExposedSats: 1_000_000,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      chainTip,
      now: clock,
    })

  /** `E` past gate (d): 28 blocks converts to 16800s, plus the recourse margin. */
  const armWindow = 8 * 3600

  it('writes the refund deadline as a HEIGHT, projected from the tip', async () => {
    const tip = movableTip(TIP)
    const outcome = await blockService(tip.provider).quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    const row = await store.get(outcome.swap.id)
    // MAX_REFUND_HORIZON is 2h, which is 12 blocks at the nominal interval.
    expect(row.refundLocktime).toBe(TIP + 12)
  })

  it('builds the covenant from that same height, so the row can spend its own lockup', async () => {
    const tip = movableTip(TIP)
    const outcome = await blockService(tip.provider).quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    const row = await store.get(outcome.swap.id)
    // The check `assertScriptMatchesRow` runs before every claim and refund: a
    // second conversion anywhere would derive a script the row cannot spend.
    const rebuilt = covenantScriptFromRow(receiveCovenantRowFor(row))
    expect(hex.encode(rebuilt.pkScript)).toBe(row.pkScript)
  })

  it('refuses to quote at all when block mode has nowhere to read a height', async () => {
    await expect(blockService(undefined).quote(quoteRequest())).rejects.toThrow(/no chainTip provider is wired/)
  })

  it('does NOT read a fresh block-typed row as past its deadline, though the clock dwarfs it', async () => {
    // The regression this pins: `now >= row.refundLocktime` is `1800000000 >= 812`.
    // A swap minutes old would refund itself on its first tick.
    const tip = movableTip(TIP)
    const service = blockService(tip.provider)
    const outcome = await service.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    ln.armHold(paymentHash, now + armWindow)
    const funded = await service.tick(outcome.swap.id)
    expect(funded.state).toBe('funded')
    // Still funded on the next tick, with nothing refunded.
    expect((await service.tick(funded.id)).state).toBe('funded')
    expect(arkade.state.refundCalls).toBe(0)
  })

  it('refunds once the CHAIN passes the height, with the wall clock unmoved', async () => {
    const tip = movableTip(TIP)
    const service = blockService(tip.provider)
    const outcome = await service.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    ln.armHold(paymentHash, now + armWindow)
    const funded = await service.tick(outcome.swap.id)
    expect(funded.state).toBe('funded')

    const before = now
    tip.mine(20)
    expect(now).toBe(before)
    const row = await service.tick(funded.id)
    expect(row.state).toBe('refunded')
    expect(arkade.state.refundCalls).toBe(1)
  })

  it('leaves a seconds-typed deployment reading its deadline off the clock', async () => {
    // The additive claim at this level: the default service has no `chainTip`
    // and must behave exactly as it always did.
    const outcome = await service.quote(quoteRequest())
    if (!outcome.accepted) throw new Error('expected acceptance')
    const row = await store.get(outcome.swap.id)
    expect(row.refundLocktime).toBe(now + MAX_REFUND_HORIZON)
  })
})
