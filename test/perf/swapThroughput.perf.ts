/**
 * LOAD TEST — a hundred independent wallets swapping through one solver, on all
 * four corridors at once, against the live regtest stack.
 *
 * NOT part of `pnpm test` and NOT part of `pnpm test:e2e`. It has its own
 * config and its own script (`pnpm test:perf`) because it is slow, it moves a
 * lot of money, and it wants a stack all to itself. The filename ends `.perf.ts`
 * rather than `.test.ts` so that even if someone points a bare `vitest` at this
 * tree it is not collected: `vitest.config.ts`'s include is the default
 * `*.{test,spec}.*`, and a name that cannot match it is a stronger guarantee
 * than an exclude pattern nobody remembers to update.
 *
 * WHAT IT IS FOR. The corridor e2e tests answer "does this work". This answers
 * "how fast, how many at once, and where does the time actually go" — and it is
 * the only test in the repo where the solver is under simultaneous load from
 * parties that do not know about each other.
 *
 * THE CLIENTS TRANSACT WITH EACH OTHER, THROUGH THE SOLVER. The Lightning
 * corridors are launched in PAIRS: wallet A quotes `arkade:BTC->lightning:BTC`
 * for N sats at the same moment wallet B quotes `lightning:BTC->arkade:BTC` for
 * N sats. A's Arkade sats end up in the solver's float and the solver's float
 * ends up as B's Arkade lockup, so across the pair the money has moved A -> B
 * with the solver as the only counterparty either of them ever spoke to. Both
 * legs of the Lightning payment cross the same boltz-lnd <-> lnd channel in
 * opposite directions, so the channel nets out too and a long run does not
 * exhaust it.
 *
 * A PAIR OF DIFFERENT CLIENTS CANNOT SHARE A PAYMENT HASH. #47's
 * cross-corridor duplicate-hash guard refuses `duplicate_swap` for a hash live
 * in any other corridor's store, so an A-to-B pair here is two independent
 * hashes whose ECONOMICS net, not one hash used twice.
 *
 * ONE client sharing a hash with ITSELF is now a supported flow, and this file
 * measures it too. A client that quotes `lightning:BTC->arkade:BTC` and then
 * `arkade:BTC->lightning:BTC` against the bolt11 it was just handed is
 * refreshing Arkade funds through the solver; the two swaps are recognised as a
 * coupled pair and settled entirely on Arkade, with no Lightning payment,
 * because one node cannot pay its own invoice. `PERF_SELF_PAYMENT` sets how
 * many of those run. Their cost profile is genuinely different from every other
 * corridor — two quotes, two Arkade lockups, no htlc anywhere — so they are
 * reported as their own corridor rather than folded into the Lightning ones.
 *
 * The services below are wired exactly as `packages/solver-app/src/cli.ts` wires them, coupling
 * included: the receive store is passed to the send corridor as `coupling`
 * rather than in `peerStores`, because in both places the duplicate check would
 * refuse the very quote that creates the coupling. That fidelity is the point —
 * the benchmark measures the admission path a real deployment runs.
 *
 * WHAT IS TIMED. Every swap carries a {@link Timeline} of named marks taken at
 * boundaries this file controls — never inside the service, which would measure
 * an instrumented build. Phases are the gaps between adjacent marks, and each
 * is named for WHOSE wait it is:
 *
 *   `quote`         the solver's `quote()` call, start to return. No external
 *                   wait on three corridors; on `lightning:BTC->arkade:BTC` it
 *                   includes minting a real hold invoice on LND, because that
 *                   side effect genuinely is inside `quote()`.
 *   `client_*`      something the CLIENT does — funding a lockup, broadcasting
 *                   a claim. Solver latency does not appear here.
 *   `solver_*`      the solver noticing and acting. This is the number a
 *                   "sub-2s per swap" target is about.
 *   `indexer_visible` / `htlc_arrives`
 *                   the gap between a client's action completing and the money
 *                   being OBSERVABLE — the Arkade indexer surfacing a new VTXO,
 *                   or a Lightning payment finding its route. Split out of the
 *                   `solver_*` phase that follows precisely so it is not billed
 *                   to the solver: under load both grow, and neither is the
 *                   solver's doing.
 *   `chain_confirm` waiting for a Bitcoin block. Nothing in this repo can make
 *                   it faster, and it is kept in its own phase so it never
 *                   contaminates a solver number.
 *
 * THE PHASES ARE AS FINE-GRAINED AS THE CODE ALLOWS, AND NO FINER. `tick()` is
 * a `while (await step())` loop, so a single call routinely crosses several
 * states — on `arkade:BTC->lightning:BTC` one tick adopts the lockup, pays the
 * invoice AND claims. Splitting those into three phases reported the first at
 * 4.6s and the other two at 0ms, which is not a breakdown, it is one number and
 * two decorations. So states a tick crosses together are reported together and
 * the phase is named for what it actually covers (`solver_deliver`,
 * `solver_arm_and_fund`). Anything finer would need instrumentation inside the
 * service, which would mean benchmarking an instrumented build.
 *
 * POLLING QUANTISES EVERYTHING. Every `solver_*` phase is observed by calling
 * `tick()` on a loop, so a measured duration carries up to one poll interval of
 * error (`PERF_POLL_MS`, default 250ms). That is why the interval is printed
 * with the results. A production watch loop's cadence is its own, larger
 * number; this deliberately polls tighter than production so the figure
 * reported is the SERVICE's cost rather than the loop's.
 *
 * WHAT IT ASSERTS. That every swap reached its terminal GOOD state — a real
 * correctness assertion under concurrency, and the thing most likely to break
 * first. It deliberately asserts NOTHING about the timings: a wall-clock
 * threshold against a shared regtest stack fails for reasons no one can act on.
 * The numbers are printed; a human reads them.
 *
 * PREREQUISITES — the same stack the corridor e2e suite needs, with all six of
 * `docs/runbook.md`'s mandatory arkd overrides, plus:
 *   - the solver's Arkade wallet funded and SETTLED with enough float to fan
 *     out to the send-side wallets AND fund every concurrent receive lockup;
 *     `beforeAll` fails with the exact shortfall and the command to fix it.
 *   - a MINING miner. `onchain:BTC->arkade:BTC` waits on real confirmations, so
 *     this file drives the chain itself while that corridor has work in flight
 *     (see {@link startMiner}) — additive and non-destructive, the same thing
 *     `receiveOnchain.e2e.test.ts` already does.
 *
 * Run: `pnpm test:perf`  (and nothing else against the stack at the same time —
 * two runs would fight over the solver's float and the channel's liquidity)
 */

