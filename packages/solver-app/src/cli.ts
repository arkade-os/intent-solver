#!/usr/bin/env node
/**
 * The reproducibility surface: everything a swap does, drivable by hand.
 *
 * Each command goes through the SAME orchestrator the service runs — there is
 * exactly one implementation of the money path, and this is how it is exercised,
 * debugged and demonstrated. If a behaviour cannot be reproduced from here, it
 * does not exist.
 *
 *   quote <bolt11> <refund-address>   quote a swap, print the lockup address
 *   status <id>                       one swap's row
 *   timeline [id|txid|hash]           where one swap's wall-clock went, stage by stage (default: latest)
 *   list                              every non-terminal swap
 *   drive <id>                        tick one swap until it reaches a terminal state
 *   watch                             recover, then drive + refund-sweep forever
 *   serve                             HTTP host (bus-shaped payloads) + the watch loop
 *   relay                             outbound-only host: read swaps off a relay, no ports (RELAY_URL)
 *   send <bolt11>                     E2E self-test: quote, fund own derivation, drive
 *   send-onchain <sats>               E2E self-test for arkade:BTC->onchain:BTC: quote, fund,
 *                                     drive to awaiting_claim, claim the onchain HTLC, drive to claimed
 *   refund                            push covenant refunds for every eligible failed swap
 *   refund-now <id>                   push the covenant refund for ONE swap now, no deadline wait
 *   claim-now <id> [preimage]         the opposite of refund-now: for a `stuck` swap that DID pay,
 *                                     record P and return it to claiming (refunding would double-pay)
 *   park-swap <id> <reason>           stop driving a swap that cannot progress; the ONLY way out of a
 *                                     tick that throws forever. Does not refund or claim.
 *   onchain-refund-now <id>           the same, for an onchain-corridor swap — its ARKADE LOCKUP
 *                                     only; the only way a `stuck` one's lockup ever moves again
 *   reclaim-l1-htlc <id>              the OTHER leg of an onchain-corridor swap: re-broadcast the
 *                                     solver's OWN Bitcoin L1 HTLC refund, to the solver
 *   test-refund <sats>                fund a short-deadline covenant script, then refund it
 *   invoice <sats>                    issue a test invoice: forged locally on the fake backend, otherwise
 *                                     minted from the rail's own payee wallet where it has one
 *   card <name>                       this deployment's signed solver-registry corridor card, on stdout
 *   balances                          both wallet balances
 *
 * Secrets come only from the environment; errors are printed as messages, never
 * as whole objects, because config objects carry mnemonics.
 */

