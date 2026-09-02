/**
 * E2E — `lightning:BTC->arkade:BTC` (receive), against a live regtest stack and
 * REAL LIGHTNING.
 *
 * This corridor has NO CLI command and NO RFQ ingress routing, so there is
 * nothing to shell out to: the test constructs `ReceiveSwapService` against
 * real adapters and drives `quote`/`tick` — the same thing `packages/solver-app/src/cli.ts`'s
 * self-test commands do internally, minus the CLI. That is a genuine exercise
 * of the money path and does not depend on wiring that does not exist yet.
 *
 * WHY THIS IS THE HIGHEST-VALUE TEST IN THE SET. The solver never learns `P`
 * from anyone here — it reads it back out of the Arkade transaction that
 * claimed the lockup (`findClaimPreimage`, `src/arkade/wallet.ts`). That read
 * rests on Ark's proprietary `ConditionWitness` PSBT field surviving a
 * `toPSBT()`/`fromPSBT()` round trip at the pinned SDK version — covered
 * elsewhere only by synthetic PSBT fixtures, never against a live Arkade node.
 * The `expect(row.preimage).toBe(hex.encode(preimage))` below is that gap
 * closing: the preimage the solver recovered from a real claim must be the
 * byte-for-byte `P` the client generated and never disclosed.
 *
 * THE PAYER IS NOW REAL, AND THAT IS THE POINT OF THIS FILE'S REWRITE. The
 * solver mints its hold invoice on its OWN node through the shipped
 * `LndLightningBackendAdapter` (boltz-lnd), and arkade-regtest's SECOND LND
 * node (`lnd`, alias "arkade-counterparty") pays it for real. So the things
 * this corridor exists to guarantee are now observed rather than asserted
 * against a fake's own bookkeeping:
 *
 *   - the incoming HTLC is GENUINELY HELD — `htlcs[].state === 'ACCEPTED'` on
 *     the solver's node, sats hanging in a real channel, not yet collected —
 *     for the whole time the solver is funding and watching Arkade;
 *   - when the solver settles with the recovered `P`, THE PAYER'S OWN NODE
 *     reports the payment `SUCCEEDED` with that same `P`. That is the proof
 *     the solver actually got paid, and no fake can establish it: a fake can
 *     only report what the test told it.
 *
 * THE CLIENT CLAIMS, NOT COVCLAIMD. The covenant's `receiver` is the client
 * (`receiveCovenantRowFor` maps `receiverPubkey: row.payoutPubkey`), so the
 * client can spend the collaborative claim leaf itself — `preimage + receiver
 * + arkade server`, no CSV, no unilateral exit. That is what
 * `support/clientClaim.ts` does here.
 *
 * covclaimd is supported and OPTIONAL, and is not used by this test so that the
 * CLIENT-claims path is exercised deterministically rather than racing a daemon
 * that would also claim. The solver's watch path is indifferent to who spent the
 * lockup, so the same `findClaimPreimage` code runs either way.
 *
 * That it CAN claim is covered separately, by `covclaimdClaim.e2e.test.ts`.
 * Older builds could not — `v0.0.1-rc.1` accepted a reveal and then silently
 * pushed nothing, because the funding output carried no taptree and the check
 * that needed one logged at no level — which is why this header used to say
 * covclaimd could not claim this covenant at all.
 *
 * ROLES. The test plays client and solver both. As client it generates `P`,
 * seals it (`support/claimPacket.ts` — the one piece of client code that
 * exists nowhere in `src/`, by design), supplies its own Arkade payout
 * address and key, and claims. As solver it quotes, funds its OWN Arkade
 * lockup, and settles the hold once `P` is public.
 *
 * THE FIRST TEST IS AN ADAPTER-CONTRACT REGRESSION, and it used to fail. The
 * shipped `getHoldState` returned the BOLT11 validity window (600s) where the
 * port asks for the held HTLC's settle deadline, so `evaluateReceiveFunding`
 * refused EVERY receive swap on a real LND with `settle_window_too_short` and
 * this corridor could not fund at all on the backend it ships for. The two
 * money tests below used to need a `withRealHtlcDeadline` wrapper to get past
 * it; the adapter now reads the held HTLC's own CLTV timeout height, so they
 * drive the shipped adapter unwrapped and the wrapper is gone.
 *
 * PREREQUISITES
 *   - arkade-regtest up: arkd (ARK_SERVER_URL), emulator (EMULATOR_URL), and
 *     BOTH LND nodes with their channel active:
 *       docker exec lnd lncli --network=regtest listchannels
 *     No covclaimd needed by any test in this file.
 *   - `.env.regtest.lnd` (or E2E_ENV_FILE) with ARK_MNEMONIC / ARK_SERVER_URL /
 *     EMULATOR_URL / LND_SOCKET / LND_CERT_PATH / LND_MACAROON_PATH
 *   - the Arkade wallet funded AND SETTLED (`scripts/regtest-fund.mjs`) — on
 *     THIS corridor the SOLVER funds the lockup out of its own balance
 *   - the counterparty node able to pay {@link AMOUNT_SATS} — it starts with
 *     ~500k of local balance in the channel
 *
 * Run: `pnpm test:e2e`   (never runs in CI — `pnpm test` excludes `test/e2e`)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { ReceiveSwapStore, type ReceiveSwapRow } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import { receiveArkadeOpsFromContext } from '@arkade-os/solver-corridors/receive/arkadeOps.js'
import { DEFAULT_HOLD_INVOICE_WINDOW, ReceiveSwapService } from '@arkade-os/solver-corridors/receive/orchestrator.js'
import type { CovclaimdClient } from '@arkade-os/solver-corridors/receive/covclaimd.js'
import { evaluateReceiveFunding, MIN_SETTLE_WINDOW } from '@arkade-os/solver-core/core/receive.js'
import { HOUR } from '@arkade-os/solver-core/core/timelocks.js'
import { nowSeconds, poll } from '@arkade-os/solver-core/util/poll.js'
import { newSealedPreimage } from './support/claimPacket.js'
import { clientClaimLockup } from './support/clientClaim.js'
import {
  cancelSolverHold,
  counterpartyPayment,
  payFromCounterparty,
  solverInvoice,
  type CounterpartyPayment,
} from './support/counterparty.js'
import { requireStack } from './support/preflight.js'
import {
  assertArkadeSpendable,
  holdSettleDeadline,
  openArkade,
  openSolverLightning,
  SETUP_TIMEOUT_MS,
  SWAP_TIMEOUT_MS,
  tempStoreDir,
  type E2eArkade,
} from './support/stack.js'

const AMOUNT_SATS = Number(process.env.E2E_AMOUNT_SATS ?? 5000)

/**
 * How far behind the funding clock the happy path's QUOTE clock runs, seconds.
 *
 * Stands in for the wall-clock gap every real deployment has between quoting a
 * swap and funding it on a later tick, without making the test wait it out.
 * Any value above zero exercises the case; a minute is comfortably above the
 * one-second granularity `refund_locktime` is measured in, and still far
 * inside the hold invoice's own 600s validity window.
 */