import { randomBytes } from 'node:crypto'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ArkAddress } from '@arkade-os/sdk'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { Address, OutScript, SigHash, p2tr } from '@scure/btc-signer'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { scriptHashFromPaymentHash } from '@arkade-os/solver-core/core/preimage.js'
import { type Corridor } from '@arkade-os/solver-core/core/corridorPolicy.js'
import { decodeInvoice } from '@arkade-os/solver-core/invoice/decode.js'
import { OnchainReceiveSwapStore } from '@arkade-os/solver-corridors/db/onchainReceiveSwaps.js'
import { OnchainSendSwapStore } from '@arkade-os/solver-corridors/db/onchainSwaps.js'
import { ReceiveSwapStore } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import { SwapStore } from '@arkade-os/solver-corridors/db/swaps.js'
import { buildOnchainClaimTx, estimateClaimTxVsize, signOnchainClaimTx } from '@arkade-os/solver-rails/onchain/claim.js'
import { buildOnchainHtlc, ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'
import type { OnchainSendBackend } from '@arkade-os/solver-core/ports/onchain.js'
import type { OnchainSigner } from '@arkade-os/solver-rails/onchain/refund.js'
import { receiveArkadeOpsFromContext } from '@arkade-os/solver-corridors/receive/arkadeOps.js'
import { onchainReceiveArkadeOpsFromContext } from '@arkade-os/solver-corridors/receive/onchainArkadeOps.js'
import { OnchainReceiveSwapService } from '@arkade-os/solver-corridors/receive/onchainOrchestrator.js'
import { ReceiveSwapService } from '@arkade-os/solver-corridors/receive/orchestrator.js'
import { arkadeOpsFromContext } from '@arkade-os/solver-corridors/send/arkadeOps.js'
import { OnchainSendSwapService } from '@arkade-os/solver-corridors/send/onchainOrchestrator.js'
import { SendSwapService } from '@arkade-os/solver-corridors/send/orchestrator.js'
import { poll } from '@arkade-os/solver-core/util/poll.js'
import { mineBlocks } from '../e2e/support/chain.js'
import { newSealedPreimage } from '../e2e/support/claimPacket.js'
import { clientClaimLockup } from '../e2e/support/clientClaim.js'
import { cancelSolverHold, counterpartyInvoice, payFromCounterparty } from '../e2e/support/counterparty.js'
import type { CounterpartyPayment } from '../e2e/support/counterparty.js'
import { requireStack } from '../e2e/support/preflight.js'
import { findClaimPreimage, findLockupOutpoints } from '@arkade-os/solver-arkade/arkade/wallet.js'
import {
  assertArkadeSpendable,
  openArkade,
  openOnchainBackend,
  openSolverLightning,
  tempStoreDir,
  type E2eArkade,
} from '../e2e/support/stack.js'
import { openFleet, reclaimFleet, splitSolverFloat, topUpFleet, type Fleet, type FleetWallet } from './support/fleet.js'
import { formatReport, Timeline, type SwapTiming } from './support/metrics.js'

/** The RFQ family requires a client refund pubkey on every quote. */
const CLIENT_REFUND_PUBKEY = hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(11)))

