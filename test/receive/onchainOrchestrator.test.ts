import { describe, it, expect, beforeEach } from 'vitest'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { SigHash } from '@scure/btc-signer'
import { ArkAddress } from '@arkade-os/sdk'
import { OnchainReceiveSwapService } from '@arkade-os/solver-corridors/receive/onchainOrchestrator.js'
import { EMPTY_LOCKUP_GRACE } from '@arkade-os/solver-corridors/receive/orchestrator.js'
import {
  OnchainReceiveSwapStore,
  type OnchainReceiveSwapRow,
  type OnchainReceiveSwapState,
} from '@arkade-os/solver-corridors/db/onchainReceiveSwaps.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { FakeOnchainBackend } from '@arkade-os/solver-rails-fake/onchain/fake/backend.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import type { OnchainSigner } from '@arkade-os/solver-rails/onchain/refund.js'
import type { OnchainReceiveArkadeOps } from '@arkade-os/solver-corridors/receive/onchainArkadeOps.js'
import type { CovclaimdClient } from '@arkade-os/solver-corridors/receive/covclaimd.js'

const keyBytes = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))

const P = new Uint8Array(32).fill(9)
const paymentHash = hex.encode(sha256(P))

// The onchain HTLC's claim/refund pubkeys are pushed as raw bytes into a
// plain CHECKSIG script (never lift_x'd), so an arbitrary 32-byte value is
// fine EXCEPT for the solver's own key, which the test signer must be able
// to sign for.
const clientOnchainRefundPubkey = hex.encode(new Uint8Array(32).fill(3))
/** The client's ARKADE key — the covenant's `receiver` role on this leg, mirroring the Lightning receive corridor. */
const clientPayoutPubkey = hex.encode(keyBytes(4))
const solverPriv = new Uint8Array(32).fill(7)
const providerPubkey = hex.encode(schnorr.getPublicKey(solverPriv))
const serverPubkey = hex.encode(keyBytes(5))
const emulatorPubkey = hex.encode(keyBytes(6))
const solverArkadeDest = Uint8Array.from([0x51, 0x20, ...keyBytes(8)])
const claimDestinationScript = Uint8Array.from([0x51, 0x20, ...keyBytes(12)])

/** Mirrors the SDK's own `SeedIdentity.signTxWithKey` — see test/onchain/claim.test.ts. */
const signer: OnchainSigner = {
  sign: async (tx, inputIndexes) => {
    const clone = tx.clone()
    for (const idx of inputIndexes ?? [0]) clone.signIdx(solverPriv, idx, [SigHash.DEFAULT])
    return clone
  },
}