const QUOTE_LAG = 60

let arkade: E2eArkade
let store: ReceiveSwapStore
/** The shipped adapter, exactly as production builds it, and unwrapped. */
let ln: Awaited<ReturnType<typeof openSolverLightning>>
let arkadeOps: Awaited<ReturnType<typeof receiveArkadeOpsFromContext>>
let dir: string
/** Payments left running by a test, stopped in `afterAll` so no fork is held open. */
const payers: CounterpartyPayment[] = []

/** Build a service over the shared store, with an injectable clock and an optional covclaimd. */
const serviceWith = (covclaimd: CovclaimdClient | null, now?: () => number): ReceiveSwapService =>
  new ReceiveSwapService({
    acceptUnilateralGap: false,
    store,
    ln,
    arkade: arkadeOps,
    covclaimd,
    limits: arkade.limits,
    maxExposedSats: arkade.maxExposedSats,
    totalCommitted: () => store.committedSats(),
    admission: new AdmissionControl(),
    ...(now ? { now } : {}),
  })

/** Pay `invoice` from the counterparty and remember the child so it can be stopped. */
const payFromCounterpartyNode = (invoice: string): CounterpartyPayment => {
  const payer = payFromCounterparty(invoice)
  payers.push(payer)
  return payer
}

describe('e2e lightning:BTC->arkade:BTC (receive)', () => {
  beforeAll(async () => {
    await requireStack('lightning:BTC->arkade:BTC', ['arkd', 'emulator', 'lnd', 'ln-counterparty'])
    arkade = await openArkade()
    dir = tempStoreDir()
    store = await ReceiveSwapStore.open(`${dir}/receive-swaps.sqlite`)
    ln = await openSolverLightning()
    arkadeOps = await receiveArkadeOpsFromContext(arkade.ctx, arkade.emulator)
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    for (const payer of payers) payer.stop()
    await store?.close()
    // One raw gRPC client per LND subservice; leaving them open crashes the
    // fork on exit on Windows. See `SendBackend.close` in `src/ln/port.ts`.
    await ln?.close()
    arkade?.close()
  })

  /**
   * THE ADAPTER CONTRACT, against a real LND. This was a failing bug report
   * until `getHoldState` was fixed; it stays as the regression that pins it.
   *
   * It uses the SHIPPED adapter with nothing corrected, and asserts what
   * `src/ln/port.ts` states for `HoldState.expiresAt`: "the deadline by which
   * an armed HTLC must be settled". That field used to come back as the BOLT11
   * validity window — 600 seconds, which is what `DEFAULT_HOLD_INVOICE_WINDOW`
   * was AT THE TIME (it has since been 7200, then 5700, and is now derived from
   * `MAX_REFUND_HORIZON - MIN_CLAIM_WINDOW`) — against
   * a `MIN_SETTLE_WINDOW` of 5400 — so `evaluateReceiveFunding` refused every
   * single receive swap with `settle_window_too_short` and this corridor could
   * not fund at all against the backend it ships for.
   *
   * The value it reads now is on the same response it always fetched:
   * `payments[].timeout`, the `lightning` package's name for LND's
   * `htlcs[].expiry_height` ("HTLC CLTV Timeout Height Number"), differenced
   * against the node's current chain height.
   *
   * BOTH DIRECTIONS ARE ASSERTED, because only one of them is about funding at
   * all. The deadline must be far enough out to clear the gate, AND it must not
   * run past what a nominal-rate reading of the same height gives — over-stating
   * the time left is how a provider pays out on Arkade and then fails to collect.
   */
  it(
    'reports the held HTLC CLTV deadline as E, early enough to fund and never later than the chain allows',
    async () => {
      await requireStack('lightning:BTC->arkade:BTC adapter contract', ['lnd', 'ln-counterparty'])

      // A hold invoice on the solver's own node, minted exactly as the
      // orchestrator mints one. Nobody will ever hold the preimage of this
      // hash, which is fine: the hold is cancelled below, never settled.
      const paymentHash = hex.encode(sha256(secp256k1.utils.randomSecretKey()))
      const hold = await ln.createHoldInvoice({
        amountSats: AMOUNT_SATS,
        paymentHash,
        expirySeconds: DEFAULT_HOLD_INVOICE_WINDOW,
      })
      payFromCounterpartyNode(hold.invoice)
      await awaitHeld(paymentHash)

      // Everything the assertions need is read BEFORE the HTLC is released,
      // and released before the first `expect`. A failure between the two would
      // otherwise strand the counterparty's sats in the channel for the ~83
      // blocks the HTLC's CLTV runs to — on a stack whose miner produces one
      // block every 600 seconds, that is most of a day, for everyone sharing it.
      const state = await ln.getHoldState(paymentHash)
      const realDeadline = await holdSettleDeadline(paymentHash)
      await cancelSolverHold(paymentHash)

      expect(state.status).toBe('armed')

      // What LND actually knows, read the other way round (lncli, not the
      // `lightning` package): the held HTLC's own CLTV deadline, far beyond the
      // settle window the funding gate insists on.
      expect(realDeadline - nowSeconds()).toBeGreaterThan(MIN_SETTLE_WINDOW)

      // THE CONTRACT. `expiresAt` must be the settle deadline, which means the
      // funding gate must be able to clear it. It used to be the BOLT11 window,
      // and failed here by roughly 4800 seconds.
      expect(state.expiresAt).not.toBeNull()
      expect(state.expiresAt! - nowSeconds()).toBeGreaterThanOrEqual(MIN_SETTLE_WINDOW)

      // AND THE SAFE DIRECTION. `realDeadline` converts the same height at the
      // nominal 600s/block; the adapter converts it at a deliberately faster
      // rate. Reporting anything later than the nominal reading would mean
      // claiming settle time the chain has not promised — the failure the port
      // warns about, and the one no amount of downstream gating can catch.
      expect(state.expiresAt!).toBeLessThanOrEqual(realDeadline)
      expect(
        evaluateReceiveFunding({
          acceptUnilateralGap: false,
          invoiceExpiresAt: nowSeconds() + DEFAULT_HOLD_INVOICE_WINDOW,
          htlcExpiresAt: state.expiresAt,
          refundLocktime: nowSeconds() + HOUR,
          // The live ladder this deployment actually derives; the assertion
          // below is about gate (b)/(c), so this must not be what refuses.
          unilateralRefundWithoutReceiverDelay: arkadeOps.delays.unilateralRefundWithoutReceiverDelay,
          now: nowSeconds(),
        }),
      ).toEqual({ fund: true })
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'is paid for real, holds the HTLC, funds its own lockup, and settles with the P it read off the claim',
    async () => {
      await requireStack('lightning:BTC->arkade:BTC happy path', ['arkd', 'emulator', 'lnd', 'ln-counterparty'])
      await assertArkadeSpendable(arkade, AMOUNT_SATS)

      // No covclaimd: the CLIENT claims. See this file's header for why that
      // is the path under test rather than an alternative to it.
      const service = serviceWith(null)

      // Two clocks over ONE store, the same idiom the refund test below uses —
      // here to make ELAPSED TIME BETWEEN QUOTE AND FUNDING deterministic
      // rather than however long the stack happened to take. Quoting a minute
      // "ago" is exactly the real-world case of quoting on one tick and funding
      // on a later one, and it is what this corridor got wrong: the funding
      // transition used to recompute `refund_locktime` against the newer clock,
      // so the covenant no longer re-derived the funded pkScript and the
      // client's own claim below could not match it.
      const quoting = serviceWith(null, () => nowSeconds() - QUOTE_LAG)

      // CLIENT: choose P, seal it (the packet still travels, so the solver can
      // hand it to a covclaimd whenever one can claim), and nominate the payout.
      const sealed = newSealedPreimage(hex.encode(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)))
      const payoutAddress = await arkade.ctx.wallet.getAddress()
      const payoutPubkey = hex.encode(await arkade.ctx.identity.xOnlyPublicKey())

      const outcome = await quoting.quote({
        paymentHash: sealed.paymentHash,
        amountSats: AMOUNT_SATS,
        payoutAddress,
        payoutPubkey,
        claimPacket: sealed.packet,
      })
      if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
      const swap = outcome.swap
      expect(swap.invoice).toContain(arkade.profile.invoicePrefix)

      // THE PAYER: a second, independent Lightning node pays the hold invoice
      // for real. Not awaited — `payinvoice` blocks for as long as the HTLC is
      // held, which is the whole rest of this test.
      payFromCounterpartyNode(swap.invoice)
      const held = await awaitHeld(sealed.paymentHash)

      // GENUINELY HELD, NOT SETTLED. The sats are hanging in a real channel:
      // committed by the payer, collectable only with P, and P does not exist
      // anywhere outside this test's own memory yet.
      expect(held.state).toBe('ACCEPTED')
      expect(held.settled).toBe(false)
      expect(held.r_preimage).toBe('')
      expect(Number(held.amt_paid_sat)).toBe(AMOUNT_SATS)
      expect(held.htlcs.some((htlc) => htlc.state === 'ACCEPTED')).toBe(true)

      // SOLVER: fund its own Arkade lockup, then wait.
      const funded = await driveUntil(service, swap.id, new Set(['funded', ...TERMINAL]))
      expect(funded.state).toBe('funded')
      expect(funded.arkadeLockupTxid).toBeTruthy()
      // Nothing revealed — there is no covclaimd in this run.
      expect(funded.revealedAt).toBeNull()

      // ...and the payer is STILL waiting, through the whole Arkade funding.
      // This is the exposure window the corridor is designed around: the
      // solver has now paid out on Arkade and still holds only an unsettled
      // HTLC.
      expect((await solverInvoice(sealed.paymentHash)).state).toBe('ACCEPTED')
      expect((await counterpartyPayment(sealed.paymentHash))?.status).toBe('IN_FLIGHT')

      // CLIENT: claim the lockup through the collaborative claim leaf,
      // deriving the covenant independently and refusing a mismatch.
      const claimTxid = await clientClaimLockup(
        arkade.ctx,
        {
          payoutPubkey: funded.payoutPubkey,
          payoutAddress: funded.payoutAddress,
          payoutPkScript: funded.payoutPkScript,
          solverPubkey: funded.solverPubkey,
          solverRefundPkScript: funded.solverRefundPkScript,
          serverPubkey: funded.serverPubkey,
          emulatorPubkey: funded.emulatorPubkey,
          paymentHash: funded.paymentHash,
          refundLocktime: funded.refundLocktime,
          claimDelay: funded.claimDelay,
          refundDelay: funded.refundDelay,
          refundWithoutReceiverDelay: funded.refundWithoutReceiverDelay,
          pkScript: funded.pkScript,
          nonInteractiveParameters: funded.nonInteractiveParameters ?? false,
        },
        sealed.preimage,
      )
      expect(claimTxid).toBeTruthy()

      // SOLVER: observe the claim, recover P from it, settle the held HTLC.
      const settled = await driveUntil(service, swap.id, new Set(['settled', ...TERMINAL]))
      expect(settled.state).toBe('settled')

      // THE ASSERTION THIS WHOLE SUITE EXISTS FOR: the preimage the solver
      // recovered from a REAL Arkade claim witness is byte-for-byte the P the
      // client generated and never disclosed. That is the ConditionWitness
      // toPSBT()/fromPSBT() round trip, proven against a live node rather than
      // a synthetic fixture.
      expect(settled.preimage).toBe(hex.encode(sealed.preimage))

      // AND THE SOLVER ACTUALLY GOT PAID. Its own node settled the HTLC with
      // that P...
      const collected = await solverInvoice(sealed.paymentHash)
      expect(collected.state).toBe('SETTLED')
      expect(collected.r_preimage).toBe(hex.encode(sealed.preimage))

      // ...and THE PAYER'S node — a separate process this test cannot write to
      // except by being paid — agrees the sats left it, for that same P. This
      // is the assertion the file's old fake payer could not make at all.
      const payment = await awaitPaymentStatus(sealed.paymentHash, 'SUCCEEDED')
      expect(payment.payment_preimage).toBe(hex.encode(sealed.preimage))
      expect(Number(payment.value_sat)).toBe(AMOUNT_SATS)
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'refunds the solver its own capital when the claim never comes, and the payer gets its sats back',
    async () => {
      await requireStack('lightning:BTC->arkade:BTC refund', ['arkd', 'emulator', 'lnd', 'ln-counterparty'])
      await assertArkadeSpendable(arkade, AMOUNT_SATS)

      // covclaimd is deliberately a no-op that accepts the packet and never
      // pushes a claim — precisely the situation this path exists for, and it
      // makes the test deterministic instead of racing a real daemon that
      // might claim. It also means this test needs no covclaimd at all.
      const neverClaims: CovclaimdClient = {
        getPubKeys: async () => ({ covclaimdPubKey: '', emulatorPubKey: arkade.emulator.pubkey }),
        reveal: async () => {},
      }

      // Two clocks over ONE store. The quoting service runs BACKDATED, so the
      // refund deadline it derives (`now + MAX_REFUND_HORIZON`, 2h) lands 3h in
      // the PAST — the same "already matured" trick `cli test-refund` uses, and
      // the same 3h figure, so the covenant's locktime clears median-time-past
      // (which lags wall clock by ~1h) on the first try. The driving service
      // then runs on the real clock and sees a deadline long gone.
      const backdated = serviceWith(neverClaims, () => nowSeconds() - 5 * HOUR)
      const present = serviceWith(neverClaims)

      // A throwaway recipient key: the packet is never decrypted by anyone on
      // this path, but sealing it still has to be a real ECIES operation.
      const nobody = hex.encode(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true))
      const sealed = newSealedPreimage(nobody)
      const outcome = await backdated.quote({
        paymentHash: sealed.paymentHash,
        amountSats: AMOUNT_SATS,
        payoutAddress: await arkade.ctx.wallet.getAddress(),
        payoutPubkey: hex.encode(await arkade.ctx.identity.xOnlyPublicKey()),
        claimPacket: sealed.packet,
      })
      if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
      const swap = outcome.swap
      expect(swap.refundLocktime).toBeLessThan(nowSeconds())

      // Paid for real, and held for real — the solver's capital goes out
      // against an HTLC it can only ever collect by learning P.
      payFromCounterpartyNode(swap.invoice)
      await awaitHeld(sealed.paymentHash)

      // Backdated clock: arms and funds, and stops at `funded` because from
      // where it stands the deadline has not passed.
      const funded = await driveUntil(backdated, swap.id, new Set(['funded', ...TERMINAL]))
      expect(funded.state).toBe('funded')
      expect(funded.arkadeLockupTxid).toBeTruthy()

      // Real clock: the deadline is three hours gone, nothing claimed it, so
      // the solver takes its own capital back through the emulator-co-signed
      // covenant refund.
      const refunded = await driveUntil(present, swap.id, new Set(['refunded', ...TERMINAL]))
      expect(refunded.state).toBe('refunded')
      expect(refunded.refundArkTxid).toBeTruthy()
      // It never learned P, so it never could have settled.
      expect(refunded.preimage).toBeNull()

      // THE OTHER HALF, which the fake could not show: the payer must not be
      // left paying for a swap that did not happen. The HTLC is failed back —
      // here by the harness standing in for the network at `E`, see
      // `cancelSolverHold` — and the payer's own node records the payment as
      // FAILED rather than quietly succeeding.
      expect((await solverInvoice(sealed.paymentHash)).settled).toBe(false)
      await cancelSolverHold(sealed.paymentHash)
      const payment = await awaitPaymentStatus(sealed.paymentHash, 'FAILED')
      expect(payment.payment_preimage).toMatch(/^0*$/)

      // And the solver collected nothing on this swap.
      const abandoned = await solverInvoice(sealed.paymentHash)
      expect(abandoned.state).toBe('CANCELED')
      expect(abandoned.settled).toBe(false)
    },
    SWAP_TIMEOUT_MS,
  )
})

