/**
 * One lifecycle for every contract this service registers, whatever corridor
 * produced it.
 *
 * The engine deliberately knows nothing about swaps. A corridor contributes a
 * {@link CorridorSource}; this decides what to register, disable and delete.
 * That split is what keeps a fifth corridor from arriving with a fifth
 * lifecycle — the failure mode `liveLockupRows` already had once, when
 * `registerLiveLockups` read only the two SEND stores and silently skipped both
 * RECEIVE legs.
 *
 * RETIREMENT IS TWO-STAGE, and the stages answer different questions. Disabling
 * (`watch: 'retained'`) says "stop watching this": it is reversible, keeps the
 * row annotating its own VTXOs, and really does unsubscribe it — the SDK's
 * contract watcher IS running in this process, since
 * `ContractManager.initialize()` ends by calling `watcher.startWatching` and
 * `getContractManager()` is what reaches it. Deleting says "stop SYNCING this",
 * which is the only thing that actually bounds cost: `getContractsWithVtxos`
 * hands `syncContracts` an explicit, unfiltered contract list, so a retained row
 * is still fetched from the indexer on every snapshot.
 *
 * That second point is an SDK defect rather than a design constraint — raised as
 * arkade-os/ts-sdk#787. If it lands, DELETE STAGE TWO rather than keeping it out
 * of momentum: stage one alone would then be sufficient.
 */

import type { CreateContractParams } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { covenantScriptFromRow } from './covenantRow.js'
import {
  liveLockupRows,
  lockupContractRegistration,
  LOCKUP_CONTRACT_KIND,
  LOCKUP_CONTRACT_TYPE,
} from './vtxoLifecycle.js'
import type { LockupDeadline } from './vtxoLifecycle.js'
import type { CorridorReaderSet } from '@arkade-os/solver-core/core/corridor.js'

/** A contract a corridor currently holds, and what it takes to register it. */
export interface LiveContract {
  /** pkScript hex. The identity of a contract everywhere in this module. */
  script: string
  /**
   * What `createContract` needs, or null when no registered handler can
   * express this script. Null is a correct answer, not a failure — it is the
   * forward contract for a corridor whose script no registered type can
   * truthfully express (the asset-offer source the module header names is the
   * candidate). No corridor in service returns null today: since the base
   * three-leaf program was deleted, `lockupContractRegistration` always can.
   */
  registration: CreateContractParams | null
  /** Absolute refund deadline, unix SECONDS, for the recovery guard. */
  refundLocktime: number
}

/**
 * A contract already in the wallet's repository, as the planner needs it.
 *
 * Read back from the rows rather than tracked in memory, deliberately: an
 * in-process set forgets everything on restart, and a lifecycle that only
 * retired what this particular process registered would never retire anything
 * on a service that restarts more often than its swaps close.
 */
export interface KnownContract {
  script: string
  /** Already disabled — `watch === 'retained'`. */
  retained: boolean
  /** When stage 1 disabled it, unix MILLIseconds, or null if never/unrecorded. */
  retiredAt: number | null
  /** Whether the script still holds an unspent output. */
  funded: boolean
}

/**
 * The spend facts of a VTXO as the funded gate needs them, typed structurally
 * rather than as the SDK's `VirtualCoin` so the interface names exactly what
 * it reads. Mirrors `hasTerminalSpend` (`isSpent || spentBy || settledBy`,
 * checked against SDK 0.4.66): the wire contract permits `isSpent: true` with
 * an empty `spentBy`, so all three facts are consulted — and a SWEPT output
 * is deliberately absent, so a batch-swept lockup still reads as funded and
 * stays protected until recovery drains it. Duplicated rather than imported
 * because the SDK's predicate is typed on the full `VirtualCoin`, which is
 * what would force this interface to carry fields it never reads.
 */
export interface LifecycleVtxo {
  isSpent?: boolean
  spentBy?: string
  settledBy?: string
}

/** `hasTerminalSpend`, over the structural slice this module defines. */
const hasTerminalSpend = (vtxo: LifecycleVtxo): boolean => Boolean(vtxo.isSpent || vtxo.spentBy || vtxo.settledBy)

/**
 * A repository row, as the ownership predicate sees it. Both fields are
 * optional because rows predating them exist: `watch` and `metadata` were
 * added after the first contracts were written.
 */
export interface KnownRow {
  script: string
  type?: string
  metadata?: Record<string, unknown> | null
}

/**
 * A corridor, as the lifecycle sees it: a name, a live set, and the rows it
 * owns. Named `CorridorSource` rather than `ContractSource` because
 * `lockupWatcher.ts` already exports a `ContractSource` — the SDK
 * ContractManager slice — and the two mean opposite things; the file that
 * imports both (the natural next step when a second corridor lands) would
 * have to alias one.
 */
