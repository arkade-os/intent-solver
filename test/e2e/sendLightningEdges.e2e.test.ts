/**
 * E2E — `arkade:BTC->lightning:BTC` (send), everything the happy path is not.
 *
 * `sendLightning.e2e.test.ts` proves the corridor works when the client behaves.
 * This file is the other half: what happens when the client funds the wrong
 * amount, funds twice, funds too late, or does not fund at all — plus the two
 * live-stack facts no unit test can establish, that arkd REFUSES a claim built
 * on the wrong preimage, and that a swap survives the process that quoted it.
 *
 * WHY THESE BELONG IN E2E AND NOT IN THE UNIT SUITE. Every refusal below is
 * already unit-tested against a fake `ArkadeOps`. What is not, and cannot be,
 * is that the money actually comes BACK: `refundSweep` pushes the covenant's
 * `nonInteractiveRefund` leaf, whose CLTV matures against the CHAIN TIP's
 * timestamp rather than wall clock, and which a real emulator and a real arkd
 * must both agree to co-sign. A fake says yes to anything.
 *
 * THE THREE-CLOCK IDIOM, used throughout. Every service here is built over ONE
 * store with a DIFFERENT `now`, which is how a test that must not take three
 * days still exercises deadlines three days out:
 *
 *  - the QUOTING clock runs far enough BACK that the `refundLocktime` the quote
 *    derives (`refundLocktimeFor`, ~3.1 days ahead of whatever clock quotes it)
 *    lands three hours in the PAST — the same figure `cli test-refund` defaults
 *    to, chosen so the locktime clears median-time-past, which lags the tip's
 *    own timestamp by ~50 minutes on this stack.
 *  - the DRIVING clock is whatever that particular deadline needs: the real one
 *    for refusals that do not involve a timeout, or `+20 minutes` to mature
 *    `DEFAULT_LOCKUP_TIMEOUT` without waiting fifteen of them.
 *  - the SWEEPING clock is the real one, because `findRefundable` selects on
 *    `refund_locktime <= now` and the quote clock has already put that in the
 *    past.
 *
 * PREREQUISITES — the same as `sendLightning.e2e.test.ts`: arkd, emulator, and
 * an Arkade wallet funded AND SETTLED. Lightning is the file-backed fake.
 *
 * Run: `pnpm test:e2e`   (never runs in CI — `pnpm test` excludes `test/e2e`)
 */

import { schnorr } from '@noble/curves/secp256k1.js'
import { randomBytes } from 'node:crypto'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { decodeInvoice } from '@arkade-os/solver-core/invoice/decode.js'
import { refundLocktimeFor } from '@arkade-os/solver-core/core/send.js'
import { HOUR, MINUTE } from '@arkade-os/solver-core/core/timelocks.js'
import { SwapStore, type SendSwapRow } from '@arkade-os/solver-corridors/db/swaps.js'
import { arkadeOpsFromContext } from '@arkade-os/solver-corridors/send/arkadeOps.js'
import { SendSwapService, type ArkadeOps } from '@arkade-os/solver-corridors/send/orchestrator.js'
import { nowSeconds, poll } from '@arkade-os/solver-core/util/poll.js'
import { requireStack } from './support/preflight.js'
import {
  assertArkadeSpendable,
  openArkade,
  openFakeLightning,
  SETUP_TIMEOUT_MS,
  SWAP_TIMEOUT_MS,
  tempStoreDir,
  type E2eArkade,
} from './support/stack.js'

/** The RFQ family requires a client refund pubkey on every quote. */
const CLIENT_REFUND_PUBKEY = hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(11)))

const AMOUNT_SATS = Number(process.env.E2E_AMOUNT_SATS ?? 5000)

/**
 * How far past the funding deadline the driving clock stands for the timeout
 * cases. Above `DEFAULT_LOCKUP_TIMEOUT` (15m) and well below the forged
 * invoice's own 2h expiry, so the refusal reason names the LOCKUP timeout
 * rather than the invoice expiring — two different branches of `whenQuoted`.
 */