import { randomBytes } from 'node:crypto'
import { resolveDbLayout } from '@arkade-os/solver-corridors/db/layout.js'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ArkAddress } from '@arkade-os/sdk'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { Transaction, SigHash, p2tr } from '@scure/btc-signer'
import { loadConfig, swapDbPath, type Config } from './config.js'
import { SwapStore, type SendSwapRow } from '@arkade-os/solver-corridors/db/swaps.js'
import { type OnchainSendSwapRow } from '@arkade-os/solver-corridors/db/onchainSwaps.js'
import { findLockups, refundSwapScript } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { lazyContractSource } from '@arkade-os/solver-arkade/arkade/lazyContractSource.js'
import { LockupWatcher } from '@arkade-os/solver-arkade/arkade/lockupWatcher.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { lockupSource, runContractLifecycle } from '@arkade-os/solver-arkade/arkade/contractLifecycle.js'
import { scriptHashFromPaymentHash } from '@arkade-os/solver-core/core/preimage.js'
import { RFQ_PAIR_SEND } from '@arkade-os/solver-corridors/wire/payloads.js'
import { CORRIDORS } from '@arkade-os/solver-core/core/corridorPolicy.js'
import type { Corridor } from '@arkade-os/solver-core/core/corridor.js'
import {
  MAX_FINAL_CLTV_BLOCKS,
  maxServableExitDelay,
  minFinalCltvBlocksFor,
} from '@arkade-os/solver-core/core/receive.js'
import { MIN_CLAIM_WINDOW } from '@arkade-os/solver-core/core/send.js'
import { decodeInvoice } from '@arkade-os/solver-core/invoice/decode.js'
import { FakeLightningBackend } from '@arkade-os/solver-rails-fake/ln/fake/backend.js'
import { buildOnchainHtlc, ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'
import { SendSwapService } from '@arkade-os/solver-corridors/send/orchestrator.js'
import { OnchainSendSwapService } from '@arkade-os/solver-corridors/send/onchainOrchestrator.js'
import { AdminStore } from './admin/db.js'
import { applyOverrides } from './admin/settings.js'
import { GiveUp, json, log, nowSeconds, poll, sleep } from '@arkade-os/solver-core/util/poll.js'
import type { Services } from './ops/services.js'
import { refundNow, onchainRefundNow, reclaimL1Htlc } from './ops/refunds.js'
import { claimNow } from './ops/claims.js'
import { poolPlan, mintPool } from './ops/pool.js'
import { maybeMintPool, runFloatLifecycle } from './ops/float.js'
import { lightningRailFor, requireLn, requireOnchain } from './ops/rails.js'

/**
 * How often `relay` refreshes its liveness file. Six of these fit inside the
 * 60s staleness bound in the Dockerfile's HEALTHCHECK — a Dockerfile cannot
 * import a constant, so the two move together by hand or not at all.
 */
const RELAY_HEARTBEAT_MS = 10_000

/** Terminal states: nothing further will ever happen to these rows. */
const TERMINAL = new Set(['claimed', 'refused', 'stuck'])

/** A row as printed: everything the operator needs, never the preimage. */
const printable = (row: SendSwapRow): Record<string, unknown> => ({
  id: row.id,
  state: row.state,
  amountSats: row.amountSats,
  paymentHash: row.paymentHash,
  // The two fields a client is meant to TRUST from a quote; everything else it
  // derives itself and compares.
  providerPubkey: row.receiverPubkey,
  lockupAddress: row.lockupAddress,
  lockupValue: row.lockupValue,
  refundLocktime: row.refundLocktime,
  invoiceExpiresAt: row.invoiceExpiresAt,
  paymentId: row.paymentId,
  claimArkTxid: row.claimArkTxid,
  failureReason: row.failureReason,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

/**
 * `send_swap_event.at` is unix SECONDS, so a stamp is printed to the second and
 * never dressed up with a milliseconds field it does not have. Trimming `.000Z`
 * rather than formatting by hand keeps the value unambiguously UTC.
 */
const utc = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString().replace('.000Z', 'Z')

/**
 * The timetable's bar, scaled against the SLOWEST stage rather than the total.
 *
 * Against the total, a swap dominated by one stage draws every other one as a
 * blank and the eye learns only what it already knew. Against the slowest, the
 * second-worst stage is still legible — which is the comparison an operator
 * deciding what to fix actually makes. Anything that took measurable time gets
 * at least one block, so "under a second" never renders identically to "the
 * slowest stage in the swap".
 */
const bar = (deltaSeconds: number, slowestSeconds: number, width = 30): string => {
  if (deltaSeconds <= 0 || slowestSeconds <= 0) return ''
  return '#'.repeat(Math.max(1, Math.round((deltaSeconds / slowestSeconds) * width)))
}

import { createServices } from './ops/services.js'

/**
 * The watch loop's three cadences, fastest first.
 *
 * They differ because what each one waits on differs by orders of magnitude. A
 * preimage lands in well under a second, so `HOT_TICK_MS` paces the states where
 * the provider has already paid and is exposed until it claims. A client's
 * funding is a human action minutes wide, so the full sweep stays cheap. Refund
 * deadlines are hours away and mature against the chain tip rather than wall
 * clock, so sweeping them faster only produces rejected pushes.
 */
const HOT_TICK_MS = 250
const FULL_SWEEP_MS = 3000
const REFUND_SWEEP_MS = 60_000

/**
 * The solver's OWN coins, on their own much slower cadence.
 *
 * A fourth cadence rather than a share of the refund sweep's, because what it
 * waits on is slower again by two orders of magnitude: renewal acts on VTXOs
 * within days of expiry, and every pass costs a contract-snapshot sync against
 * the indexer. Minutes is already far tighter than the deadline needs, and
 * anything faster buys nothing but load. Missing a pass is harmless — the next
 * one sees the same coins, a little closer to expiry.
 */
const VTXO_LIFECYCLE_MS = 300_000

/** Recover, then drive every swap and sweep refunds until SIGINT/SIGTERM. */
const watchUntilStopped = async (services: Services): Promise<void> => {
  let running = true
  const stop = (): void => {
    running = false
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  log('recovering...')
  // Every registered corridor, not the two that used to be named here — a
  // corridor left out of recovery starts the process with its non-terminal rows
  // untouched until the first full sweep comes round.
  let recovered = 0
  for (const corridor of services.corridors) recovered += await corridor.tickAll()
  log(`recovered ${recovered} swap(s) across ${services.corridors.size} corridor(s); watching`)
  const served = CORRIDORS.filter((corridor) => services.config.corridorEnabled[corridor])
  log(`serving ${served.length === CORRIDORS.length ? 'all four corridors' : served.join(', ')}`)
  // The corridor is configured to run but cannot quote, and the reason is a
  // deployment fact no request will ever change — so say it once at boot rather
  // than leaving an operator to infer it from a stream of refusals. Says which
  // of the two exits is available, because they are different decisions: shorten
  // the delay (gate intact) or accept the window (gate dropped).
  if (
    services.config.corridorEnabled['lightning:BTC->arkade:BTC'] &&
    !services.config.lnReceiveAcceptUnilateralGap &&
    minFinalCltvBlocksFor(services.arkade.unilateralDelays.unilateralRefundWithoutReceiverDelay, false) >
      MAX_FINAL_CLTV_BLOCKS
  ) {
    const cliff = maxServableExitDelay()
    log(
      `lightning receive will refuse EVERY quote: this server's ${services.arkade.unilateralDelays.unilateralRefundWithoutReceiverDelay}s ` +
        `solo recourse needs more final CLTV than a payer will route. Serve it by lowering the exit delay to ` +
        `${cliff}s or less (ARK_UNILATERAL_EXIT_DELAY, if the server enforces less than it advertises), ` +
        `or by accepting the #69 window (LN_RECEIVE_ACCEPT_UNILATERAL_GAP=true)`,
    )
  }
  // Said out loud at every boot, not just recorded in the console. This is the
  // only setting here that accepts a LOSS, and an operator who inherits a
  // deployment should meet it in the log rather than by reading the unit file.
  // Only when it is ON: a line printed either way is a line nobody reads.
  if (services.config.lnReceiveAcceptUnilateralGap && services.config.corridorEnabled['lightning:BTC->arkade:BTC']) {
    log(
      `LN_RECEIVE_ACCEPT_UNILATERAL_GAP=true: funding lightning receive without a solo-recourse guarantee, ` +
        `up to ${services.policy.corridorLimits['lightning:BTC->arkade:BTC'].maxSats} sats per swap (#69)`,
    )
  }

  // Which swap a watched script belongs to, and how to drive it. Rebuilt from
  // the swap tables on every sweep, so it can never name a swap the sweep has
  // already retired.
  //
  // A thunk rather than an id because the four corridors have four services:
  // the script alone does not say which one owns it, and a map of id -> service
  // would be the same thing with a lookup in the way.
  let swapByScript = new Map<string, { id: string; tick: () => Promise<unknown> }>()
  // Lazily resolved and retried until it attaches, both for reasons the module
  // documents: obtaining the manager reconciles against the indexer, and the
  // money path does not wait on that. @see arkade/lazyContractSource.ts
  const contractEvents = lazyContractSource({
    getContractManager: () => services.arkade.wallet.getContractManager(),
    onError: (error, retryInMs) =>
      log(
        `lockup watcher: contract stream unavailable, retrying in ${retryInMs}ms:`,
        error instanceof Error ? error.message : String(error),
      ),
  })

  const watcher = new LockupWatcher({
    contracts: contractEvents,
    // An event is a nudge, never evidence: tick re-reads the lockup from the
    // indexer exactly as the sweep does, so a wrong or replayed script costs one
    // redundant tick and decides nothing.
    onScripts: (scripts) => {
      for (const script of scripts) {
        const watched = swapByScript.get(script)
        if (!watched) continue
        void watched.tick().catch((error) => {
          // The sweep retries this row regardless; losing the fast path is not
          // worth taking the watcher down.
          log(`lockup-triggered tick ${watched.id} failed:`, error instanceof Error ? error.message : String(error))
        })
      }
    },
    onError: (error) => log('lockup watcher:', error instanceof Error ? error.message : String(error)),
    // A lockup whose script is not a registered contract can never reach this
    // stream. The sweep registers what it adopts, on the same pass, and the
    // watcher only reports a script still uncovered on the read AFTER that —
    // so this line means a registration that failed or silently skipped the
    // row, not one still in flight. Those swaps fall back to the sweep, which
    // is correct but slower, and an operator should hear it rather than infer
    // it from a latency graph.
    onUnwatched: (scripts) =>
      log(`lockup watcher: ${scripts.length} lockup(s) are not registered contracts, sweep-only:`, scripts.join(', ')),
  })
  watcher.start()

  /**
   * Point the subscription at exactly the swaps still worth watching, across
   * ALL FOUR corridors.
   *
   * It watched only the Lightning-send store for a while, which left the other
   * three on the sweep alone — most obviously onchain send, which has the
   * identical shape (a client funding a covenant lockup at a pkScript) and was
   * already being registered as a contract two functions down.
   *
   * The two receive corridors are here on the same terms even though the event
   * they care about is the opposite one: the solver funds the lockup itself and
   * then waits for the CLIENT to claim it, so the useful signal is a spend
   * rather than an arrival. Whether the indexer reports both is its business,
   * not ours — an event only ever causes a re-read, so a corridor whose event
   * never fires is exactly as correct as it was before, just no faster.
   */
  const resyncWatchedScripts = async (): Promise<void> => {
    const next = new Map<string, { id: string; tick: () => Promise<unknown> }>()
    const watch = (rows: readonly { id: string; pkScript: string }[], tick: (id: string) => Promise<unknown>): void => {
      for (const row of rows) next.set(row.pkScript, { id: row.id, tick: () => tick(row.id) })
    }
    // One loop over the SERVING set, which is exactly the four `if (service)`
    // guards this replaced: a disabled corridor has no service, so it is not in
    // this registry and its rows are simply not watched. They stay readable —
    // the console and the status route read the wider READER set — and
    // re-enabling resumes them.
    for (const corridor of services.corridors) {
      watch(await corridor.findRecoverable(), (id) => corridor.tick(id))
    }
    // Read before `swapByScript` is replaced: the scripts this pass is the
    // first to see, which are exactly the ones not yet registered anywhere.
    const adopted = [...next.keys()].filter((script) => !swapByScript.has(script))
    swapByScript = next
    watcher.sync([...swapByScript.keys()])
    // Registration is what puts a lockup on the contract stream at all, and it
    // used to run only on the five-minute lifecycle cadence — so a swap quoted
    // just after one pass spent up to five minutes on the watched list without
    // being watchable, getting none of the fast path it had just been added to.
    // It runs here too now, the moment a script is adopted; the cadenced pass
    // stays the reconciliation that also retires what the sweep has dropped.
    //
    // Not awaited, for the reason the whole watcher is not awaited: this
    // reaches `getContractManager()`, and the money path does not wait on the
    // indexer to be reconciled. Nothing here is load-bearing — an unregistered
    // lockup is a slower swap, never a wrong one.
    if (adopted.length > 0) {
      void runLifecyclePass().catch((error) =>
        log('contract lifecycle pass failed:', error instanceof Error ? error.message : String(error)),
      )
    }
  }
  // Deliberately NOT awaited before the loop: the first sweep does it, one hot
  // tick in. Subscribing is a network call with no timeout, and the watcher is
  // explicitly best-effort — letting a wedged indexer delay the first tick of
  // the money path would give the fast path veto over the correct one.

  /**
   * Every contract this service registers, as one lifecycle.
   *
   * Registration is what puts a lockup inside the wallet's own view of its
   * coins: `getVtxos` and `getSpendableVtxos` both read the contract snapshot,
   * so an unregistered script is invisible to them. That buys the
   * `isGenericallySpendable: false` gate on `vhtlc-v2` (which keeps renewal
   * off live escrow), balance accounting that counts escrow separately, and a
   * recovery path for a lockup that gets swept -- and it is also what makes the
   * CLTV guard in `runVtxoLifecycle` necessary, since recovery reads ungated.
   *
   * A LIST because the corridors are not the end of it: an asset offer sits at
   * a foreign script that wants the same treatment, and adding it should be
   * adding a source rather than a second lifecycle. @see arkade/contractLifecycle.ts
   *
   * Built once, outside the loop: `lockupSource` closes over the four stores
   * and reads them afresh on every pass, so there is nothing per-pass to rebuild.
   */
  const contractSources = [
    lockupSource(
      // The READER set, never `services.corridors`: a corridor an operator
      // switched off keeps its funded lockups, and those still need registering.
      services.readers,
      services.arkade.hrp,
      services.arkade.wallet.arkServerPublicKey,
      (line) => log(line),
    ),
  ]

  /** A contract-lifecycle pass in flight, if any. @see runLifecyclePass */
  let lifecyclePass: Promise<void> | undefined

  /**
   * `runContractLifecycle`, never twice at once.
   *
   * Two callers now: the sweep, on every script it adopts, and the lifecycle
   * pass on `VTXO_LIFECYCLE_MS`. Sharing one pass between them is not a
   * correctness fix — registration is idempotent and retirement is planned
   * from repository state, so two overlapping passes would both finish
   * correctly. It is about what happens when one does NOT finish: a pass held
   * open by a wedged manager would otherwise have every later caller stack
   * another behind it, on a cadence, each waiting on the same wedged manager.
   *
   * The returned deadlines are deliberately dropped: `runFloatLifecycle`
   * derives its own through `lockupDeadlinesOf` (ops/float.ts) so the admin
   * action gets the same guard without depending on this pass having run.
   */
  const runLifecyclePass = (): Promise<void> => {
    if (lifecyclePass) return lifecyclePass
    lifecyclePass = (async () => {
      await runContractLifecycle({
        manager: await services.arkade.wallet.getContractManager(),
        sources: contractSources,
        now: () => Date.now(),
        retentionMs: services.config.contractRetentionMs,
        log: (line) => log(line),
      })
    })().finally(() => {
      lifecyclePass = undefined
    })
    return lifecyclePass
  }

  let lastFullSweep = 0
  let lastRefundSweep = 0
  let lastVtxoLifecycle = 0
  while (running) {
    await sleep(HOT_TICK_MS)
    // Money already in flight, checked on its own cadence: waiting for the full
    // sweep here rounds a sub-second Lightning payment up to that sweep's
    // interval, inside the window where the provider is exposed.
    await services.service?.tickHot()
    if (Date.now() - lastFullSweep >= FULL_SWEEP_MS) {
      lastFullSweep = Date.now()
      // Every registered corridor on one cadence. The onchain and receive legs
      // never had a hot-tick path of their own — HTLC confirmations are minutes
      // wide — so riding the full sweep costs nothing and needs no cadence of
      // its own, which is what the four hardcoded calls here already did.
      //
      // SEQUENTIAL is load-bearing, not incidental: the receive legs are the
      // funding side of the float that `runVtxoLifecycle` below renews, and
      // awaiting each in turn is what keeps the reservation ledger's job small.
      // @see arkade/reservations.ts — do not turn this into a Promise.all.
      //
      // The EVM legs ride this same loop: no hot tick (an EVM confirmation
      // depth is minutes wide, so a sub-second cadence would buy nothing but
      // RPC calls), and their rows are driven by the sweep alone.
      for (const corridor of services.corridors) await corridor.tickAll()
      // After the sweep, so a swap it just retired is dropped and one it just
      // adopted is watched from here on.
      await resyncWatchedScripts()
    }
    if (Date.now() - lastRefundSweep > REFUND_SWEEP_MS) {
      lastRefundSweep = Date.now()
      // Every corridor that HAS an unattended refund sweep, not the two that
      // happened to be named here. `refundSweep` is optional on `Corridor` —
      // absent means the corridor has no refund it can push on its own, which
      // is true of both receive legs — so this reproduces exactly what the two
      // hardcoded calls did, and additionally sweeps a corridor this build was
      // never compiled against. The EVM send corridor has one: a refused row's
      // lockup is returned via the non-interactive covenant refund.
      for (const corridor of services.corridors) {
        if (!corridor.refundSweep) continue
        for (const id of await corridor.refundSweep()) log('refunded', corridor.descriptor.pair, id)
      }
      // Settling a reclaimed deposit is recovery of money already safely back
      // in our own hands, so it must never cost a tick of the money path:
      // caught here, unlike the sweeps above, because this one adds a network
      // call whose failure would otherwise end the watch loop entirely. The
      // next sweep re-lists whatever this pass missed.
      try {
        for (const settlement of (await services.onchainService?.settleRefundDeposits()) ?? []) {
          const deposit = `${settlement.txid}:${settlement.vout}`
          if (settlement.settled) log('onchain refund deposit settled', deposit, settlement.reference)
          else log('onchain refund deposit still unsettled', deposit, settlement.reason)
        }
      } catch (error) {
        log('onchain refund deposit sweep failed:', error instanceof Error ? error.message : String(error))
      }
    }
    if (Date.now() - lastVtxoLifecycle > VTXO_LIFECYCLE_MS) {
      lastVtxoLifecycle = Date.now()
      // Wrapped for the same reason as the deposit sweep above, and more so:
      // this is the only entry in the loop that is not about a specific swap,
      // so nothing downstream isolates its failures the way `onTickError`
      // isolates a tick's. A wallet-level settlement failing must not end the
      // watch loop and take every swap down with it.
      try {
        // The SAME pass the `float-lifecycle` admin action runs. @see ops/float.ts
        //
        // Registration stays here and stays first: it is what makes a lockup's
        // vtxos visible to the contract snapshot at all, and it is the daemon's
        // job rather than an operator-triggerable one. Retirement is the half
        // that only exists here.
        await runLifecyclePass()
        const report = await runFloatLifecycle(services)
        // Shape, after lifecycle and only ever after it: minting spends the
        // float, and spending coins that were about to expire — or are sitting
        // in `recoverable` and cannot be spent at all — is the wrong order. A
        // pass that recovered first has something to split.
        //
        // Opt-in. @see Config.poolAutoMint
        try {
          const mint = await maybeMintPool(services, {
            enabled: services.config.poolAutoMint,
            // No `force`: the concurrent-provider guard exists for exactly the
            // caller that has no human to weigh it.
            mint: (s) => mintPool(s),
          })
          if (mint.minted) log('pool auto-minted', JSON.stringify(mint.result))
          else if (mint.skipped !== 'disabled') log('pool auto-mint skipped:', mint.skipped)
        } catch (error) {
          // Same isolation as the pass above: a failed split must not end the
          // watch loop. The next cadence sees the same float.
          log('pool auto-mint failed:', error instanceof Error ? error.message : String(error))
        }
        if (report.migrated) log('vtxos migrated off deprecated signers', report.migrated)
        if (report.renewed) log('vtxos renewed', report.renewed)
        if (report.resplit) log('float re-split after renewal', report.resplit)
        if (report.recovered) log('vtxos recovered', report.recovered)
        if (report.recoverySkipped) log('vtxo recovery skipped:', report.recoverySkipped)
        for (const failure of report.failures) log('vtxo lifecycle:', failure)
      } catch (error) {
        log('vtxo lifecycle failed:', error instanceof Error ? error.message : String(error))
      }
    }
  }
  await watcher.stop()
}

/** Tick one swap until it lands in a terminal state. */
const driveToTerminal = async (service: SendSwapService, id: string, attempts = 120): Promise<SendSwapRow> =>
  poll(
    async () => {
      const row = await service.tick(id)
      log('state:', row.state)
      if (TERMINAL.has(row.state)) return row
      return null
    },
    { attempts, intervalMs: 2000, whenExhausted: `swap ${id} did not reach a terminal state` },
  )

/** Onchain terminal states: nothing further will ever happen to these rows. */
const ONCHAIN_TERMINAL = new Set(['claimed', 'refused', 'stuck'])

/** Tick one onchain swap until it reaches any state in `until` (terminal or an intermediate wait point). */
const driveOnchainUntil = async (
  service: OnchainSendSwapService,
  id: string,
  until: ReadonlySet<string>,
  attempts = 120,
): Promise<OnchainSendSwapRow> =>
  poll(
    async () => {
      const row = await service.tick(id)
      log('onchain state:', row.state)
      if (until.has(row.state)) return row
      return null
    },
    { attempts, intervalMs: 2000, whenExhausted: `onchain swap ${id} did not reach one of [${[...until].join(', ')}]` },
  )

/**
 * The pool plan for the float as it stands.
 *
 * Shared by `balances`, which reports it, and `pool`, which can act on it, so
 * the two can never disagree about what the target is or how it was measured.
 *
 * `maxCount` and `maxOutputs` bound one transaction's shape rather than a
 * deployment's policy, which is why they are constants here and not config: an
 * operator who wants a differently-shaped pool changes the exposure cap, and
 * `poolTarget` derives the whole target from that.
 */
// The pool plan and the committed-sats total now live in src/ops/pool.ts, so
// the admin console drives the same spend gate this command does.

/**
 * Options every `serve()` in this process must pass, and why.
 *
 * By default `@hono/node-server` replaces `globalThis.Request` and
 * `globalThis.Response` with its own lightweight classes the moment a listener
 * is created — `getRequestListener` does it unconditionally unless this flag is
 * `false`. It is a real performance win for a server that only ever handles its
 * own requests. This process is not that: it also runs an HTTP CLIENT whose
 * correctness depends on the identity of those classes.
 *
 * A backend SDK compiled from Rust to WebAssembly is the case that made this
 * mandatory: its glue tests every fetch result with a bare
 * `arg0 instanceof Response`, resolved from the global scope at CALL time. So
 * once the console binds, a genuine undici `Response` is measured against
 * Hono's replacement class and answers false. reqwest's `promise::<T>()` then
 * fails its cast and reports `promise resolved to unexpected type`, which the
 * SDK wraps until it reaches the log as
 * `service provider error: authentication error: network error` — naming the
 * first call in flight rather than the fault, and sending every Lightning quote
 * back as `pricing_unavailable`.
 *
 * Mainnet, 2026-08-21: the console bound at 12:07:49.518 and the first backend
 * error landed 2.8s later. It read as an outage at the service provider for
 * most of a day. An out-of-process probe passed throughout — correctly, and
 * misleadingly — because a probe process starts no console and so never has its
 * globals replaced.
 *
 * Named once and shared rather than written at each call site: a second server
 * added later without this flag reintroduces the fault, and the failure it
 * produces names neither Hono nor the server that was started.
 */
const HONO_SERVE_OPTIONS = { overrideGlobalObjects: false } as const

/**
 * Bring up the admin console alongside a long-lived mode, if configured.
 *
 * Returns a closer, or null when ADMIN_PORT is unset — the opt-in lives in
 * `loadConfig`, so a deployment that sets nothing gets no new socket here.
 *
 * Shared by `serve`, `relay` and `watch` so the console cannot be available in
 * one mode and mysteriously absent in another. `relay` is the one that matters
 * most: it is the container default and otherwise has no listening port at
 * all, so this is the only way to see inside a production solver.
 *
 * It is handed the SAME `services` the money-mover is using. That is the whole
 * reason the console lives in-process: Arkade coin reservations are
 * process-local (`src/arkade/reservations.ts`), so an action that spends has
 * to run where those reservations are held.
 */
const startAdminServer = async (
  services: Services,
  config: Config,
  mode: 'serve' | 'relay' | 'watch',
  /**
   * `relay` mode only. Without it the console cannot answer "am I reachable",
   * which is the one thing a port-less solver cannot otherwise be asked — see
   * `RelayConnection.isConnected`'s own docstring.
   */
  extras?: { relay?: { url: string; isConnected(): boolean } },
): Promise<{ close(): void } | null> => {
  if (config.adminPort === null) return null
  const { buildAdminApp } = await import('./admin/server.js')
  const { createChangeFeed } = await import('./admin/events.js')
  const { serve } = await import('@hono/node-server')
  // Polls and diffs the stores; nothing in the orchestrators is instrumented
  // for it, which is what keeps the console a strict reader of the money layer.
  const changes = createChangeFeed(services, {
    onError: (error) => log('admin change feed:', error instanceof Error ? error.message : String(error)),
  })
  changes.start()
  const app = buildAdminApp({ services, startedAt: nowSeconds(), mode, relay: extras?.relay, changes })
  const server = serve({ fetch: app.fetch, port: config.adminPort, hostname: config.adminHost, ...HONO_SERVE_OPTIONS })
  log(`admin console on ${config.adminHost}:${config.adminPort}`)
  return {
    close: () => {
      changes.stop()
      try {
        server.close()
      } catch (error) {
        log('admin server.close() failed:', error instanceof Error ? error.message : String(error))
      }
    },
  }
}

/**
 * The corridor whose store holds `id`, or null.
 *
 * Only for commands that take an id and NOT a corridor. The console never needs
 * this — every row it renders carries its own pair — and `actions.ts` refuses to
 * guess for exactly the reason this is safe here and not there: a swap id is
 * unique only within its own store, so a search is sound only because ids are
 * `randomUUID()` and no second store can answer for one.
 *
 * `detail` rather than `get`: it already answers null for an id a corridor does
 * not hold, where `get` throws.
 */
const corridorHolding = async (services: Services, id: string): Promise<Corridor | null> => {
  for (const corridor of services.corridors) {
    if (await corridor.detail(id)) return corridor
  }
  return null
}

const commands: Record<string, (args: string[]) => Promise<void>> = {
  async quote([invoice, refundAddress]) {
    if (!invoice || !refundAddress) throw new GiveUp('usage: quote <bolt11> <refund-address>')
    const config = loadConfig()
    const services = await createServices(config)
    try {
      if (!services.service)
        throw new GiveUp('the arkade:BTC->lightning:BTC corridor is disabled (LN_SEND_ENABLED=false)')
      // The RFQ family requires a client refund pubkey on every quote, so a
      // real client always gets the EXTENDED covenant. Generated fresh here and
      // discarded, exactly as the onchain self-test already does: without it
      // this command quoted the base three-leaf script, and a deployment check
      // that exercises a covenant shape no client ever receives is checking the
      // wrong thing. This self-test never spends the client-unilateral leaf —
      // that is the client's own out-of-band recourse — it only needs the key
      // for the script to be built the way production builds it.
      const clientRefundPub = schnorr.getPublicKey(schnorr.utils.randomSecretKey())
      const outcome = await services.service.quote(invoice, refundAddress, {
        clientRefundPubkey: hex.encode(clientRefundPub),
      })
      if (!outcome.accepted) {
        log('refused:', outcome.reason)
        process.exitCode = 2
        return
      }
      log(json({ ...printable(outcome.swap), lockupDeadline: outcome.lockupDeadline }))
      log('fund the lockup address, then run: drive', outcome.swap.id)
    } finally {
      await services.close()
    }
  },

  async status([id]) {
    if (!id) throw new GiveUp('usage: status <id>')
    const store = await SwapStore.open(swapDbPath())
    try {
      log(json(printable(await store.get(id))))
      log('history:', json(await store.history(id)))
    } finally {
      await store.close()
    }
  },

  /**
   * Where one swap's wall-clock actually went, stage by stage.
   *
   * The solver has recorded this all along — `send_swap_event` stamps a row per
   * transition — but there was no way to READ it, so "that felt slow" has never
   * been answerable with a number. This is a pure read: no service stack, no
   * network, safe to run against a live solver's database while it works.
   *
   * Takes whatever identifier the operator HAS, and with none, the most recent
   * swap — which is almost always the one they just watched. The swap id is ours
   * and appears in no UI; what a maker can see is the Arkade lockup txid on an
   * explorer, or the payment hash from their own invoice. A finished swap is
   * terminal, so `list` does not show it either.
   *
   * Stamps are unix SECONDS (`recordEvent`, src/db/swaps.ts), so every delta
   * carries up to a second of quantisation at each end and a stage printed as 0s
   * took UNDER a second rather than no time at all. That is said in the output
   * instead of being hidden behind a millisecond format the column cannot back.
   *
   * What this CANNOT show is stated in the footer rather than left for the
   * operator to assume: the table starts at `quoted`, and `funded` is stamped
   * when the solver first SAW the lockup, not when the client sent it.
   */
  async timeline([ref]) {
    const store = await SwapStore.open(swapDbPath())
    try {
      const row = ref
        ? ((await store.findByLockupTxid(ref)) ??
          (await store.findByPaymentHash(ref)) ??
          (await store.findByRfqId(ref)) ??
          (await store.get(ref).catch(() => null)))
        : await store.findMostRecent()
      if (!row) throw new GiveUp(ref ? `no swap found for ${ref}` : 'no swaps in this database')

      const events = await store.history(row.id)
      // Unreachable for any row this service wrote — insertQuote records
      // `quoted` in the same call — so it means a hand-inserted or partially
      // restored row, and inventing a timetable for one would be a lie.
      if (events.length === 0) throw new GiveUp(`swap ${row.id} has no recorded transitions`)

      // Each event closes the stage that led INTO it, so the delta belongs to
      // the arriving row and the first event (the quote itself) closes nothing.
      const stages = events.map((event, index) => {
        const previous = events[index - 1]
        return {
          label: `${event.from ?? '(new)'} -> ${event.to}`,
          at: event.at,
          delta: previous ? event.at - previous.at : null,
        }
      })
      const first = events[0]!
      const last = events[events.length - 1]!
      const total = last.at - first.at
      const slowest = stages.reduce<(typeof stages)[number] | null>(
        (worst, stage) => (stage.delta !== null && stage.delta > (worst?.delta ?? -1) ? stage : worst),
        null,
      )

      log(`swap ${row.id}  ${row.amountSats} sats  now: ${row.state}`)
      log(`lockup ${row.lockupTxid ?? '(unfunded)'}`)
      // The table itself goes to stdout unadorned, like `card` and `invoice`:
      // log()'s per-line timestamp prefix is exactly the wrong thing in front of
      // a column of timestamps.
      console.log('')
      console.log(`  ${'stage'.padEnd(22)}${'at (unix)'.padEnd(12)}${'utc'.padEnd(22)}${'delta'.padStart(7)}`)
      for (const stage of stages) {
        const delta = stage.delta === null ? '-' : `${stage.delta}s`
        const share = stage.delta === null || total <= 0 ? '' : ` ${Math.round((stage.delta / total) * 100)}%`
        const mark = stage === slowest && (stage.delta ?? 0) > 0 ? '  <-- SLOWEST' : ''
        const drawn = stage.delta === null || !slowest ? '' : bar(stage.delta, slowest.delta ?? 0)
        console.log(
          (
            `  ${stage.label.padEnd(22)}${String(stage.at).padEnd(12)}${utc(stage.at).padEnd(22)}${delta.padStart(7)}` +
            `  ${drawn}${share}${mark}`
          ).trimEnd(),
        )
      }
      console.log('')

      // A swap with one event has no elapsed stage at all, and "total 0s over 0
      // stage(s)" reads like a swap that took no time rather than one that has
      // not moved yet.
      if (stages.length === 1) log(`no transitions past ${first.to} yet — nothing to time`)
      else log(`total ${first.to} -> ${last.to}: ${total}s over ${stages.length - 1} stage(s)`)
      if (slowest?.delta) {
        log(`slowest: ${slowest.label} at ${slowest.delta}s — ${Math.round((slowest.delta / total) * 100)}% of it`)
      }
      // A swap still in flight has an open stage that is not in the table yet,
      // and it is usually the one being complained about.
      if (!TERMINAL.has(row.state)) log(`still ${row.state}: ${nowSeconds() - last.at}s and counting`)
      log('`at` is unix SECONDS: each delta is +/- 1s, and a stage shown as 0s took under a second')
      log(
        'NOT timed here: everything before `quoted` (discovery, RFQ negotiation), and the gap between the client ' +
          'funding the lockup and this solver noticing — `funded` is stamped when findLockups first SAW it',
      )
    } finally {
      await store.close()
    }
  },

  async list() {
    const store = await SwapStore.open(swapDbPath())
    try {
      for (const row of await store.findRecoverable()) log(json(printable(row)))
      log('(non-terminal swaps only; use status <id> for any specific swap)')
    } finally {
      await store.close()
    }
  },

  async drive([id]) {
    if (!id) throw new GiveUp('usage: drive <id>')
    const config = loadConfig()
    const services = await createServices(config)
    try {
      if (!services.service)
        throw new GiveUp('the arkade:BTC->lightning:BTC corridor is disabled (LN_SEND_ENABLED=false)')
      const row = await driveToTerminal(services.service, id)
      log('terminal:', json(printable(row)))
      if (row.state !== 'claimed') process.exitCode = 2
    } finally {
      await services.close()
    }
  },

  async watch() {
    const config = loadConfig()
    const services = await createServices(config)
    const admin = await startAdminServer(services, config, 'watch')
    try {
      await watchUntilStopped(services)
    } finally {
      admin?.close()
      await services.close()
    }
    log('stopped')
  },

  /**
   * HTTP host + the same watch loop, one process.
   *
   * The app itself is runtime-agnostic (Hono); this command is merely its Node
   * binding. On Cloudflare Workers the same `buildApp(...)` is the default
   * export and the watch loop moves to a scheduled/queue worker instead.
   */
  async serve() {
    const config = loadConfig()
    const services = await createServices(config)
    const { buildApp } = await import('@arkade-os/solver-transport/http/server.js')
    const { serve } = await import('@hono/node-server')
    const { getConnInfo } = await import('@hono/node-server/conninfo')
    // THE SET `createServices` ALREADY BUILT, not a second one derived here.
    //
    // This used to hand `buildApp` the flat services and stores and let it call
    // `corridorSetFromDeps` on them. That re-derivation was narrower than the
    // real registry in a way nobody could see from the call site: it passed no
    // `evmSendStore`, `evmReceiveStore` or `evmCorridors`, and the EVM family
    // registers only when its store AND its policy are present — so every EVM
    // corridor silently failed to register, and the pair a client asked for was
    // refused as `unsupported_pair` by a solver that was in fact sweeping those
    // very swaps. Two sets, one of them wrong.
    //
    // `services.corridors` is the one the sweep drives, so quoting and driving
    // can no longer disagree. It remains opt-in: a corridor is in it only if a
    // chain is configured and the operator enabled that token's policy.
    const app = buildApp({
      corridors: services.corridors,
      readers: services.readers,
      network: config.network,
      // The socket peer is the requester identity. Behind a reverse proxy this
      // becomes the proxy's address for everyone — deploy direct, or the quota
      // is shared by all clients (fail-closed, never spoofable).
      clientKey: (c) => getConnInfo(c).remote.address ?? 'unknown',
      onRefusal: (context, detail) => log(`${context}:`, detail),
    })
    const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host, ...HONO_SERVE_OPTIONS })
    log(`listening on ${config.host}:${config.port}`)
    const admin = await startAdminServer(services, config, 'serve')
    try {
      await watchUntilStopped(services)
    } finally {
      try {
        server.close()
      } catch (error) {
        log('server.close() failed:', error instanceof Error ? error.message : String(error))
      }
      admin?.close()
      await services.close()
    }
    log('stopped')
  },

  /**
   * Purely-outbound host: swap requests arrive over a relay connection this
   * process OPENS, and the money-mover runs alongside. No listening port — the
   * end-state architecture, where the solver only subscribes outward.
   *
   * Requires RELAY_URL. The relay's specific wire protocol is adapted at the
   * frame codec in src/relay/connection.ts.
   */
  async relay() {
    const config = loadConfig()
    if (!config.relayUrl) throw new GiveUp('RELAY_URL is not set')
    const services = await createServices(config)
    const { webSocketRelayConnection, isRelayFault } = await import('@arkade-os/solver-transport/relay/connection.js')
    const { RelayIngress, OpenRfqBidder } = await import('@arkade-os/solver-transport/ingress/relay.js')

    // The factory asserts the derived key IS the wallet identity — the pubkey
    // on the registry card, the one makers address — and refuses to start on
    // drift, which would otherwise fail silently forever.
    const codec =
      config.relayProtocol === 'nostr'
        ? (await import('@arkade-os/solver-transport/relay/nostr.js')).nostrCodecForWallet(
            config.arkade.mnemonic,
            config.arkade.isMainnet,
            services.providerPubkey,
          )
        : undefined
    const connection = webSocketRelayConnection(config.relayUrl, {
      onReconnect: (attempt) => log('relay reconnect attempt', attempt),
      // A relay refusing our events, or tearing down the subscription we
      // believe is live, is otherwise indistinguishable from a quiet market —
      // the solver sits there looking healthy and answers nobody. `accepted`
      // is every publish and says nothing, so only the bad news is logged.
      onNotice: (notice) => {
        if (!isRelayFault(notice)) return
        log(`relay ${notice.kind}${notice.ref ? ` (${notice.ref})` : ''}: ${notice.message ?? 'no reason given'}`)
      },
      codec,
    })
    const onError = (context: string, error: unknown): void =>
      log(`${context}:`, error instanceof Error ? error.message : String(error))
    // A refusal is an ANSWER, not a fault, so it never reaches `onError` — and
    // for a long time that meant a turned-away request left no trace at all.
    const onRefusal = (context: string, detail: string): void => log(`${context}:`, detail)
    // Only the ENABLED corridors reach the ingress; the rest refuse their pair
    // by name. The services still exist and the sweep still drives them, so
    // switching a corridor off stops new quotes without stranding a swap that
    // was already funded under the old setting.
    // The same registry the HTTP host and the sweep use — see `serve()` on why
    // re-deriving it here was silently dropping every EVM corridor.
    const ingress = new RelayIngress({
      connection,
      corridors: services.corridors,
      readers: services.readers,
      providerPubkey: services.providerPubkey,
      onError,
      onRefusal,
    })
    await ingress.start()
    log(
      `relay ingress open (outbound only, ${config.relayProtocol}) to`,
      config.relayUrl,
      'as',
      services.providerPubkey,
    )
    // Whether to bid at all is decided HERE, once: a zero rate means the
    // bidder simply does not exist. So does a disabled Lightning-send
    // corridor — the bidder only ever bids on that one pair, and a bid on a
    // corridor that then refuses the directed RFQ is worse than no bid.
    let bidder
    if (config.openRfqMaxBidsPerMinute > 0 && services.service) {
      bidder = new OpenRfqBidder({
        connection,
        providerPubkey: services.providerPubkey,
        pair: RFQ_PAIR_SEND,
        // The bidder serves exactly one pair, so it gets that corridor's own
        // range and fee — not the deployment-wide ones, which would have it
        // bidding on amounts the corridor will refuse to quote.
        limits: services.policy.corridorLimits['arkade:BTC->lightning:BTC'],
        fee: services.policy.corridorFees['arkade:BTC->lightning:BTC'],
        maxBidsPerMinute: config.openRfqMaxBidsPerMinute,
        onError,
      })
      await bidder.start()
      log('open-RFQ bidding on, capped at', config.openRfqMaxBidsPerMinute, 'bids/min')
    }

    // Liveness for a container with no port to probe: the file's mtime, touched
    // only while the relay socket is up, so a solver that is running but
    // disconnected goes stale and reports unhealthy. Why that distinction is the
    // one worth publishing is on `isConnected` in relay/connection.ts.
    //
    // Created once here rather than on the first beat, so every beat is a plain
    // touch and the ordinary startup path is not an exception. Empty on purpose:
    // the mtime is the signal, the content is not — which is also why this
    // touches instead of rewriting, one syscall against open+write+close on the
    // same event loop that serves the relay socket.
    //
    // NOTE: this reports socket connectivity, NOT reachability. A relay that
    // tears down our subscription with CLOSED leaves the socket up, so we go on
    // beating while receiving nothing. `onNotice` above logs that case; closing
    // the gap in the health signal means re-subscribing on CLOSED, which is a
    // behaviour change and not this commit's job.
    // Created up front so every beat is a plain touch, and guarded because this
    // must never be what stops a solver from starting: the directory is the
    // swap DB's by default but RELAY_HEALTH_PATH can point anywhere, and an
    // unwritable health file is a reporting problem, not a reason to refuse to
    // move money.
    let beating = true
    const giveUp = (error: unknown): void => {
      beating = false
      onError(`relay heartbeat (${config.relayHealthPath}; set RELAY_HEALTH_PATH) — health reporting off`, error)
    }
    try {
      mkdirSync(dirname(config.relayHealthPath), { recursive: true })
      writeFileSync(config.relayHealthPath, '')
    } catch (error) {
      giveUp(error)
    }
    const heartbeat = setInterval(() => {
      if (!beating || !connection.isConnected()) return
      const now = new Date()
      try {
        utimesSync(config.relayHealthPath, now, now)
      } catch (error) {
        // Stop rather than repeat every 10 s — a swap log is for swap traffic,
        // and this way the message is true instead of aspirational.
        clearInterval(heartbeat)
        giveUp(error)
      }
    }, RELAY_HEARTBEAT_MS)
    // Do not hold the event loop open on this alone.
    heartbeat.unref()

    // Last, so a failure to bind the console cannot stop the ingress coming
    // up: the money-mover is the point of this mode and the console is not.
    // The connection is handed over so the console can publish `isConnected()`
    // — a disconnected solver stays up, stays quiet and looks entirely healthy,
    // and this is the only surface that can say otherwise.
    const admin = await startAdminServer(services, config, 'relay', {
      relay: { url: config.relayUrl, isConnected: () => connection.isConnected() },
    })

    try {
      await watchUntilStopped(services)
    } finally {
      clearInterval(heartbeat)
      try {
        await bidder?.stop()
      } catch (error) {
        log('bidder.stop() failed:', error instanceof Error ? error.message : String(error))
      }
      try {
        await ingress.stop()
      } catch (error) {
        log('ingress.stop() failed:', error instanceof Error ? error.message : String(error))
      }
      admin?.close()
      await services.close()
    }
    log('stopped')
  },

  async send([invoice]) {
    if (!invoice) throw new GiveUp('usage: send <bolt11>')
    const config = loadConfig()
    const services = await createServices(config)
    try {
      if (!services.service)
        throw new GiveUp('the arkade:BTC->lightning:BTC corridor is disabled (LN_SEND_ENABLED=false)')
      // The self-test plays the client, so its refund destination is our own
      // wallet — exactly what a real client would pass as theirs.
      const refundAddress = await services.arkade.wallet.getAddress()
      // The RFQ family requires a client refund pubkey on every quote, so a
      // real client always gets the EXTENDED covenant. Generated fresh here and
      // discarded, exactly as the onchain self-test already does: without it
      // this command quoted the base three-leaf script, and a deployment check
      // that exercises a covenant shape no client ever receives is checking the
      // wrong thing. This self-test never spends the client-unilateral leaf —
      // that is the client's own out-of-band recourse — it only needs the key
      // for the script to be built the way production builds it.
      const clientRefundPub = schnorr.getPublicKey(schnorr.utils.randomSecretKey())
      const outcome = await services.service.quote(invoice, refundAddress, {
        clientRefundPubkey: hex.encode(clientRefundPub),
      })
      if (!outcome.accepted) {
        log('refused:', outcome.reason)
        process.exitCode = 2
        return
      }
      const swap = outcome.swap
      log('quoted', swap.id)

      // CLIENT RULE, exercised here so the reference flow embodies it: the
      // client derives the swap script itself and funds ONLY its own
      // derivation. From the quote it trusts exactly two fields — the
      // provider's pubkey and the refund deadline. Everything else comes from
      // what the client already holds: the invoice it decoded, the Arkade server
      // key from its own connection, the emulator key from its own fetch, and
      // its own refund address. A server-returned address is compare-only; a
      // mismatch means a wrong (or compromised) backend and nothing is funded.
      // With the service's own hint denylist, for the reason the orchestrator
      // threads it into every decode of a row's invoice: a raw reading here
      // would throw `cltv_too_large` on an invoice the quote above just
      // accepted, one state after the client would have funded it.
      const decoded = decodeInvoice(invoice, services.service.sendHintScidDenylist)
      const serverKey = services.arkade.wallet.arkServerPublicKey
      const local = new CovenantSwapScript({
        receiver: hex.decode(swap.receiverPubkey), // trusted from quote: provider key
        server: serverKey,
        preimageHash: scriptHashFromPaymentHash(decoded.paymentHash),
        refundLocktime: swap.refundLocktime, // trusted from quote: deadline
        claimDelay: services.arkade.unilateralDelays.unilateralClaimDelay,
        nonInteractiveParameters: {
          emulatorPubkey: hex.decode(services.emulatorPubkey),
          // The one field here that does come from the quote, and the rule above
          // is unchanged by it: `receiverPkScript` binds only where the PROVIDER
          // may pay itself on `nonInteractiveClaim`. A provider that lied about
          // its own claim destination would be robbing itself; none of the
          // client's refund leaves depend on it.
          receiverPkScript: hex.decode(swap.receiverPkScript!),
          senderPkScript: ArkAddress.decode(refundAddress).pkScript,
        },
        // The client's OWN key, generated above — not taken from the quote.
        client: clientRefundPub,
        clientRefundDelay: services.arkade.unilateralDelays.unilateralRefundWithoutReceiverDelay,
        refundWithoutServerDelay: services.arkade.unilateralDelays.unilateralRefundDelay,
        // Every quote the service issues now carries the full covenant suite;
        // matching that here is what makes `localAddress` below agree with
        // `swap.lockupAddress`.
      })
      const localAddress = local.address(services.arkade.hrp, serverKey).encode()
      if (localAddress !== swap.lockupAddress) {
        throw new GiveUp(
          `REFUSING TO FUND: server address ${swap.lockupAddress} does not match local derivation ${localAddress}`,
        )
      }

      // Both funding gates, immediately before funding — not at quote time.
      const now = nowSeconds()
      if (now >= decoded.expiresAt) throw new GiveUp('REFUSING TO FUND: invoice expired')
      if (swap.refundLocktime - now < MIN_CLAIM_WINDOW) {
        throw new GiveUp('REFUSING TO FUND: refund deadline headroom below 90 minutes')
      }

      const txid = await services.arkade.wallet.send({ address: localAddress, amount: decoded.amountSats })
      log('funded', decoded.amountSats, 'sats at own derivation, arkTxid', txid)

      const row = await driveToTerminal(services.service, swap.id)
      log('terminal:', json(printable(row)))
      if (row.state !== 'claimed') process.exitCode = 2
    } finally {
      await services.close()
    }
  },

  /**
   * E2E self-test for `arkade:BTC->onchain:BTC`, playing BOTH roles in one
   * process — same spirit as `send` above, extended for the one step the
   * Lightning leg never needs: an ACTIVE CLIENT CLAIM. Unlike a Lightning
   * payment (which reveals its preimage automatically), the onchain HTLC only
   * reveals P when its claim leaf is spent — so after the solver funds it,
   * this command signs and broadcasts that claim transaction itself, using an
   * ephemeral keypair generated for the "client" role, exactly the way any
   * real client integration would (see `docs/superpowers/specs/2026-08-06-onchain-send-receive-design.md`
   * and `arkade-os/ts-sdk`'s `@arkade-os/swap` package for the reference
   * client-side implementation this mirrors).
   */
  async 'send-onchain'([sats]) {
    const amountSats = Number(sats)
    if (!Number.isInteger(amountSats) || amountSats <= 0) throw new GiveUp('usage: send-onchain <sats>')
    const config = loadConfig()
    const services = await createServices(config)
    try {
      if (!services.onchainService) {
        throw new GiveUp('the arkade:BTC->onchain:BTC corridor is disabled (ONCHAIN_SEND_ENABLED=false)')
      }
      const onchainService = services.onchainService
      // The "client" role needs its own onchain keypair to claim with — a real
      // integration holds this in its own wallet; here it is generated fresh
      // and discarded at the end of the process. Same for the client-unilateral
      // refund key: this self-test never spends that leaf (it's the client's
      // own out-of-band recourse), but the RFQ family requires the pubkey on
      // every quote.
      const claimPriv = schnorr.utils.randomSecretKey()
      const claimPub = schnorr.getPublicKey(claimPriv)
      const clientRefundPub = schnorr.getPublicKey(schnorr.utils.randomSecretKey())
      const preimage = randomBytes(32)
      const paymentHash = hex.encode(sha256(preimage))

      const refundAddress = await services.arkade.wallet.getAddress()
      const outcome = await services.onchainService.quote({
        paymentHash,
        amountSats,
        payoutPubkey: hex.encode(claimPub),
        refundAddress,
        clientRefundPubkey: hex.encode(clientRefundPub),
      })
      if (!outcome.accepted) {
        log('refused:', outcome.reason)
        process.exitCode = 2
        return
      }
      const swap = outcome.swap
      log('quoted', swap.id)

      // CLIENT RULE, same as `send`: derive both scripts locally and refuse to
      // fund on any mismatch. The Arkade-side script is byte-identical to the
      // Lightning leg's; the onchain HTLC is new to this leg.
      const serverKey = services.arkade.wallet.arkServerPublicKey
      const localArkade = new CovenantSwapScript({
        receiver: hex.decode(swap.providerPubkey),
        server: serverKey,
        preimageHash: scriptHashFromPaymentHash(paymentHash),
        refundLocktime: swap.refundLocktime,
        claimDelay: services.arkade.unilateralDelays.unilateralClaimDelay,
        client: clientRefundPub,
        clientRefundDelay: services.arkade.unilateralDelays.unilateralRefundWithoutReceiverDelay,
        refundWithoutServerDelay: services.arkade.unilateralDelays.unilateralRefundDelay,
        nonInteractiveParameters: {
          emulatorPubkey: hex.decode(services.emulatorPubkey),
          receiverPkScript: hex.decode(swap.receiverPkScript),
          senderPkScript: ArkAddress.decode(refundAddress).pkScript,
        },
      })
      const localArkadeAddress = localArkade.address(services.arkade.hrp, serverKey).encode()
      if (localArkadeAddress !== swap.lockupAddress) {
        throw new GiveUp(
          `REFUSING TO FUND: server Arkade address ${swap.lockupAddress} does not match local derivation ${localArkadeAddress}`,
        )
      }
      const localHtlc = buildOnchainHtlc({
        network: ONCHAIN_NETWORKS[config.network],
        paymentHash,
        claimPubkey: claimPub,
        refundPubkey: hex.decode(swap.htlcPubkey),
        refundLocktime: swap.htlcLocktime,
      })
      if (localHtlc.address !== swap.onchainAddress) {
        throw new GiveUp(
          `REFUSING TO FUND: server onchain HTLC address ${swap.onchainAddress} does not match local derivation ${localHtlc.address}`,
        )
      }

      const now = nowSeconds()
      if (swap.refundLocktime - now < MIN_CLAIM_WINDOW) {
        throw new GiveUp('REFUSING TO FUND: refund deadline headroom below 90 minutes')
      }

      const fundTxid = await services.arkade.wallet.send({ address: localArkadeAddress, amount: amountSats })
      log('funded Arkade lockup', amountSats, 'sats, arkTxid', fundTxid)

      const funded = await driveOnchainUntil(onchainService, swap.id, new Set(['awaiting_claim', ...ONCHAIN_TERMINAL]))
      if (funded.state !== 'awaiting_claim') {
        log('terminal before the solver funded the onchain HTLC:', json(funded))
        process.exitCode = 2
        return
      }
      log('solver funded the onchain HTLC, funding txid', funded.fundingTxid, 'vout', funded.fundingVout)

      // The client's claim transaction: script-path spend of the claim leaf,
      // witness [signature, P, claimScript, controlBlock] — the exact shape
      // whenAwaitingClaim (src/send/onchainOrchestrator.ts) expects to observe.
      // Pay out to the client's own onchain wallet: a single-key taproot
      // address using the SAME ephemeral key, key-path spendable — standing in
      // for "the client's real wallet address" in this self-test.
      const feeRate = await requireOnchain(services.onchain).estimateFeeRate()
      const payout = p2tr(claimPub, undefined, ONCHAIN_NETWORKS[config.network])
      const witness = (sig: Uint8Array): Uint8Array[] => [
        sig,
        preimage,
        localHtlc.claimScript,
        localHtlc.claimControlBlock,
      ]
      const assemble = (payoutAmount: bigint): InstanceType<typeof Transaction> => {
        const tx = new Transaction({ allowUnknownOutputs: true })
        tx.addInput({
          txid: funded.fundingTxid!,
          index: funded.fundingVout!,
          witnessUtxo: { script: localHtlc.pkScript, amount: BigInt(amountSats) },
          sequence: 0xfffffffd,
        })
        tx.addOutput({ script: payout.script, amount: payoutAmount })
        return tx
      }

      // Sizing pass: a DEFAULT-sighash schnorr signature is always 64 bytes,
      // so a dummy-signed build measures the exact vsize before the real sign.
      const sizing = assemble(BigInt(amountSats))
      sizing.updateInput(0, { finalScriptWitness: witness(new Uint8Array(64)) }, true)
      const fee = BigInt(Math.ceil(sizing.vsize * feeRate))
      const payoutAmount = BigInt(amountSats) - fee
      if (payoutAmount <= 0n) throw new GiveUp(`fee ${fee} exceeds the HTLC amount ${amountSats}`)

      const claimTx = assemble(payoutAmount)
      const sighash = claimTx.preimageWitnessV1(
        0,
        [localHtlc.pkScript],
        SigHash.DEFAULT,
        [BigInt(amountSats)],
        undefined,
        localHtlc.claimScript,
        0xc0,
      )
      const sig = schnorr.sign(sighash, claimPriv)
      claimTx.updateInput(0, { finalScriptWitness: witness(sig) }, true)
      const claimTxid = await requireOnchain(services.onchain).broadcastRaw(hex.encode(claimTx.extract()))
      log('client claimed the onchain HTLC, claim txid', claimTxid.txid, 'payout', payoutAmount, 'sats')

      const claimed = await driveOnchainUntil(onchainService, swap.id, ONCHAIN_TERMINAL)
      log('terminal:', json(claimed))
      if (claimed.state !== 'claimed') process.exitCode = 2
    } finally {
      await services.close()
    }
  },

  async refund() {
    const config = loadConfig()
    // `allCorridors`: a one-shot operator command opens no ingress, so the
    // enable flags gate nothing here — and a corridor disabled with live rows
    // still needs its refunds swept.
    const services = await createServices(config, { allCorridors: true })
    try {
      // BOTH sweeps, same as watchUntilStopped: an operator running this by
      // hand is asking for every eligible refund, and the onchain corridor has
      // its own store and its own sweep.
      const pushed = await services.service!.refundSweep()
      const onchainPushed = await services.onchainService!.refundSweep()
      const evmPushed = (await services.evmSendService?.refundSweep()) ?? []
      if (pushed.length === 0 && onchainPushed.length === 0 && evmPushed.length === 0) {
        log('nothing eligible: refunds need a failed swap past its deadline with funds at the script')
        return
      }
      for (const id of pushed) log('refunded', id, json((await services.store.get(id)).refundArkTxid))
      for (const id of onchainPushed) {
        log('onchain refunded', id, json((await services.onchainStore.get(id)).refundArkTxid))
      }
      for (const id of evmPushed) {
        log('evm refunded', id, json((await services.evmSendStore!.get(id)).refundArkTxid))
      }
    } finally {
      await services.close()
    }
  },

  /**
   * Operator override: push the covenant refund for ONE specific swap right
   * now, bypassing `refundSweep`'s deadline gate. That gate deliberately
   * excludes any swap that was ever exposed (`src/db/swaps.ts`'s
   * `findRefundable` only considers `refused` rows — a swap that reached
   * `paying` and failed goes to `stuck` for a human, on purpose, since a
   * backend's "failed" verdict is trusted there and a false negative would
   * mean paying out over Lightning AND refunding the same lockup). This
   * command is the human's next step once they've looked at a `stuck` row
   * and decided a refund is warranted: the RFQ family's non-interactive
   * refund leaf (server + receiver + emulator) needs no timelock, so there
   * is no remaining reason to still wait out `refund_locktime` once that
   * decision is made.
   */
  async 'refund-now'([id]) {
    if (!id) throw new GiveUp('usage: refund-now <id>')
    const config = loadConfig()
    const services = await createServices(config)
    try {
      const result = await refundNow(services, id)
      if ('skipped' in result) {
        log('nothing at the script — already spent or never funded')
        return
      }
      log('COVENANT REFUND PUSHED, arkTxid', result.txid)
    } finally {
      await services.close()
    }
  },

  /**
   * The OTHER answer to a `stuck` row, and the opposite of `refund-now`: this
   * one is for when the payment DID settle.
   *
   * Reach for it when the backend committed our sats against the payment hash
   * but the row never learned a payment id — `payLightningInvoice` dies between
   * `initiate_preimage_swap_v3` and the call that mints the id. `read-payment`
   * (console) and `scripts/lookup-htlc.mjs` both read that commitment; if it
   * comes back settled, the solver paid and refunding would be a DOUBLE PAYOUT.
   *
   * Takes the preimage or, given none, reads it off the backend itself. It
   * pushes nothing: it records the preimage and returns the row to `claiming`,
   * so the ordinary sweep moves the money through the same path every other
   * claim takes. Refuses any preimage that does not hash to the row's payment
   * hash, which is what makes the `stuck -> claiming` edge sound.
   */
  async 'claim-now'([id, preimage]) {
    if (!id) throw new GiveUp('usage: claim-now <id> [preimage]')
    const config = loadConfig()
    // `allCorridors` for the same reason the refund commands use it: this
    // unwinds EXISTING rows, including a corridor since disabled.
    const services = await createServices(config, { allCorridors: true })
    try {
      const row = await services.store.get(id)
      log('swap', row.id, 'is', row.state, row.failureReason ? `— ${row.failureReason}` : '')
      await claimNow(services, id, preimage)
      log('PREIMAGE RECORDED, swap returned to claiming — the sweep will push the claim')
    } finally {
      await services.close()
    }
  },

  /**
   * Stop driving ONE swap, with the reason recorded on the row.
   *
   * The lever that did not exist during the d69041e8 incident: a row whose
   * every tick threw was re-driven by the sweep for six days, and nothing short
   * of a hand-written script against the live database could stop it. `tick`
   * drives it again; `refund-now` does not change state.
   *
   * It neither refunds nor claims — that decision is separate, and `read-payment`
   * is what informs it. This only stops the machine.
   */
  async 'park-swap'([id, ...reason]) {
    const why = reason.join(' ').trim()
    if (!id || !why) throw new GiveUp('usage: park-swap <id> <reason...>')
    const config = loadConfig()
    const services = await createServices(config, { allCorridors: true })
    try {
      // Which corridor holds it has to be DISCOVERED here, unlike in the console
      // where every rendered row carries its own. Searching the stores is safe
      // in a way `tick`'s doc rules out for itself: ids are `randomUUID()`, so
      // the first store to answer is the only store that can answer. This read
      // the Lightning-send store alone, so parking an onchain, receive or EVM
      // row failed with "not found" on a row that plainly existed.
      const owner = await corridorHolding(services, id)
      if (!owner) throw new GiveUp(`no corridor on this deployment holds swap ${id}`)
      const detail = await owner.detail(id)
      log('swap', id, 'is', detail?.swap.state, 'on', owner.descriptor.pair)
      const { state } = await owner.park(id, why)
      log('PARKED ->', state, '—', why)
    } finally {
      await services.close()
    }
  },

  /**
   * `refund-now` for the onchain corridor, and the only path out of `stuck`
   * there: that state means the solver funded its onchain HTLC but could not
   * claim the Arkade lockup, and the automatic sweep deliberately never
   * touches it (see `OnchainSendSwapService.refundNow` for why refunding a
   * `stuck` row is correct in some of its cases and a double-payout in
   * others). Without this the client's lockup has no operator-driven path at
   * all — only the client's own `refundUnilateral` leaf, which needs the
   * client's key, their CSV delay, and their cooperation.
   *
   * REFUNDS THE ARKADE LOCKUP, TO THE CLIENT — never the solver's own onchain
   * HTLC. The `onchain-` prefix names which STORE the row lives in
   * (`send_onchain_swap`, the onchain corridor's table, as opposed to
   * `refund-now`'s Lightning-family `SwapStore`), not which leg gets refunded.
   * The solver's own L1 HTLC is `reclaim-l1-htlc` below.
   *
   * Unlike `refund-now` above, the reconstruct-and-push lives on the service
   * (shared with its own sweep), so this stays a thin wrapper over the one
   * implementation of the money path.
   */
  async 'onchain-refund-now'([id]) {
    if (!id) throw new GiveUp('usage: onchain-refund-now <id>')
    const config = loadConfig()
    // `allCorridors`: this command exists to unwind rows, including rows of a
    // corridor that has since been disabled — see createServices.
    const services = await createServices(config, { allCorridors: true })
    try {
      const row = await services.onchainStore.get(id)
      log('swap', row.id, 'is', row.state, row.failureReason ? `— ${row.failureReason}` : '')
      const result = await onchainRefundNow(services, id)
      if ('skipped' in result) {
        log('nothing at the script — already spent or never funded')
        return
      }
      log('COVENANT REFUND PUSHED, arkTxid', result.txid)
    } finally {
      await services.close()
    }
  },

  /**
   * The OTHER leg of an onchain-corridor swap, and deliberately not named like
   * the one above: `onchain-refund-now` gives the CLIENT their Arkade lockup
   * back, this reclaims the SOLVER's own Bitcoin L1 sats out of the HTLC it
   * funded. Different money, different direction, different recipient — the
   * shared word in the old name was "refund", so this one does not use it.
   *
   * Reach for it when a row is `stuck` with a `funding_txid` on it. That
   * combination means the solver's L1 HTLC was broadcast and the automatic
   * refund then gave up: `stuck` has no outgoing edge in `LEGAL_EDGES` and no
   * case in the orchestrator's `step()`, so nothing retries on its own.
   *
   * Safe to run more than once, and safe to run against an output that turns
   * out to be spent already — both legs of this HTLC spend the SAME output, so
   * a redundant refund is a double-spend the network rejects rather than a
   * second payout. (That is exactly what `onchain-refund-now` cannot promise,
   * and why it stays a judgement call.) The one case it refuses outright is a
   * client claim already on the chain: it prints the preimage from that
   * witness instead, since claiming the Arkade lockup — not refunding
   * anything — is what recovers the swap from there.
   */
  async 'reclaim-l1-htlc'([id]) {
    if (!id) throw new GiveUp('usage: reclaim-l1-htlc <id>')
    const config = loadConfig()
    // `allCorridors`: same unwind-existing-rows reasoning as onchain-refund-now.
    const services = await createServices(config, { allCorridors: true })
    try {
      const row = await services.onchainStore.get(id)
      log('swap', row.id, 'is', row.state, row.failureReason ? `— ${row.failureReason}` : '')
      log('onchain HTLC', row.fundingTxid ? `${row.fundingTxid}:${row.fundingVout}` : '(never funded)')
      const { txid } = await reclaimL1Htlc(services, id)
      log('L1 HTLC REFUND BROADCAST, txid', txid)
    } finally {
      await services.close()
    }
  },

  /**
   * Prove the covenant refund on a live network in one shot: fund a covenant
   * script whose claim path can never be used (the preimage is random and
   * discarded), then push the non-interactive refund back to our own wallet.
   *
   * What this verifies, in order: the Arkade server accepts the three-leaf covenant
   * tree at funding; the emulator recognises the ArkadeScript and co-signs; the
   * refund lands at the committed destination. This is the whole refund path a
   * client would ever depend on.
   *
   * The refund deadline defaults to THREE HOURS IN THE PAST so the refund is
   * spendable immediately. The Arkade server matures a CLTV against median-time-past
   * (BIP-113), which lags wall clock by ~an hour on mainnet — a locktime a few
   * minutes in the future would leave the test retrying `FORFEIT_CLOSURE_LOCKED`
   * for over an hour until MTP caught up. A past locktime satisfies CLTV at once
   * and exercises the identical leaf. Pass a positive offset to instead test the
   * waiting behaviour against a future deadline.
   */
  async 'test-refund'([sats, offsetArg]) {
    const amountSats = Number(sats)
    if (!Number.isInteger(amountSats) || amountSats <= 0)
      throw new GiveUp('usage: test-refund <sats> [locktimeOffsetSeconds]')
    const offset = offsetArg !== undefined ? Number(offsetArg) : -3 * 60 * 60
    if (!Number.isFinite(offset)) throw new GiveUp('locktimeOffsetSeconds must be a number')

    const config = loadConfig()
    const services = await createServices(config)
    try {
      const { arkade } = services
      const destination = await arkade.wallet.getAddress()
      const refundPkScript = ArkAddress.decode(destination).pkScript

      const refundLocktime = nowSeconds() + offset
      const scriptParams = {
        receiver: await arkade.identity.xOnlyPublicKey(),
        server: arkade.wallet.arkServerPublicKey,
        // Random and immediately discarded: the claim leaves are dead ends, so
        // the ONLY way these sats move is the covenant refund under test.
        preimageHash: ripemd160(sha256(randomBytes(32))),
        refundLocktime,
        claimDelay: arkade.unilateralDelays.unilateralClaimDelay,
        // Generated and discarded. This test spends the covenant refund and
        // nothing else, but the script has one shape now and it needs a client
        // key to be built at all.
        client: schnorr.getPublicKey(schnorr.utils.randomSecretKey()),
        clientRefundDelay: arkade.unilateralDelays.unilateralRefundWithoutReceiverDelay,
        refundWithoutServerDelay: arkade.unilateralDelays.unilateralRefundDelay,
        nonInteractiveParameters: {
          emulatorPubkey: hex.decode(services.emulatorPubkey),
          receiverPkScript: ArkAddress.decode(await arkade.wallet.getAddress()).pkScript,
          senderPkScript: refundPkScript,
        },
      }
      const script = new CovenantSwapScript(scriptParams)
      const address = script.address(arkade.hrp, arkade.wallet.arkServerPublicKey).encode()
      // Log the full reconstruction params BEFORE funding: the script lives only
      // in this process's memory, so if it dies mid-run these are the only way to
      // rebuild the tree and recover the 500 sats. Cheap insurance against a
      // stranded lockup.
      log(
        'covenant script params',
        json({
          ...scriptParams,
          preimageHash: hex.encode(scriptParams.preimageHash),
          server: hex.encode(scriptParams.server),
          receiver: hex.encode(scriptParams.receiver),
          nonInteractiveParameters: {
            ...scriptParams.nonInteractiveParameters,
            emulatorPubkey: hex.encode(scriptParams.nonInteractiveParameters.emulatorPubkey),
            receiverPkScript: hex.encode(scriptParams.nonInteractiveParameters.receiverPkScript),
            senderPkScript: hex.encode(scriptParams.nonInteractiveParameters.senderPkScript),
          },
          refundPkScript: hex.encode(refundPkScript),
        }),
      )
      log('funding covenant script', address, 'refundable at', refundLocktime, '(offset', offset, 's)')

      const fundTxid = await arkade.wallet.send({ address, amount: amountSats })
      log('funded', amountSats, 'sats, arkTxid', fundTxid)

      const pkScriptHex = hex.encode(script.pkScript)
      const outputs = await poll(() => findLockups(arkade, pkScriptHex).then((o) => (o.length ? o : null)), {
        attempts: 30,
        whenExhausted: 'lockup never appeared at the covenant script',
      })
      log('lockup seen; pushing covenant refund')

      const txid = await poll(
        async () => {
          if (nowSeconds() < refundLocktime) return null
          try {
            return await refundSwapScript(arkade, config.emulatorUrl, script, outputs, refundPkScript)
          } catch (error) {
            // Surface each attempt's reason: FORFEIT_CLOSURE_LOCKED (locktime not
            // yet matured against MTP) is a retry; anything else is a real
            // emulator/server rejection that this makes visible instead of
            // silently retrying.
            log('refund attempt failed, retrying:', error instanceof Error ? error.message : String(error))
            throw error
          }
        },
        // Deliberately few attempts: every rejected push writes an error line in
        // the emulator operator's logs, and the refund leaf has no expiry — if
        // this run cannot land it, a later run costs nothing. Bounded noise.
        { attempts: 6, intervalMs: 30_000, whenExhausted: 'refund not accepted within 6 attempts; re-run later' },
      )
      log('COVENANT REFUND PUSHED, arkTxid', txid)
    } finally {
      await services.close()
    }
  },

  async invoice([sats]) {
    const amountSats = Number(sats)
    if (!Number.isInteger(amountSats) || amountSats <= 0) throw new GiveUp('usage: invoice <sats>')
    const config = loadConfig()
    if (config.lnBackend === 'fake') {
      // Forge an invoice the fake backend can pay: the preimage lands in the
      // shared state file, so `send` in a separate process finds it.
      const fake = new FakeLightningBackend(config.fakeLnStatePath, config.profile.invoicePrefix)
      console.log(fake.forgeInvoice(amountSats).invoice)
      return
    }
    // The payee stands in for an arbitrary Lightning recipient: the service has
    // no relationship with it beyond paying a BOLT11 like any other, so it has
    // to be a SEPARATE wallet. That is a capability only the rail can supply —
    // it knows how to open a second wallet from a second seed, and on some
    // vendors there is no such thing — so it is optional on the rail rather
    // than something this command can synthesise. Minting from the solver's own
    // wallet instead would make the self-test a swap with itself.
    const rail = config.lnBackend === null ? undefined : lightningRailFor(config.lnBackend)
    if (!rail?.mintPayeeInvoice) {
      throw new GiveUp(
        `no registered rail can mint a payee invoice (LN_BACKEND=${config.lnBackend ?? 'unset'}). ` +
          'LN_BACKEND=fake forges one locally instead.',
      )
    }
    // Only the invoice on stdout, so it can be piped into `send`.
    console.log(await rail.mintPayeeInvoice(config, amountSats))
  },

  /**
   * The solver-registry corridor card for THIS deployment, signed by the
   * wallet identity — the key makers already address RFQs to. Built from the
   * live config so the published listing cannot drift from what the service
   * enforces. Needed because `solverd` cannot emit corridor cards yet
   * (arkade-os/solver-registry#13).
   */
  async card([nameArg]) {
    const name = nameArg ?? process.env.SOLVER_NAME
    if (!name) throw new GiveUp('usage: card <name>   (or set SOLVER_NAME; becomes solvers/<network>/<name>.json)')
    const config = loadConfig()
    // Extra relays beyond RELAY_URL, for a deployment listening on several.
    const extra = (process.env.SOLVER_CARD_RELAYS ?? '')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean)
    const relays = [...(config.relayUrl ? [config.relayUrl] : []), ...extra]
    // This command does not build the service stack, but the card it writes
    // must state the terms the stack would actually enforce — so it resolves
    // the same effective policy `createServices` does, from the same store.
    // Through the layout, not `adminDbPath` directly: on a consolidated
    // deployment the overrides live in the swap file, and opening the suffixed
    // path would silently create an EMPTY second database — the card would then
    // publish the unoverridden config as if the operator had never narrowed it.
    const cardAdminStore = await AdminStore.open(resolveDbLayout(config.swapDbPath).admin)
    let policy
    try {
      policy = applyOverrides(config, await cardAdminStore.getOverrides())
    } finally {
      await cardAdminStore.close()
    }
    const { MnemonicIdentity } = await import('@arkade-os/sdk')
    const identity = MnemonicIdentity.fromMnemonic(config.arkade.mnemonic, { isMainnet: config.arkade.isMainnet })
    const { buildSolverCard, signSolverCard } = await import('@arkade-os/solver-core/core/registryCard.js')
    const card = await signSolverCard(
      buildSolverCard({
        name,
        discoveryPubkey: hex.encode(await identity.xOnlyPublicKey()),
        relays,
        // What this deployment actually serves, so discovery cannot describe a
        // corridor the config has disabled. Limits AND fees per corridor, so a
        // market cannot be stamped with terms belonging to another one.
        //
        // From `policy`, NOT `config` — the same source the admin route reads,
        // and the reason this command resolved effective policy above. Reading
        // the raw environment here would drop every console override, so `cli
        // card` and `/api/card` would print different cards for one deployment.
        //
        // There is deliberately no hard refusal for a disabled LN_SEND any
        // more: it protected the hardcoded single market, and an onchain-only
        // deployment now has an honest card to publish rather than none.
        // `buildSolverCard` still refuses when NOTHING is served.
        corridors: Object.fromEntries(
          CORRIDORS.filter((corridor) => policy.corridorEnabled[corridor]).map((corridor) => [
            corridor,
            { limits: policy.corridorLimits[corridor], fee: policy.corridorFees[corridor] },
          ]),
        ),
      }),
      (digest) => identity.signMessage(digest, 'schnorr'),
    )
    // Only the card on stdout, so it can be piped straight into the registry
    // checkout; the destination hint goes to stderr.
    console.log(JSON.stringify(card, null, 2))
    console.error(`registry path: solvers/${config.network}/${name}.json`)
  },

  async balances() {
    const config = loadConfig()
    const services = await createServices(config)
    try {
      log('lightning:', json(await requireLn(services.ln).getBalance()))
      log('arkade address:', await services.arkade.wallet.getAddress())
      log('arkade balance:', json(await services.arkade.wallet.getBalance()))
      log('limits:', json(config.limits), 'exposure cap:', config.maxExposedSats)
      log('committed now:', await services.store.committedSats())
      // How many swaps this float can fund AT ONCE, which is not the same
      // question as how many sats it holds. Funding pins the coins it spends,
      // so one fat coin funds one swap and refuses the next however large it
      // is. Read-only here; `pool --mint` is what acts on the same plan.
      // @see arkade/vtxoPool.ts
      const { spendable, target, plan } = await poolPlan(services)
      log('pool pieces:', spendable.length, 'sizes:', json([...spendable].sort((a, b) => b - a).slice(0, 12)))
      log('pool target:', json(target), '->', plan.reason)
    } finally {
      await services.close()
    }
  },

  /**
   * Split the float into the shape {@link poolTarget} asks for. Dry unless
   * `--mint`, because this is the one read-only-adjacent command that spends.
   *
   * The mechanism is one Arkade transaction paying the solver's own address
   * several times over: `send` takes a list of recipients, so N pieces cost one
   * transaction and no operator intent fee — unlike settling, which charges per
   * input and would be the expensive way to reshape a float that is already
   * spendable.
   *
   * The hazard it guards is a CONCURRENT PROVIDER. Funding pins the coins it
   * spends through a ledger that is PROCESS-LOCAL (@see
   * arkade/reservations.ts), so a mint run from this second process cannot see
   * what a running provider has already reserved and can spend a coin out from
   * under an in-flight funding, leaving that swap unable to fund.
   *
   * Non-terminal rows are the only signal about the other process that is
   * actually shared — both processes open the same database — so that is what
   * the default gate reads. It is a proxy and deliberately a loose one: a
   * `quoted` row has reserved nothing yet, and a solver with steady traffic
   * almost always has something open, so a hard refusal would make this
   * unusable exactly where a starved pool matters most. Hence `--force`, for
   * the operator who knows no provider is running. What cannot be detected
   * from here is liveness itself: `watch` and `serve` leave no heartbeat, and
   * guessing from a row's state would be a worse lie than asking.
   */
  async pool(args) {
    const config = loadConfig()
    const services = await createServices(config)
    try {
      const { spendable, plan } = await poolPlan(services)
      log('pool pieces:', spendable.length, '->', plan.reason)
      if (plan.outputs.length === 0) return

      if (!args.includes('--mint')) {
        log('dry run:', json(plan.outputs), 'would be minted. Pass --mint to execute')
        return
      }

      const result = await mintPool(services, { force: args.includes('--force') })
      if ('refused' in result) {
        log(`refusing to mint — ${result.refused} (see \`list\`)`)
        process.exitCode = 1
        return
      }
      if ('skipped' in result) return
      if (result.committedSats > 0) log(`--force: minting with ${result.committedSats} sat committed`)
      log('minted', result.minted.length, 'piece(s):', json(result.minted), 'arkTxid', result.txid)
    } finally {
      await services.close()
    }
  },
}

const main = async (): Promise<void> => {
  const [, , command, ...args] = process.argv
  const handler = command ? commands[command] : undefined
  if (!handler) {
    console.error(`usage: one of [${Object.keys(commands).join(', ')}]`)
    process.exitCode = 1
    return
  }
  await handler(args)
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error('failed:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
