/**
 * E2E — `arkade:BTC->lightning:BTC` (send), against a live regtest stack and
 * REAL LIGHTNING.
 *
 * The in-code equivalent of `src/cli.ts`'s `send` command and of
 * `scripts/e2e-relay.sh`'s money path (that script additionally proves the
 * outbound RELAY transport with two processes; this proves the money path with
 * one, and asserts on the row rather than on grepped stdout).
 *
 * Plays both roles, like `cli send` does: the SOLVER quotes and claims, the
 * CLIENT derives the covenant script independently and funds only its OWN
 * derivation. That client rule is the load-bearing assertion here — a solver
 * that returned a lockup address the client's own inputs do not reproduce is
 * a compromised or wrong backend, and the client must fund nothing.
 *
 * LIGHTNING IS REAL ON BOTH SIDES HERE. The solver pays through the shipped
 * `LndLightningBackendAdapter` against its own node (boltz-lnd), and the payee
 * is arkade-regtest's SECOND LND node (`lnd`, alias "arkade-counterparty"),
 * driven from `support/counterparty.ts`. The sats cross a real channel.
 *
 * WHAT THAT BUYS OVER THE FAKE, precisely. The fake forged the invoice AND
 * knew its preimage, so `payInvoice` handed back a secret the test had
 * effectively supplied — the assertion "the solver claimed with the right
 * preimage" was circular. Here the PAYEE chooses `P` and never discloses it;
 * the only way the solver can learn it is by actually paying, and the only way
 * this test can check the value is by asking the payee's node afterwards. So
 * `expect(paid.r_preimage).toBe(row.preimage)` now says something real: the
 * secret the solver spent the Arkade claim leaf with is the one that settled a
 * real HTLC on a node this process does not control.
 *
 * PREREQUISITES
 *   - arkade-regtest up: arkd (ARK_SERVER_URL), emulator (EMULATOR_URL), and
 *     BOTH LND nodes with their channel active:
 *       docker exec lnd lncli --network=regtest listchannels
 *   - `.env.regtest.lnd` (or E2E_ENV_FILE) with ARK_MNEMONIC / ARK_SERVER_URL /
 *     EMULATOR_URL / LND_SOCKET / LND_CERT_PATH / LND_MACAROON_PATH
 *   - the Arkade wallet funded AND SETTLED — `scripts/regtest-fund.mjs`
 *
 * THE LAST TWO TESTS are the send leg's `refund_outcome: 'external'` branch —
 * `refundSweep` finding the lockup already gone. The first is the honest case
 * (the client pushed the covenant refund itself and the sweep correctly records
 * that somebody else moved it); the second asks what happens when the script is
 * empty only because the read was early.
 *
 * THAT SECOND ONE FAILED until the sweep learned to tell the two apart, for a
 * reason in `src/send/orchestrator.ts` rather than here. `refundSweep` read
 * `findLockups` once and took an empty answer as proof that "the client (or
 * another watcher) already moved it", writing `refund_outcome: 'external'`.
 * But `findLockups` is `getVtxos({ spendableOnly: true })` — the same read
 * whose lag PR #21 fixed on the receive leg, where `whenRefunding` had the
 * identical single-read empty-lockup branch and sent COMPLETED swaps to a
 * terminal `stuck`. That fix's own message audits `send/onchainOrchestrator.ts`
 * and clears it (it needs positive evidence, not two reads disagreeing); this
 * sweep was not audited and did not have that property. It does now:
 * `lockupProvablySpent` asks for the spend itself, so an empty spendable read
 * on its own no longer closes the row.
 *
 * It is worse here than it was there, in two ways this test's failure output
 * does not show on its own:
 *
 *  - IT IS A ONE-WAY DOOR. The receive leg's escalation now waits
 *    `EMPTY_LOCKUP_GRACE` and rechecks on the next tick. `findRefundable`
 *    filters `refund_outcome IS NULL`, so once `external` is written the row is
 *    never selected again — no grace, no recheck, no later sweep, and the
 *    assertion below on `healthySweep` is what pins that down.
 *  - AND THE CLIENT IS TOLD IT WAS REFUNDED. `rfqStateFromRow`
 *    (`src/wire/payloads.ts`) maps a `refused` row with ANY non-null
 *    `refundOutcome` to the wire state `refunded`. So the client is not merely
 *    left unserved, it is actively told the swap is done while every sat is
 *    still sitting at the covenant script. A client that believes that status
 *    and stops watching its own deadline is the way this actually costs money.
 *
 * Nothing is cryptographically lost — the refund leaf still pays the client's
 * committed address and needs no keys of ours, so a client that keeps watching
 * can push it forever. That is the whole margin here, and the wire status is
 * what talks a client out of using it.
 *
 * `src/send/onchainOrchestrator.ts`'s `pushRefund` had the identical
 * single-read branch over the identical `refund_outcome IS NULL` filter
 * (`src/db/onchainSwaps.ts`), and there it is shared with the OPERATOR's
 * `refundNow` — so a human running a manual refund inside a lag window wrote
 * the same one-way `external` too. It takes the same guard, and throws rather
 * than returning null so the operator is told why instead of reading it as
 * "already refunded". Covered by unit test, not here; this file is the
 * Lightning send leg.
 *
 * The test's ASSERTIONS are kept exactly as written — they are correct, and
 * asserting the buggy value instead would bake the defect into the suite. Only
 * its release path changed: it asserts that the healthy sweep pushes the refund
 * ITSELF, so reading the script once afterwards and pushing whatever it still
 * showed raced that spend and retried until it exhausted, for any correct fix.
 *
 * Run: `pnpm test:e2e`   (never runs in CI — `pnpm test` excludes `test/e2e`)
 */