const count = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer, got ${raw}`)
  return value
}

/**
 * How many swaps of each corridor to run.
 *
 * The default mix is weighted toward the two Lightning corridors on purpose:
 * they are the ones whose latency is actually the solver's, so they are where
 * the interesting number lives. The onchain corridors are present in smaller
 * numbers because each one broadcasts a real transaction and one of them waits
 * on a real block — enough to prove they work under concurrent load and to
 * measure their shape, without letting block time dominate the run.
 *
 * The pairing is between the two Lightning counts: `min(LN_SEND, LN_RECEIVE)`
 * swaps are launched as A-sends-to-B pairs.
 */
const LN_SEND = count('PERF_LN_SEND', 40)
const LN_RECEIVE = count('PERF_LN_RECEIVE', 40)
const ONCHAIN_SEND = count('PERF_ONCHAIN_SEND', 10)
const ONCHAIN_RECEIVE = count('PERF_ONCHAIN_RECEIVE', 10)
/**
 * Coupled self-payment refreshes: one client quoting BOTH Lightning corridors
 * against one bolt11. Each consumes one wallet and two Arkade lockups, and no
 * Lightning capacity at all, so it does not compete with the paired corridors
 * for the boltz-lnd channel.
 */
const SELF_PAYMENT = count('PERF_SELF_PAYMENT', 10)
const TOTAL_SWAPS = LN_SEND + LN_RECEIVE + ONCHAIN_SEND + ONCHAIN_RECEIVE + SELF_PAYMENT

/**
 * How many swaps may be in flight at once.
 *
 * Defaults to ALL of them — the point is to find where the stack stops coping,
 * not to avoid finding out. Lower it to bisect a ceiling: a run that fails at
 * 100 and passes at 40 has located something real, and the number belongs in
 * the report rather than being quietly designed around.
 */
const CONCURRENCY = count('PERF_CONCURRENCY', TOTAL_SWAPS)

/**
 * Swap size, sats. The Lightning corridors run at the network minimum
 * (`TESTNET_LIMITS.minSats` = 1000) because a hundred swaps of anything larger
 * is a lot of float to have committed at once for no extra signal.
 *
 * The onchain corridors cannot: their payout has to clear the taproot dust
 * limit AFTER a real miner fee comes out of it, so they use the same order of
 * magnitude `sendOnchain.e2e.test.ts` does.
 */
const AMOUNT_SATS = count('PERF_AMOUNT_SATS', 1000)
const ONCHAIN_AMOUNT_SATS = count('PERF_ONCHAIN_AMOUNT_SATS', 20_000)

/**
 * How often a swap's own driver calls `tick`.
 *
 * Deliberately far tighter than any production watch loop: the question here is
 * what the SERVICE costs, and a slow poll would report the poll. It is the
 * quantisation error on every `solver_*` figure, so it is printed with the
 * results.
 */
const POLL_MS = count('PERF_POLL_MS', 250)

/** Bounded so a wedged swap fails with its own name rather than hanging the run. */
const POLL_ATTEMPTS = count('PERF_POLL_ATTEMPTS', 2400)

/**
 * How long a client's L1 funding may keep retrying, and how often.
 *
 * THE CEILING THIS EXISTS FOR IS REAL AND WORTH READING. Both onchain corridors
 * put every client's funding through the SOLVER's own LND wallet, because the
 * stack has no second onchain wallet to give them (the same both-roles
 * shortcut `receiveOnchain.e2e.test.ts` takes). That wallet holds TWO confirmed
 * UTXOs — measured on the live stack with `lncli listunspent` — and
 * `sendToChainAddress` selects confirmed inputs only. So the first two
 * concurrent fundings spend both, their change is unconfirmed, and every
 * further funding fails outright with
 * `503,InsufficientBalanceToSendToChainAddress` on a wallet holding 198 million
 * sats. Observed exactly that way at five concurrent onchain receives: two
 * succeeded, three failed instantly.
 *
 * That is a property of the STACK's wallet, not of the solver — a real
 * deployment's clients each fund from their own wallet and never contend — so
 * it is absorbed here rather than allowed to fail the run. It is absorbed
 * VISIBLY: the wait lands in the `client_fund` phase, which is already labelled
 * as the client's, so the number is reported rather than hidden. The same wall
 * bounds the SOLVER's own HTLC funding on `arkade:BTC->onchain:BTC`, and there
 * it needs no special handling — a throwing `tick` costs one `poll` attempt and
 * the loop retries, which is what `poll` is documented to do.
 *
 * The escape is a confirmed block: {@link startMiner} is what makes the change
 * spendable again, which is why the miner runs for EITHER onchain corridor and
 * not just the one that waits on confirmations.
 */
const ONCHAIN_FUND_ATTEMPTS = count('PERF_ONCHAIN_FUND_ATTEMPTS', 90)
const ONCHAIN_FUND_INTERVAL_MS = count('PERF_ONCHAIN_FUND_INTERVAL_MS', 2000)

/** The whole workload's budget. Generous: the onchain receive corridor waits on blocks. */
const RUN_TIMEOUT_MS = count('PERF_RUN_TIMEOUT_MS', 45 * 60_000)
const SETUP_TIMEOUT_MS = count('PERF_SETUP_TIMEOUT_MS', 15 * 60_000)

/**
 * How often to mine while onchain-receive swaps are waiting.
 *
 * arkade-regtest's auto-miner produces a block every 600 seconds, which is
 * slower than this whole run. Mining is additive and non-destructive — it
 * appends blocks to a chain that was going to get them anyway and touches no
 * configuration — which is what makes it safe from a test on a shared stack.
 * Worth stating plainly for anyone reading the results: the onchain receive
 * corridor's numbers are what they are BECAUSE something mined by hand, and its
 * `chain_confirm` phase is bounded below by this interval rather than by
 * anything in this repo.
 */
const MINE_INTERVAL_MS = count('PERF_MINE_INTERVAL_MS', 5_000)

/**
 * Whether teardown sweeps the fleet's balances back to the solver. On by
 * default — see `reclaimFleet`. Turn it off (`PERF_RECLAIM=0`) only to inspect
 * where the money ended up after a run that went wrong.
 */
const RECLAIM = process.env.PERF_RECLAIM !== '0'

/**
 * How many separate vtxos to split the solver's float into before the run.
 *
 * OFF by default (`1` is a no-op), because it was measured and it does not
 * help: the receive corridors' funding is serialised inside the single Arkade
 * wallet, not by coin selection, so more coins buy nothing. `splitSolverFloat`
 * carries the full measurement. The knob stays so the experiment is one
 * environment variable to repeat, and so a future SDK that DOES parallelise can
 * be checked against it.
 */
const FLOAT_COINS = count('PERF_SOLVER_FLOAT_COINS', 1)
const FLOAT_COIN_SATS = count('PERF_SOLVER_FLOAT_COIN_SATS', Math.max(AMOUNT_SATS, ONCHAIN_AMOUNT_SATS))

/**
 * How long a client's Arkade lockup funding may keep retrying.
 *
 * A freshly-opened SDK wallet's view of its OWN coins lags: the fleet's
 * databases persist between runs, so a wallet re-opened moments after the last
 * run swept it can still report the swept coin as `available` and then refuse
 * the spend with "Insufficient funds" — seen once at twenty concurrent, on the
 * first wallet in the plan, which is the one with the least time to catch up.
 * Retrying rides out the sync instead of failing a swap for a reason belonging
 * to the harness. It stays inside `client_fund`, where it is honestly the
 * client's cost.
 */
const CLIENT_FUND_ATTEMPTS = count('PERF_CLIENT_FUND_ATTEMPTS', 20)

let arkade: E2eArkade
let fleet: Fleet
let ln: Awaited<ReturnType<typeof openSolverLightning>>
let onchain: OnchainSendBackend & { close?(): Promise<void> }
/** The solver's Arkade view, hoisted so a pipeline can watch the indexer directly. */
let arkadeOps: Awaited<ReturnType<typeof arkadeOpsFromContext>>
let sendService: SendSwapService
let receiveService: ReceiveSwapService
let onchainSendService: OnchainSendSwapService
let onchainReceiveService: OnchainReceiveSwapService
/** Pre-minted BOLT11s for the send corridor, keyed by the wallet that will use one. */
const sendInvoices = new Map<number, { invoice: string; paymentHash: string }>()
/** Every counterparty payment left running, stopped in `afterAll` so no fork is held open. */
const payers: CounterpartyPayment[] = []
/** Hold invoices this run minted, so a failed receive swap's HTLC is failed back rather than stranded. */
const mintedHolds = new Set<string>()

/**
 * A throwaway recipient for the client's sealed preimage packet.
 *
 * No covclaimd claims anything here — the CLIENT claims, as both receive
 * corridor e2e tests do and for the reason they document (covclaimd:v0.0.1-rc.1
 * accepts the reveal and then silently never claims this covenant). The packet
 * still has to be a real ECIES operation against a real point, so one is
 * generated and discarded.
 */
const nobody = (): string => hex.encode(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true))

/** An ephemeral raw key standing in for a client's own onchain wallet. */
const rawSigner = (privateKey: Uint8Array): OnchainSigner => ({
  sign: async (tx, inputIndexes) => {
    const clone = tx.clone()
    for (const index of inputIndexes ?? [0]) clone.signIdx(privateKey, index, [SigHash.DEFAULT])
    return clone
  },
})

/** Run `work` over `items`, at most `limit` at a time, never rejecting. */
const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      for (;;) {
        const index = next
        next += 1
        const item = items[index]
        if (item === undefined) return
        results[index] = await work(item, index)
      }
    }),
  )
  return results
}

/** Tick one swap until it reaches any state in `until` — the same `tick` the watch loop calls. */
const driveUntil = <R extends { state: string }>(
  service: { tick(id: string): Promise<R> },
  id: string,
  until: readonly string[],
  label: string,
): Promise<R> => {
  const wanted = new Set(until)
  return poll(
    async () => {
      const row = await service.tick(id)
      return wanted.has(row.state) ? row : null
    },
    {
      attempts: POLL_ATTEMPTS,
      intervalMs: POLL_MS,
      whenExhausted: `${label}: never reached one of [${until.join(', ')}]`,
    },
  )
}

/**
 * Assert a driven row landed in the state the corridor's happy path expects.
 *
 * Every `driveUntil` above includes the corridor's BAD terminal states in its
 * wait set on purpose — a swap that went `stuck` must end the pipeline with a
 * legible reason rather than spin until the attempt budget runs out and reports
 * a timeout for a swap that stopped moving minutes earlier.
 */
const expectState = <R extends { state: string; failureReason?: string | null }>(
  row: R,
  want: string,
  label: string,
): R => {
  if (row.state !== want)
    throw new Error(`${label}: state ${row.state}, wanted ${want}${row.failureReason ? ` (${row.failureReason})` : ''}`)
  return row
}

/** The client's own Arkade lockup funding, retried — see {@link CLIENT_FUND_ATTEMPTS}. */
const fundAsArkadeClient = (wallet: FleetWallet, address: string, amount: number, label: string): Promise<string> =>
  poll(() => wallet.ctx.wallet.send({ address, amount }), {
    attempts: CLIENT_FUND_ATTEMPTS,
    intervalMs: ONCHAIN_FUND_INTERVAL_MS,
    whenExhausted: `${label}: wallet ${wallet.index} could not fund the lockup with ${amount} sats`,
  })

/**
 * Wait until the client's Arkade lockup is visible AT THE INDEXER, before any
 * tick runs.
 *
 * The same split `sendLightning.e2e.test.ts`'s `awaitFunding` makes, and here
 * it is the difference between an honest number and a misleading one. Under
 * load the indexer takes seconds to surface a new VTXO, and a `solver_notice`
 * measured from the client's `send()` returning would bill all of that to the
 * solver. Measuring it separately means `solver_notice` starts from the instant
 * the money is actually THERE to be seen, which is the only thing the solver
 * could possibly have reacted to.
 */
const awaitIndexerVisible = (pkScript: string, expected: number, label: string): Promise<unknown> =>
  poll(
    async () => {
      const outputs = await arkadeOps.findLockups(pkScript)
      return outputs.reduce((sum, output) => sum + output.value, 0) === expected ? outputs : null
    },
    {
      attempts: POLL_ATTEMPTS,
      intervalMs: POLL_MS,
      whenExhausted: `${label}: ${expected} sats never appeared at ${pkScript} — the funding did not reach the indexer`,
    },
  )

/**
 * Wait until the counterparty's HTLC is genuinely held on the solver's node.
 *
 * Split out of `solver_arm_and_fund` for {@link awaitIndexerVisible}'s reason,
 * and it matters more here: the payer is `docker exec lncli payinvoice`, and
 * forty of those at once spend most of their time in process startup and route
 * finding. Rolling that into the solver's number would report docker's cost as
 * the corridor's. Read through the SHIPPED adapter over gRPC rather than
 * another `docker exec`, so the observation itself does not add to the queue it
 * is measuring.
 */
const awaitHtlcHeld = (paymentHash: string, label: string): Promise<unknown> =>
  poll(
    async () => {
      const state = await ln.getHoldState(paymentHash)
      return state.status === 'armed' ? state : null
    },
    {
      attempts: POLL_ATTEMPTS,
      intervalMs: POLL_MS,
      whenExhausted: `${label}: no HTLC was ever held — the counterparty's payment never arrived`,
    },
  )

