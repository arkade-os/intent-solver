/**
 * Cooperative deprecated-signer migration, run by this service rather than by
 * the SDK's own poll.
 *
 * WHY THIS EXISTS AT ALL. Building the wallet with `settlementConfig: false`
 * stops the SDK's `VtxoManager` boarding poll — the thing that calls
 * `getSpendableVtxos()`, an UNFILTERED contract snapshot, every 60 seconds
 * whatever this service is doing. That poll is also where the SDK ran its
 * automatic migration pass (`migrationEnabled && isMigrationCapable`), so
 * turning it off would silently drop the capability. `migrateDeprecatedSignerVtxos`
 * is public and bypasses the internal cooldown precisely so a caller can own
 * this, which is the same posture that makes this service the single renewal
 * authority instead of racing the SDK's.
 *
 * WHAT IS AND IS NOT AT STAKE, because "migration" sounds more alarming than it
 * is. Cutoff-EXPIRED inputs are not migrated by this path and never were: the
 * SDK's own report documents that each keeps its batch expiry, the server
 * sweeps it, and the recovery path re-mints it under the active signer — and
 * recovery is something `runVtxoLifecycle` already does on this same pass. So
 * what a missing migration costs is the COOPERATIVE window, before the cutoff
 * closes: cheaper and sooner than sweep-then-recover, not a difference between
 * recoverable and lost.
 *
 * The summary below is pure so those judgements are testable without a wallet;
 * `ops/float.ts` owns the call.
 */

import type { DeprecatedSignerMigrationReport, MigrationLegReport } from '@arkade-os/sdk'

/** One pass's outcome, in the shape `VtxoLifecycleReport` carries. */
export interface SignerMigrationOutcome {
  /** Inputs that actually moved to the active signer, across both legs. */
  migrated: number
  /**
   * Anything an operator should see. Deliberately NOT everything unusual — see
   * the expired and below-dust cases below, both of which resolve themselves.
   */
  failures: string[]
}

const legOutcome = (name: string, leg: MigrationLegReport | undefined, failures: string[]): number => {
  if (!leg) return 0
  if (leg.error) failures.push(`deprecated-signer migration (${name} leg) failed: ${leg.error}`)
  // A single output under the operator's per-output ceiling cannot hold these,
  // so no later pass rescues them either — they need a unilateral exit and a
  // human. Silence here would leave funds parked with nothing ever saying so.
  if (leg.oversized?.length) {
    failures.push(
      `deprecated-signer migration (${name} leg): ${leg.oversized.length} input(s) exceed the per-output ceiling ` +
        'and can never migrate cooperatively — they need a unilateral exit',
    )
  }
  return leg.migrated.length
}

/**
 * Turn one migration report into the two things the lifecycle reports.
 *
 * `skipped: 'no-deprecated-vtxos'` is the overwhelmingly common answer and is
 * silence, not news. `'unknown-wallet-signer'` is the opposite: the pass refused
 * to rotate because it could not classify our own signer against the server's
 * set, which is a deployment fact only a human resolves.
 *
 * A leg reporting `skipped` (`below-dust`, `oversized-only`,
 * `not-spendable-only`) is not a failure either — the first resolves itself as
 * value accumulates and the last as the chain tip moves. `oversized` is called
 * out separately above because it is the one that never resolves.
 */
export const summariseSignerMigration = (report: DeprecatedSignerMigrationReport): SignerMigrationOutcome => {
  const failures: string[] = []
  if (report.skipped === 'unknown-wallet-signer') {
    failures.push(
      'deprecated-signer migration skipped: unknown-wallet-signer — this wallet’s signer is neither the ' +
        'active key nor an advertised deprecated one, so the pass refused to rotate',
    )
  }
  const migrated = legOutcome('vtxos', report.vtxos, failures) + legOutcome('boarding', report.boarding, failures)
  return { migrated, failures }
}