const TERMINAL = new Set(['refused', 'stuck'])

const driveUntil = (service: ReceiveSwapService, id: string, until: ReadonlySet<string>): Promise<ReceiveSwapRow> =>
  poll(
    async () => {
      const row = await service.tick(id)
      return until.has(row.state) ? row : null
    },
    {
      attempts: 150,
      intervalMs: 2000,
      whenExhausted: `receive swap ${id} never reached one of [${[...until].join(', ')}]`,
    },
  )

/**
 * Wait until the counterparty's HTLC has actually arrived and is being HELD on
 * the solver's node.
 *
 * A real payment is not instantaneous: `payinvoice` has to find a route and
 * the HTLC has to be locked in on both sides of the channel. Every scenario
 * waits for this explicitly rather than letting the orchestrator's own poll
 * absorb it, so an exhausted wait says "the payment never arrived" instead of
 * failing later as "the swap never funded".
 */
const awaitHeld = (paymentHash: string) =>
  poll(
    async () => {
      const invoice = await solverInvoice(paymentHash)
      return invoice.state === 'ACCEPTED' ? invoice : null
    },
    {
      attempts: 60,
      intervalMs: 2000,
      whenExhausted: `no HTLC was ever held against ${paymentHash} — the counterparty's payment did not arrive`,
    },
  )

/** Wait for the PAYER's own node to reach a terminal verdict on the payment. */
const awaitPaymentStatus = (paymentHash: string, status: 'SUCCEEDED' | 'FAILED') =>
  poll(
    async () => {
      const payment = await counterpartyPayment(paymentHash)
      return payment?.status === status ? payment : null
    },
    {
      attempts: 45,
      intervalMs: 2000,
      whenExhausted: `the counterparty never reported ${paymentHash} as ${status}`,
    },
  )