const PAST_LOCKUP_DEADLINE = 20 * MINUTE

/**
 * How far in the past a quote's derived `refundLocktime` is aimed.
 *
 * Three hours, the same default `cli test-refund` uses, and for its reason:
 * a seconds-based CLTV matures against MEDIAN-TIME-PAST, which on this regtest
 * lags the chain tip's own timestamp by ~50 minutes (11-block median at a
 * 600s block interval). Three hours clears it with room to spare, so a refund
 * push is not rejected as FORFEIT_CLOSURE_LOCKED on the first attempt.
 */
const MATURED_BY = 3 * HOUR

let arkade: E2eArkade
let store: SwapStore
let ln: ReturnType<typeof openFakeLightning>
let arkadeOps: ArkadeOps
let dir: string

/** A service over the shared store, on `now`'s clock. See this file's header. */
const serviceWith = (now?: () => number): SendSwapService =>
  new SendSwapService({
    store,
    ln,
    arkade: arkadeOps,
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

describe('e2e arkade:BTC->lightning:BTC (send) — refusals, refunds and recovery', () => {
  beforeAll(async () => {
    await requireStack('arkade:BTC->lightning:BTC edges', ['arkd', 'emulator'])
    arkade = await openArkade()
    dir = tempStoreDir()
    store = await SwapStore.open(`${dir}/swaps.sqlite`)
    ln = openFakeLightning(dir, arkade.network)
    arkadeOps = await arkadeOpsFromContext(arkade.ctx, arkade.emulator)
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await store?.close()
    arkade?.close()
  })

  it('refuses a second live quote for the same payment hash', async () => {
    const { invoice } = ln.forgeInvoice(AMOUNT_SATS)
    const refundAddress = await arkade.ctx.wallet.getAddress()
    const service = serviceWith()

    const first = await service.quote(invoice, refundAddress, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })
    expect(first.accepted).toBe(true)

    // Two live swaps on one hash mean two lockups and one payment; whoever
    // loses the race has their lockup claimed and no refund.
    const second = await service.quote(invoice, refundAddress, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })
    expect(second).toEqual({ accepted: false, reason: 'duplicate_swap' })
  })

  it('refuses an invoice below the network minimum', async () => {
    const { invoice } = ln.forgeInvoice(arkade.limits.minSats - 1)
    const outcome = await serviceWith().quote(invoice, await arkade.ctx.wallet.getAddress(), {
      clientRefundPubkey: CLIENT_REFUND_PUBKEY,
    })
    expect(outcome).toEqual({ accepted: false, reason: 'amount_out_of_range' })
  })

  it('refuses a refund address that is not an Arkade address on this network', async () => {
    const { invoice } = ln.forgeInvoice(AMOUNT_SATS)
    const outcome = await serviceWith().quote(invoice, 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', {
      clientRefundPubkey: CLIENT_REFUND_PUBKEY,
    })
    expect(outcome).toEqual({ accepted: false, reason: 'invalid_refund_address' })
  })

  it('refuses a quote whose lockup never arrives, without ever moving money', async () => {
    const { invoice } = ln.forgeInvoice(AMOUNT_SATS)
    const outcome = await serviceWith().quote(invoice, await arkade.ctx.wallet.getAddress(), {
      clientRefundPubkey: CLIENT_REFUND_PUBKEY,
    })
    if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)

    // Nothing is funded. Past the deadline the swap is refused rather than left
    // open — an always-on watcher would have timed it out, and the recovery
    // path must not smuggle a stale lockup in later.
    const row = await serviceWith(() => nowSeconds() + PAST_LOCKUP_DEADLINE).tick(outcome.swap.id)
    expect(row.state).toBe('refused')
    expect(row.failureReason).toBe('lockup timeout')
    expect(row.lockupValue).toBeNull()
  })

  it(
    'refuses an overfunded lockup and gives every sat of it back through the covenant refund',
    async () => {
      await assertArkadeSpendable(arkade, AMOUNT_SATS * 2)
      const { invoice } = ln.forgeInvoice(AMOUNT_SATS)
      const refundAddress = await arkade.ctx.wallet.getAddress()

      const outcome = await serviceWith(quoteClockFor(invoice)).quote(invoice, refundAddress, {
        clientRefundPubkey: CLIENT_REFUND_PUBKEY,
      })
      if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
      const swap = outcome.swap
      // The whole point of backdating the quote: this deadline is already past,
      // so the refund below can actually be pushed.
      expect(swap.refundLocktime).toBeLessThan(nowSeconds())

      const overfunded = AMOUNT_SATS + 1000
      await arkade.ctx.wallet.send({ address: swap.lockupAddress, amount: overfunded })
      await awaitFunding(swap.pkScript, overfunded)

      // Refused, never paid: the claim leaf sweeps WHOLE vtxos, so paying an
      // overfunded lockup hands the solver the excess with no way back.
      const refused = await driveUntil(serviceWith(), swap.id, TERMINAL)
      expect(refused.state).toBe('refused')
      expect(refused.failureReason).toBe(`overfunded lockup: ${overfunded} > ${AMOUNT_SATS} sats`)
      expect(refused.lockupValue).toBe(overfunded)

      // And now the part only a live stack can prove: the emulator and arkd
      // both co-sign the refund, and the client's own address gets it all.
      const swept = await pushRefundSweep(serviceWith(), swap.id)
      expect(swept).toContain(swap.id)
      const refunded = await store.get(swap.id)
      expect(refunded.refundOutcome).toBe('pushed')
      expect(refunded.refundArkTxid).toBeTruthy()
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'refuses a partially funded lockup at the deadline and refunds the partial amount',
    async () => {
      await assertArkadeSpendable(arkade, AMOUNT_SATS)
      const { invoice } = ln.forgeInvoice(AMOUNT_SATS)
      const refundAddress = await arkade.ctx.wallet.getAddress()

      const outcome = await serviceWith(quoteClockFor(invoice)).quote(invoice, refundAddress, {
        clientRefundPubkey: CLIENT_REFUND_PUBKEY,
      })
      if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
      const swap = outcome.swap

      const partial = AMOUNT_SATS - 1000
      await arkade.ctx.wallet.send({ address: swap.lockupAddress, amount: partial })
      // MUST come before the deadline clock is applied. The forward clock makes
      // `timedOut` true on the very first tick, so a tick that lands before the
      // indexer has the payment refuses for a bare "lockup timeout" with
      // `lockup_value` null — terminal, unrecoverable, and the wrong scenario.
      // The overfunded test above survives the same ordering only because it
      // drives on the REAL clock, where an early tick simply does nothing.
      await awaitFunding(swap.pkScript, partial)

      // A partial lockup is not a fundable swap: it sits in `quoted` until the
      // deadline, then is refused NAMING what actually arrived, so the sweep
      // below knows there is something to return.
      const refused = await driveUntil(
        serviceWith(() => nowSeconds() + PAST_LOCKUP_DEADLINE),
        swap.id,
        TERMINAL,
      )
      expect(refused.state).toBe('refused')
      expect(refused.failureReason).toBe(`lockup timeout with partial ${partial} sats`)
      expect(refused.lockupValue).toBe(partial)

      const swept = await pushRefundSweep(serviceWith(), swap.id)
      expect(swept).toContain(swap.id)
      expect((await store.get(swap.id)).refundArkTxid).toBeTruthy()
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'refuses a lockup funded twice, and refunds both vtxos in one covenant spend',
    async () => {
      await assertArkadeSpendable(arkade, AMOUNT_SATS * 2)
      const { invoice } = ln.forgeInvoice(AMOUNT_SATS)
      const refundAddress = await arkade.ctx.wallet.getAddress()

      const outcome = await serviceWith(quoteClockFor(invoice)).quote(invoice, refundAddress, {
        clientRefundPubkey: CLIENT_REFUND_PUBKEY,
      })
      if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
      const swap = outcome.swap

      // A client that resends after a timeout it did not actually suffer. Both
      // payments are for the EXACT quoted amount, so neither is wrong on its
      // own — it is the sum at the script that decides, which is why
      // `whenQuoted` totals the outputs rather than looking for one match.
      await arkade.ctx.wallet.send({ address: swap.lockupAddress, amount: AMOUNT_SATS })
      await arkade.ctx.wallet.send({ address: swap.lockupAddress, amount: AMOUNT_SATS })

      const doubled = AMOUNT_SATS * 2
      // Both, not either: a tick between the two payments sees exactly the
      // quoted amount and would transition the swap to `funded` — a legitimate
      // outcome for a lockup that was correctly funded once, and the wrong
      // scenario for this test.
      const before = await awaitFunding(swap.pkScript, doubled)
      expect(before).toHaveLength(2)

      const refused = await driveUntil(serviceWith(), swap.id, TERMINAL)
      expect(refused.state).toBe('refused')
      expect(refused.failureReason).toBe(`overfunded lockup: ${doubled} > ${AMOUNT_SATS} sats`)

      // Two vtxos, ONE refund transaction. `refundSweep` hands every output it
      // finds at the script to a single covenant spend, and a live arkd has to
      // accept a multi-input spend of the same leaf — the case a single-output
      // refund test never reaches.
      const swept = await pushRefundSweep(serviceWith(), swap.id)
      expect(swept).toContain(swap.id)
      expect((await store.get(swap.id)).refundArkTxid).toBeTruthy()

      // BOTH outputs gone, polled rather than read once. The refund txid is
      // recorded the moment the spend is accepted, and the indexer's
      // spendable view catches up a beat later — read immediately this
      // legitimately still returns two. That lag is the same one that makes
      // `whenRefunding`'s claim/refund race on the receive leg intermittent;
      // here it is only a test's impatience.
      await poll(async () => ((await arkadeOps.findLockups(swap.pkScript)).length === 0 ? true : null), {
        attempts: 30,
        intervalMs: 2000,
        whenExhausted: `both vtxos at ${swap.pkScript} were still unspent after the refund was pushed`,
      })
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'is refused by a live arkd when the claim carries the wrong preimage, and still claims with the right one',
    async () => {
      await assertArkadeSpendable(arkade, AMOUNT_SATS)
      const { invoice } = ln.forgeInvoice(AMOUNT_SATS)
      const service = serviceWith()

      const outcome = await service.quote(invoice, await arkade.ctx.wallet.getAddress(), {
        clientRefundPubkey: CLIENT_REFUND_PUBKEY,
      })
      if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
      const swap = outcome.swap
      await arkade.ctx.wallet.send({ address: swap.lockupAddress, amount: AMOUNT_SATS })

      const outputs = await awaitFunding(swap.pkScript, AMOUNT_SATS)

      // THE ASSERTION THIS TEST EXISTS FOR. The covenant's claim leaf is
      // `HASH160 <h> EQUALVERIFY ...`; nothing local enforces it, so the only
      // proof the hash branch is real is a LIVE arkd refusing to co-sign a
      // spend built on 32 random bytes. Unit tests use a fake that says yes.
      await expect(arkadeOps.claim(swap, outputs, hex.encode(randomBytes(32)))).rejects.toThrow()

      // The lockup is untouched by that attempt, so the ordinary path still
      // completes — which also returns the sats this test spent.
      const claimed = await driveUntil(service, swap.id, new Set(['claimed', 'refused', 'stuck']))
      expect(claimed.state).toBe('claimed')
      expect(claimed.claimArkTxid).toBeTruthy()
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'recovers a swap funded while the process was down, from durable state alone',
    async () => {
      await assertArkadeSpendable(arkade, AMOUNT_SATS)
      const { invoice } = ln.forgeInvoice(AMOUNT_SATS)

      const outcome = await serviceWith().quote(invoice, await arkade.ctx.wallet.getAddress(), {
        clientRefundPubkey: CLIENT_REFUND_PUBKEY,
      })
      if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
      const swap = outcome.swap
      await arkade.ctx.wallet.send({ address: swap.lockupAddress, amount: AMOUNT_SATS })
      await awaitFunding(swap.pkScript, AMOUNT_SATS)

      // NOT TICKED. This is the crash the recovery sweep exists for: the client
      // funded and the process died before the solver ever looked. The row on
      // disk still says `quoted`, and everything needed to finish the swap —
      // the covenant fields, the invoice, the idempotency key it will derive —
      // has to come off that row alone.
      //
      // Stopping at `funded` instead is not available and it is worth saying
      // why: `tick` loops `while (step(...))`, so one call carries a fully
      // ready swap quoted -> funded -> paying -> paid -> claiming -> claimed
      // without pausing. There is no way to observe `funded` through the public
      // surface, and an earlier version of this test polled for it until it
      // timed out — the swap was already `claimed`.
      expect((await store.get(swap.id)).state).toBe('quoted')

      // THE RESTART. Closing the store drops every handle and every scrap of
      // in-memory state (`inFlight`, the service object itself); reopening the
      // same FILE and rebuilding the service is exactly what `cli watch` does
      // on a fresh boot. Nothing is carried across but the sqlite file.
      await store.close()
      store = await SwapStore.open(`${dir}/swaps.sqlite`)
      const rebooted = serviceWith()

      // `tickAll` — the recovery sweep, not a targeted tick: the new process is
      // told nothing about which swap to resume and has to find it itself.
      const resumed = await poll(
        async () => {
          const rows = await rebooted.tickAll()
          const row = rows.find((r) => r.id === swap.id)
          return row && ['claimed', 'refused', 'stuck'].includes(row.state) ? row : null
        },
        { attempts: 150, intervalMs: 2000, whenExhausted: `swap ${swap.id} never recovered after the restart` },
      )
      expect(resumed.state).toBe('claimed')
      expect(resumed.claimArkTxid).toBeTruthy()
    },
    SWAP_TIMEOUT_MS,
  )
})

const TERMINAL = new Set(['claimed', 'refused', 'stuck'])

const driveUntil = (service: SendSwapService, id: string, until: ReadonlySet<string>): Promise<SendSwapRow> =>
  poll(
    async () => {
      const row = await service.tick(id)
      return until.has(row.state) ? row : null
    },
    { attempts: 150, intervalMs: 2000, whenExhausted: `swap ${id} never reached one of [${[...until].join(', ')}]` },
  )

/**
 * Wait until `expected` sats are visible AT THE SCRIPT, before any tick runs.
 *
 * Every money test here funds first and drives second, and the two are ordered
 * on purpose. `wallet.send` returns as soon as the transaction is accepted, but
 * `findLockups` reads an indexer that is a moment behind, and a tick landing in
 * that gap sees an EMPTY script. On the real clock that is harmless — nothing
 * happens and the next tick retries — but under a forward clock `timedOut` is
 * already true, so the swap is refused for a bare "lockup timeout" with
 * `lockup_value` null. That is terminal and has no way back, so the test then
 * asserts against a refusal it did not mean to produce and cannot recover from.
 *
 * Separating the wait also makes failures legible: an exhausted poll here says
 * the payment never reached the indexer, while an exhausted `driveUntil` says
 * the orchestrator did not act on one that did.
 */
const awaitFunding = (pkScript: string, expected: number) =>
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

/**
 * Run `refundSweep` until it pushes this swap's refund.
 *
 * Retried rather than called once because the leaf's CLTV matures against
 * median-time-past: even three hours back, a first push can still come back
 * FORFEIT_CLOSURE_LOCKED if the chain tip is stale, and the next block fixes
 * it. `refundSweep` swallows per-row errors by design, so the retry reads the
 * outcome column rather than an exception.
 */
const pushRefundSweep = async (service: SendSwapService, id: string): Promise<string[]> =>
  poll(
    async () => {
      const pushed = await service.refundSweep()
      return pushed.includes(id) ? pushed : null
    },
    { attempts: 12, intervalMs: 15_000, whenExhausted: `covenant refund for ${id} was never accepted` },
  )