export interface CorridorSource {
  /** Names the corridor in log lines. Never load-bearing. */
  readonly name: string
  live(): Promise<readonly LiveContract[]>
  /**
   * Whether a repository row belongs to this corridor.
   *
   * The engine retires nothing a source does not claim: an unfiltered
   * `getContractsWithVtxos()` also returns the wallet's OWN rows — `default`
   * and `delegate` contracts per signer and a `boarding` contract per signer,
   * registered by `ensureWalletContract` — and none of those can ever appear
   * in a corridor's live set, so without this gate every unfunded one would
   * be disabled on the first pass and deleted after the window. Ownership by
   * claim rather than by denylist, so a future SDK contract type falls
   * outside every source by construction.
   */
  owns(row: KnownRow): boolean
}

/** What one pass should do. Pure data, so the decision is testable without I/O. */
export interface LifecyclePlan {
  register: LiveContract[]
  disable: string[]
  delete: string[]
}

/**
 * Diff live contracts against the repository.
 *
 * BOTH RETIREMENT STAGES ARE GATED ON AN EMPTY SCRIPT, and that is a safety rule
 * rather than tidiness: the SDK raises `UnannotatableInputError` for a spend
 * naming a VTXO whose contract row is gone, so acting on a script that still
 * holds an unspent output would strand it. A script that is dead but non-empty is
 * left alone until it drains — including one funded again after being retained,
 * which `refundNow` warns is possible ("a lockup can be funded more than once").
 *
 * A retained row with no `retiredAt` is never deleted. Absence means "written
 * before this field existed", and guessing a retirement time would delete rows
 * the window was supposed to protect; it is re-stamped by the disable path
 * instead, which is why such a row appears in `disable` despite already being
 * retained.
 */
export const planContractLifecycle = (
  live: readonly LiveContract[],
  known: readonly KnownContract[],
  opts: { now: number; retentionMs: number },
): LifecyclePlan => {
  const liveScripts = new Set(live.map((contract) => contract.script))
  const knownScripts = new Set(known.map((contract) => contract.script))
  const retirable = known.filter((contract) => !liveScripts.has(contract.script) && !contract.funded)
  return {
    register: live.filter((contract) => contract.registration !== null && !knownScripts.has(contract.script)),
    disable: retirable
      .filter((contract) => !contract.retained || contract.retiredAt === null)
      .map((contract) => contract.script),
    delete: retirable
      .filter(
        (contract) =>
          contract.retained && contract.retiredAt !== null && opts.now - contract.retiredAt >= opts.retentionMs,
      )
      .map((contract) => contract.script),
  }
}

/**
 * The four BTC corridors as one source.
 *
 * The row's own script stays the authority, exactly as `registerLiveLockups`
 * had it: rebuilding something that derives a different pkScript would register
 * a contract against a script nothing is funded at, leaving the real lockup
 * unwatched while reporting success.
 *
 * PER-ROW ISOLATION IS LOAD-BEARING HERE, not tidiness. `covenantScriptFromRow`
 * THROWS for a row predating the client-unilateral refund leaf, and
 * {@link runContractLifecycle} reads a throwing source as an incomplete live set
 * and suppresses retirement for the entire pass. Letting one un-rebuildable
 * legacy row escape would therefore freeze retirement across every corridor,
 * permanently and silently. Skipped rows are reported, never swallowed.
 *
 * A skipped row is also absent from the live set, so it looks retirable. That is
 * safe because both retirement stages are gated on the script holding nothing
 * unspent: a terminal legacy row retires, a funded one is left alone until it
 * drains.
 */