// A real, decodable Arkade address for the client's payout destination —
// same construction test/send/onchainOrchestrator.test.ts's REFUND_ADDRESS
// uses; content is irrelevant, it only needs to decode to SOME P2TR pkScript.
const CLIENT_PAYOUT_ADDRESS = new CovenantSwapScript({
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

// A realistic unix timestamp — refundLocktime/htlcLocktime are BIP65
// absolute locktimes, rejected below LOCKTIME_THRESHOLD.
let now = 1_800_000_000
const clock = () => now

interface ArkadeFake {
  arkade: OnchainReceiveArkadeOps
  lockups: Map<string, { txid: string; vout: number; value: number }[]>
  /**
   * Spend the lockup at `pkScriptHex`, revealing `preimage` if the spender was
   * a claim (pass null for anything else — the solver's own refund, or a spend
   * this service cannot recognise).
   *
   * Models what production actually observes rather than a raw witness stack:
   * the output stops being spendable, and the preimage — when there is one —
   * becomes readable off the spending transaction. Which PSBT field carries it
   * is `findClaimPreimage`'s problem, and covered by its own tests.
   */
  spendLockup: (pkScriptHex: string, preimage: Uint8Array | null) => void
  refundCalls: number
}

const buildArkadeFake = (): ArkadeFake => {
  const lockups = new Map<string, { txid: string; vout: number; value: number }[]>()
  // Every outpoint the script ever held, spent included — the unfiltered view
  // `findLockupOutpoints` serves, and the reason a claim stays readable after
  // it has already spent the output.
  const everSeen = new Map<string, { txid: string; vout: number }[]>()
  const claimed = new Map<string, Uint8Array>()
  let fundCounter = 0
  const state: ArkadeFake = {
    lockups,
    spendLockup: (pkScriptHex, preimage) => {
      lockups.delete(pkScriptHex)
      if (preimage) claimed.set(pkScriptHex, preimage)
    },
    refundCalls: 0,
    arkade: {
      providerPubkey,
      serverPubkey,
      emulatorPubkey,
      receiverPkScript: hex.encode(solverArkadeDest),
      delays: { unilateralClaimDelay: 512, unilateralRefundDelay: 1024, unilateralRefundWithoutReceiverDelay: 1536 },
      hrp: 'tark',
      findLockups: async (pkScriptHex) => lockups.get(pkScriptHex) ?? [],
      findLockupOutpoints: async (pkScriptHex) => everSeen.get(pkScriptHex) ?? [],
      findClaimPreimage: async (outpoints, paymentHashHex) => {
        // Resolve the outpoints back to their script the way the indexer does,
        // then answer only for a preimage that actually hashes right — the
        // same refuse-on-mismatch discipline the real one applies.
        for (const [pkScriptHex, seen] of everSeen) {
          if (!seen.some((s) => outpoints.some((o) => o.txid === s.txid && o.vout === s.vout))) continue
          const preimage = claimed.get(pkScriptHex)
          if (preimage && hex.encode(sha256(preimage)) === paymentHashHex) return preimage
        }
        return null
      },
      fund: async (params) => {
        const txid = `arkade-fund-${fundCounter++}`
        // Keyed by pkScript (decoded from the address, same as production
        // `findLockups`/`findLockupOutpoints` both are), NOT by address —
        // those two read this same map back by pkScript, so a fake that
        // recorded under the address would never be found again.
        const pkScriptHex = hex.encode(ArkAddress.decode(params.address).pkScript)
        const existing = lockups.get(pkScriptHex) ?? []
        lockups.set(pkScriptHex, [...existing, { txid, vout: 0, value: params.amountSats }])
        everSeen.set(pkScriptHex, [...(everSeen.get(pkScriptHex) ?? []), { txid, vout: 0 }])
        return txid
      },
      refund: async (_row, outputs) => {
        state.refundCalls++
        // Simulate the spend: drop whatever script the refunded outputs came from.
        for (const [key, value] of lockups.entries()) {
          if (value.some((o) => outputs.some((out) => out.txid === o.txid && out.vout === o.vout))) {
            lockups.delete(key)
          }
        }
        return 'arkade-refund-txid'
      },
    },
  }
  return state
}

const buildDeps = (fundingVout = 0) => {
  const driver = betterSqliteDriver(':memory:')
  const onchain = new FakeOnchainBackend(5, fundingVout)
  const arkadeFake = buildArkadeFake()
  const covclaimdCalls: { swapAddress: string; ciphertext: string }[] = []
  const covclaimd: Pick<CovclaimdClient, 'reveal'> = {
    reveal: async (params) => {
      covclaimdCalls.push({ swapAddress: params.swapAddress, ciphertext: params.ciphertext })
    },
  }
  return { driver, onchain, arkadeFake, covclaimd, covclaimdCalls }
}

describe('OnchainReceiveSwapService', () => {
  let deps: ReturnType<typeof buildDeps>
  let store: OnchainReceiveSwapStore
  let service: OnchainReceiveSwapService

  beforeEach(async () => {
    now = 1_800_000_000
    deps = buildDeps()
    store = await OnchainReceiveSwapStore.open(deps.driver, clock)
    service = new OnchainReceiveSwapService({
      store,
      onchain: deps.onchain,
      arkade: deps.arkadeFake.arkade,
      covclaimd: deps.covclaimd,
      limits: { minSats: 1_000, maxSats: 1_000_000 },
      maxExposedSats: 1_000_000,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      network: 'regtest',
      signer,
      claimDestinationScript,
      now: clock,
    })
  })

  const quoteRequest = (overrides: Partial<Parameters<OnchainReceiveSwapService['quote']>[0]> = {}) => ({
    paymentHash,
    amountSats: 50_000,
    claimPacket: 'ZmFrZS1zZWFsZWQtcGFja2V0',
    refundPubkey: clientOnchainRefundPubkey,
    payoutAddress: CLIENT_PAYOUT_ADDRESS,
    payoutPubkey: clientPayoutPubkey,
    ...overrides,
  })

  describe('quote()', () => {
    it('persists a row with a derived Arkade lockup and onchain HTLC address', async () => {
      const outcome = await service.quote(quoteRequest())
      expect(outcome.accepted).toBe(true)
      if (!outcome.accepted) throw new Error('expected acceptance')
      expect(outcome.swap.state).toBe('quoted')
      expect(outcome.swap.onchainAddress).toMatch(/^tb|^bcrt|^bc/)
      expect(outcome.swap.lockupAddress).toMatch(/^tark1/)
      // The solver's own refund destination on this leg is its own Arkade
      // receiving script, not the client's.
      expect(outcome.swap.refundPkScript).toBe(hex.encode(solverArkadeDest))
      expect(outcome.swap.clientPayoutPkScript).not.toBe(hex.encode(solverArkadeDest))
    })

    /**
     * Pins WHO holds which covenant role, from the outside.
     *
     * The two receive corridors must carry an IDENTICAL Arkade covenant: the
     * CLIENT is `receiver` (so it can spend the collaborative claim leaf
     * itself, without covclaimd) and the SOLVER is `client`/sender (it funded
     * the lockup, so it holds the refund recourse). Nothing else in this file
     * catches a swap of those two — every other assertion derives its
     * expectation from the same code under test, so the whole suite passed
     * unchanged when the roles were the other way round.
     *
     * Asserting on the ADDRESS is what makes this bite: the taproot tree, and
     * therefore the address, differs between the two mappings, so a revert to
     * solver-as-`receiver` fails here and only here.
     */
    it('builds the covenant with the CLIENT as receiver and the SOLVER as sender', async () => {
      const outcome = await service.quote(quoteRequest())
      if (!outcome.accepted) throw new Error('expected acceptance')

      const withClientAsReceiver = new CovenantSwapScript({
        receiver: hex.decode(clientPayoutPubkey),
        server: hex.decode(serverPubkey),
        preimageHash: ripemd160(hex.decode(paymentHash)),
        refundLocktime: outcome.swap.refundLocktime,
        claimDelay: 512,
        client: hex.decode(providerPubkey),
        clientRefundDelay: 1536,
        refundWithoutServerDelay: 1024,
        // Every quote the service issues now carries the full covenant suite;
        // matching that here is what makes this agree with
        // `outcome.swap.lockupAddress`.
        nonInteractiveParameters: {
          emulatorPubkey: hex.decode(emulatorPubkey),
          receiverPkScript: hex.decode(outcome.swap.clientPayoutPkScript),
          senderPkScript: solverArkadeDest,
        },
      })
      expect(outcome.swap.lockupAddress).toBe(withClientAsReceiver.address('tark', hex.decode(serverPubkey)).encode())
      expect(outcome.swap.clientPayoutPubkey).toBe(clientPayoutPubkey)

      // ...and specifically NOT the old mapping, where the solver held both.
      const withSolverAsReceiver = new CovenantSwapScript({
        receiver: hex.decode(providerPubkey),
        server: hex.decode(serverPubkey),
        preimageHash: ripemd160(hex.decode(paymentHash)),
        refundLocktime: outcome.swap.refundLocktime,
        claimDelay: 512,
        client: hex.decode(providerPubkey),
        clientRefundDelay: 1536,
        refundWithoutServerDelay: 1024,
        nonInteractiveParameters: {
          emulatorPubkey: hex.decode(emulatorPubkey),
          receiverPkScript: hex.decode(outcome.swap.clientPayoutPkScript),
          senderPkScript: solverArkadeDest,
        },
      })
      expect(outcome.swap.lockupAddress).not.toBe(
        withSolverAsReceiver.address('tark', hex.decode(serverPubkey)).encode(),
      )
    })

    it('derives an htlcLocktime strictly after the arkade refundLocktime', async () => {
      const outcome = await service.quote(quoteRequest())
      if (!outcome.accepted) throw new Error('expected acceptance')
      expect(outcome.swap.htlcLocktime).toBeGreaterThan(outcome.swap.refundLocktime)
    })

    it('refuses an amount outside limits', async () => {
      const outcome = await service.quote(quoteRequest({ amountSats: 10 }))
      expect(outcome).toEqual({ accepted: false, reason: 'amount_out_of_range' })
    })

    it('refuses an invalid payout address', async () => {
      const outcome = await service.quote(quoteRequest({ payoutAddress: 'not-an-address' }))
      expect(outcome).toEqual({ accepted: false, reason: 'invalid_payout_address' })
    })

    it('refuses a payout address on the wrong network (wrong HRP)', async () => {
      // A well-formed Arkade address, but not on this service's own hrp
      // ('tark' for regtest) — same mainnet-hrp-vs-testnet-hrp mismatch
      // guardrail the send leg's refund_address check applies.
      const mainnetAddress = new CovenantSwapScript({
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
        .address('ark', keyBytes(5))
        .encode()
      const outcome = await service.quote(quoteRequest({ payoutAddress: mainnetAddress }))
      expect(outcome).toEqual({ accepted: false, reason: 'invalid_payout_address' })
    })

    it('refuses a duplicate live payment hash', async () => {
      await service.quote(quoteRequest())
      const outcome = await service.quote(quoteRequest())
      expect(outcome).toEqual({ accepted: false, reason: 'duplicate_swap' })
    })

    it('refuses once aggregate exposure would exceed the cap', async () => {
      const tightService = new OnchainReceiveSwapService({
        store,
        onchain: deps.onchain,
        arkade: deps.arkadeFake.arkade,
        covclaimd: deps.covclaimd,
        limits: { minSats: 1_000, maxSats: 1_000_000 },
        maxExposedSats: 60_000,
        totalCommitted: () => store.committedSats(),
        admission: new AdmissionControl(),
        network: 'regtest',
        signer,
        claimDestinationScript,
        now: clock,
      })
      await tightService.quote(quoteRequest())
      const secondHash = hex.encode(sha256(keyBytes(11)))
      const outcome = await tightService.quote(quoteRequest({ paymentHash: secondHash, amountSats: 20_000 }))
      expect(outcome).toEqual({ accepted: false, reason: 'provider_at_capacity' })
    })

    describe('the corridor fee', () => {
      // 100bps plus 50 flat against a 50_000 sat client HTLC: the client
      // funds 50_000 onchain, the solver funds the lockup with
      // 50_000 - 500 - 50 = 49_450.
      const FEE = { bps: 100, flatSats: 50 }

      const withFee = (over: { limits?: { minSats: number; maxSats: number }; fee?: typeof FEE } = {}) =>
        new OnchainReceiveSwapService({
          store,
          onchain: deps.onchain,
          arkade: deps.arkadeFake.arkade,
          covclaimd: deps.covclaimd,
          limits: over.limits ?? { minSats: 1_000, maxSats: 1_000_000 },
          maxExposedSats: 1_000_000,
          totalCommitted: () => store.committedSats(),
          admission: new AdmissionControl(),
          network: 'regtest',
          signer,
          claimDestinationScript,
          now: clock,
          fee: over.fee ?? FEE,
        })

      it('persists the payout MINUS the fee at quote time', async () => {
        const outcome = await withFee().quote(quoteRequest())
        if (!outcome.accepted) throw new Error(`refused: ${outcome.reason}`)
        expect(outcome.swap.amountSats).toBe(50_000)
        expect(outcome.swap.payoutSats).toBe(49_450)
      })

      it('still watches for the full client HTLC, then funds the lockup with the payout', async () => {
        const svc = withFee()
        const outcome = await svc.quote(quoteRequest())
        if (!outcome.accepted) throw new Error(`refused: ${outcome.reason}`)
        const swap = outcome.swap

        // The client funds their own onchain HTLC for the FULL quoted amount…
        deps.onchain.receiveExternal({ address: swap.onchainAddress, amountSats: 50_000 })
        deps.onchain.mineBlocks(1)
        const row = await svc.tick(swap.id)
        expect(row.state).toBe('awaiting_claim')
        // …and the solver's Arkade lockup carries the payout, not the amount.
        expect(deps.arkadeFake.lockups.get(swap.pkScript)?.[0]?.value).toBe(49_450)
      })

      it('refuses fee_consumes_swap when the fee eats the whole amount', async () => {
        const outcome = await withFee({ fee: { bps: 0, flatSats: 2_000 } }).quote(quoteRequest({ amountSats: 1_000 }))
        expect(outcome).toEqual({ accepted: false, reason: 'fee_consumes_swap' })
      })

      it('refuses payout_below_dust when the payout would be an unspendable lockup', async () => {
        const outcome = await withFee({ fee: { bps: 0, flatSats: 800 } }).quote(quoteRequest({ amountSats: 1_000 }))
        expect(outcome).toEqual({ accepted: false, reason: 'payout_below_dust' })
      })

      it('charges nothing when the fee is free, exactly as before it existed', async () => {
        const outcome = await service.quote(quoteRequest())
        if (!outcome.accepted) throw new Error(`refused: ${outcome.reason}`)
        expect(outcome.swap.payoutSats).toBe(outcome.swap.amountSats)
      })

      it('exact-out: the client funds the solved give, the lockup carries exactly the requested payout', async () => {
        const svc = withFee()
        const outcome = await svc.quote(quoteRequest({ amountSats: 49_450, amountSide: 'to' }))
        if (!outcome.accepted) throw new Error(`refused: ${outcome.reason}`)
        expect(outcome.swap.amountSats).toBe(50_000)
        expect(outcome.swap.payoutSats).toBe(49_450)

        // The client funds its onchain HTLC for the solved give…
        deps.onchain.receiveExternal({ address: outcome.swap.onchainAddress, amountSats: 50_000 })
        deps.onchain.mineBlocks(1)
        const row = await svc.tick(outcome.swap.id)
        expect(row.state).toBe('awaiting_claim')
        // …and the solver's lockup carries exactly the requested payout.
        expect(deps.arkadeFake.lockups.get(outcome.swap.pkScript)?.[0]?.value).toBe(49_450)
      })

      it('exact-out: a sub-dust payout is refused on this side too', async () => {
        const outcome = await withFee({
          limits: { minSats: 100, maxSats: 1_000_000 },
          fee: { bps: 0, flatSats: 0 },
        }).quote(quoteRequest({ amountSats: 200, amountSide: 'to' }))
        expect(outcome).toEqual({ accepted: false, reason: 'payout_below_dust' })
      })
    })

    it('refuses a hash that is live in ANOTHER corridor’s store', async () => {
      // Each corridor's own duplicate check sees only its own table; a hash
      // live anywhere else is spoken for just the same.
      const crossChecked = new OnchainReceiveSwapService({
        store,
        onchain: deps.onchain,
        arkade: deps.arkadeFake.arkade,
        limits: { minSats: 1_000, maxSats: 1_000_000 },
        maxExposedSats: 1_000_000,
        totalCommitted: () => store.committedSats(),
        admission: new AdmissionControl(),
        network: 'regtest',
        signer,
        claimDestinationScript,
        now: clock,
        peerStores: [{ findLiveByPaymentHash: async () => ({ id: 'other-corridor-row' }) }],
      })
      const outcome = await crossChecked.quote(quoteRequest())
      expect(outcome).toEqual({ accepted: false, reason: 'duplicate_swap' })
    })
  })

  describe('the happy path', () => {
    it('drives quoted all the way to settled', async () => {
      const outcome = await service.quote(quoteRequest())
      if (!outcome.accepted) throw new Error('expected acceptance')
      const swap = outcome.swap

      // Step 3: the client funds their own onchain HTLC and it confirms.
      const funded = deps.onchain.receiveExternal({ address: swap.onchainAddress, amountSats: 50_000 })
      deps.onchain.mineBlocks(1)

      // Step 4: tick drives quoted -> awaiting_confirmations -> funding_arkade -> awaiting_claim in one call.
      let row = await service.tick(swap.id)
      expect(row.state).toBe('awaiting_claim')
      expect(row.fundingTxid).toBe(funded.txid)
      expect(row.arkadeFundTxid).toBeTruthy()
      expect(deps.arkadeFake.lockups.get(swap.pkScript)?.[0]?.value).toBe(50_000)
      // covclaimd was asked to push the claim.
      expect(deps.covclaimdCalls).toHaveLength(1)
      expect(deps.covclaimdCalls[0]?.swapAddress).toBe(swap.lockupAddress)

      // Step 5: covclaimd's autonomous claim lands, revealing P.
      deps.arkadeFake.spendLockup(swap.pkScript, P)

      // Step 6: tick observes the claim and claims the onchain HTLC.
      row = await service.tick(swap.id)
      expect(row.state).toBe('settled')
      expect(row.preimage).toBe(hex.encode(P))
      expect(row.onchainClaimTxid).toBeTruthy()
    })

    /**
     * covclaimd is OPTIONAL — the same fallback the Lightning receive corridor
     * has. With none configured the solver funds the Arkade lockup and waits
     * for the CLIENT to claim it (which it can, now that it holds the
     * covenant's `receiver` key), then uses the revealed P on the onchain leg
     * exactly as before. The watch path never cared who spent the lockup.
     */
    it('drives quoted to settled with no covclaimd at all, on the client’s own claim', async () => {
      const solo = new OnchainReceiveSwapService({
        store,
        onchain: deps.onchain,
        arkade: deps.arkadeFake.arkade,
        limits: { minSats: 1_000, maxSats: 1_000_000 },
        maxExposedSats: 1_000_000,
        totalCommitted: () => store.committedSats(),
        admission: new AdmissionControl(),
        network: 'regtest',
        signer,
        claimDestinationScript,
        now: clock,
      })
      const outcome = await solo.quote(quoteRequest())
      if (!outcome.accepted) throw new Error('expected acceptance')
      const swap = outcome.swap

      deps.onchain.receiveExternal({ address: swap.onchainAddress, amountSats: 50_000 })
      deps.onchain.mineBlocks(1)

      let row = await solo.tick(swap.id)
      expect(row.state).toBe('awaiting_claim')
      // Nothing was revealed, and the absent covclaimd threw nothing.
      expect(deps.covclaimdCalls).toHaveLength(0)

      deps.arkadeFake.spendLockup(swap.pkScript, P)
      row = await solo.tick(swap.id)
      expect(row.state).toBe('settled')
      expect(row.preimage).toBe(hex.encode(P))
      expect(row.onchainClaimTxid).toBeTruthy()
    })
  })

  describe('whenQuoted', () => {
    it('fails to refused once the lockup window passes with no client funding', async () => {
      const outcome = await service.quote(quoteRequest())
      if (!outcome.accepted) throw new Error('expected acceptance')
      now += 16 * 60 // past DEFAULT_ONCHAIN_RECEIVE_LOCKUP_TIMEOUT (15 min)
      const row = await service.tick(outcome.swap.id)
      expect(row.state).toBe('refused')
      expect(row.failureReason).toMatch(/lockup timeout/)
    })

    it('does not adopt a wrong-amount output as funding', async () => {
      const outcome = await service.quote(quoteRequest())
      if (!outcome.accepted) throw new Error('expected acceptance')
      deps.onchain.receiveExternal({ address: outcome.swap.onchainAddress, amountSats: 1_000 }) // dust, not the real amount
      const row = await service.tick(outcome.swap.id)
      expect(row.state).toBe('quoted')
      expect(row.fundingTxid).toBeNull()
    })

    it('holds a wrong-amount output that is still UNCONFIRMED, which may yet be replaced', async () => {
      // The mismatch refusal below must not fire here. An unconfirmed output
      // can be fee-bumped into a different one, so refusing on sight would kill
      // swaps over a transaction the client is still in the middle of sending.
      const outcome = await service.quote(quoteRequest())
      if (!outcome.accepted) throw new Error('expected acceptance')
      deps.onchain.receiveExternal({ address: outcome.swap.onchainAddress, amountSats: 1_000 })
      const row = await service.tick(outcome.swap.id)
      expect(row.state).toBe('quoted')
      expect(row.failureReason).toBeNull()
    })

    it('refuses a CONFIRMED wrong-amount output immediately instead of waiting out the lockup window', async () => {
      // Confirmed is what makes it terminal: it cannot be replaced, and a
      // second output cannot rescue it because adoption wants one output and
      // the claim builder spends one input. Nothing of the solver's is at risk
      // in `quoted`, so the point is to tell the client early enough to start
      // reclaiming their own HTLC rather than to save the solver anything.
      const outcome = await service.quote(quoteRequest())
      if (!outcome.accepted) throw new Error('expected acceptance')
      deps.onchain.receiveExternal({ address: outcome.swap.onchainAddress, amountSats: 1_000 })
      deps.onchain.mineBlocks(1)

      const row = await service.tick(outcome.swap.id)
      expect(row.state).toBe('refused')
      expect(row.failureReason).toMatch(/funding mismatch/)
      // Both amounts, so the client can see what went wrong without a log dive.
      expect(row.failureReason).toMatch(/1000/)
      expect(row.failureReason).toMatch(String(row.amountSats))
      expect(row.fundingTxid).toBeNull()
    })

    it('still adopts the right amount even after it confirms', async () => {
      const outcome = await service.quote(quoteRequest())
      if (!outcome.accepted) throw new Error('expected acceptance')
      const row0 = await service.tick(outcome.swap.id)
      deps.onchain.receiveExternal({ address: outcome.swap.onchainAddress, amountSats: row0.amountSats })
      deps.onchain.mineBlocks(1)

      const row = await service.tick(outcome.swap.id)
      expect(row.state).not.toBe('refused')
      expect(row.fundingTxid).toBeTruthy()
    })
  })

  describe('whenAwaitingConfirmations', () => {
    it('waits without progressing until min_confirmations is reached', async () => {
      const outcome = await service.quote(quoteRequest({ minConfirmations: 2 }))
      if (!outcome.accepted) throw new Error('expected acceptance')
      deps.onchain.receiveExternal({ address: outcome.swap.onchainAddress, amountSats: 50_000 })
      deps.onchain.mineBlocks(1) // only 1 confirmation, need 2
      const row = await service.tick(outcome.swap.id)
      expect(row.state).toBe('awaiting_confirmations')
    })

    it('fails safely (no exposure) if confirmations never arrive before the arkade refund window closes', async () => {
      const outcome = await service.quote(quoteRequest({ minConfirmations: 6 }))
      if (!outcome.accepted) throw new Error('expected acceptance')
      deps.onchain.receiveExternal({ address: outcome.swap.onchainAddress, amountSats: 50_000 })
      deps.onchain.mineBlocks(1)
      let row = await service.tick(outcome.swap.id)
      expect(row.state).toBe('awaiting_confirmations')

      now = outcome.swap.refundLocktime + 1 // past the solver's own arkade refund deadline
      row = await service.tick(outcome.swap.id)
      expect(row.state).toBe('refused')
      expect(deps.arkadeFake.lockups.size).toBe(0) // never funded — nothing exposed
    })
  })

  describe('whenFundingArkade re-checks the funding gate', () => {
    /**
     * `whenAwaitingConfirmations` evaluated the gate against ITS `now`, and a
     * row can then sit in `funding_arkade` across a restart or a failed tick.
     * `now` only moves forward, so a window open at the hand-off can be shut by
     * the time the payment is actually made — and before this check existed,
     * `whenFundingArkade` paid anyway.
     *
     * Which of the two bounds in `evaluateOnchainReceiveFunding` fires is not
     * the point and is left unasserted: they close in an order fixed by the
     * corridor's own construction (the Arkade refund deadline lands before the
     * onchain htlc timeout). The point is that ONE of them is consulted at all
     * — nothing here was consulted before — and that a refusal spends nothing.
     */
    /**
     * TWO WORKERS, one row, one lockup — issue #103.
     *
     * Two SERVICE INSTANCES on one store, which is the whole point. `tick()`'s
     * `inFlight` set makes a second tick on the SAME instance return before it
     * reaches the fund path, so racing one instance against itself proves
     * nothing about this — it exercises that set. `inFlight` is per-process and
     * is exactly what a second worker, a restart, or the Go rewrite removes.
     *
     * With two instances both reach `findLockups` and both read an EMPTY
     * script: the first one's payment has not landed yet, which is precisely
     * why the second is still running. The adoption check above closes the
     * CRASH case — a restart sees what landed — and cannot close this one; its
     * comment saying a persisted flag is unnecessary is true only of the
     * former. Coin selection is per-process, so both would succeed against
     * DIFFERENT vtxos and leave two lockup outputs where the swap needs one,
     * and the compare-and-swap on `state` afterwards gates recording, not
     * spending.
     *
     * Asserted on the LOCKUP COUNT: two outputs at one script is the damage,
     * and it is what an operator would actually find.
     */
    it('two workers on one store fund a row ONCE, not twice', async () => {
      const second = new OnchainReceiveSwapService({
        store,
        onchain: deps.onchain,
        arkade: deps.arkadeFake.arkade,
        limits: { minSats: 1_000, maxSats: 1_000_000 },
        maxExposedSats: 1_000_000,
        totalCommitted: () => store.committedSats(),
        admission: new AdmissionControl(),
        network: 'regtest',
        signer,
        claimDestinationScript,
        now: clock,
      })

      const outcome = await service.quote(quoteRequest())
      if (!outcome.accepted) throw new Error('expected acceptance')
      const swap = outcome.swap
      deps.onchain.receiveExternal({ address: swap.onchainAddress, amountSats: 50_000 })
      deps.onchain.mineBlocks(1)
      await store.transition(swap.id, 'quoted', 'awaiting_confirmations', {})
      await store.transition(swap.id, 'awaiting_confirmations', 'funding_arkade', {})

      // Started together, deliberately not awaited in turn: awaiting the first
      // would let it finish, and the second would then ADOPT its lockup — the
      // path that already worked and proves nothing.
      await Promise.all([service.tick(swap.id), second.tick(swap.id)])

      const pkScript = hex.encode(ArkAddress.decode(swap.lockupAddress).pkScript)
      expect(deps.arkadeFake.lockups.get(pkScript) ?? []).toHaveLength(1)
      expect((await store.get(swap.id)).state).toBe('awaiting_claim')
    })

    it('refuses instead of funding when the window closed while the row waited here', async () => {
      const outcome = await service.quote(quoteRequest())
      if (!outcome.accepted) throw new Error('expected acceptance')
      const swap = outcome.swap
      deps.onchain.receiveExternal({ address: swap.onchainAddress, amountSats: 50_000 })
      deps.onchain.mineBlocks(1)

      // Hand-place the row in `funding_arkade` without funding, which is what a
      // crash between the hand-off transition and `fund()` leaves behind.
      await store.transition(swap.id, 'quoted', 'awaiting_confirmations', {})
      await store.transition(swap.id, 'awaiting_confirmations', 'funding_arkade', {})

      const funded: string[] = []
      const originalFund = deps.arkadeFake.arkade.fund.bind(deps.arkadeFake.arkade)
      deps.arkadeFake.arkade.fund = async (params) => {
        funded.push(params.address)
        return originalFund(params)
      }

      now = swap.refundLocktime + 1
      const row = await service.tick(swap.id)

      expect(funded).toHaveLength(0)
      expect(row.failureReason).toMatch(/^refused to fund: /)
      // `stuck`, not `refused`: `funding_arkade` is EXPOSED, and the read that
      // said "not funded yet" is `spendableOnly` and can be stale. Claiming no
      // exposure on that evidence is exactly the mistake #102 tracks, so the
      // conservative terminal state is the right one and a human looks.
      expect(row.state).toBe('stuck')
    })
  })

  describe('whenFundingArkade crash recovery', () => {
    it('does not fund the arkade lockup twice when the process dies between fund() and the persist', async () => {
      const outcome = await service.quote(quoteRequest())
      if (!outcome.accepted) throw new Error('expected acceptance')
      const swap = outcome.swap
      deps.onchain.receiveExternal({ address: swap.onchainAddress, amountSats: 50_000 })
      deps.onchain.mineBlocks(1)

      const funded: string[] = []
      const originalFund = deps.arkadeFake.arkade.fund.bind(deps.arkadeFake.arkade)
      deps.arkadeFake.arkade.fund = async (params) => {
        const txid = await originalFund(params)
        funded.push(txid)
        return txid
      }
      const originalTransition = store.transition.bind(store)
      store.transition = async (
        id: string,
        from: OnchainReceiveSwapState,
        to: OnchainReceiveSwapState,
        fields: Partial<Record<string, unknown>> = {},
      ) => {
        if (from === 'funding_arkade' && to === 'awaiting_claim') throw new Error('simulated crash after broadcast')
        return originalTransition(id, from, to, fields)
      }

      await expect(service.tick(swap.id)).rejects.toThrow('simulated crash after broadcast')
      expect(funded).toHaveLength(1) // the broadcast really happened, once

      // Restore normal transition behaviour and retry — recovery must not
      // fund a second time.
      store.transition = originalTransition
      const row = await service.tick(swap.id)
      expect(row.state).toBe('awaiting_claim')
      expect(funded).toHaveLength(1) // still just the one broadcast
    })
  })

  describe('the arkade-refund failure path', () => {
    const driveToAwaitingClaim = async (): Promise<OnchainReceiveSwapRow> => {
      const outcome = await service.quote(quoteRequest())
      if (!outcome.accepted) throw new Error('expected acceptance')
      deps.onchain.receiveExternal({ address: outcome.swap.onchainAddress, amountSats: 50_000 })
      deps.onchain.mineBlocks(1)
      return service.tick(outcome.swap.id)
    }

    it("reclaims the solver's own arkade capital once the refund deadline passes with no claim", async () => {
      const awaitingClaim = await driveToAwaitingClaim()
      expect(awaitingClaim.state).toBe('awaiting_claim')

      now = awaitingClaim.refundLocktime + 1
      let row = await service.tick(awaitingClaim.id)
      expect(row.state).toBe('refunded')
      expect(row.arkadeRefundTxid).toBe('arkade-refund-txid')
      expect(deps.arkadeFake.refundCalls).toBe(1)
    })

    it('recovers to claimed when a late-but-valid claim lands during the refund attempt', async () => {
      const awaitingClaim = await driveToAwaitingClaim()
      now = awaitingClaim.refundLocktime + 1

      // Hand-place the row in refunding_arkade (mirrors a crash right after
      // that transition, before the actual refund broadcast happened) so
      // the late-claim recovery path is exercised in isolation.
      await store.transition(awaitingClaim.id, 'awaiting_claim', 'refunding_arkade', {})
      deps.arkadeFake.spendLockup(awaitingClaim.pkScript, P)

      const row = await service.tick(awaitingClaim.id)
      expect(row.state).toBe('settled') // tick chains straight through claimed -> settled
      expect(row.preimage).toBe(hex.encode(P))
      expect(deps.arkadeFake.refundCalls).toBe(0) // recovered before ever pushing the refund
    })

    /**
     * The same read race `test/receive/orchestrator.test.ts` pins for the
     * Lightning receive leg, and it reaches this leg through the same two
     * reads: `findLockups` is `spendableOnly`, so it empties the instant a
     * claim lands, while `findClaimPreimage` still has to fetch the spending
     * transaction. In the gap this looks identical to the unrecognizable-spend
     * case below — and `stuck` has no outgoing edge, so getting it wrong
     * throws away a swap that in fact completed.
     */
    it('rides out the lag between the lockup emptying and the claim becoming readable', async () => {
      const awaitingClaim = await driveToAwaitingClaim()
      now = awaitingClaim.refundLocktime + 1
      await store.transition(awaitingClaim.id, 'awaiting_claim', 'refunding_arkade', {})
      // The claim spent the lockup, but the spending tx is not readable yet.
      deps.arkadeFake.spendLockup(awaitingClaim.pkScript, null)

      const waiting = await service.tick(awaitingClaim.id)
      expect(waiting.state).toBe('refunding_arkade')
      expect(waiting.failureReason).toBeNull()

      // The indexer catches up and the claim becomes readable.
      deps.arkadeFake.spendLockup(awaitingClaim.pkScript, P)
      const row = await service.tick(awaitingClaim.id)
      expect(row.state).toBe('settled')
      expect(row.preimage).toBe(hex.encode(P))
      expect(deps.arkadeFake.refundCalls).toBe(0)
    })

    it('fails to stuck when the lockup is spent by something unrecognizable during a refund attempt', async () => {
      const awaitingClaim = await driveToAwaitingClaim()
      now = awaitingClaim.refundLocktime + 1
      await store.transition(awaitingClaim.id, 'awaiting_claim', 'refunding_arkade', {})
      // A witness too short to be any leaf this service recognizes.
      deps.arkadeFake.spendLockup(awaitingClaim.pkScript, null)

      // Indistinguishable from read lag on the first look, so it has to
      // PERSIST past the grace before it counts as inexplicable.
      expect((await service.tick(awaitingClaim.id)).state).toBe('refunding_arkade')
      now += EMPTY_LOCKUP_GRACE

      const row = await service.tick(awaitingClaim.id)
      expect(row.state).toBe('stuck')
      expect(row.failureReason).toMatch(/no matching claim/)
    })
  })

  describe('whenAwaitingClaim safety checks', () => {
    it('never claims on a preimage that does not hash to paymentHash, and lets the deadline end the wait', async () => {
      const outcome = await service.quote(quoteRequest())
      if (!outcome.accepted) throw new Error('expected acceptance')
      deps.onchain.receiveExternal({ address: outcome.swap.onchainAddress, amountSats: 50_000 })
      deps.onchain.mineBlocks(1)
      const awaitingClaim = await service.tick(outcome.swap.id)
      expect(awaitingClaim.state).toBe('awaiting_claim')

      deps.arkadeFake.spendLockup(awaitingClaim.pkScript, new Uint8Array(32).fill(0xff))
      // The security property: a non-matching preimage is never mistaken for
      // a claim, so `P` is never recorded and the onchain HTLC is never
      // claimed against it.
      const row = await service.tick(awaitingClaim.id)
      expect(row.state).toBe('awaiting_claim')
      expect(row.preimage).toBeNull()

      // And it does NOT fail fast on it: an unreadable spend is indistinguishable
      // from ordinary indexer read lag, so the refund deadline is what ends the
      // wait — and then the grace, which is what tells those two apart — at
      // which point the empty lockup surfaces for a human.
      now = awaitingClaim.refundLocktime + 1
      expect((await service.tick(awaitingClaim.id)).state).toBe('refunding_arkade')
      now += EMPTY_LOCKUP_GRACE
      expect((await service.tick(awaitingClaim.id)).state).toBe('stuck')
    })
  })

  describe('whenClaimed safety checks', () => {
    const driveToClaimed = async (): Promise<OnchainReceiveSwapRow> => {
      const outcome = await service.quote(quoteRequest())
      if (!outcome.accepted) throw new Error('expected acceptance')
      deps.onchain.receiveExternal({ address: outcome.swap.onchainAddress, amountSats: 50_000 })
      deps.onchain.mineBlocks(1)
      const swap = outcome.swap
      await service.tick(swap.id) // -> awaiting_claim
      deps.arkadeFake.spendLockup(swap.pkScript, P)
      return store
        .transition(swap.id, 'awaiting_claim', 'claimed', { preimage: hex.encode(P) })
        .then(() => store.get(swap.id))
    }

    it('fails to stuck if the onchain HTLC was already spent before the solver could claim', async () => {
      const claimed = await driveToClaimed()
      // Simulate the client's own refund having already spent it. No preimage
      // in the witness — the refund path cannot produce one.
      deps.onchain.spendClaim(claimed.fundingTxid!, claimed.fundingVout!, [
        new Uint8Array(64),
        new Uint8Array(1),
        new Uint8Array(1),
      ])
      const row = await service.tick(claimed.id)
      expect(row.state).toBe('stuck')
    })

    it('settles rather than blaming the client when the prior spend is our OWN claim', async () => {
      // `broadcastRaw` is irreversible and the compare-and-swap that records it
      // is a separate write. A process that dies in between comes back and
      // finds its own claim at the outpoint.
      //
      // Read as the client's refund, that is a false-negative `stuck` —
      // terminal, for a swap the solver successfully claimed — and the reason
      // string blames the client, so an operator concludes the onchain sats are
      // gone when they are in hand.
      const claimed = await driveToClaimed()
      // The claim path's witness carries `P`; that is what tells them apart.
      deps.onchain.spendClaim(claimed.fundingTxid!, claimed.fundingVout!, [new Uint8Array(64), P, new Uint8Array(1)])

      const row = await service.tick(claimed.id)
      expect(row.state).toBe('settled')
      // No claim txid: `findSpendWitness` returns the witness stack and not the
      // spending txid, so there is nothing truthful to record. An empty column
      // beats an invented one.
      expect(row.onchainClaimTxid).toBeNull()
    })

    /**
     * `claimNow` — the operator's fee-dust retry (TLA+ finding F4). arkana's
     * review of #172 raised two things about it, and this is the second: the
     * tests added there asserted action-registry metadata only, so every
     * refuse branch below was new code that no test executed. The dust one in
     * particular IS the scenario the override exists for, and a regression
     * there would silently block the recovery it was added to enable.
     */
    describe('claimNow — the operator retry, and every way it declines', () => {
      it('refuses rather than throwing when the client already swept the HTLC', async () => {
        // arkana's first finding. The fake's `broadcastRaw` always succeeds, so
        // without the guard this returns a txid for a transaction the real
        // network would reject as a double-spend — an operator told the claim
        // worked when somebody else took the output.
        const claimed = await driveToClaimed()
        deps.onchain.spendClaim(claimed.fundingTxid!, claimed.fundingVout!, [
          new Uint8Array(64),
          new Uint8Array(1),
          new Uint8Array(1),
        ])
        expect(await service.claimNow(claimed.id)).toMatchObject({
          refused: expect.stringContaining('already spent'),
        })
      })

      it('refuses a row with no preimage instead of building an unspendable witness', async () => {
        const claimed = await driveToClaimed()
        await deps.driver.run(`UPDATE receive_onchain_swap SET preimage = NULL WHERE id = ?`, [claimed.id])
        expect(await service.claimNow(claimed.id)).toMatchObject({
          refused: expect.stringContaining('no preimage'),
        })
      })

      it('refuses when the HTLC rebuilt from the row does not match what was funded', async () => {
        // The defensive check the automatic path makes. An operator override is
        // exactly when a mismatched script must NOT be signed against.
        const claimed = await driveToClaimed()
        await deps.driver.run(`UPDATE receive_onchain_swap SET onchain_pk_script = ? WHERE id = ?`, [
          '5120' + 'ab'.repeat(32),
          claimed.id,
        ])
        expect(await service.claimNow(claimed.id)).toMatchObject({
          refused: expect.stringContaining('does not match'),
        })
      })
    })
  })
})
