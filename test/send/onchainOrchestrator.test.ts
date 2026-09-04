import { describe, it, expect, beforeEach } from 'vitest'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { SigHash } from '@scure/btc-signer'
import { OnchainSendSwapService, HTLC_REFUND_MTP_MARGIN } from '@arkade-os/solver-corridors/send/onchainOrchestrator.js'
import { ARKADE_CLAIM_WINDOW_SECONDS } from '@arkade-os/solver-core/core/onchainSend.js'
import {
  OnchainSendSwapStore,
  type OnchainSendSwapState,
  type OnchainSendSwapRow,
} from '@arkade-os/solver-corridors/db/onchainSwaps.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { FakeOnchainBackend } from '@arkade-os/solver-rails-fake/onchain/fake/backend.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import type { OnchainSigner } from '@arkade-os/solver-rails/onchain/refund.js'

const keyBytes = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))

const P = new Uint8Array(32).fill(9)
const paymentHash = hex.encode(sha256(P))
// A SECOND, distinct hash, so two quotes can be in flight at once without
// tripping the live-payment-hash uniqueness index — which would otherwise
// refuse the second for a reason that has nothing to do with the exposure cap.
const otherPaymentHash = hex.encode(sha256(keyBytes(11)))
// The onchain HTLC's claim key is never lift_x'd (it's pushed as raw bytes
// into a plain CHECKSIG script, validated only at spend time), so an
// arbitrary 32-byte value is fine here. The Arkade-side keys below ARE
// lift_x'd by the SDK's covenant-tweak math and must be real curve points —
// derived via keyBytes(), same as the existing send-leg test's REFUND_ADDRESS.
const payoutPubkey = hex.encode(new Uint8Array(32).fill(3))
const clientRefundPubkey = hex.encode(keyBytes(10))
// providerPubkey doubles as the onchain HTLC's refundPubkey
// (onchainOrchestrator.ts: `htlcPubkey = arkade.providerPubkey`), so it
// must be a REAL key the test's `signer` below can sign for — unlike the
// other Arkade-only keys, an arbitrary curve point is not enough here.
const solverRefundPriv = new Uint8Array(32).fill(7)
const providerPubkey = hex.encode(schnorr.getPublicKey(solverRefundPriv))
const serverPubkey = hex.encode(keyBytes(5))
const emulatorPubkey = hex.encode(keyBytes(6))

/** Mirrors the SDK's own `SeedIdentity.signTxWithKey` — see test/onchain/refund.test.ts. */
const signer: OnchainSigner = {
  sign: async (tx, inputIndexes) => {
    const clone = tx.clone()
    for (const idx of inputIndexes ?? [0]) clone.signIdx(solverRefundPriv, idx, [SigHash.DEFAULT])
    return clone
  },
}
/** Any valid 34-byte P2TR script — the fake backend doesn't care where refunds go. */
const refundDestinationScript = Uint8Array.from([0x51, 0x20, ...keyBytes(8)])

// A real, decodable Arkade address for the client's refund destination —
// same construction test/send/orchestrator.test.ts's REFUND_ADDRESS uses.
const REFUND_ADDRESS = new CovenantSwapScript({
  receiver: keyBytes(4),
  server: keyBytes(5),
  preimageHash: new Uint8Array(20).fill(9),
  refundLocktime: 1_800_000_000,
  claimDelay: 512,
  client: keyBytes(11),
  clientRefundDelay: 1024,
  refundWithoutServerDelay: 2048,
  nonInteractiveParameters: {
    emulatorPubkey: keyBytes(6),
    receiverPkScript: Uint8Array.from([0x51, 0x20, ...keyBytes(13)]),
    senderPkScript: Uint8Array.from([0x51, 0x20, ...keyBytes(4)]),
  },
})
  .address('tark', keyBytes(5))
  .encode()

// A realistic unix timestamp, not a tiny synthetic one: refundLocktime is a
// BIP65 absolute locktime, and assertAbsoluteLocktime (src/core/timelocks.ts)
// rejects anything below LOCKTIME_THRESHOLD (500_000_000) as ambiguous with a
// block height — same reason the existing Lightning-leg orchestrator test
// clocks itself off a real invoice timestamp rather than a small counter.
let now = 1_800_000_000
const clock = () => now

const buildDeps = async (fundingVout = 0) => {
  // The driver is held onto, not just handed to the store, so a test can write
  // a row state no store method is allowed to produce — see the "no longer
  // rebuilds the funded script" test.
  const driver = betterSqliteDriver(':memory:')
  const store = await OnchainSendSwapStore.open(driver, clock)
  const onchain = new FakeOnchainBackend(5, fundingVout)
  const outputs = new Map<string, { txid: string; vout: number; value: number }[]>()
  // Scripts whose outputs are PROVABLY spent. Deliberately separate from
  // `outputs` going empty: telling "the money was spent" apart from "the
  // spendable view has not caught up" is the whole point of the second read,
  // and a fake that derived one from the other could not express the gap.
  const spent = new Set<string>()
  const arkade = {
    providerPubkey,
    serverPubkey,
    emulatorPubkey,
    receiverPkScript: hex.encode(Uint8Array.from([0x51, 0x20, ...keyBytes(11)])),
    delays: { unilateralClaimDelay: 512, unilateralRefundDelay: 1024, unilateralRefundWithoutReceiverDelay: 1536 },
    hrp: 'tark',
    findLockups: async (pkScriptHex: string) => outputs.get(pkScriptHex) ?? [],
    lockupProvablySpent: async (pkScriptHex: string) => spent.has(pkScriptHex),
    claim: async () => 'claim-ark-txid',
    refund: async () => 'refund-ark-txid',
  }
  return { store, driver, onchain, arkade, outputs, spent }
}

