/**
 * The solver's own float: keeping it alive, and keeping it spendable.
 *
 * Two separate jobs, and they fail in opposite directions.
 *
 * **Lifecycle** — renew what is near expiry, recover what has already been
 * swept. Without it the float ages out of its batch into `recoverable`, which is
 * a bucket coin selection will not touch: the wallet reads healthy on `total`
 * and can fund nothing. Every corridor then refuses for a reason that names the
 * corridor rather than the float.
 *
 * **Shape** — split one fat coin into several. Funding PINS the coins it spends,
 * so a float of one coin funds one swap and refuses the next however large it
 * is. `poolPlan` answers "how many swaps can this fund at once", which is not
 * the same question as how many sats it holds.
 *
 * Here rather than inline in the watch loop so the console and the CLI drive the SAME
 * code, and so an operator can trigger a pass now rather than waiting on a cadence. An
 * operator-triggered recovery that shortcut the guard below would be a second
 * implementation of a money path, and the more dangerous of the two — a manual trigger
 * is used precisely when something is already wrong.
 *
 * THE GUARD is why this is not a one-liner. `recoverVtxos` puts every recoverable
 * output into ONE settlement, and a registered lockup's annotation leaf carries the
 * swap's `refundLocktime` as an absolute CLTV, so one immature lockup fails the whole
 * batch — taking the operating-balance coins that were the reason for recovering.
 * {@link runVtxoLifecycle} holds recovery back when that would happen.
 */

import {
  liveLockupRows,
  recoverableVtxosFrom,
  renewExpiringVtxos,
  runVtxoLifecycle,
  RENEWAL_THRESHOLD_MS,
  type LockupDeadline,
  type VtxoLifecycleReport,
} from '@arkade-os/solver-arkade/arkade/vtxoLifecycle.js'
import type { ReleaseReservation } from '@arkade-os/solver-arkade/arkade/reservations.js'
import { poolTarget } from '@arkade-os/solver-arkade/arkade/vtxoPool.js'
import { poolPlan, resplitFloat } from './pool.js'
import { summariseSignerMigration } from '@arkade-os/solver-arkade/arkade/signerMigration.js'
import type { Services } from './services.js'

/**
 * Every live lockup's refund deadline, for the recovery guard.
 *
 * Derived from `liveLockupRows` exactly as the daemon's contract registration
 * derives it, rather than being handed over as that registration's by-product.
 * Registration and this guard want the same rows for different reasons, and
 * coupling them would mean a manual recovery could only be as safe as whatever
 * the last registration pass happened to leave behind.
 */
export const lockupDeadlinesOf = async (services: Services): Promise<readonly LockupDeadline[]> => {
  // The READER set, deliberately — never `services.corridors`. That one holds
  // only corridors with a live SERVICE, and a corridor an operator switched off
  // still has funded lockups whose deadlines this guard exists to respect.
  const rows = await liveLockupRows(services.readers)
  return rows.map((row) => ({ script: row.pkScript, refundLocktime: row.refundLocktime }))
}

/**
 * The migration throttle this pass owes the server.
 *
 * The SDK's own poll backed off: `MIGRATION_COOLDOWN_MS` (30s) doubling to a
 * 5-minute ceiling, so a server-side refusal — arkd not yet accepting old-key
 * inputs, or a closed cutoff window — was not re-submitted as an identical
 * intent on every poll. The manual API bypasses that cooldown BY DESIGN (the
 * SDK's comment on the fields says so), which means owning the call means
 * owning the throttle too: an unthrottled caller re-submits the same intent
 * on every pass and reports a failure line each time, which is how a log
 * stops being read. The constants mirror the SDK's; module scope so the watch
 * loop and the admin action share one clock, `migrateCore` taking no mutex.
 */
const MIGRATION_RETRY_MS = 30_000
const MIGRATION_RETRY_MAX_MS = 300_000
const migrationThrottle = { lastAttempt: 0, lastFailure: 0, consecutiveFailures: 0 }

/** Overridable in tests, so the throttle is asserted rather than waited on. */
export const migrationClock = { nowMs: () => Date.now() }