/**
 * The client's L1 HTLC funding, retried until the shared LND wallet has a
 * confirmed input to spend. See {@link ONCHAIN_FUND_ATTEMPTS} for the whole
 * story; the short version is that a hundred clients sharing one two-UTXO
 * wallet is the harness's problem, not the solver's.
 */
const fundAsOnchainClient = (address: string, amountSats: number, label: string): Promise<{ txid: string }> =>
  poll(() => onchain.fund({ address, amountSats, idempotencyKey: `perf-${address}` }), {
    attempts: ONCHAIN_FUND_ATTEMPTS,
    intervalMs: ONCHAIN_FUND_INTERVAL_MS,
    whenExhausted: `${label}: the shared LND wallet never had a confirmed UTXO to fund the client's HTLC with`,
  })

/**
 * Mine on an interval for as long as the returned handle is open.
 *
 * Only started when an onchain corridor has swaps in the plan: nothing else in
 * this file needs a block, and a run that does not need blocks should not be
 * adding them to a stack it shares. BOTH onchain corridors need it, for two
 * different reasons — `onchain:BTC->arkade:BTC` waits out `min_confirmations`,
 * and both of them need the shared LND wallet's change to confirm before the
 * next funding can select an input.
 *
 * Overlapping calls are suppressed rather than queued — `regtest.mjs mine`
 * shells out to a container and can occasionally take longer than the interval,
 * and stacking those would turn a hiccup into an unbounded pile of child
 * processes.
 */
const startMiner = (intervalMs: number): { stop(): void } => {
  let running = false
  let stopped = false
  const timer = setInterval(() => {
    if (running || stopped) return
    running = true
    void mineBlocks(1)
      .catch(() => undefined)
      .finally(() => {
        running = false
      })
  }, intervalMs)
  // Never hold vitest's fork open on the miner's account.
  timer.unref?.()
  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}

// -- the four pipelines --

/**
 * `arkade:BTC->lightning:BTC`. The client locks Arkade sats; the solver pays a
 * real invoice on the counterparty node, learns `P` by paying, and claims.
 *
 * The invoice is PRE-MINTED in `beforeAll` rather than here. Minting it is a
 * `docker exec lncli` — the client's business, not the solver's — and doing a
 * hundred of those inside the measured window would report docker's process
 * startup cost as swap latency.
 */
const runLightningSend = async (wallet: FleetWallet): Promise<SwapTiming> => {
  const timeline = new Timeline('arkade:BTC->lightning:BTC', wallet.index)
  try {
    const minted = sendInvoices.get(wallet.index)
    if (!minted) throw new Error(`no pre-minted invoice for wallet ${wallet.index}`)

    const outcome = await timeline.phase('quote', () =>
      sendService.quote(minted.invoice, wallet.address, { clientRefundPubkey: CLIENT_REFUND_PUBKEY }),
    )
    if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
    const swap = outcome.swap

    // THE CLIENT RULE, kept even here: derive the covenant locally and fund only
    // a match. A load test that skipped it would be the one place in the repo
    // where a wrong lockup address goes unnoticed.
    const serverKey = wallet.ctx.wallet.arkServerPublicKey
    const receiverPkScript = swap.receiverPkScript
    if (receiverPkScript === null) throw new Error(`swap ${swap.id} carries no receiver pkScript to derive against`)
    const derived = new CovenantSwapScript({
      receiver: hex.decode(swap.receiverPubkey),
      server: serverKey,
      preimageHash: scriptHashFromPaymentHash(decodeInvoice(minted.invoice).paymentHash),
      refundLocktime: swap.refundLocktime,
      claimDelay: wallet.ctx.unilateralDelays.unilateralClaimDelay,
      client: hex.decode(CLIENT_REFUND_PUBKEY),
      // Off the stack and the quote, not constants: the service derives these
      // from `arkade.delays` and its own receiving pkScript, and a hardcoded
      // pair only matches while the stack is configured the way they were
      // written. @see test/e2e/sendLightning.e2e.test.ts for the same rule.
      clientRefundDelay: wallet.ctx.unilateralDelays.unilateralRefundWithoutReceiverDelay,
      refundWithoutServerDelay: wallet.ctx.unilateralDelays.unilateralRefundDelay,
      nonInteractiveParameters: {
        emulatorPubkey: hex.decode(arkade.emulator.pubkey),
        receiverPkScript: hex.decode(receiverPkScript),
        senderPkScript: ArkAddress.decode(wallet.address).pkScript,
        // Read off the row, not hardcoded — see sendLightning.e2e.test.ts's
        // clientDerivedAddress for why: this is the same rule, missed here
        // once already because it derives independently of that file's helper.
        ...(swap.nonInteractiveParameters ? {} : { legacy: 'preTimelockedRefund' as const }),
      },
    })
    if (derived.address(wallet.ctx.hrp, serverKey).encode() !== swap.lockupAddress) {
      throw new Error('client derivation does not reproduce the solver lockup address')
    }

    const label = `ln-send ${swap.id}`
    await timeline.phase('client_fund', () => fundAsArkadeClient(wallet, swap.lockupAddress, swap.amountSats, label))
    await timeline.phase('indexer_visible', () => awaitIndexerVisible(swap.pkScript, swap.amountSats, label))

    // ONE phase, not four. `tick` is a run-to-completion loop, so the single
    // call that adopts the lockup also pays the invoice and claims — measured,
    // `quoted -> funded`, `funded -> paid` and `paid -> claimed` all land inside
    // it, and splitting them reported the first at 4.6s and the other two at
    // 0ms. Sub-phases the code cannot expose to an outside observer are not
    // worth printing.
    const claimed = await timeline.phase('solver_deliver', () =>
      driveUntil(sendService, swap.id, ['claimed', 'refused', 'stuck'], label),
    )
    expectState(claimed, 'claimed', label)
    if (!claimed.claimArkTxid) throw new Error(`${label}: claimed with no Arkade claim txid`)
    return timeline.succeeded()
  } catch (error) {
    return timeline.failed(error)
  }
}