describe('OnchainSendSwapService', () => {
  let deps: Awaited<ReturnType<typeof buildDeps>>
  let service: OnchainSendSwapService

  beforeEach(async () => {
    now = 1_800_000_000
    deps = await buildDeps()
    service = new OnchainSendSwapService({
      store: deps.store,
      onchain: deps.onchain,
      arkade: deps.arkade,
      limits: { minSats: 1_000, maxSats: 1_000_000 },
      maxExposedSats: 1_000_000,
      totalCommitted: () => deps.store.committedSats(),
      admission: new AdmissionControl(),
      network: 'regtest',
      signer,
      refundDestinationScript,
      now: clock,
    })
  })

  // Issue #105. `quote()` reads the committed total, compares it against the
  // cap, and only then inserts. Both reads land before either insert, so both
  // quotes see the same headroom and both take it.
  //
  // The cap here admits exactly ONE 50_000 swap. Sequentially that is what
  // happens; concurrently the solver ends up committed for 100_000 against a
  // 50_000 cap — real money past a bound an operator set deliberately.
  it('admits only one of two concurrent quotes that cannot both fit under the cap', async () => {
    const capped = new OnchainSendSwapService({
      store: deps.store,
      onchain: deps.onchain,
      arkade: deps.arkade,
      limits: { minSats: 1_000, maxSats: 1_000_000 },
      // Room for one 50_000 lockup and not a sat more.
      maxExposedSats: 50_000,
      totalCommitted: () => deps.store.committedSats(),
      admission: new AdmissionControl(),
      network: 'regtest',
      signer,
      refundDestinationScript,
      now: clock,
    })
    const quote = (hash: string) =>
      capped.quote({
        paymentHash: hash,
        amountSats: 50_000,
        payoutPubkey,
        refundAddress: REFUND_ADDRESS,
        clientRefundPubkey,
      })

    const outcomes = await Promise.all([quote(paymentHash), quote(otherPaymentHash)])

    const accepted = outcomes.filter((outcome) => outcome.accepted)
    expect(accepted).toHaveLength(1)
    expect(outcomes.find((outcome) => !outcome.accepted)?.reason).toBe('provider_at_capacity')
    // The bound that actually matters: what the solver is on the hook for.
    expect(await deps.store.committedSats()).toBeLessThanOrEqual(50_000)
  })

  // The cap is GLOBAL (#96), so the reservation has to be too. This mirrors how
  // `createServices` wires production: separate per-corridor stores, one
  // `totalCommitted` that sums across them, and — the part under test — a
  // single shared AdmissionControl. Give each corridor its own control instead
  // and both admit, because neither can see the other's in-flight quote.
  it('bounds two corridors against ONE cap when they share an admission control', async () => {
    const peer = await buildDeps()
    const shared = new AdmissionControl()
    const totalCommitted = async () => (await deps.store.committedSats()) + (await peer.store.committedSats())

    const corridor = (own: typeof deps, admission: AdmissionControl) =>
      new OnchainSendSwapService({
        store: own.store,
        onchain: own.onchain,
        arkade: own.arkade,
        limits: { minSats: 1_000, maxSats: 1_000_000 },
        maxExposedSats: 50_000,
        totalCommitted,
        admission,
        network: 'regtest',
        signer,
        refundDestinationScript,
        now: clock,
      })

    const quote = (svc: OnchainSendSwapService, hash: string) =>
      svc.quote({
        paymentHash: hash,
        amountSats: 50_000,
        payoutPubkey,
        refundAddress: REFUND_ADDRESS,
        clientRefundPubkey,
      })

    const shared_outcomes = await Promise.all([
      quote(corridor(deps, shared), paymentHash),
      quote(corridor(peer, shared), otherPaymentHash),
    ])
    expect(shared_outcomes.filter((outcome) => outcome.accepted)).toHaveLength(1)
    expect(await totalCommitted()).toBeLessThanOrEqual(50_000)
  })

  it('quote() persists a row with a derived Arkade lockup and onchain HTLC address', async () => {
    const outcome = await service.quote({
      paymentHash,
      amountSats: 50_000,
      payoutPubkey,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey,
    })
    expect(outcome.accepted).toBe(true)
    if (outcome.accepted) {
      expect(outcome.swap.state).toBe('quoted')
      expect(outcome.swap.onchainAddress).toMatch(/^tb|^bcrt|^bc/)
    }
  })

  describe('the corridor fee', () => {
    // 100bps plus 50 flat against a 50_000 sat lockup: the client locks
    // 50_000, the solver funds the onchain HTLC with 50_000 - 500 - 50 = 49_450.
    const FEE = { bps: 100, flatSats: 50 }

    const withFee = (over: { limits?: { minSats: number; maxSats: number }; fee?: typeof FEE } = {}) =>
      new OnchainSendSwapService({
        store: deps.store,
        onchain: deps.onchain,
        arkade: deps.arkade,
        limits: over.limits ?? { minSats: 1_000, maxSats: 1_000_000 },
        maxExposedSats: 1_000_000,
        totalCommitted: () => deps.store.committedSats(),
        admission: new AdmissionControl(),
        network: 'regtest',
        signer,
        refundDestinationScript,
        now: clock,
        fee: over.fee ?? FEE,
      })

    const quoteWithFee = async (amountSats = 50_000, svc = withFee()) =>
      svc.quote({ paymentHash, amountSats, payoutPubkey, refundAddress: REFUND_ADDRESS, clientRefundPubkey })

    it('persists the payout MINUS the fee at quote time', async () => {
      const outcome = await quoteWithFee()
      if (!outcome.accepted) throw new Error(`refused: ${outcome.reason}`)
      expect(outcome.swap.amountSats).toBe(50_000)
      expect(outcome.swap.payoutSats).toBe(49_450)
    })

    it('still gates the CLIENT lockup on the full amount, then funds the HTLC with the payout', async () => {
      const svc = withFee()
      const outcome = await quoteWithFee(50_000, svc)
      if (!outcome.accepted) throw new Error(`refused: ${outcome.reason}`)
      deps.outputs.set(outcome.swap.pkScript, [{ txid: 'lockup-tx', vout: 0, value: 50_000 }])
      const row = await svc.tick(outcome.swap.id)
      expect(row.state).toBe('awaiting_claim')
      const funded = await deps.onchain.findOutputs({ address: row.onchainAddress })
      expect(funded).toHaveLength(1)
      expect(funded[0]?.valueSats).toBe(49_450)
    })

    it('refuses fee_consumes_swap when the fee eats the whole amount', async () => {
      // A 2_000-sat flat fee against a 1_000-sat swap leaves a negative
      // payout. Distinct from amount_out_of_range: 1_000 is inside the
      // corridor's range — it just cannot be priced.
      const outcome = await quoteWithFee(1_000, withFee({ fee: { bps: 0, flatSats: 2_000 } }))
      expect(outcome).toEqual({ accepted: false, reason: 'fee_consumes_swap' })
    })

    it('refuses payout_below_dust when the payout cannot buy a spendable HTLC', async () => {
      // 1_000 - 800 = 200 sats of payout: priced, but below the 330-sat
      // taproot dust floor the claim/refund spends already refuse at.
      const outcome = await quoteWithFee(1_000, withFee({ fee: { bps: 0, flatSats: 800 } }))
      expect(outcome).toEqual({ accepted: false, reason: 'payout_below_dust' })
      // The floor applies at zero fee too — a deployment that narrows its
      // minimum under the dust line gets the same refusal, not a dust HTLC.
      const zeroFee = await quoteWithFee(
        200,
        withFee({ limits: { minSats: 100, maxSats: 1_000_000 }, fee: { bps: 0, flatSats: 0 } }),
      )
      expect(zeroFee).toEqual({ accepted: false, reason: 'payout_below_dust' })
    })

    it('charges nothing when the fee is free, exactly as before it existed', async () => {
      const outcome = await service.quote({
        paymentHash,
        amountSats: 50_000,
        payoutPubkey,
        refundAddress: REFUND_ADDRESS,
        clientRefundPubkey,
      })
      if (!outcome.accepted) throw new Error(`refused: ${outcome.reason}`)
      expect(outcome.swap.payoutSats).toBe(outcome.swap.amountSats)
    })

    it('exact-out: the client locks the solved give, the HTLC carries exactly the requested payout', async () => {
      const svc = withFee()
      const outcome = await svc.quote({
        paymentHash,
        amountSats: 49_450,
        amountSide: 'to',
        payoutPubkey,
        refundAddress: REFUND_ADDRESS,
        clientRefundPubkey,
      })
      if (!outcome.accepted) throw new Error(`refused: ${outcome.reason}`)
      expect(outcome.swap.amountSats).toBe(50_000)
      expect(outcome.swap.payoutSats).toBe(49_450)
      // And the funding path delivers exactly that: the client locks 50_000…
      deps.outputs.set(outcome.swap.pkScript, [{ txid: 'lockup-tx', vout: 0, value: 50_000 }])
      const row = await svc.tick(outcome.swap.id)
      expect(row.state).toBe('awaiting_claim')
      const funded = await deps.onchain.findOutputs({ address: row.onchainAddress })
      expect(funded[0]?.valueSats).toBe(49_450)
    })

    it('exact-out: a sub-dust payout is refused on this side too', async () => {
      const outcome = await withFee({
        limits: { minSats: 100, maxSats: 1_000_000 },
        fee: { bps: 0, flatSats: 0 },
      }).quote({
        paymentHash,
        amountSats: 200,
        amountSide: 'to',
        payoutPubkey,
        refundAddress: REFUND_ADDRESS,
        clientRefundPubkey,
      })
      expect(outcome).toEqual({ accepted: false, reason: 'payout_below_dust' })
    })
  })

  it('refuses a hash that is live in ANOTHER corridor’s store', async () => {
    // Each corridor's own duplicate check sees only its own table; a hash
    // live anywhere else is spoken for just the same.
    const crossChecked = new OnchainSendSwapService({
      store: deps.store,
      onchain: deps.onchain,
      arkade: deps.arkade,
      limits: { minSats: 1_000, maxSats: 1_000_000 },
      maxExposedSats: 1_000_000,
      totalCommitted: () => deps.store.committedSats(),
      admission: new AdmissionControl(),
      network: 'regtest',
      signer,
      refundDestinationScript,
      now: clock,
      peerStores: [{ findLiveByPaymentHash: async () => ({ id: 'other-corridor-row' }) }],
    })
    const outcome = await crossChecked.quote({
      paymentHash,
      amountSats: 50_000,
      payoutPubkey,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey,
    })
    expect(outcome).toEqual({ accepted: false, reason: 'duplicate_swap' })
  })

  it('observes the Arkade lockup and records its txid/vout/value on the funded transition', async () => {
    const outcome = await service.quote({
      paymentHash,
      amountSats: 50_000,
      payoutPubkey,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey,
    })
    if (!outcome.accepted) throw new Error('expected acceptance')
    deps.outputs.set(outcome.swap.pkScript, [{ txid: 'lockup-tx', vout: 0, value: 50_000 }])
    // tick() chains through every step that can proceed without waiting (the
    // fake onchain backend resolves fund() instantly) — same documented
    // behavior as the Lightning leg's orchestrator ("a fully-ready swap goes
    // quoted -> claimed in a single call"). It does NOT stop at 'funded'.
    const row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('awaiting_claim')
    expect(row.onchainLockupTxid).toBe('lockup-tx')
    expect(row.onchainLockupVout).toBe(0)
    expect(row.onchainLockupValue).toBe(50_000)
  })

  it('drives funded -> funding_onchain -> awaiting_claim once the onchain HTLC is funded', async () => {
    const outcome = await service.quote({
      paymentHash,
      amountSats: 50_000,
      payoutPubkey,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey,
    })
    if (!outcome.accepted) throw new Error('expected acceptance')
    deps.outputs.set(outcome.swap.pkScript, [{ txid: 'lockup-tx', vout: 0, value: 50_000 }])
    const row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('awaiting_claim')
    expect(row.fundingTxid).toBeTruthy()
  })

  it('does not fund the onchain HTLC twice when the process dies between fund() and the persist', async () => {
    // The crash-safety hole this guards: onchain.fund() broadcasts a real,
    // irreversible transaction and THEN the process dies (or the store write
    // fails) before funding_txid reaches disk. findRecoverable() hands the row
    // straight back in funding_onchain with a null txid — which, from the row
    // alone, is indistinguishable from "the broadcast never went out" — and a
    // blind resubmit pays the same HTLC a SECOND time out of the solver's own
    // pocket, unrecoverably. The Lightning leg closes this with LND's own
    // idempotency key (orchestrator.ts's whenPaying); an onchain send has no
    // equivalent on any rail, so the only guard left is asking the chain what
    // already happened.
    //
    // fundingVout 2, not 0: the recovered vout must be read off the discovered
    // output, and a fake that always funds at 0 cannot tell that apart from a
    // vout quietly defaulted to 0.
    const localDeps = await buildDeps(2)
    const localService = new OnchainSendSwapService({
      store: localDeps.store,
      onchain: localDeps.onchain,
      arkade: localDeps.arkade,
      limits: { minSats: 1_000, maxSats: 1_000_000 },
      maxExposedSats: 1_000_000,
      totalCommitted: () => deps.store.committedSats(),
      admission: new AdmissionControl(),
      network: 'regtest',
      signer,
      refundDestinationScript,
      now: clock,
    })

    const outcome = await localService.quote({
      paymentHash,
      amountSats: 50_000,
      payoutPubkey,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey,
    })
    if (!outcome.accepted) throw new Error('expected acceptance')
    localDeps.outputs.set(outcome.swap.pkScript, [{ txid: 'lockup-tx', vout: 0, value: 50_000 }])

    const funded: { txid: string; vout: number }[] = []
    const originalFund = localDeps.onchain.fund.bind(localDeps.onchain)
    localDeps.onchain.fund = async (params) => {
      const result = await originalFund(params)
      funded.push(result)
      return result
    }

    // Kill the persist, not the broadcast: fund() runs for real and its output
    // lands on the fake chain, then the transition that would have recorded it
    // throws. That is precisely the window the money is exposed in.
    const originalTransition = localDeps.store.transition.bind(localDeps.store)
    localDeps.store.transition = async (
      id: string,
      from: OnchainSendSwapState,
      to: OnchainSendSwapState,
      fields: Partial<Record<string, unknown>> = {},
    ) => {
      if (from === 'funding_onchain' && to === 'awaiting_claim') throw new Error('simulated crash after broadcast')
      return originalTransition(id, from, to, fields)
    }
    await expect(localService.tick(outcome.swap.id)).rejects.toThrow('simulated crash after broadcast')

    let row = await localDeps.store.get(outcome.swap.id)
    expect(row.state).toBe('funding_onchain')
    expect(row.fundingTxid).toBeNull() // the sats moved; the disk has no idea
    expect(funded).toHaveLength(1)

    // Restart. The sweep picks the row back up exactly the way tickAll() does.
    localDeps.store.transition = originalTransition
    expect((await localDeps.store.findRecoverable()).map((r) => r.id)).toContain(outcome.swap.id)

    row = await localService.tick(outcome.swap.id)
    expect(funded).toHaveLength(1) // 2 is the bug: a second, unrecoverable broadcast
    expect(await localDeps.onchain.findOutputs({ address: row.onchainAddress })).toHaveLength(1)
    expect(row.state).toBe('awaiting_claim')
    expect(row.fundingTxid).toBe(funded[0]?.txid) // the first broadcast, adopted
    expect(row.fundingVout).toBe(2)
  })

  /**
   * TWO WORKERS, one row, one broadcast — issue #103, send side.
   *
   * Two SERVICE INSTANCES on one store, because that is the only way to reach
   * it: `tick()`'s `inFlight` set makes a second tick on the SAME instance
   * return before `submitFunding`, so racing one instance against itself
   * exercises that set and nothing else. `inFlight` is per-process and is
   * exactly what a second worker, a restart, or the Go rewrite removes.
   *
   * Without the lease both instances reach `onchain.fund` and both broadcast an
   * L1 payment to the client's HTLC address, from different UTXOs, because coin
   * selection is per-process. The compare-and-swap on `state` afterwards gates
   * RECORDING, not spending.
   */
  it('two workers on one store broadcast the funding ONCE, not twice', async () => {
    const second = new OnchainSendSwapService({
      store: deps.store,
      onchain: deps.onchain,
      arkade: deps.arkade,
      limits: { minSats: 1_000, maxSats: 1_000_000 },
      maxExposedSats: 1_000_000,
      totalCommitted: () => deps.store.committedSats(),
      admission: new AdmissionControl(),
      network: 'regtest',
      signer,
      refundDestinationScript,
      now: clock,
    })

    const outcome = await service.quote({
      paymentHash,
      amountSats: 50_000,
      payoutPubkey,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey,
    })
    if (!outcome.accepted) throw new Error('expected acceptance')
    deps.outputs.set(outcome.swap.pkScript, [{ txid: 'lockup-tx', vout: 0, value: 50_000 }])

    // Hand-placed AT the funding step, and this is load-bearing. Racing from
    // `quoted` proves nothing: the state compare-and-swap on the FIRST
    // transition already serialises the two, so the loser leaves its step loop
    // long before `submitFunding`. Only workers that both arrive at the fund
    // itself can reproduce the double broadcast — the mutation confirms it,
    // since an earlier version of this test passed with the lease removed.
    await deps.store.transition(outcome.swap.id, 'quoted', 'funded', {})
    await deps.store.transition(outcome.swap.id, 'funded', 'funding_onchain', {})

    const funded: string[] = []
    const originalFund = deps.onchain.fund.bind(deps.onchain)
    deps.onchain.fund = async (params) => {
      funded.push(params.address)
      return originalFund(params)
    }

    // Started together, deliberately not awaited in turn: awaiting the first
    // would let it reach `awaiting_claim`, and the second would then find
    // nothing to do — the path that already worked and proves nothing.
    await Promise.all([service.tick(outcome.swap.id), second.tick(outcome.swap.id)])

    expect(funded).toHaveLength(1)
    expect((await deps.store.get(outcome.swap.id)).state).toBe('awaiting_claim')
  })

  it('does not mistake a third party payment to the HTLC address for its own funding', async () => {
    // onchainAddress is public the moment the client holds a quote, and the
    // refund leaf pays the SOLVER, so paying it is a gift nobody can take
    // back — but a dust payment is a cheap grief. If recovery adopted whatever
    // output it found there, one sat would stop the solver funding at all, and
    // a client who then claimed that sat would reveal P and lose the whole
    // Arkade lockup for it. Only an output for exactly amountSats can be our
    // own funding: both backends pay the address exactly that.
    const outcome = await service.quote({
      paymentHash,
      amountSats: 50_000,
      payoutPubkey,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey,
    })
    if (!outcome.accepted) throw new Error('expected acceptance')
    deps.outputs.set(outcome.swap.pkScript, [{ txid: 'lockup-tx', vout: 0, value: 50_000 }])

    // Strand the row in funding_onchain with NOTHING broadcast — the other
    // half of the ambiguity recovery has to resolve.
    const originalFund = deps.onchain.fund.bind(deps.onchain)
    deps.onchain.fund = async () => {
      throw new Error('simulated broadcast failure')
    }
    await expect(service.tick(outcome.swap.id)).rejects.toThrow('simulated broadcast failure')
    let row = await deps.store.get(outcome.swap.id)
    expect(row.state).toBe('funding_onchain')
    expect(row.fundingTxid).toBeNull()

    // A third party's dust payment to the (public) HTLC address — a different
    // key from the solver's own funding, since it is not the solver's payment.
    const dust = await originalFund({ address: row.onchainAddress, amountSats: 1, idempotencyKey: 'stranger-dust' })

    deps.onchain.fund = originalFund
    row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('awaiting_claim')
    expect(row.fundingTxid).not.toBe(dust.txid)
    const outputs = await deps.onchain.findOutputs({ address: row.onchainAddress })
    expect(outputs).toHaveLength(2) // the dust, plus the funding recovery still had to send
    expect(outputs.find((o) => o.txid === row.fundingTxid)?.valueSats).toBe(50_000)
  })

  it('drives awaiting_claim -> claiming -> claimed once the client reveals the preimage onchain', async () => {
    const outcome = await service.quote({
      paymentHash,
      amountSats: 50_000,
      payoutPubkey,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey,
    })
    if (!outcome.accepted) throw new Error('expected acceptance')
    deps.outputs.set(outcome.swap.pkScript, [{ txid: 'lockup-tx', vout: 0, value: 50_000 }])
    let row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('awaiting_claim')

    // simulate the client's onchain claim: witness = [signature, P, claimScript, controlBlock]
    deps.onchain.spendClaim(row.fundingTxid!, 0, [
      new Uint8Array([0xaa]),
      P,
      new Uint8Array([0xbb]),
      new Uint8Array([0xcc]),
    ])
    row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('claimed')
    expect(row.claimArkTxid).toBe('claim-ark-txid')
  })

  /**
   * TLA+ finding F7 (#104), the half a locktime cannot fix.
   *
   * `onchainRefundLocktimeFor` reserves the budget at quote time, so the
   * geometry always leaves room. Elapsed time can still eat it: a solver down
   * for hours comes back to a claim already on the chain and a deadline nearly
   * spent. It must still claim — that is the only recourse, and a claim landing
   * a second early collects in full — but silence is what turned this into a
   * loss nobody could account for afterwards.
   */
  it('reports the squeeze when the client claims with the refund deadline nearly spent', async () => {
    const outcome = await service.quote({
      paymentHash,
      amountSats: 50_000,
      payoutPubkey,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey,
    })
    if (!outcome.accepted) throw new Error('expected acceptance')
    deps.outputs.set(outcome.swap.pkScript, [{ txid: 'lockup-tx', vout: 0, value: 50_000 }])
    let row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('awaiting_claim')

    const reported: string[] = []
    service.onTickError = (_id, error) => reported.push(error instanceof Error ? error.message : String(error))

    // The claim arrives with less than the budget left before refund_locktime.
    now = row.refundLocktime - ARKADE_CLAIM_WINDOW_SECONDS + 60
    deps.onchain.spendClaim(row.fundingTxid!, 0, [
      new Uint8Array([0xaa]),
      P,
      new Uint8Array([0xbb]),
      new Uint8Array([0xcc]),
    ])
    row = await service.tick(outcome.swap.id)

    // Claimed anyway — the warning must not cost the swap its recourse.
    expect(row.state).toBe('claimed')
    expect(reported.join(' ')).toContain('claim race')
  })

  it('says nothing when the claim arrives with the whole budget intact', async () => {
    const outcome = await service.quote({
      paymentHash,
      amountSats: 50_000,
      payoutPubkey,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey,
    })
    if (!outcome.accepted) throw new Error('expected acceptance')
    deps.outputs.set(outcome.swap.pkScript, [{ txid: 'lockup-tx', vout: 0, value: 50_000 }])
    let row = await service.tick(outcome.swap.id)

    const reported: string[] = []
    service.onTickError = (_id, error) => reported.push(error instanceof Error ? error.message : String(error))
    deps.onchain.spendClaim(row.fundingTxid!, 0, [
      new Uint8Array([0xaa]),
      P,
      new Uint8Array([0xbb]),
      new Uint8Array([0xcc]),
    ])
    row = await service.tick(outcome.swap.id)

    expect(row.state).toBe('claimed')
    expect(reported).toEqual([])
  })

  it('never confuses fundingVout (onchain HTLC) with onchainLockupVout (Arkade lockup) — they are different outputs', async () => {
    // Every other test in this file uses 0 for both, which cannot tell a
    // caller reading the wrong field apart from one reading the right one:
    // both fields would hold the same value either way. Deliberately
    // distinct here so a future swap of the two fields fails this test.
    const localDeps = await buildDeps(3)
    const localService = new OnchainSendSwapService({
      store: localDeps.store,
      onchain: localDeps.onchain,
      arkade: localDeps.arkade,
      limits: { minSats: 1_000, maxSats: 1_000_000 },
      maxExposedSats: 1_000_000,
      totalCommitted: () => deps.store.committedSats(),
      admission: new AdmissionControl(),
      network: 'regtest',
      signer,
      refundDestinationScript,
      now: clock,
    })

    const outcome = await localService.quote({
      paymentHash,
      amountSats: 50_000,
      payoutPubkey,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey,
    })
    if (!outcome.accepted) throw new Error('expected acceptance')
    localDeps.outputs.set(outcome.swap.pkScript, [{ txid: 'lockup-tx', vout: 0, value: 50_000 }])
    let row = await localService.tick(outcome.swap.id)
    expect(row.state).toBe('awaiting_claim')
    expect(row.fundingVout).toBe(3)
    expect(row.onchainLockupVout).toBe(0)

    // The claim lives at fundingVout (3). If findSpendWitness were ever
    // called with onchainLockupVout (0) instead, this witness would never
    // be found and the row would stay in awaiting_claim forever.
    localDeps.onchain.spendClaim(row.fundingTxid!, 3, [
      new Uint8Array([0xaa]),
      P,
      new Uint8Array([0xbb]),
      new Uint8Array([0xcc]),
    ])
    row = await localService.tick(outcome.swap.id)
    expect(row.state).toBe('claimed')
  })

  it('refunds the onchain HTLC once htlcLocktime passes with no client claim', async () => {
    const outcome = await service.quote({
      paymentHash,
      amountSats: 50_000,
      payoutPubkey,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey,
    })
    if (!outcome.accepted) throw new Error('expected acceptance')
    deps.outputs.set(outcome.swap.pkScript, [{ txid: 'lockup-tx', vout: 0, value: 50_000 }])
    let row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('awaiting_claim')

    now = row.htlcLocktime + HTLC_REFUND_MTP_MARGIN + 1 // client never claimed, and the timeout (plus MTP margin) has matured
    row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('refunding_onchain')
    expect(row.onchainRefundTxid).toBeTruthy()

    deps.onchain.mineBlocks(1)
    expect((await service.tick(outcome.swap.id)).state).toBe('refunded')
  })

  it('does not arm the refund at the bare htlcLocktime deadline — needs the MTP margin too', async () => {
    const outcome = await service.quote({
      paymentHash,
      amountSats: 50_000,
      payoutPubkey,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey,
    })
    if (!outcome.accepted) throw new Error('expected acceptance')
    deps.outputs.set(outcome.swap.pkScript, [{ txid: 'lockup-tx', vout: 0, value: 50_000 }])
    let row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('awaiting_claim')

    // Past the bare deadline, but still short of the MTP margin: a refund
    // broadcast here would be rejected as non-final for up to ~an hour.
    now = row.htlcLocktime + 1
    row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('awaiting_claim')
  })

  it('recovers a late-but-valid claim instead of racing it with a refund broadcast', async () => {
    const outcome = await service.quote({
      paymentHash,
      amountSats: 50_000,
      payoutPubkey,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey,
    })
    if (!outcome.accepted) throw new Error('expected acceptance')
    deps.outputs.set(outcome.swap.pkScript, [{ txid: 'lockup-tx', vout: 0, value: 50_000 }])
    let row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('awaiting_claim')

    now = row.htlcLocktime + HTLC_REFUND_MTP_MARGIN + 1

    // Stop the row at refunding_onchain rather than letting tick() chain
    // straight through to refunded in one call (same technique the broadcast
    // retry test below uses) — otherwise there's no gap to land a late claim in.
    const originalBroadcast = deps.onchain.broadcastRaw.bind(deps.onchain)
    deps.onchain.broadcastRaw = async () => {
      throw new Error('simulated broadcast failure')
    }
    await expect(service.tick(outcome.swap.id)).rejects.toThrow('simulated broadcast failure')
    row = await deps.store.get(outcome.swap.id)
    expect(row.state).toBe('refunding_onchain')
    deps.onchain.broadcastRaw = originalBroadcast

    // The client's claim actually confirmed just before the solver's own
    // refund broadcast — without the re-check, the next tick would try (and
    // fail) to double-spend the same output forever, and never recover the
    // preimage needed to claim the Arkade lockup.
    deps.onchain.spendClaim(row.fundingTxid!, 0, [
      new Uint8Array([0xaa]),
      P,
      new Uint8Array([0xbb]),
      new Uint8Array([0xcc]),
    ])
    // tick() chains straight through claiming -> claimed in one call, same as
    // the ordinary "client reveals the preimage onchain" path above — the
    // point here is what it did NOT do: race a refund broadcast first.
    row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('claimed')
    expect(row.claimArkTxid).toBe('claim-ark-txid')
    expect(row.onchainRefundTxid).toBeTruthy()
    expect(await deps.onchain.transactionOutcome(row.onchainRefundTxid!)).toBe('unknown')
  })

  it('routes to stuck rather than broadcasting a sub-dust refund output', async () => {
    const outcome = await service.quote({
      paymentHash,
      amountSats: 1_000,
      payoutPubkey,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey,
    })
    if (!outcome.accepted) throw new Error('expected acceptance')
    deps.outputs.set(outcome.swap.pkScript, [{ txid: 'lockup-tx', vout: 0, value: 1_000 }])
    let row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('awaiting_claim')

    now = row.htlcLocktime + HTLC_REFUND_MTP_MARGIN + 1
    row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('stuck')
    expect(row.failureReason).toMatch(/dust/)
    expect(row.onchainRefundTxid).toBeNull() // never broadcast
  })

  /**
   * Drive a swap to `stuck` through the orchestrator's OWN logic — the
   * sub-dust refund path directly above — rather than hand-setting the state.
   * A hand-set row would prove nothing about whether production can reach the
   * case under test, and would miss the funding txid/vout a real one carries.
   */
  const driveToStuck = async (): Promise<OnchainSendSwapRow> => {
    const outcome = await service.quote({
      paymentHash,
      amountSats: 1_000,
      payoutPubkey,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey,
    })
    if (!outcome.accepted) throw new Error('expected acceptance')
    deps.outputs.set(outcome.swap.pkScript, [{ txid: 'lockup-tx', vout: 0, value: 1_000 }])
    let row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('awaiting_claim')
    now = row.htlcLocktime + HTLC_REFUND_MTP_MARGIN + 1
    row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('stuck')
    return row
  }

  it('never auto-refunds a stuck swap, however far past its refund deadline', async () => {
    const row = await driveToStuck()

    // Past refundLocktime — the only gate besides state that the automatic
    // sweep applies. A `refused` row here would be swept (see the sweep test
    // below); an exposed one must not be, because `stuck` cannot tell "the
    // client never got paid" apart from "the client already claimed onchain
    // and we merely failed to collect", and refunding the latter pays twice.
    now = row.refundLocktime + 1
    expect(await deps.store.findRefundable(now)).toEqual([])
    expect(await service.refundSweep()).toEqual([])

    const after = await deps.store.get(row.id)
    expect(after.refundArkTxid).toBeNull()
    expect(after.refundOutcome).toBeNull()
    // The client's lockup is still sitting at the script, untouched.
    expect(await deps.arkade.findLockups(row.pkScript)).toHaveLength(1)
  })

  it('refundNow() pushes the covenant refund for a stuck swap — the operator override the sweep leaves to a human', async () => {
    const row = await driveToStuck()
    // No clock move: the leaf this spends (nonInteractiveRefund — server +
    // receiver + emulator) carries no timelock, so the override works BEFORE
    // refundLocktime. That is the whole point of it.
    expect(now).toBeLessThan(row.refundLocktime)

    expect(await service.refundNow(row.id)).toBe('refund-ark-txid')

    const after = await deps.store.get(row.id)
    expect(after.refundArkTxid).toBe('refund-ark-txid')
    expect(after.refundOutcome).toBe('pushed')
    // The refund is recorded on the row; the terminal verdict is not rewritten.
    expect(after.state).toBe('stuck')
  })

  it('refundNow() records an already-emptied lockup as external rather than inventing a txid', async () => {
    const row = await driveToStuck()
    // The client took it themselves, via the covenant's client-only
    // refundUnilateral leaf — the recourse that needs nobody but them. The
    // spend is readable, which is what separates this from a stale read.
    deps.outputs.set(row.pkScript, [])
    deps.spent.add(row.pkScript)

    expect(await service.refundNow(row.id)).toBeNull()
    const after = await deps.store.get(row.id)
    expect(after.refundOutcome).toBe('external')
    expect(after.refundArkTxid).toBeNull()
  })

  it('refundNow() refuses to call a stale read an external refund, and tells the operator why', async () => {
    const row = await driveToStuck()
    // The `spendableOnly` view is behind: empty answer, no provable spend, and
    // the client's sats still at the script.
    deps.outputs.set(row.pkScript, [])

    // Throws rather than returning null, because a null here reads as "already
    // refunded" — the exact false verdict this guard exists to prevent, and one
    // an operator would act on.
    await expect(service.refundNow(row.id)).rejects.toThrow(/no spend is provable/)

    const after = await deps.store.get(row.id)
    expect(after.refundOutcome).toBeNull()
    expect(after.refundArkTxid).toBeNull()
  })

  const driveToBroadcastRefund = async (): Promise<OnchainSendSwapRow> => {
    const outcome = await service.quote({
      paymentHash,
      amountSats: 50_000,
      payoutPubkey,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey,
    })
    if (!outcome.accepted) throw new Error('expected acceptance')
    deps.outputs.set(outcome.swap.pkScript, [{ txid: 'lockup-tx', vout: 0, value: 50_000 }])
    let row = await service.tick(outcome.swap.id)
    now = row.htlcLocktime + HTLC_REFUND_MTP_MARGIN + 1
    row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('refunding_onchain')
    expect(row.onchainRefundTxid).toBeTruthy()
    return row
  }

  /** What our OWN refund leaves: no preimage, so shape alone cannot place it (#169). */
  const plantRefundLeafWitness = (row: OnchainSendSwapRow): void =>
    deps.onchain.spendClaim(row.fundingTxid!, 0, [
      new Uint8Array([0xaa]),
      new Uint8Array([0xbb]),
      new Uint8Array([0xcc]),
    ])

  it('recognises its own confirmed refund by txid rather than failing the row to stuck', async () => {
    const row = await driveToBroadcastRefund()
    plantRefundLeafWitness(row)
    deps.onchain.mineBlocks(1)
    const after = await service.tick(row.id)
    expect(after.state).toBe('refunded')
    expect(after.failureReason).toBeNull()
  })

  it('waits rather than settling or sticking while its own refund is still in the mempool', async () => {
    const row = await driveToBroadcastRefund()
    plantRefundLeafWitness(row)
    const after = await service.tick(row.id)
    expect(after.state).toBe('refunding_onchain')
    expect(after.failureReason).toBeNull()
  })

  it('rebuilds and rebroadcasts a refund the mempool dropped instead of calling it refunded', async () => {
    const row = await driveToBroadcastRefund()
    deps.onchain.dropFromMempool(row.onchainRefundTxid!)
    const broadcasts = captureBroadcasts()

    const after = await service.tick(row.id)
    expect(broadcasts).toHaveLength(1)
    expect(after.state).toBe('refunding_onchain')
    deps.onchain.mineBlocks(1)
    expect((await service.tick(row.id)).state).toBe('refunded')
  })

  /**
   * Drive a swap to `stuck` the OTHER way `whenRefundingOnchain` reaches it:
   * the funding output turns out to be spent by something this code cannot
   * read as a matching claim. Through the orchestrator's own logic, not by
   * hand-setting the state — and the witness planted here is the shape that
   * makes this the likeliest real cause rather than an exotic one: the
   * SOLVER'S OWN refund spend (`[signature, refundScript, controlBlock]`, no
   * preimage at witness[1]) that went out before the process died, leaving
   * the transition recording it unwritten.
   */
  const driveToStuckOnUnreadableSpend = async (): Promise<OnchainSendSwapRow> => {
    const outcome = await service.quote({
      paymentHash,
      amountSats: 50_000,
      payoutPubkey,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey,
    })
    if (!outcome.accepted) throw new Error('expected acceptance')
    deps.outputs.set(outcome.swap.pkScript, [{ txid: 'lockup-tx', vout: 0, value: 50_000 }])
    let row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('awaiting_claim')

    // Park the row at refunding_onchain so the spend can appear between the
    // decision to refund and a recorded broadcast — the same technique the
    // late-claim and broadcast-retry tests above use.
    now = row.htlcLocktime + HTLC_REFUND_MTP_MARGIN + 1
    const originalBroadcast = deps.onchain.broadcastRaw.bind(deps.onchain)
    deps.onchain.broadcastRaw = async () => {
      throw new Error('simulated broadcast failure')
    }
    await expect(service.tick(outcome.swap.id)).rejects.toThrow('simulated broadcast failure')
    row = await deps.store.get(outcome.swap.id)
    expect(row.state).toBe('refunding_onchain')
    deps.onchain.broadcastRaw = originalBroadcast

    deps.onchain.spendClaim(row.fundingTxid!, 0, [
      new Uint8Array([0xaa]), // signature
      new Uint8Array([0xbb]), // refundScript — where a claim would carry the preimage
      new Uint8Array([0xcc]), // control block
    ])
    row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('stuck')
    expect(row.failureReason).toMatch(/something other than a matching claim/)
    expect(row.onchainRefundTxid).toBeTruthy()
    expect(await deps.onchain.transactionOutcome(row.onchainRefundTxid!)).toBe('unknown')
    return row
  }

  /** Records every raw transaction handed to the backend, and still broadcasts it. */
  const captureBroadcasts = (): string[] => {
    const broadcasts: string[] = []
    const original = deps.onchain.broadcastRaw.bind(deps.onchain)
    deps.onchain.broadcastRaw = async (txHex) => {
      broadcasts.push(txHex)
      return original(txHex)
    }
    return broadcasts
  }

  it('never retries the L1 refund of a stuck row on its own, however far past its deadline', async () => {
    const row = await driveToStuckOnUnreadableSpend()
    const broadcasts = captureBroadcasts()

    // `stuck` is not a key of LEGAL_EDGES and has no case in step(), and
    // findRecoverable() only selects NON_TERMINAL states — so neither the
    // per-row tick nor the sweep touches it. That is the gap reclaimOnchainHtlc
    // fills, and it must stay a gap: an automatic retry here would re-broadcast
    // a doomed double-spend every cycle for any row that got stuck because the
    // client had in fact already claimed.
    now = row.refundLocktime + 1
    expect(await deps.store.findRecoverable()).toEqual([])
    expect(await service.tickAll()).toEqual([])
    expect((await service.tick(row.id)).state).toBe('stuck')
    expect(broadcasts).toEqual([])
    expect((await deps.store.get(row.id)).onchainRefundTxid).toBe(row.onchainRefundTxid)
  })

  it('reclaimOnchainHtlc() re-broadcasts the solver’s own L1 refund for a row stuck on an unreadable spend', async () => {
    const row = await driveToStuckOnUnreadableSpend()
    const broadcasts = captureBroadcasts()

    // Re-broadcasting against an output that may already be spent is a
    // double-spend, and here that is safe rather than merely tolerable: both
    // legs of this HTLC spend the SAME output, so the worst case is a
    // transaction the network refuses to confirm — never a second payout. The
    // Arkade lockup has no such backstop, which is why refundNow() stays a
    // judgement call and this does not.
    const txid = await service.reclaimOnchainHtlc(row.id)
    expect(txid).toBeTruthy()
    expect(broadcasts).toHaveLength(1) // really went out — not a no-op reporting success

    const after = await deps.store.get(row.id)
    expect(after.onchainRefundTxid).toBe(txid)
    // Recorded on the row; the terminal verdict a human parked it at is not
    // rewritten — same treatment refundNow() gives refund_ark_txid.
    expect(after.state).toBe('stuck')
  })

  it('reclaimOnchainHtlc() refuses once the client has claimed, and hands back the preimage instead', async () => {
    const row = await driveToStuck()
    // The claim leaf carries no locktime (src/onchain/htlc.ts), so a client can
    // still claim long after htlcLocktime and long after the row went stuck.
    deps.onchain.spendClaim(row.fundingTxid!, 0, [
      new Uint8Array([0xaa]),
      P,
      new Uint8Array([0xbb]),
      new Uint8Array([0xcc]),
    ])
    const broadcasts = captureBroadcasts()
    // Cheap fees, so the sub-dust refusal below cannot be what stops this row:
    // the claim check has to be the thing that does, and dropping it has to
    // produce a real broadcast rather than a differently-worded refusal.
    deps.onchain.estimateFeeRate = async () => 1

    // A refund here could never confirm, and the preimage on that witness is
    // what actually recovers the swap — so it goes in the message rather than
    // being spent on a broadcast.
    await expect(service.reclaimOnchainHtlc(row.id)).rejects.toThrow(hex.encode(P))
    expect(broadcasts).toEqual([])
    expect((await deps.store.get(row.id)).onchainRefundTxid).toBeNull()
  })

  it('reclaimOnchainHtlc() refuses a still-sub-dust refund rather than pretending the retry helped', async () => {
    const row = await driveToStuck()
    const broadcasts = captureBroadcasts()

    // Names the rate it refused at, so "fees spiked" stays separable from
    // "this HTLC is too small at any rate" — the difference between a retry
    // worth making later and one that never will be.
    await expect(service.reclaimOnchainHtlc(row.id)).rejects.toThrow(/at 5 sat\/vB/)
    await expect(service.reclaimOnchainHtlc(row.id)).rejects.toThrow(/below the 330 sat dust limit/)
    expect(broadcasts).toEqual([])
    expect((await deps.store.get(row.id)).onchainRefundTxid).toBeNull()
  })

  it('reclaimOnchainHtlc() succeeds on that same dust-stuck row once fees fall — the one lever there is', async () => {
    const row = await driveToStuck()
    // estimateFeeRate is re-read on every attempt, so the refusal above is a
    // verdict about that moment's mempool, not a permanent one.
    deps.onchain.estimateFeeRate = async () => 1

    const txid = await service.reclaimOnchainHtlc(row.id)
    expect((await deps.store.get(row.id)).onchainRefundTxid).toBe(txid)
  })

  it('reclaimOnchainHtlc() refuses a row that never funded an onchain HTLC rather than inventing an outpoint', async () => {
    // Overfunded: fails out of `quoted`, which was never exposed, so it lands
    // in `refused` with no funding txid. The override has no state gate on
    // purpose, so this is exactly the fat-finger it has to survive.
    const outcome = await service.quote({
      paymentHash,
      amountSats: 50_000,
      payoutPubkey,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey,
    })
    if (!outcome.accepted) throw new Error('expected acceptance')
    deps.outputs.set(outcome.swap.pkScript, [{ txid: 'lockup-tx', vout: 0, value: 60_000 }])
    const row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('refused')
    expect(row.fundingTxid).toBeNull()

    const broadcasts = captureBroadcasts()
    await expect(service.reclaimOnchainHtlc(row.id)).rejects.toThrow(/nothing was ever broadcast/)
    expect(broadcasts).toEqual([])
  })

  it('reclaimOnchainHtlc() refuses to sign when the row no longer rebuilds the funded script', async () => {
    const row = await driveToStuck()
    // No store method can produce this: the columns the HTLC is rebuilt from
    // are fixed at quote time, and neither transition() nor patch() may touch
    // them. Written straight through the driver because that IS the case —
    // the branch is unreachable by construction, and what it must never do is
    // sign a spend against a script that is not what was funded. A second
    // attempt would rebuild identically, so refusing is the whole remedy.
    await deps.driver.run('UPDATE send_onchain_swap SET htlc_locktime = ? WHERE id = ?', [
      row.htlcLocktime + 600,
      row.id,
    ])
    const broadcasts = captureBroadcasts()

    await expect(service.reclaimOnchainHtlc(row.id)).rejects.toThrow(/does not match the funded pkScript/)
    expect(broadcasts).toEqual([])
    expect((await deps.store.get(row.id)).onchainRefundTxid).toBeNull()
  })

  /** Automatic refund and operator override on one row, the second entering mid-attempt. */
  const raceRefundAttempts = async (first: 'tick' | 'reclaim'): Promise<OnchainSendSwapRow> => {
    const outcome = await service.quote({
      paymentHash,
      amountSats: 50_000,
      payoutPubkey,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey,
    })
    if (!outcome.accepted) throw new Error('expected acceptance')
    deps.outputs.set(outcome.swap.pkScript, [{ txid: 'lockup-tx', vout: 0, value: 50_000 }])
    const id = outcome.swap.id
    now = (await service.tick(id)).htlcLocktime + HTLC_REFUND_MTP_MARGIN + 1

    let broadcasts = 0
    const broadcastRaw = deps.onchain.broadcastRaw.bind(deps.onchain)
    deps.onchain.broadcastRaw = async (txHex) => {
      if (broadcasts++ > 0) throw new Error('txn-mempool-conflict')
      return broadcastRaw(txHex)
    }
    // Hold the leader mid-attempt; the follower's rate is what makes the txids differ.
    let entered: () => void = () => {}
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    const arrived = new Promise<void>((resolve) => (entered = resolve))
    const estimateFeeRate = deps.onchain.estimateFeeRate.bind(deps.onchain)
    deps.onchain.estimateFeeRate = async () => {
      deps.onchain.estimateFeeRate = estimateFeeRate
      entered()
      await held
      return 4
    }

    const run = (which: 'tick' | 'reclaim') =>
      (which === 'tick' ? service.tick(id) : service.reclaimOnchainHtlc(id)).catch(() => null)
    const leading = run(first)
    await arrived
    await run(first === 'tick' ? 'reclaim' : 'tick')
    release()
    await leading
    return deps.store.get(id)
  }

  it.each(['tick', 'reclaim'] as const)(
    'never leaves a refund txid nobody broadcast when %s gets there first',
    async (first) => {
      const after = await raceRefundAttempts(first)
      expect(after.onchainRefundTxid).toBeTruthy()
      expect(await deps.onchain.transactionOutcome(after.onchainRefundTxid!)).not.toBe('unknown')
    },
  )

  it('refundSweep() still refunds a refused row once its deadline passes, and records the push', async () => {
    const outcome = await service.quote({
      paymentHash,
      amountSats: 50_000,
      payoutPubkey,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey,
    })
    if (!outcome.accepted) throw new Error('expected acceptance')
    // Overfunded: fails out of `quoted`, which was never exposed, so it lands
    // in `refused` — the state the automatic sweep exists for.
    deps.outputs.set(outcome.swap.pkScript, [{ txid: 'lockup-tx', vout: 0, value: 60_000 }])
    let row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('refused')

    expect(await service.refundSweep()).toEqual([]) // deadline not reached yet
    now = row.refundLocktime + 1
    expect(await service.refundSweep()).toEqual([row.id])

    row = await deps.store.get(row.id)
    expect(row.refundArkTxid).toBe('refund-ark-txid')
    expect(row.refundOutcome).toBe('pushed')
  })

  it('refundSweep() leaves a refused row actionable when the lockup reads empty with no provable spend', async () => {
    const outcome = await service.quote({
      paymentHash,
      amountSats: 50_000,
      payoutPubkey,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey,
    })
    if (!outcome.accepted) throw new Error('expected acceptance')
    deps.outputs.set(outcome.swap.pkScript, [{ txid: 'lockup-tx', vout: 0, value: 60_000 }])
    const row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('refused')

    // ONE STALE READ: the `spendableOnly` view answers empty while the sats are
    // still at the script, so `deps.spent` stays empty and no spend is provable.
    deps.outputs.set(row.pkScript, [])
    now = row.refundLocktime + 1

    const errors: string[] = []
    service.onTickError = (id) => errors.push(id)
    expect(await service.refundSweep()).toEqual([])
    expect(errors).toEqual([row.id])

    // Left untouched, so `findRefundable` — which filters `refund_outcome IS
    // NULL` (src/db/onchainSwaps.ts) — still returns it. Without that the sweep
    // gets exactly one look at a row whose money never moved.
    expect((await deps.store.get(row.id)).refundOutcome).toBeNull()
    expect(await deps.store.findRefundable(now)).toHaveLength(1)

    // And the next sweep, once the view catches up, does the real thing.
    deps.outputs.set(row.pkScript, [{ txid: 'lockup-tx', vout: 0, value: 60_000 }])
    expect(await service.refundSweep()).toEqual([row.id])
    expect((await deps.store.get(row.id)).refundOutcome).toBe('pushed')
  })

  it('does not time out the onchain HTLC before htlcLocktime', async () => {
    const outcome = await service.quote({
      paymentHash,
      amountSats: 50_000,
      payoutPubkey,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey,
    })
    if (!outcome.accepted) throw new Error('expected acceptance')
    deps.outputs.set(outcome.swap.pkScript, [{ txid: 'lockup-tx', vout: 0, value: 50_000 }])
    let row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('awaiting_claim')

    now = row.htlcLocktime - 1
    row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('awaiting_claim') // still waiting — not yet timed out
  })

  it('retries a failed refund broadcast rather than failing the row — same convention as submitFunding', async () => {
    const outcome = await service.quote({
      paymentHash,
      amountSats: 50_000,
      payoutPubkey,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey,
    })
    if (!outcome.accepted) throw new Error('expected acceptance')
    deps.outputs.set(outcome.swap.pkScript, [{ txid: 'lockup-tx', vout: 0, value: 50_000 }])
    let row = await service.tick(outcome.swap.id)
    now = row.htlcLocktime + HTLC_REFUND_MTP_MARGIN + 1

    const originalBroadcast = deps.onchain.broadcastRaw.bind(deps.onchain)
    deps.onchain.broadcastRaw = async () => {
      throw new Error('simulated broadcast failure')
    }
    await expect(service.tick(outcome.swap.id)).rejects.toThrow('simulated broadcast failure')
    row = await deps.store.get(outcome.swap.id)
    expect(row.state).toBe('refunding_onchain') // not stuck — a transient failure, next sweep retries

    deps.onchain.broadcastRaw = originalBroadcast
    row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('refunding_onchain')
    deps.onchain.mineBlocks(1)
    expect((await service.tick(outcome.swap.id)).state).toBe('refunded')
  })

  it('refuses an out-of-range amount', async () => {
    const outcome = await service.quote({
      paymentHash,
      amountSats: 5,
      payoutPubkey,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey,
    })
    expect(outcome).toEqual({ accepted: false, reason: 'amount_out_of_range' })
  })

  it('refuses a duplicate live preimage hash', async () => {
    await service.quote({
      paymentHash,
      amountSats: 50_000,
      payoutPubkey,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey,
    })
    const second = await service.quote({
      paymentHash,
      amountSats: 50_000,
      payoutPubkey,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey,
    })
    expect(second).toEqual({ accepted: false, reason: 'duplicate_swap' })
  })

  it('settleRefundDeposits() is empty on a backend whose receive address needs no settling', async () => {
    // FakeOnchainBackend, like the LND adapter, hands out an ordinary address
    // that is spendable once paid, and so implements no settle step at all.
    // The optional call must degrade to "nothing to do", not to a crash.
    await expect(service.settleRefundDeposits()).resolves.toEqual([])
  })

  it('settleRefundDeposits() hands back exactly what the backend settled, failures included', async () => {
    const settlements = [
      { settled: true as const, txid: 'txa', vout: 0, reference: 'transfer-a' },
      { settled: false as const, txid: 'txb', vout: 1, reason: 'backend unavailable' },
    ]
    const settling = new OnchainSendSwapService({
      store: deps.store,
      onchain: Object.assign(new FakeOnchainBackend(), { settleReceiveAddress: async () => settlements }),
      arkade: deps.arkade,
      limits: { minSats: 1_000, maxSats: 1_000_000 },
      maxExposedSats: 1_000_000,
      totalCommitted: () => deps.store.committedSats(),
      admission: new AdmissionControl(),
      network: 'regtest',
      signer,
      refundDestinationScript,
      now: clock,
    })

    // Unsettled deposits come back alongside settled ones rather than being
    // filtered or thrown: the refund they belong to already succeeded, and the
    // operator's log is what turns a stuck one into something a human sees.
    await expect(settling.settleRefundDeposits()).resolves.toEqual(settlements)
  })
})