import { schnorr } from '@noble/curves/secp256k1.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { ArkAddress } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { scriptHashFromPaymentHash } from '@arkade-os/solver-core/core/preimage.js'
import { decodeInvoice } from '@arkade-os/solver-core/invoice/decode.js'
import { refundLocktimeFor } from '@arkade-os/solver-core/core/send.js'
import { HOUR, MINUTE } from '@arkade-os/solver-core/core/timelocks.js'
import { SwapStore, type SendSwapRow } from '@arkade-os/solver-corridors/db/swaps.js'
import { arkadeOpsFromContext } from '@arkade-os/solver-corridors/send/arkadeOps.js'
import { SendSwapService, type ArkadeOps } from '@arkade-os/solver-corridors/send/orchestrator.js'
import { nowSeconds, poll } from '@arkade-os/solver-core/util/poll.js'
import {
  cancelCounterpartyInvoice,
  counterpartyInvoice,
  counterpartyInvoiceState,
  solverInvoice,
  solverMintedInvoice,
} from './support/counterparty.js'
import { requireStack } from './support/preflight.js'
import {
  assertArkadeSpendable,
  openArkade,
  openSolverLightning,
  SETUP_TIMEOUT_MS,
  SWAP_TIMEOUT_MS,
  tempStoreDir,
  type E2eArkade,
} from './support/stack.js'

/** The RFQ family requires a client refund pubkey on every quote. */
const CLIENT_REFUND_PUBKEY = hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(11)))

const AMOUNT_SATS = Number(process.env.E2E_AMOUNT_SATS ?? 5000)

/**
 * How far in the past a quote's derived `refundLocktime` is aimed, for the
 * refund case only.
 *
 * Three hours, the same default `cli test-refund` uses, and for its reason: a
 * seconds-based CLTV matures against MEDIAN-TIME-PAST, which on this regtest
 * lags the chain tip's own timestamp by ~50 minutes (11-block median at a 600s
 * block interval). Three hours clears it with room to spare, so a refund push
 * is not rejected as FORFEIT_CLOSURE_LOCKED on the first attempt.
 */
const MATURED_BY = 3 * HOUR

/**
 * How far after the quote the payment is driven from, seconds.
 *
 * Comfortably inside `DEFAULT_LOCKUP_TIMEOUT` (15m, after which the swap is
 * refused as abandoned) and above zero so the funding wait is not being
 * pretended away. Any value in (0, 900) works.
 */
const PAY_AFTER_QUOTE = 5 * MINUTE

/**
 * How far past the quoted amount the two refund-sweep scenarios overfund.
 *
 * Overfunding is the cheapest way to reach a row that `refundSweep` will
 * actually pick up. `findRefundable` selects `refused` rows only, and
 * `whenQuoted` refuses an overfunded lockup BEFORE Lightning is touched at
 * all — no payment attempted, no invoice to cancel, no exposure. A terminal
 * payment failure lands in `stuck` instead, which the sweep deliberately does
 * not serve (see the previous test), so it cannot reach this branch.
 *
 * The excess comes back with the rest: the refund leaf pays the client's
 * committed address, and here that is this wallet's own.
 */
const OVERFUND_BY = 1000

let arkade: E2eArkade
let store: SwapStore
let ln: Awaited<ReturnType<typeof openSolverLightning>>
let arkadeOps: ArkadeOps