export const lockupSource = (
  deps: CorridorReaderSet,
  hrp: string,
  serverKey: Uint8Array,
  log: (line: string) => void = () => {},
): CorridorSource => ({
  name: 'lockups',
  live: async () => {
    const out: LiveContract[] = []
    for (const row of await liveLockupRows(deps, log)) {
      try {
        const script = covenantScriptFromRow(row)
        if (hex.encode(script.pkScript) !== row.pkScript) continue
        out.push({
          script: row.pkScript,
          registration: lockupContractRegistration(script, script.address(hrp, serverKey).encode()),
          refundLocktime: row.refundLocktime,
        })
      } catch (error) {
        log(`lockup ${row.id} cannot be rebuilt, skipped: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return out
  },
  // `kind` is what every registration this service writes carries; the `type`
  // arm covers rows written before the metadata existed. Neither matches the
  // wallet's own `default`/`delegate`/`boarding` rows, which is the point.
  owns: (row) => row.metadata?.kind === LOCKUP_CONTRACT_KIND || row.type === LOCKUP_CONTRACT_TYPE,
})

/** Where stage 1 records when it disabled a contract. */
export const RETIRED_AT_KEY = 'retiredAt'

/** The four contract-manager methods this engine needs, and no more. */
export interface LifecycleManager {
  createContract(params: CreateContractParams): Promise<unknown>
  updateContract(script: string, updates: Record<string, unknown>): Promise<unknown>
  deleteContract(script: string): Promise<void>
  getContractsWithVtxos(): Promise<
    readonly {
      contract: { script: string; type?: string; watch?: string; metadata?: Record<string, unknown> | null }
      vtxos: readonly LifecycleVtxo[]
    }[]
  >
}

export interface LifecycleDeps {
  manager: LifecycleManager
  sources: readonly CorridorSource[]
  /** Injected so the retention window is testable without waiting 30 days. */
  now: () => number
  retentionMs: number
  log: (line: string) => void
}

/**
 * One pass: register what is new, disable what has died, delete what has been
 * disabled long enough, and report every live contract's deadline.
 *
 * Best-effort and per-row isolated throughout: a contract that cannot be acted
 * on must not stop the others, and must not stop the renewal that is the whole
 * reason this pass runs.
 *
 * A SOURCE THAT THROWS SUPPRESSES RETIREMENT for that pass, and the asymmetry
 * is deliberate. A partial live set can be trusted to say what EXISTS — those
 * contracts are registered as usual — but never to say what is GONE: a
 * corridor that failed to answer has not said its contracts are dead. Without
 * this, one flaky store read would retire three other corridors' live
 * contracts. Registration is idempotent so the optimistic half costs nothing.
 *
 * Deadlines come back for every contract in the CURRENT live set, registered
 * on this pass or an earlier one, because the recovery guard has to know
 * about a lockup whether or not this particular pass was the one that
 * registered it. A source that failed contributes nothing, so with
 * `complete = false` the returned list is a PARTIAL subset — callers needing
 * completeness must derive deadlines independently (as `lockupDeadlinesOf`
 * does) rather than rely on this return value.
 */
export const runContractLifecycle = async (deps: LifecycleDeps): Promise<LockupDeadline[]> => {
  const live: LiveContract[] = []
  let complete = true
  for (const source of deps.sources) {
    try {
      live.push(...(await source.live()))
    } catch (error) {
      complete = false
      deps.log(`contract source ${source.name} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // The one manager call that cannot be per-row isolated is the snapshot
  // itself, and it gets the same treatment every throwing source gets: catch,
  // log, and read an unreadable repository as "register what the sources
  // answered, retire nothing this pass". `ContractManager.getContractsWithVtxos`
  // rethrows what `isRetryableProviderError` rejects, so without this a single
  // non-retryable indexer answer propagated out of the engine into the watch
  // loop's `try` — the same one `runFloatLifecycle` sits in — and cost a full
  // cadence of renewal and recovery, reported as one `vtxo lifecycle failed`
  // line that names registration rather than the float.
  let rows: Awaited<ReturnType<LifecycleManager['getContractsWithVtxos']>>
  try {
    rows = await deps.manager.getContractsWithVtxos()
  } catch (error) {
    complete = false
    rows = []
    deps.log(
      `contract snapshot unreadable, retiring nothing this pass: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  // Only rows a corridor claims are the lifecycle's business. The unfiltered
  // snapshot also carries the wallet's own rows (`default`/`delegate` per
  // signer, `boarding` per signer), which no corridor's live set can ever
  // contain — retiring those would drop the wallet's receive contract from
  // the watcher and, after the window, delete it under `pickActiveReceive`.
  // It does not self-heal: `createContract` on an existing script returns it
  // untouched, and `getContractManager()`'s ensure pass runs once per process.
  const ownedRows = rows.filter((row) => deps.sources.some((source) => source.owns(row.contract)))
  const rowsByScript = new Map(ownedRows.map((row) => [row.contract.script, row]))
  const known: KnownContract[] = ownedRows.map((row) => ({
    script: row.contract.script,
    retained: row.contract.watch === 'retained',
    retiredAt:
      typeof row.contract.metadata?.[RETIRED_AT_KEY] === 'number'
        ? (row.contract.metadata[RETIRED_AT_KEY] as number)
        : null,
    // UNSPENT only: the repository keeps spent rows forever, so counting them
    // would leave every settled lockup — the precise set retirement exists
    // for — permanently funded, and neither stage would ever fire.
    funded: row.vtxos.some((vtxo) => !hasTerminalSpend(vtxo)),
  }))

  const now = deps.now()
  // `complete ? known : []` reads oddly and is deliberate: a source that
  // failed to answer has not said its contracts are GONE, so retirement sees
  // nothing rather than a partial truth. The cost is one pass of idempotent
  // re-registration across the live set, not a correctness hazard.
  const plan = planContractLifecycle(live, complete ? known : [], { now, retentionMs: deps.retentionMs })

  for (const contract of plan.register) {
    try {
      await deps.manager.createContract(contract.registration as CreateContractParams)
    } catch (error) {
      deps.log(
        `contract registration ${contract.script} failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  for (const script of plan.disable) {
    try {
      const existing = rowsByScript.get(script)?.contract.metadata ?? {}
      await deps.manager.updateContract(script, {
        watch: 'retained',
        metadata: { ...existing, [RETIRED_AT_KEY]: now },
      })
    } catch (error) {
      deps.log(`contract disable ${script} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const script of plan.delete) {
    try {
      await deps.manager.deleteContract(script)
    } catch (error) {
      deps.log(`contract delete ${script} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return live.map((contract) => ({ script: contract.script, refundLocktime: contract.refundLocktime }))
}