/**
 * `lightning:BTC->arkade:BTC`. The solver mints a hold invoice, the counterparty
 * node pays it for real, the solver funds its OWN Arkade lockup, the client
 * claims it, and the solver settles the hold with the `P` it read off that claim.
 *
 * `quote` here is the one phase in this file that carries an external side
 * effect: `ReceiveSwapService.quote` mints the hold invoice on LND before it
 * returns. That is genuinely inside the quote, so it is genuinely inside the
 * measurement.
 */
const runLightningReceive = async (wallet: FleetWallet): Promise<SwapTiming> => {
  const timeline = new Timeline('lightning:BTC->arkade:BTC', wallet.index)
  try {
    const sealed = newSealedPreimage(nobody())
    const outcome = await timeline.phase('quote', () =>
      receiveService.quote({
        paymentHash: sealed.paymentHash,
        amountSats: AMOUNT_SATS,
        payoutAddress: wallet.address,
        payoutPubkey: wallet.pubkey,
        claimPacket: sealed.packet,
      }),
    )
    if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
    const swap = outcome.swap
    mintedHolds.add(sealed.paymentHash)
    const label = `ln-receive ${swap.id}`

    // Not awaited: `payinvoice` blocks for as long as the HTLC is held, which is
    // the whole rest of this swap.
    payers.push(payFromCounterparty(swap.invoice))

    await timeline.phase('htlc_arrives', () => awaitHtlcHeld(sealed.paymentHash, label))
    // `quoted -> armed -> funded` in ONE phase, because one `tick` does all of
    // it: `whenArmed` re-reads the hold, funds the solver's own Arkade lockup,
    // and waits for that output at the indexer before it returns. THIS IS THE
    // CORRIDOR'S DOMINANT COST and the lockup funding is nearly all of it — see
    // `splitSolverFloat` for the measurement showing one Arkade wallet issues
    // about a third of a send per second however its coins are arranged.
    const funded = await timeline.phase('solver_arm_and_fund', () =>
      driveUntil(receiveService, swap.id, ['funded', 'claimed', 'settled', 'refused', 'stuck'], label),
    )
    expectState(funded, 'funded', label)

    await timeline.phase('client_claim', () =>
      clientClaimLockup(
        wallet.ctx,
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
      ),
    )

    // Reading `P` off the client's claim witness and settling the held HTLC
    // with it, in one phase for the same reason: one tick does both.
    const settled = await timeline.phase('solver_settle', () =>
      driveUntil(receiveService, swap.id, ['settled', 'refunded', 'refused', 'stuck'], label),
    )
    expectState(settled, 'settled', label)
    // The proof no fake can make: the preimage the solver recovered from a real
    // Arkade claim witness is the one the client never disclosed.
    if (settled.preimage !== hex.encode(sealed.preimage)) {
      throw new Error(`${label}: solver settled with a preimage that is not the client's`)
    }
    mintedHolds.delete(sealed.paymentHash)
    return timeline.succeeded()
  } catch (error) {
    return timeline.failed(error)
  }
}

/**
 * `arkade:BTC->onchain:BTC`. The client locks Arkade sats, the solver funds a
 * real L1 HTLC, the client spends its claim leaf, and the solver reads `P` back
 * out of that witness to claim the Arkade side.
 */
const runOnchainSend = async (wallet: FleetWallet): Promise<SwapTiming> => {
  const timeline = new Timeline('arkade:BTC->onchain:BTC', wallet.index)
  try {
    const claimPriv = schnorr.utils.randomSecretKey()
    const claimPub = schnorr.getPublicKey(claimPriv)
    const clientRefundPub = schnorr.getPublicKey(schnorr.utils.randomSecretKey())
    const preimage = randomBytes(32)
    const paymentHash = hex.encode(sha256(preimage))

    const outcome = await timeline.phase('quote', () =>
      onchainSendService.quote({
        paymentHash,
        amountSats: ONCHAIN_AMOUNT_SATS,
        payoutPubkey: hex.encode(claimPub),
        refundAddress: wallet.address,
        clientRefundPubkey: hex.encode(clientRefundPub),
      }),
    )
    if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
    const swap = outcome.swap
    const label = `onchain-send ${swap.id}`

    const localHtlc = buildOnchainHtlc({
      network: ONCHAIN_NETWORKS[arkade.network],
      paymentHash,
      claimPubkey: claimPub,
      refundPubkey: hex.decode(swap.htlcPubkey),
      refundLocktime: swap.htlcLocktime,
    })
    if (localHtlc.address !== swap.onchainAddress) {
      throw new Error(`${label}: client derivation does not reproduce the solver HTLC address`)
    }

    await timeline.phase('client_fund', () => fundAsArkadeClient(wallet, swap.lockupAddress, swap.amountSats, label))
    await timeline.phase('indexer_visible', () => awaitIndexerVisible(swap.pkScript, swap.amountSats, label))

    const funded = await timeline.phase('solver_fund_htlc', () =>
      driveUntil(onchainSendService, swap.id, ['awaiting_claim', 'claimed', 'refunded', 'refused', 'stuck'], label),
    )
    expectState(funded, 'awaiting_claim', label)
    if (!funded.fundingTxid || funded.fundingVout === null) throw new Error(`${label}: no HTLC funding recorded`)

    await timeline.phase('client_claim', async () => {
      const feeRate = await onchain.estimateFeeRate()
      const destinationScript = p2tr(claimPub, undefined, ONCHAIN_NETWORKS[arkade.network]).script
      const sizing = {
        htlc: localHtlc,
        preimage,
        fundingTxid: funded.fundingTxid!,
        fundingVout: funded.fundingVout!,
        fundingValueSats: funded.payoutSats,
        destinationScript,
        payoutAmountSats: BigInt(funded.payoutSats),
      }
      const fee = BigInt(Math.ceil(estimateClaimTxVsize(sizing) * feeRate))
      const payoutAmountSats = BigInt(funded.payoutSats) - fee
      if (payoutAmountSats <= 0n) throw new Error(`${label}: the claim fee (${fee}) eats the payout`)
      const signed = await signOnchainClaimTx(
        buildOnchainClaimTx({ ...sizing, payoutAmountSats }),
        rawSigner(claimPriv),
        preimage,
      )
      return onchain.broadcastRaw(hex.encode(signed.extract()))
    })

    const claimed = await timeline.phase('solver_claim', () =>
      driveUntil(onchainSendService, swap.id, ['claimed', 'refunded', 'refused', 'stuck'], label),
    )
    expectState(claimed, 'claimed', label)
    if (claimed.preimage !== hex.encode(preimage)) {
      throw new Error(`${label}: the solver claimed with a preimage it did not read off the client's witness`)
    }
    return timeline.succeeded()
  } catch (error) {
    return timeline.failed(error)
  }
}