/**
 * A service over the shared store, on `now`'s clock and — for the read-race
 * scenario at the end of this file — over `ops` instead of the real Arkade ops.
 */
const serviceWith = (now?: () => number, ops: ArkadeOps = arkadeOps): SendSwapService =>
  new SendSwapService({
    store,
    ln,
    arkade: ops,
    limits: arkade.limits,
    invoicePrefix: arkade.profile.invoicePrefix,
    maxExposedSats: arkade.maxExposedSats,
    totalCommitted: () => store.committedSats(),
    admission: new AdmissionControl(),
    ...(now ? { now } : {}),
  })

/**
 * The clock a quote must run on for its `refundLocktime` to land
 * {@link MATURED_BY} in the past.
 *
 * Derived from the invoice rather than hardcoded: `refundLocktimeFor` returns
 * `quoteClock + K` for a constant `K` that depends on the invoice's own final
 * CLTV delta and the server's exit delay, so `K` is read back by evaluating it
 * at zero. Hardcoding an offset would silently stop maturing the locktime the
 * day either input changed.
 */
const quoteClockFor = (invoice: string): (() => number) => {
  const decoded = decodeInvoice(invoice)
  const horizon = refundLocktimeFor(
    {
      minFinalCltvBlocks: decoded.minFinalCltvBlocks,
      worstRouteHintCltvBlocks: decoded.worstRouteHintCltvBlocks,
      bestRouteHintCltvBlocks: decoded.bestRouteHintCltvBlocks,
      routeCltvBudgetBlocks: ln.routeCltvBudgetBlocks,
      enforcesRouteCltv: ln.enforcesRouteCltv,
    },
    arkade.ctx.unilateralDelays.unilateralClaimDelay,
    0,
  )
  const at = nowSeconds() - MATURED_BY - horizon
  return () => at
}

/**
 * The CLIENT's independent derivation of the lockup script.
 *
 * Built from what the client already holds — the decoded invoice, its own
 * Arkade server key, its own emulator fetch, its own refund address — trusting
 * only the provider pubkey and the refund deadline from the quote. The client
 * funds only a match.
 */
/**
 * The solver's own claim destination, as the QUOTE reported it.
 *
 * Nullable on the row for swaps quoted before the leaf shipped, and there is no
 * sensible stand-in: a swap without it was built from a covenant this check
 * cannot reconstruct, so the check would be comparing nothing to nothing.
 */
const receiverPkScriptOf = (swap: SendSwapRow): string => {
  if (swap.receiverPkScript === null) throw new Error(`swap ${swap.id} carries no receiver pkScript to derive against`)
  return swap.receiverPkScript
}

const clientDerivedAddress = (swap: SendSwapRow, invoice: string, refundAddress: string): string => {
  const serverKey = arkade.ctx.wallet.arkServerPublicKey
  const local = new CovenantSwapScript({
    receiver: hex.decode(swap.receiverPubkey),
    server: serverKey,
    preimageHash: scriptHashFromPaymentHash(decodeInvoice(invoice).paymentHash),
    refundLocktime: swap.refundLocktime,
    claimDelay: arkade.ctx.unilateralDelays.unilateralClaimDelay,
    client: hex.decode(CLIENT_REFUND_PUBKEY),
    // Read off the stack and the quote, never hardcoded. The service builds the
    // lockup from `arkade.delays` and its own receiving pkScript, so constants
    // here would only agree with it while the regtest stack happened to be
    // configured the way they were written — and the assertion below would then
    // be comparing two addresses derived from different parameters.
    clientRefundDelay: arkade.ctx.unilateralDelays.unilateralRefundWithoutReceiverDelay,
    refundWithoutServerDelay: arkade.ctx.unilateralDelays.unilateralRefundDelay,
    nonInteractiveParameters: {
      emulatorPubkey: hex.decode(arkade.emulator.pubkey),
      receiverPkScript: hex.decode(receiverPkScriptOf(swap)),
      senderPkScript: ArkAddress.decode(refundAddress).pkScript,
      // Read off the row, not hardcoded: makes this a live test of the row
      // round trip rather than a constant that can silently fall behind what
      // the service actually quoted, which is exactly how the reference client
      // fell behind when this flag was gated on stored state.
      ...(swap.nonInteractiveParameters ? {} : { legacy: 'preTimelockedRefund' as const }),
    },
  })
  return local.address(arkade.ctx.hrp, serverKey).encode()
}