/** Test seam: the throttle is module state, and one suite's failures must not gate the next suite's passes. */
export const resetMigrationThrottle = (): void => {
  migrationThrottle.lastAttempt = 0
  migrationThrottle.lastFailure = 0
  migrationThrottle.consecutiveFailures = 0
}

/** True when a migration attempt should be made now; records the attempt. */
const migrationDue = (failed: boolean): boolean => {
  const now = migrationClock.nowMs()
  if (now - migrationThrottle.lastAttempt < MIGRATION_RETRY_MS) return false
  if (failed) {
    const backoff = Math.min(MIGRATION_RETRY_MS * 2 ** migrationThrottle.consecutiveFailures, MIGRATION_RETRY_MAX_MS)
    if (now - migrationThrottle.lastFailure < backoff) return false
  }
  migrationThrottle.lastAttempt = now
  return true
}

/**
 * One lifecycle pass — renew, then recover — against the live wallet.
 *
 * Nothing here throws: {@link runVtxoLifecycle} collects failures into its
 * report because it runs on a loop whose other entries are unguarded money-path
 * work. A caller wanting to surface a failure reads `report.failures`.
 *
 * Renewal deliberately reads the GATED coin set minus anything a funding has
 * pinned. `settle` and `sendBitcoin` are two independent spenders of one float,
 * and arkd resolves a collision by failing one of them — when that one is the
 * funding, a swap dies for no reason.
 */