/**
 * `onchain:BTC->arkade:BTC`. The client funds a real L1 HTLC, the solver waits
 * out `min_confirmations`, funds an Arkade lockup out of its own float, the
 * client claims it, and the solver spends the L1 HTLC with the revealed `P`.
 *
 * The client's L1 funding comes out of the SOLVER's own LND wallet — the same
 * both-roles-one-process shortcut `receiveOnchain.e2e.test.ts` takes, and it
 * costs only fees since the solver's claim pays back into the same wallet.
 */
const runOnchainReceive = async (wallet: FleetWallet): Promise<SwapTiming> => {
  const timeline = new Timeline('onchain:BTC->arkade:BTC', wallet.index)
  try {
    const sealed = newSealedPreimage(nobody())
    const clientRefundPub = schnorr.getPublicKey(schnorr.utils.randomSecretKey())

    const outcome = await timeline.phase('quote', () =>
      onchainReceiveService.quote({
        paymentHash: sealed.paymentHash,
        amountSats: ONCHAIN_AMOUNT_SATS,
        claimPacket: sealed.packet,
        refundPubkey: hex.encode(clientRefundPub),
        payoutAddress: wallet.address,
        payoutPubkey: wallet.pubkey,
      }),
    )
    if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
    const swap = outcome.swap
    const label = `onchain-receive ${swap.id}`

    const localHtlc = buildOnchainHtlc({
      network: ONCHAIN_NETWORKS[arkade.network],
      paymentHash: sealed.paymentHash,
      claimPubkey: hex.decode(swap.htlcPubkey),
      refundPubkey: clientRefundPub,
      refundLocktime: swap.htlcLocktime,
    })
    if (localHtlc.address !== swap.onchainAddress) {
      throw new Error(`${label}: client derivation does not reproduce the solver HTLC address`)
    }

    await timeline.phase('client_fund', () => fundAsOnchainClient(swap.onchainAddress, ONCHAIN_AMOUNT_SATS, label))

    await timeline.phase('solver_notice', () =>
      driveUntil(
        onchainReceiveService,
        swap.id,
        ['awaiting_confirmations', 'funding_arkade', 'awaiting_claim', 'claimed', 'settled', 'refused', 'stuck'],
        label,
      ),
    )
    // The block wait, alone in its own phase. `startMiner` is what makes it
    // finite; on the stack's own 600s cadence this corridor cannot finish
    // inside any budget a test would accept.
    const awaiting = await timeline.phase('chain_confirm_and_fund', () =>
      driveUntil(onchainReceiveService, swap.id, ['awaiting_claim', 'claimed', 'settled', 'refused', 'stuck'], label),
    )
    expectState(awaiting, 'awaiting_claim', label)

    await timeline.phase('client_claim', () =>
      clientClaimLockup(
        wallet.ctx,
        {
          payoutPubkey: awaiting.clientPayoutPubkey,
          payoutAddress: wallet.address,
          payoutPkScript: awaiting.clientPayoutPkScript,
          solverPubkey: awaiting.providerPubkey,
          solverRefundPkScript: awaiting.refundPkScript,
          serverPubkey: awaiting.serverPubkey,
          emulatorPubkey: awaiting.emulatorPubkey,
          paymentHash: awaiting.paymentHash,
          refundLocktime: awaiting.refundLocktime,
          claimDelay: awaiting.claimDelay,
          refundDelay: awaiting.refundDelay,
          refundWithoutReceiverDelay: awaiting.refundWithoutReceiverDelay,
          pkScript: awaiting.pkScript,
          nonInteractiveParameters: awaiting.nonInteractiveParameters ?? false,
        },
        sealed.preimage,
      ),
    )

    const settled = await timeline.phase('solver_settle', () =>
      driveUntil(onchainReceiveService, swap.id, ['settled', 'refunded', 'refused', 'stuck'], label),
    )
    expectState(settled, 'settled', label)
    if (!settled.onchainClaimTxid) throw new Error(`${label}: settled with no onchain claim txid`)
    return timeline.succeeded()
  } catch (error) {
    return timeline.failed(error)
  }
}

/**
 * A client refreshing its OWN Arkade funds through the solver: quote
 * `lightning:BTC->arkade:BTC`, quote `arkade:BTC->lightning:BTC` against the
 * bolt11 that came back, fund the send lockup, take the payout, claim it, and
 * let the solver collect on the claim witness.
 *
 * There is no `htlc_arrives` phase and no counterparty node anywhere on this
 * path, because no Lightning payment is possible — the solver would be paying
 * its own invoice. Two quotes and two Arkade lockups instead, which is a
 * genuinely different cost shape from every other corridor and the reason this
 * reports separately rather than folding into the Lightning numbers.
 */