describe('e2e arkade:BTC->lightning:BTC (send)', () => {
  beforeAll(async () => {
    await requireStack('arkade:BTC->lightning:BTC', ['arkd', 'emulator', 'lnd', 'ln-counterparty'])
    arkade = await openArkade()
    const dir = tempStoreDir()
    store = await SwapStore.open(`${dir}/swaps.sqlite`)
    ln = await openSolverLightning()
    arkadeOps = await arkadeOpsFromContext(arkade.ctx, arkade.emulator)
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await store?.close()
    // The LND adapter holds one raw gRPC client per subservice. Leaving them
    // open crashes the fork on exit on Windows — see `SendBackend.close`.
    await ln?.close()
    arkade?.close()
  })

  it(
    'quotes, funds the client-derived lockup, pays a REAL invoice and claims with the preimage the payee chose',
    async () => {
      await assertArkadeSpendable(arkade, AMOUNT_SATS)

      // THE PAYEE: a second, independent Lightning node. It picks `P` and keeps
      // it — nothing in this process knows the preimage before the payment.
      const { invoice, paymentHash } = await counterpartyInvoice(AMOUNT_SATS)
      const refundAddress = await arkade.ctx.wallet.getAddress()

      const outcome = await serviceWith().quote(invoice, refundAddress, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })
      if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
      const swap = outcome.swap

      // CLIENT RULE: fund only what the client's own derivation reproduces.
      expect(clientDerivedAddress(swap, invoice, refundAddress)).toBe(swap.lockupAddress)

      const fundTxid = await arkade.ctx.wallet.send({
        address: swap.lockupAddress,
        amount: decodeInvoice(invoice).amountSats,
      })
      expect(fundTxid).toBeTruthy()

      const row = await driveToTerminal(serviceWith(), swap.id)
      expect(row.state).toBe('claimed')
      // The solver actually spent the lockup's claim leaf — not merely a row
      // marked done.
      expect(row.claimArkTxid).toBeTruthy()

      // THE PAYEE'S OWN BOOKS: the sats arrived. A fake can report anything it
      // is told; this is a second node, in another container, that this process
      // has no write access to except by paying it.
      const paid = await counterpartyInvoiceState(paymentHash)
      expect(paid.state).toBe('SETTLED')
      expect(paid.settled).toBe(true)
      expect(Number(paid.amt_paid_sat)).toBe(AMOUNT_SATS)

      // AND THE PREIMAGE IS THE PAYEE'S, NOT ONE THIS TEST SUPPLIED. The value
      // the solver spent the Arkade claim leaf with is byte-for-byte the secret
      // that settled a real HTLC on a node it does not control. With the fake
      // this assertion was circular — the same object forged the invoice and
      // answered the payment.
      expect(row.preimage).toBe(paid.r_preimage)
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'leaves the client every sat when a REAL payment fails terminally, and refunds it without waiting out the deadline',
    async () => {
      await assertArkadeSpendable(arkade, AMOUNT_SATS)

      // AN INVOICE THE SOLVER GENUINELY CANNOT PAY. Cancelled at the payee, so
      // the destination itself rejects the incoming HTLC: LND reports
      // FAILURE_REASON_INCORRECT_PAYMENT_DETAILS, which reaches the adapter as
      // `PaymentRejectedByDestination` — one of the six reasons
      // `FAILED_PAYMENT_REASONS` treats as "the sats provably did not leave".
      // See `cancelCounterpartyInvoice` for why this rather than an
      // over-capacity amount or an unsettled hold.
      const { invoice, paymentHash } = await counterpartyInvoice(AMOUNT_SATS)
      await cancelCounterpartyInvoice(paymentHash)

      const refundAddress = await arkade.ctx.wallet.getAddress()
      // THREE CLOCKS OVER ONE STORE, and this scenario is the reason the idiom
      // exists. The two things it needs are in direct tension:
      //
      //  - to ATTEMPT the payment at all, `evaluateSendPayment` insists the
      //    refund path is still `MIN_CLAIM_WINDOW` (90m) away — the deadline
      //    must be in the FUTURE from the driving clock;
      //  - to PUSH the covenant refund, arkd needs that same deadline already
      //    matured against median-time-past — genuinely in the PAST.
      //
      // So the quote is backdated far enough that `refundLocktime` lands
      // {@link MATURED_BY} behind real wall clock, the payment is driven from a
      // clock that stands just after the quote (where the deadline is still
      // days away and the lockup has not timed out), and the refund is pushed
      // on the real clock, where it is three hours matured.
      const quoteClock = quoteClockFor(invoice)
      const outcome = await serviceWith(quoteClock).quote(invoice, refundAddress, {
        clientRefundPubkey: CLIENT_REFUND_PUBKEY,
      })
      if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
      const swap = outcome.swap
      expect(swap.refundLocktime).toBeLessThan(nowSeconds())

      expect(clientDerivedAddress(swap, invoice, refundAddress)).toBe(swap.lockupAddress)
      await arkade.ctx.wallet.send({ address: swap.lockupAddress, amount: AMOUNT_SATS })
      await awaitFunding(swap.pkScript, AMOUNT_SATS)

      // The solver tries the payment for real and it fails terminally. Driven
      // from just after the quote: inside `DEFAULT_LOCKUP_TIMEOUT` (15m), so
      // the swap has not been abandoned, and with the deadline still ~3 days
      // out, so the pay gate lets the attempt happen.
      const paying = serviceWith(() => quoteClock() + PAY_AFTER_QUOTE)
      const row = await driveToTerminal(paying, swap.id)
      // `refused`, not `stuck`: #182 — a terminal payment failure whose refund
      // has LANDED is finished business, and `stuck` is reserved for rows a
      // human must read. The reason records the failure either way.
      expect(row.state).toBe('refused')
      expect(row.failureReason).toBe('lightning payment failed terminally; client refunded')

      // THE SAFETY PROPERTY: the solver did NOT claim. A payment that failed
      // must never be followed by a claim of the client's lockup — that is the
      // one outcome in this corridor that loses a client's money outright.
      expect(row.claimArkTxid).toBeNull()
      expect(row.preimage).toBeNull()

      // AND THE PAYEE NEVER GOT PAID either — the sats are still the client's.
      const unpaid = await counterpartyInvoiceState(paymentHash)
      expect(unpaid.state).toBe('CANCELED')
      expect(unpaid.settled).toBe(false)
      expect(Number(unpaid.amt_paid_sat)).toBe(0)

      // And the solver hands them back WITHOUT being asked, in the same tick
      // that saw the failure. Every reason in `FAILED_PAYMENT_REASONS` comes
      // from LND's own terminal `failed` state, so the sats provably did not
      // leave and cannot later — there is nothing left to wait for, and the
      // client is not made to sit out `refundLocktime` for a swap already
      // known to be dead.
      //
      // The push goes through the covenant refund leaf, co-signed by a real
      // emulator and a real arkd — the same spend the client could make
      // unilaterally, which is exactly whose refund it is. This row carries no
      // `client_refund_pubkey`, so that leaf is the TIMELOCKED one: it is
      // pushable here only because the quote was backdated far enough for
      // `refundLocktime` to have matured, which is what the three-clock idiom
      // above buys.
      //
      // `refused` now — #182. The client is whole, so nothing needs a human:
      // `stuck` is reserved for rows where the refund did NOT land or the
      // self-payment probe withheld it. `refund_outcome` tells the client they
      // were refunded; the state tells the operator there is nothing to do.
      expect(row.refundOutcome).toBe('pushed')
      expect(row.refundArkTxid).toBeTruthy()
      // Waited for rather than read once: `refund` returns when arkd ACCEPTS
      // the spend, and the indexer `findLockups` reads is a moment behind it.
      await awaitDrained(swap.pkScript)
      const drained = await arkadeOps.findLockups(swap.pkScript)
      expect(drained.reduce((sum, o) => sum + o.value, 0)).toBe(0)
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'refunds a failure the POLL found — the path a crash mid-payment lands on',
    async () => {
      await assertArkadeSpendable(arkade, AMOUNT_SATS)

      // THE OTHER FAILURE PATH, and the one #46 missed. Every other test here
      // reaches a terminal failure through `submitPayment`, because
      // `payViaPaymentRequest` answers before the call returns. A payment whose
      // id is on disk while its outcome is not takes `whenPaying` ->
      // `settleFromBackend` instead, and that branch pushed no refund at all
      // until this change — the client waited out `refundLocktime` for a swap
      // the solver already knew was dead.
      //
      // Reached the way production reaches it: the process died between
      // recording the payment id and learning what became of it. That is not a
      // contrived state — `submitPayment` patches `payment_id` immediately
      // after `payInvoice` returns, so a crash anywhere after it leaves exactly
      // this row, and `whenPaying` is written to poll rather than re-pay
      // precisely because re-paying it would risk paying twice.
      const { invoice, paymentHash } = await counterpartyInvoice(AMOUNT_SATS)
      const refundAddress = await arkade.ctx.wallet.getAddress()
      const clientRefundPubkey = hex.encode(await arkade.ctx.identity.xOnlyPublicKey())
      const outcome = await serviceWith().quote(invoice, refundAddress, { clientRefundPubkey })
      if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
      const swap = outcome.swap

      await arkade.ctx.wallet.send({ address: swap.lockupAddress, amount: AMOUNT_SATS })
      await awaitFunding(swap.pkScript, AMOUNT_SATS)

      // The crash, written onto the row rather than simulated by killing a
      // process: funded, `paying`, and carrying a payment id THIS LND has never
      // heard of. A real crash produces the same row — and the id being unknown
      // is itself the strongest fact available, since a payment LND has no
      // record of provably never left.
      await store.transition(swap.id, 'quoted', 'funded', { lockup_value: AMOUNT_SATS })
      await store.transition(swap.id, 'funded', 'paying', {
        idempotency_key: `e2e-poll-${swap.id}`,
        pay_attempted_at: nowSeconds(),
        payment_id: 'ff'.repeat(32),
      })

      const row = await serviceWith().tick(swap.id)

      // `no_record`, from a REAL LND rejecting the lookup with
      // SentPaymentNotFound — the distinction the status alone cannot carry,
      // since `failed` reads identically for a payment that was attempted and
      // died.
      expect(row.paymentEvidence).toBe('no_record')
      // `refused`, not `stuck`: the refund has landed (asserted below), and
      // #182 reserves `stuck` for rows a human must read.
      expect(row.state).toBe('refused')
      expect(row.failureReason).toBe('lightning payment failed terminally; client refunded')

      // THE FIX: the client is made whole from the polled path too, through the
      // same covenant leaf, co-signed by a real emulator and a real arkd.
      expect(row.refundOutcome).toBe('pushed')
      expect(row.refundArkTxid).toBeTruthy()
      await awaitDrained(swap.pkScript)
      expect((await arkadeOps.findLockups(swap.pkScript)).reduce((sum, o) => sum + o.value, 0)).toBe(0)

      // And nothing of the client's was claimed, nor the payee paid.
      expect(row.claimArkTxid).toBeNull()
      expect(row.preimage).toBeNull()
      const unpaid = await counterpartyInvoiceState(paymentHash)
      expect(unpaid.settled).toBe(false)
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'refunds a SELF-payment immediately — the invoice our own node minted never parks in stuck',
    async () => {
      await assertArkadeSpendable(arkade, AMOUNT_SATS)

      // THE ISSUE-41 REPRO: an invoice minted on the solver's OWN node (an
      // operator's `lncli addinvoice`, or a receive swap's hold on the same
      // node). LND will not route to itself, so the payment fails terminally
      // in under a second — and because the payee's record is ours to read,
      // "never paid" is provable without trusting the payer-side verdict.
      const { invoice, paymentHash } = await solverMintedInvoice(AMOUNT_SATS)
      const refundAddress = await arkade.ctx.wallet.getAddress()

      // The RFQ family (a client_refund_pubkey, as every RFQ quote carries) —
      // the extended script is the one whose nonInteractiveRefund leaf has no
      // timelock, which is exactly why this needs no three-clock idiom and no
      // backdated quote: the refund is pushable the moment it is decided.
      const clientRefundPubkey = hex.encode(await arkade.ctx.identity.xOnlyPublicKey())
      const outcome = await serviceWith().quote(invoice, refundAddress, { clientRefundPubkey })
      if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
      const swap = outcome.swap

      await arkade.ctx.wallet.send({ address: swap.lockupAddress, amount: AMOUNT_SATS })
      await awaitFunding(swap.pkScript, AMOUNT_SATS)

      const row = await driveToTerminal(serviceWith(), swap.id)
      // REFUSED, not stuck: the row was never really exposed, because the one
      // place the sats could have gone is back to us — and our own node says
      // nothing ever arrived.
      expect(row.state).toBe('refused')
      expect(row.failureReason).toContain('self-payment')
      // The refund was pushed by the service itself, in the same drive — no
      // operator, no deadline wait, no sweep.
      expect(row.refundOutcome).toBe('pushed')
      expect(row.refundArkTxid).toBeTruthy()

      // OUR OWN NODE'S BOOKS: the invoice was never paid.
      const view = await solverInvoice(paymentHash)
      expect(view.settled).toBe(false)
      expect(Number(view.amt_paid_sat)).toBe(0)

      // And the sats actually LEFT the script, back to the refund address —
      // the client is whole in seconds, not in 3.6 days.
      await awaitDrained(swap.pkScript)
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'records a refund the client pushed first as external, and pushes nothing of its own',
    async () => {
      const overfunded = AMOUNT_SATS + OVERFUND_BY
      await assertArkadeSpendable(arkade, overfunded)

      const { invoice } = await counterpartyInvoice(AMOUNT_SATS)
      const refundAddress = await arkade.ctx.wallet.getAddress()

      // Backdated so the refund leaf is ALREADY matured. The client has to be
      // able to push it for there to be a race at all — that is the premise.
      const outcome = await serviceWith(quoteClockFor(invoice)).quote(invoice, refundAddress, {
        clientRefundPubkey: CLIENT_REFUND_PUBKEY,
      })
      if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
      const swap = outcome.swap
      expect(swap.refundLocktime).toBeLessThan(nowSeconds())

      await arkade.ctx.wallet.send({ address: swap.lockupAddress, amount: overfunded })
      await awaitFunding(swap.pkScript, overfunded)

      const refused = await driveToTerminal(serviceWith(), swap.id)
      expect(refused.state).toBe('refused')
      expect(refused.lockupValue).toBe(overfunded)

      // THE CLIENT GETS THERE FIRST. The refund leaf needs no keys of ours and
      // can only pay the client's committed address, so a client watching its
      // own deadline can push it the moment it matures and never tell the
      // solver. This is byte-for-byte the spend `refundSweep` was about to make.
      const clientTxid = await pushCovenantRefund(swap, overfunded)
      expect(clientTxid).toBeTruthy()
      await awaitDrained(swap.pkScript)

      // THE SWEEP ARRIVES LATE and finds the script already empty.
      const service = serviceWith()
      expect(await service.refundSweep()).not.toContain(swap.id)

      const settled = await store.get(swap.id)
      // `external`, not `pushed`: the discriminator records that somebody else
      // moved it, and the txid column only ever holds txids WE broadcast.
      expect(settled.refundOutcome).toBe('external')
      expect(settled.refundArkTxid).toBeNull()

      // And it stays settled — a later sweep must not try to respend inputs
      // that are already gone.
      expect(await service.refundSweep()).not.toContain(swap.id)
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'does not write a still-funded lockup off as externally refunded on one stale read',
    async () => {
      const overfunded = AMOUNT_SATS + OVERFUND_BY
      await assertArkadeSpendable(arkade, overfunded)

      const { invoice } = await counterpartyInvoice(AMOUNT_SATS)
      const refundAddress = await arkade.ctx.wallet.getAddress()

      const outcome = await serviceWith(quoteClockFor(invoice)).quote(invoice, refundAddress, {
        clientRefundPubkey: CLIENT_REFUND_PUBKEY,
      })
      if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
      const swap = outcome.swap
      expect(swap.refundLocktime).toBeLessThan(nowSeconds())

      await arkade.ctx.wallet.send({ address: swap.lockupAddress, amount: overfunded })
      await awaitFunding(swap.pkScript, overfunded)
      const refused = await driveToTerminal(serviceWith(), swap.id)
      expect(refused.state).toBe('refused')
      expect(refused.lockupValue).toBe(overfunded)

      // ONE STALE READ, and nothing else wrong anywhere. The sats are at the
      // script, the deadline is matured, the row is exactly what the previous
      // test's row was — the only difference is that `findLockups` answers
      // empty once, which is the one thing a live `spendableOnly` indexer view
      // does on its own under load.
      const staleSweep = await serviceWith(undefined, findLockupsEmptyOnce(swap.pkScript)).refundSweep()

      // READ EVERYTHING, RELEASE, THEN ASSERT — in that order, deliberately.
      // A failing assertion must not leave the client's sats sitting at a
      // covenant script on a stack other runs share.
      const afterStale = await store.get(swap.id)
      const stillFunded = (await arkadeOps.findLockups(swap.pkScript)).reduce((sum, o) => sum + o.value, 0)
      // What the service does on its NEXT healthy pass. This is the whole
      // question: read lag resolves in seconds, so a sweep a moment later sees
      // the truth — if the row is still eligible to be looked at.
      const healthySweep = await serviceWith().refundSweep()

      // The service pushing that refund ITSELF is what this test asserts below,
      // and `findLockups` trails our own spend by a moment — the very lag
      // `awaitDrained` exists for. So reading the script once here and pushing
      // whatever it still shows would race the service's refund and try to
      // spend inputs that are already gone, which `pushCovenantRefund` then
      // retries until it exhausts. Wait for the service's own refund to land;
      // push only if it never made one.
      if (healthySweep.includes(swap.id)) {
        await awaitDrained(swap.pkScript)
      } else {
        const leftover = await arkadeOps.findLockups(swap.pkScript)
        if (leftover.length > 0) {
          await pushCovenantRefund(
            swap,
            leftover.reduce((sum, o) => sum + o.value, 0),
          )
          await awaitDrained(swap.pkScript)
        }
      }

      expect(staleSweep).not.toContain(swap.id)
      // The read was stale, not true: every sat is exactly where it was.
      expect(stillFunded).toBe(overfunded)

      // THE DEFECT THIS PINS — see this file's header. `refundSweep` used to
      // treat one empty read as proof that somebody else refunded, and
      // `findRefundable` filters `refund_outcome IS NULL`, so writing
      // `external` was a one-way door: no grace, no recheck, no second look.
      expect(afterStale.refundOutcome).toBeNull()
      expect(healthySweep).toContain(swap.id)
    },
    SWAP_TIMEOUT_MS,
  )
})

/**
 * `arkadeOps` with exactly ONE `findLockups` read of `pkScript` forced empty.
 *
 * Not a fake stack — every other call, the refund included, goes to the real
 * ops against the real arkd. This reproduces the one thing a live indexer does
 * by itself (a `spendableOnly` view that has not caught up) at an instant a
 * test can pin down, rather than waiting for it to happen by luck under load.
 * Narrowed to one script so it cannot perturb any other row the sweep visits.
 */
const findLockupsEmptyOnce = (pkScript: string): ArkadeOps => {
  let pending = true
  return {
    ...arkadeOps,
    findLockups: async (script) => {
      if (script === pkScript && pending) {
        pending = false
        return []
      }
      return arkadeOps.findLockups(script)
    },
  }
}

const TERMINAL = new Set(['claimed', 'refused', 'stuck'])

/** Drive one swap through the SAME `tick` the watch loop calls, until nothing further can happen. */
const driveToTerminal = (service: SendSwapService, id: string): Promise<SendSwapRow> =>
  poll(
    async () => {
      const row = await service.tick(id)
      return TERMINAL.has(row.state) ? row : null
    },
    { attempts: 150, intervalMs: 2000, whenExhausted: `swap ${id} never reached a terminal state` },
  )

/**
 * Wait until `expected` sats are visible AT THE SCRIPT, before any tick runs.
 *
 * `wallet.send` returns as soon as the transaction is accepted, but
 * `findLockups` reads an indexer that is a moment behind. Separating the wait
 * makes failures legible: an exhausted poll here says the funding never
 * reached the indexer, while an exhausted `driveToTerminal` says the
 * orchestrator did not act on one that did.
 */
const awaitFunding = (pkScript: string, expected: number): Promise<unknown> =>
  poll(
    async () => {
      const outputs = await arkadeOps.findLockups(pkScript)
      return outputs.reduce((sum, o) => sum + o.value, 0) === expected ? outputs : null
    },
    {
      attempts: 60,
      intervalMs: 2000,
      whenExhausted: `${expected} sats never appeared at ${pkScript} — the funding did not reach the indexer`,
    },
  )

/** Wait until nothing is left at the script — the refund actually moved the sats. */
const awaitDrained = (pkScript: string): Promise<readonly unknown[]> =>
  poll(
    async () => {
      const outputs = await arkadeOps.findLockups(pkScript)
      return outputs.reduce((sum, o) => sum + o.value, 0) === 0 ? outputs : null
    },
    { attempts: 30, intervalMs: 2000, whenExhausted: `${pkScript} still holds sats after the covenant refund` },
  )

/**
 * Push the covenant refund until arkd accepts it.
 *
 * Retried rather than called once because the leaf's CLTV matures against
 * median-time-past: even three hours back, a first push can still come back
 * FORFEIT_CLOSURE_LOCKED if the chain tip is stale, and the next block fixes it.
 */
const pushCovenantRefund = (swap: SendSwapRow, expected: number): Promise<string> =>
  poll(
    async () => {
      const outputs = await arkadeOps.findLockups(swap.pkScript)
      if (outputs.reduce((sum, o) => sum + o.value, 0) !== expected) return null
      return arkadeOps.refund(swap, outputs)
    },
    { attempts: 12, intervalMs: 15_000, whenExhausted: `covenant refund for ${swap.id} was never accepted` },
  )