export const runFloatLifecycle = async (services: Services): Promise<VtxoLifecycleReport> => {
  const wallet = services.arkade.wallet
  const vtxoManager = await wallet.getVtxoManager()
  const deadlines = await lockupDeadlinesOf(services)

  // OURS BECAUSE IT IS NO LONGER THEIRS. The SDK ran this inside the boarding
  // poll that `settlementConfig: false` turns off, so it moves here rather than
  // disappearing — @see arkade/signerMigration.ts for what that does and does
  // not cost. First in the pass: a coin still committed to a deprecated signer
  // should reach the active one before renewal decides what to re-settle.
  //
  // Never throws into the rest of the pass, same contract as every other step
  // here: this runs on a watch loop whose other entries are unguarded money-path
  // work, and the next pass retries whatever this one missed.
  const migration = { migrated: 0, failures: [] as string[] }
  const hadFailures = migrationThrottle.consecutiveFailures > 0
  if (migrationDue(hadFailures)) {
    // The migration names coins from the wallet's default/delegate contracts
    // with no knowledge of the reservation ledger — the same ledger renewal
    // consults below — so a receive-leg funding holding a coin under a
    // deprecated signer would race the migration for it, and the funding can
    // be the leg arkd fails. `MigrateDeprecatedSignerOptions` has no filter
    // hook (checked against 0.4.66), so the ledger is respected from THIS
    // side instead: the candidates are read the way the SDK reads them
    // (default/delegate contracts, spendable only — swept-but-unspent outputs
    // are recovery's, not migration's) and pinned for the duration of the
    // call. The window is named rather than hidden: a funding that lands
    // between this read and the SDK's own selection loses on the MIGRATION
    // side as VTXO_ALREADY_SPENT, which retries next pass — the acceptable
    // direction, since a failed funding is a dead swap.
    let release: ReleaseReservation = () => {}
    try {
      const contracts = await (
        await wallet.getContractManager()
      ).getContractsWithVtxos({
        type: ['default', 'delegate'],
      })
      const candidates = contracts.flatMap(({ vtxos }) =>
        vtxos.filter((vtxo) => !vtxo.isSwept && !(vtxo.isSpent || vtxo.spentBy || vtxo.settledBy)),
      )
      release = services.arkade.reservations.reserve(candidates)
      const outcome = summariseSignerMigration(await vtxoManager.migrateDeprecatedSignerVtxos())
      migration.migrated = outcome.migrated
      migration.failures.push(...outcome.failures)
      if (outcome.failures.length === 0) migrationThrottle.consecutiveFailures = 0
      else {
        migrationThrottle.consecutiveFailures += 1
        migrationThrottle.lastFailure = migrationClock.nowMs()
      }
    } catch (error) {
      migrationThrottle.consecutiveFailures += 1
      migrationThrottle.lastFailure = migrationClock.nowMs()
      migration.failures.push(
        `deprecated-signer migration failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      release()
    }
  }

  const report = await runVtxoLifecycle({
    // Not `vtxoManager.renewVtxos()`: that asks for an output equal to the gross
    // input sum, so the intent it registers pays a zero fee and any operator
    // charging one rejects it outright. @see renewExpiringVtxos
    renewVtxos: () =>
      renewExpiringVtxos({
        serverInfo: async () => {
          const info = await wallet.arkProvider.getInfo()
          return { intentFee: info.fees.intentFee, vtxoMaxAmount: info.vtxoMaxAmount, dust: info.dust }
        },
        expiringVtxos: async () => {
          const reserved = services.arkade.reservations.reserved()
          const expiring = await vtxoManager.getExpiringVtxos(RENEWAL_THRESHOLD_MS)
          return expiring.filter((vtxo) => !reserved.has(`${vtxo.txid}:${vtxo.vout}`))
        },
        destination: () => wallet.getAddress(),
        settle: (inputs, outputs) => wallet.settle({ inputs: [...inputs], outputs: [...outputs] }),
        // The shape a renewal should carve its proceeds into, so the float
        // comes back able to fund several swaps at once rather than one.
        // Same target `pool`/`mintPool` work from, so the two cannot drift.
        poolTarget: poolTarget(services.config.limits.maxSats, services.config.maxExposedSats),
        nowMs: () => Date.now(),
      }),
    // A SAFETY NET rather than the mechanism: the renewal settles straight into the
    // pool's shape above, so the float does not come back as one coin. This covers what
    // that cannot reach — too little to carve, or a float reshaped by something other
    // than a renewal. @see #123
    resplitFloat: async () => (await resplitFloat(services))?.txid ?? null,
    recoverVtxos: () => vtxoManager.recoverVtxos(),
    recoverableVtxos: () => recoverableVtxosFrom(wallet),
    lockupDeadlines: async () => deadlines,
    nowSeconds: () => Math.floor(Date.now() / 1000),
  })

  // Folded in rather than returned separately: `failures` is already the one
  // place a caller looks, and a migration problem is a float problem. The
  // migrated count rides the same report so the watch loop logs it and the
  // admin action's response carries it — a successful migration that produced
  // no output anywhere is the difference between "the cooperative path ran"
  // and "every input quietly took sweep-then-recover", which nobody could
  // tell apart before.
  return { ...report, migrated: migration.migrated, failures: [...migration.failures, ...report.failures] }
}

/** Why an automatic mint did not spend, when it declined to. */
export type AutoMintSkip = 'disabled' | 'shape_is_fine'

export type AutoMintOutcome = { minted: false; skipped: AutoMintSkip } | { minted: true; result: unknown }

/**
 * Split the float only when its SHAPE needs it — the automatic half of minting.
 *
 * **Opt-in, off by default.** Renewal preserves what the solver already has; this
 * SPENDS on a timer with no human present, which is not a decision to make silently.
 *
 * **Gated on the plan, not a clock.** Minting while the shape is already fine would
 * spend a fee to rearrange nothing, every cadence, forever — so an empty plan is the
 * normal answer, not a failure.
 *
 * `mintPool`'s concurrent-provider guard still applies underneath, and this
 * deliberately does not pass `force`: an automatic caller is exactly the one that must
 * not override it.
 */
export const maybeMintPool = async (
  services: Services,
  deps: { readonly enabled: boolean; readonly mint: (services: Services) => Promise<unknown> },
): Promise<AutoMintOutcome> => {
  if (!deps.enabled) return { minted: false, skipped: 'disabled' }
  const { plan } = await poolPlan(services)
  // `outputs` empty means the float is already shaped to fund concurrent
  // swaps; `reason` says why when it is. Either way there is nothing to spend
  // a fee on, and this is the ordinary answer rather than a failure.
  if (plan.outputs.length === 0) return { minted: false, skipped: 'shape_is_fine' }
  return { minted: true, result: await deps.mint(services) }
}