const runSelfPayment = async (wallet: FleetWallet): Promise<SwapTiming> => {
  const timeline = new Timeline('self-payment', wallet.index)
  try {
    const sealed = newSealedPreimage(nobody())
    const receiveQuote = await timeline.phase('quote_receive', () =>
      receiveService.quote({
        paymentHash: sealed.paymentHash,
        amountSats: AMOUNT_SATS,
        payoutAddress: wallet.address,
        payoutPubkey: wallet.pubkey,
        claimPacket: sealed.packet,
      }),
    )
    if (!receiveQuote.accepted) throw new Error(`solver refused the receive quote: ${receiveQuote.reason}`)
    const receiveRow = receiveQuote.swap
    // Registered for teardown even though the coupling cancels it below: a run
    // that dies between the two quotes still leaves a live hold behind.
    mintedHolds.add(sealed.paymentHash)
    const label = `self-payment ${receiveRow.id}`

    // The quote that used to be refused `quote_conflict`. Timed on its own
    // because the coupling check is extra admission work no other corridor does.
    const sendQuote = await timeline.phase('quote_send_coupled', () =>
      sendService.quote(receiveRow.invoice, wallet.address, { clientRefundPubkey: CLIENT_REFUND_PUBKEY }),
    )
    if (!sendQuote.accepted) throw new Error(`${label}: coupled send quote refused: ${sendQuote.reason}`)
    const sendRow = sendQuote.swap

    await timeline.phase('client_fund', () =>
      wallet.ctx.wallet.send({ address: sendRow.lockupAddress, amount: sendRow.amountSats }),
    )
    const sendFunded = await timeline.phase('solver_see_lockup', () =>
      driveUntil(sendService, sendRow.id, ['funded', 'claiming', 'claimed', 'refused', 'stuck'], label),
    )
    expectState(sendFunded, 'funded', label)

    // The ordering the design turns on: the payout goes out only after their
    // lockup is confirmed, so this phase can never start before the one above.
    const paidOut = await timeline.phase('solver_pay_out', () =>
      driveUntil(receiveService, receiveRow.id, ['funded', 'claimed', 'settled', 'refused', 'stuck'], label),
    )
    expectState(paidOut, 'funded', label)

    await timeline.phase('client_claim', () =>
      clientClaimLockup(
        wallet.ctx,
        {
          payoutPubkey: paidOut.payoutPubkey,
          payoutAddress: paidOut.payoutAddress,
          payoutPkScript: paidOut.payoutPkScript,
          solverPubkey: paidOut.solverPubkey,
          solverRefundPkScript: paidOut.solverRefundPkScript,
          serverPubkey: paidOut.serverPubkey,
          emulatorPubkey: paidOut.emulatorPubkey,
          paymentHash: paidOut.paymentHash,
          refundLocktime: paidOut.refundLocktime,
          claimDelay: paidOut.claimDelay,
          refundDelay: paidOut.refundDelay,
          refundWithoutReceiverDelay: paidOut.refundWithoutReceiverDelay,
          pkScript: paidOut.pkScript,
          nonInteractiveParameters: paidOut.nonInteractiveParameters ?? false,
        },
        sealed.preimage,
      ),
    )

    // The send leg reading `P` off that Arkade witness — the only place in the
    // benchmark where a preimage travels by covenant rather than by payment.
    const collected = await timeline.phase('solver_collect', () =>
      driveUntil(sendService, sendRow.id, ['claimed', 'refused', 'stuck'], label),
    )
    expectState(collected, 'claimed', label)
    if (collected.preimage !== hex.encode(sealed.preimage)) {
      throw new Error(`${label}: solver collected with a preimage that is not the client's`)
    }

    // And the receive row finishing. Nothing is settled over Lightning here —
    // the invoice was cancelled at coupling — so this is bookkeeping, and it
    // is timed because a row that never reaches it is a stuck row in disguise.
    const settled = await timeline.phase('solver_finish', () =>
      driveUntil(receiveService, receiveRow.id, ['settled', 'refunded', 'refused', 'stuck'], label),
    )
    expectState(settled, 'settled', label)
    return timeline.succeeded()
  } catch (error) {
    return timeline.failed(error)
  }
}

/** One unit of work in the plan: which corridor, which wallet. */
interface PlannedSwap {
  corridor: Corridor | 'self-payment'
  wallet: FleetWallet
}

/**
 * The launch order.
 *
 * Lightning sends and receives are INTERLEAVED so a paired send and receive go
 * out together — that adjacency is what makes the pair a pair, since the solver
 * only nets out if both legs are live at the same time. The onchain corridors
 * follow, so their much longer swaps are not the only thing left running while
 * the Lightning ones finish.
 */
const buildPlan = (wallets: readonly FleetWallet[]): PlannedSwap[] => {
  const at = (offset: number): FleetWallet => {
    const wallet = wallets[offset]
    if (!wallet) throw new Error(`the fleet has no wallet ${offset} — it holds ${wallets.length}`)
    return wallet
  }
  const plan: PlannedSwap[] = []
  const paired = Math.min(LN_SEND, LN_RECEIVE)
  for (let i = 0; i < paired; i += 1) {
    plan.push({ corridor: 'arkade:BTC->lightning:BTC', wallet: at(i) })
    plan.push({ corridor: 'lightning:BTC->arkade:BTC', wallet: at(LN_SEND + i) })
  }
  for (let i = paired; i < LN_SEND; i += 1) plan.push({ corridor: 'arkade:BTC->lightning:BTC', wallet: at(i) })
  for (let i = paired; i < LN_RECEIVE; i += 1)
    plan.push({ corridor: 'lightning:BTC->arkade:BTC', wallet: at(LN_SEND + i) })
  for (let i = 0; i < ONCHAIN_SEND; i += 1) {
    plan.push({ corridor: 'arkade:BTC->onchain:BTC', wallet: at(LN_SEND + LN_RECEIVE + i) })
  }
  for (let i = 0; i < ONCHAIN_RECEIVE; i += 1) {
    plan.push({ corridor: 'onchain:BTC->arkade:BTC', wallet: at(LN_SEND + LN_RECEIVE + ONCHAIN_SEND + i) })
  }
  for (let i = 0; i < SELF_PAYMENT; i += 1) {
    plan.push({
      corridor: 'self-payment',
      wallet: at(LN_SEND + LN_RECEIVE + ONCHAIN_SEND + ONCHAIN_RECEIVE + i),
    })
  }
  return plan
}

/**
 * Which wallets have to hold Arkade sats of their own.
 *
 * The two SEND corridors' clients, plus every self-payment client: a coupled
 * refresh funds its own send lockup exactly as an `arkade:BTC->lightning:BTC`
 * client does, so those wallets are topped up on the same Lightning-sized
 * budget. Missing them is not subtle — the swap dies at `client_fund` with
 * "Insufficient funds" — but it dies deep in the run rather than at setup.
 */
const sendSideFunding = (wallets: readonly FleetWallet[]): { lightning: FleetWallet[]; onchain: FleetWallet[] } => {
  const selfPaymentStart = LN_SEND + LN_RECEIVE + ONCHAIN_SEND + ONCHAIN_RECEIVE
  return {
    lightning: [...wallets.slice(0, LN_SEND), ...wallets.slice(selfPaymentStart, selfPaymentStart + SELF_PAYMENT)],
    onchain: wallets.slice(LN_SEND + LN_RECEIVE, LN_SEND + LN_RECEIVE + ONCHAIN_SEND),
  }
}

describe('perf — parallel swaps across all four corridors', () => {
  beforeAll(async () => {
    await requireStack('perf', ['arkd', 'emulator', 'esplora', 'lnd', 'ln-counterparty'])
    arkade = await openArkade()
    ln = await openSolverLightning()
    onchain = await openOnchainBackend()

    const dir = tempStoreDir()
    const store = await SwapStore.open(`${dir}/send.sqlite`)
    const onchainStore = await OnchainSendSwapStore.open(`${dir}/onchain-send.sqlite`)
    const receiveStore = await ReceiveSwapStore.open(`${dir}/receive.sqlite`)
    const onchainReceiveStore = await OnchainReceiveSwapStore.open(`${dir}/onchain-receive.sqlite`)

    arkadeOps = await arkadeOpsFromContext(arkade.ctx, arkade.emulator)
    const refundAddress = await onchain.newReceiveAddress()
    const refundScript = OutScript.encode(Address(ONCHAIN_NETWORKS[arkade.network]).decode(refundAddress))
    const signer: OnchainSigner = { sign: (tx, indexes) => arkade.ctx.identity.sign(tx, indexes) }

    // Wired exactly as `packages/solver-app/src/cli.ts` wires it, coupling included. The receive
    // store leaves `peerStores` and arrives as `coupling`; in both at once the
    // loop would re-refuse every coupling, and in neither the duplicate check
    // against it would silently vanish.
    sendService = new SendSwapService({
      store,
      ln,
      arkade: arkadeOps,
      limits: arkade.limits,
      invoicePrefix: arkade.profile.invoicePrefix,
      maxExposedSats: arkade.maxExposedSats,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      peerStores: [onchainStore, onchainReceiveStore],
      coupling: {
        receiveStore,
        findLockupOutpoints: (pkScript) => findLockupOutpoints(arkade.ctx, pkScript),
        findClaimPreimage: (outpoints, hash) => findClaimPreimage(arkade.ctx, outpoints, hash),
      },
    })
    onchainSendService = new OnchainSendSwapService({
      store: onchainStore,
      onchain,
      arkade: arkadeOps,
      limits: arkade.limits,
      network: arkade.network,
      maxExposedSats: arkade.maxExposedSats,
      totalCommitted: () => onchainStore.committedSats(),
      admission: new AdmissionControl(),
      signer,
      refundDestinationScript: refundScript,
      peerStores: [store, receiveStore, onchainReceiveStore],
    })
    receiveService = new ReceiveSwapService({
      acceptUnilateralGap: false,
      store: receiveStore,
      ln,
      arkade: await receiveArkadeOpsFromContext(arkade.ctx, arkade.emulator),
      covclaimd: null,
      limits: arkade.limits,
      maxExposedSats: arkade.maxExposedSats,
      totalCommitted: () => receiveStore.committedSats(),
      admission: new AdmissionControl(),
      peerStores: [onchainStore, onchainReceiveStore],
      coupledSendStore: store,
    })
    onchainReceiveService = new OnchainReceiveSwapService({
      store: onchainReceiveStore,
      onchain,
      arkade: await onchainReceiveArkadeOpsFromContext(arkade.ctx, arkade.emulator),
      covclaimd: null,
      limits: arkade.limits,
      network: arkade.network,
      maxExposedSats: arkade.maxExposedSats,
      totalCommitted: () => onchainReceiveStore.committedSats(),
      admission: new AdmissionControl(),
      signer,
      claimDestinationScript: refundScript,
      peerStores: [store, onchainStore, receiveStore],
    })

    fleet = await openFleet(arkade, TOTAL_SWAPS)
    const funding = sendSideFunding(fleet.wallets)

    // The solver's float has to cover BOTH halves at once: the fan-out to every
    // send-side client, and every receive lockup it will fund out of its own
    // pocket. Checked up front so a shortfall is one legible line here rather
    // than forty swaps failing at their funding step.
    // A self-payment appears TWICE here, and deliberately: once in
    // `funding.lightning` for the client's own lockup, and once below for the
    // payout the solver funds against it. Both are live at the same moment.
    const needed =
      funding.lightning.length * AMOUNT_SATS +
      funding.onchain.length * ONCHAIN_AMOUNT_SATS +
      LN_RECEIVE * AMOUNT_SATS +
      ONCHAIN_RECEIVE * ONCHAIN_AMOUNT_SATS +
      SELF_PAYMENT * AMOUNT_SATS
    await assertArkadeSpendable(arkade, Math.max(needed, FLOAT_COINS * FLOAT_COIN_SATS))

    if (FLOAT_COINS > 1) {
      const split = await splitSolverFloat(arkade, FLOAT_COINS, FLOAT_COIN_SATS)
      console.log(
        `[perf] solver float: ${split.before} -> ${split.after} coins of >=${FLOAT_COIN_SATS} sats in ${split.ms}ms`,
      )
    }

    const toppedLightning = await topUpFleet(arkade, funding.lightning, AMOUNT_SATS)
    const toppedOnchain = await topUpFleet(arkade, funding.onchain, ONCHAIN_AMOUNT_SATS)
    console.log(
      `[perf] fleet ${fleet.wallets.length} wallets; ` +
        `topped up ${toppedLightning.funded + toppedOnchain.funded} ` +
        `(${toppedLightning.satsSent + toppedOnchain.satsSent} sats, ` +
        `${toppedLightning.ms + toppedOnchain.ms}ms), ` +
        `${toppedLightning.skipped + toppedOnchain.skipped} already funded`,
    )

    // Pre-mint every send corridor's BOLT11 on the counterparty node. Bounded
    // concurrency because each one is a `docker exec` and a hundred at once is
    // a hundred processes for no gain.
    await mapWithConcurrency(funding.lightning, 8, async (wallet) => {
      sendInvoices.set(wallet.index, await counterpartyInvoice(AMOUNT_SATS))
    })
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    // Any hold this run minted and did not settle is a real HTLC hanging in the
    // channel until its CLTV expires — some eighty blocks out, which on this
    // stack's own miner is the better part of a day, for everyone sharing it.
    // Cancelling fails it back to the payer now.
    for (const paymentHash of mintedHolds) await cancelSolverHold(paymentHash).catch(() => undefined)
    for (const payer of payers) payer.stop()
    // Put the float back where it started, so the next run costs no funding.
    // See `reclaimFleet` for why a benchmark that skips this stops working
    // after a few runs.
    if (fleet && RECLAIM) {
      const swept = await reclaimFleet(arkade, fleet.wallets)
      console.log(
        `[perf] reclaimed ${swept.satsReturned} sats from ${swept.swept} wallets ` +
          `in ${swept.ms}ms (${swept.failed} could not be swept)`,
      )
    }
    await ln?.close()
    await onchain?.close?.()
    fleet?.close()
    arkade?.close()
  })

  it(
    'runs the whole mixed workload concurrently and reports per-corridor, per-phase latency',
    async () => {
      const plan = buildPlan(fleet.wallets)
      const miner = ONCHAIN_RECEIVE + ONCHAIN_SEND > 0 ? startMiner(MINE_INTERVAL_MS) : null

      const startedAt = performance.now()
      let timings: SwapTiming[]
      try {
        timings = await mapWithConcurrency(plan, CONCURRENCY, async (planned) => {
          switch (planned.corridor) {
            case 'arkade:BTC->lightning:BTC':
              return runLightningSend(planned.wallet)
            case 'lightning:BTC->arkade:BTC':
              return runLightningReceive(planned.wallet)
            case 'arkade:BTC->onchain:BTC':
              return runOnchainSend(planned.wallet)
            case 'onchain:BTC->arkade:BTC':
              return runOnchainReceive(planned.wallet)
            case 'self-payment':
              return runSelfPayment(planned.wallet)
          }
        })
      } finally {
        miner?.stop()
      }
      const wallClockMs = performance.now() - startedAt

      console.log(formatReport(timings, { concurrency: CONCURRENCY, wallClockMs }))
      console.log(
        `[perf] amounts: lightning ${AMOUNT_SATS} sats, onchain ${ONCHAIN_AMOUNT_SATS} sats; ` +
          `poll interval ${POLL_MS}ms (every solver_* figure carries up to that much quantisation)`,
      )

      // The only assertion, and it is about correctness rather than speed: under
      // this much simultaneous load every swap still has to reach its terminal
      // GOOD state. A run that got faster by failing is not a faster run.
      const failed = timings.filter((timing) => !timing.ok)
      expect(failed.map((timing) => `${timing.corridor} wallet ${timing.wallet}: ${timing.error}`)).toEqual([])
      expect(timings).toHaveLength(TOTAL_SWAPS)
    },
    RUN_TIMEOUT_MS,
  )
})
