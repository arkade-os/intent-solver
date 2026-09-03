/**
 * The server-independent spend of a covenant lockup: land the VTXO on Bitcoin
 * with no help from the Arkade Service, then spend the leaf that needs nobody.
 *
 * This closes the long-standing unilateral-exit gap. Until it existed, an Arkade
 * Service that CENSORED rather than merely vanished was an unmitigated loss on
 * both sides of every corridor: `refund` needs the Service to co-sign, `claim`
 * needs it to co-sign, and the two leaves that need nobody — `unilateralClaim`
 * and `unilateralRefundWithoutReceiver` — existed in every script this service
 * has ever funded with no code able to reach them.
 *
 * WHAT IS OURS AND WHAT IS THE SDK'S. `@arkade-os/sdk`'s `UnilateralExit` does
 * the exit itself: it unrolls the VTXO's chain onto Bitcoin, funds each
 * transaction's CPFP child, pre-signs the CSV sweep, and drives the package to
 * completion from nothing but an Esplora-compatible endpoint. It picks the leaf
 * too — `resolveUnilateralPath` asks the registered contract handler for every
 * path that will EVER be valid with `collaborative: false`, and `vhtlc-v2`
 * answers with exactly one per role: `unilateralClaim` (plus the preimage as
 * extra witness) to the receiver, `unilateralRefundWithoutReceiver` to the
 * sender.
 *
 * What the SDK CANNOT know is whether that is the leaf we meant. It derives the
 * role by matching our wallet key against the contract row's own
 * `sender`/`receiver` params, so the role cannot be forged — but our
 * EXPECTATION of it can be wrong, and the two legs invert:
 *
 *   `arkade:BTC->lightning:BTC`   the client funds, the solver receives
 *                                 -> the solver is the covenant `receiver`
 *                                 -> its solo path is `unilateralClaim`
 *   `lightning:BTC->arkade:BTC`   the SOLVER funds, the client receives
 *                                 -> the solver is the covenant `client`
 *                                 -> its solo path is `unilateralRefundWithoutReceiver`
 *
 * So {@link planUnilateralExit} settles the question BEFORE any fee is spent,
 * from the row alone, and {@link assertExitMatchesPlan} checks afterwards that
 * the SDK reached the same answer. A disagreement is not a warning: it means
 * the row and the registered contract describe different lockups, and the exit
 * is abandoned rather than pushed.
 *
 * TIMING IS THE OTHER HALF, and it is not ours to enforce. Each leaf carries its
 * own BIP68 relative timelock, the sweep is signed with that `nSequence`, and
 * consensus refuses it until the VTXO's own transaction has been confirmed that
 * long — so this code CANNOT spend a leaf before its CSV opens however wrong it
 * is. The clock starts when the exit lands onchain, not when the lockup was
 * funded, which is why nothing here waits for maturity before starting: starting
 * is what begins the wait.
 *
 * What consensus does NOT check is that the two leaves were written in the right
 * ORDER. `unilateralRefundWithoutReceiver` opens `SOLO_REFUND_HEADROOM_SECONDS`
 * (or `SOLO_REFUND_HEADROOM_BLOCKS`) LATER than `unilateralClaim`, deliberately,
 * so that a funder cannot refund out from under a claimant holding a valid
 * preimage. Both leaves are individually valid whatever their delays, so a row
 * whose ladder inverted spends perfectly and steals. That ordering is asserted
 * here, from BOTH sides — it is the ROW that is unsafe, not one party's use of
 * it.
 */

import type { ExitOptions, ExitPackage, ExitQuote, ExitVtxoInfo } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { rawDelaySeconds, relativeDelayFrom, type RelativeDelay } from '@arkade-os/solver-core/core/timelocks.js'
import { covenantScriptFromRow, type CovenantScriptRow } from './covenantRow.js'

/**
 * The two leaves a party can spend ALONE, named as `VHTLC.ScriptV2` names them
 * rather than as `covenant.ts`'s accessor table does.
 *
 * The SDK's own labels, because that is what a disagreement has to be compared
 * against: `resolveUnilateralPath` reports `vhtlc-v2:unilateral` and the handler
 * builds the leaf from one of these two methods. Our `refundUnilateral`
 * accessor is the same leaf under a different name; using the SDK's spelling
 * here keeps the comparison a string equality rather than a mapping that can
 * drift.
 */
export type UnilateralLeaf = 'unilateralClaim' | 'unilateralRefundWithoutReceiver'

/** Which covenant role a key plays, spelled as `VHTLC.Options` spells it. */
export type CovenantRole = 'receiver' | 'sender'

/** What a server-independent exit of one lockup will do, decided from the row alone. */
export interface UnilateralExitPlan {
  /** The swap row this plan belongs to. */
  swapId: string
  /** The lockup's pkScript, hex — the identity of a contract everywhere in this service. */
  pkScript: string
  /**
   * The solver's own x-only key, hex, as the role was resolved against.
   *
   * Carried on the plan rather than left with the caller because the check that
   * the SDK will reach the same role — {@link assertRegisteredRole} — asks the
   * registered contract row about THIS key, and taking it from anywhere else
   * would let the two answers be about different keys.
   */
  solverPubkey: string
  /**
   * Which covenant role the solver plays on this leg. `sender` is the covenant's
   * `client`: the two names are the same party, and this one is the SDK's.
   */
  role: CovenantRole
  /** The leaf the exit's sweep will spend. */
  leaf: UnilateralLeaf
  /**
   * The leaf's CSV, in the unit the row's own ladder counts. Both rungs share a
   * unit — a ladder that mixes them is refused.
   */
  delay: RelativeDelay
  /**
   * The same CSV as seconds, for reasoning against a wall clock ONLY.
   *
   * NEVER for building a script: a block delay converted here and then written
   * into a leaf encodes the converted SECONDS, a different timelock from the
   * blocks that were meant. See `relativeDelaySeconds`.
   */
  delaySeconds: number
  /**
   * The preimage the sweep's witness needs, hex, or null for a leaf that takes
   * none.
   *
   * Null for `unilateralRefundWithoutReceiver` even when the solver holds one:
   * that leaf's script has no preimage fragment, so an extra witness item makes
   * the spend invalid rather than merely redundant.
   */
  preimage: string | null
}

/** What the caller knows that the row does not. */
export interface UnilateralExitInput {
  /** The solver's own x-only public key, hex — whichever role it plays on this leg. */
  solverPubkey: string
  /**
   * The 32-byte preimage, hex. Required for `unilateralClaim` and refused if it
   * does not hash to the row's own payment hash; ignored for the refund leaf.
   */
  preimage?: string | null
}

/** Hex compared as hex, so a row written in either case still matches a key. */
const sameKey = (a: string | null, b: string): boolean =>
  typeof a === 'string' && a.length > 0 && a.toLowerCase() === b.toLowerCase()

/**
 * Which role the solver's key plays on this row — the same question the SDK's
 * `resolveRole` answers, asked of the same two fields.
 *
 * `covenantScriptFromRow` maps `clientRefundPubkey` onto the script's `sender`
 * and `receiverPubkey` onto its `receiver`, and the contract row registered for
 * that script carries those two verbatim. So matching here and matching there
 * read the same bytes.
 *
 * A key named as BOTH is refused rather than resolved. The SDK would silently
 * pick `sender` (its `matchRole` tests that arm first), and on a row where the
 * two collide that is a coin flip between the claim and the refund — opposite
 * directions for the money. Nothing legitimate produces such a row.
 */
const resolveSolverRole = (row: CovenantScriptRow, solverPubkey: string): CovenantRole => {
  const isReceiver = sameKey(row.receiverPubkey, solverPubkey)
  const isClient = sameKey(row.clientRefundPubkey, solverPubkey)
  if (isReceiver && isClient) {
    throw new Error(
      `swap ${row.id} names one key as both the receiver and the client, so which leaf is the solver's ` +
        'solo path is undecidable — the claim and the refund send the money to opposite parties',
    )
  }
  if (isReceiver) return 'receiver'
  if (isClient) return 'sender'
  throw new Error(
    `swap ${row.id} names the solver as neither the receiver nor the client, so it has no leaf of its own ` +
      'to spend: the lockup belongs to two other parties',
  )
}

/**
 * The ladder ordering `SOLO_REFUND_HEADROOM_SECONDS` exists to guarantee,
 * checked against the row rather than assumed from the code that wrote it.
 *
 * Asserted for BOTH roles, and that is the point: an inverted ladder is a
 * property of the ROW. From the funder's side it is an invitation to steal;
 * from the claimant's it is a warning that their own recourse can be taken away
 * mid-exit — and an operator about to spend real fees on a multi-day exit
 * should learn that before, not after.
 *
 * `deriveUnilateralDelays` cannot produce a violation: it builds both rungs in
 * one unit and stacks the headroom itself. A row assembled by hand, or written
 * across a unit change, can.
 */
const assertLadderOrdering = (row: CovenantScriptRow): void => {
  const claim = relativeDelayFrom(row.claimDelay)
  const solo = relativeDelayFrom(row.refundWithoutReceiverDelay)
  if (claim.unit !== solo.unit) {
    throw new Error(
      `swap ${row.id} has a unilateral ladder whose rungs count different clocks: claim ${row.claimDelay} ` +
        `(${claim.unit}) against solo refund ${row.refundWithoutReceiverDelay} (${solo.unit}) — both must ` +
        'count the same clock or their order is meaningless',
    )
  }
  if (solo.value <= claim.value) {
    throw new Error(
      `swap ${row.id} has an inverted unilateral ladder: its solo refund opens at or before its claim ` +
        `(${row.refundWithoutReceiverDelay} against ${row.claimDelay} ${claim.unit}), so the funder could ` +
        'take the lockup from a claimant holding a valid preimage',
    )
  }
}

/**
 * The preimage the claim leaf's witness needs, verified against the row.
 *
 * Both checks matter and they fail differently. A wrong preimage produces a
 * witness the script rejects, which surfaces only at the sweep — days into an
 * exit, with the fees already spent. A preimage of the wrong LENGTH is caught by
 * `OP_SIZE 32 OP_EQUALVERIFY` in the same place, which is why the length is
 * checked here rather than left to the hash comparison to notice.
 */
const assertClaimPreimage = (row: CovenantScriptRow, preimage: string | null | undefined): string => {
  if (!preimage) {
    throw new Error(
      `swap ${row.id} needs the preimage to spend its unilateralClaim leaf: that leaf is the receiver's ` +
        'key plus the secret, and there is no other witness for it',
    )
  }
  let bytes: Uint8Array
  try {
    bytes = hex.decode(preimage)
  } catch {
    throw new Error(`swap ${row.id} was given a preimage that is not hex`)
  }
  if (bytes.length !== 32) {
    throw new Error(
      `swap ${row.id} was given a ${bytes.length}-byte preimage; the claim leaf pins 32 bytes with OP_SIZE`,
    )
  }
  const hash = hex.encode(sha256(bytes))
  if (hash !== row.paymentHash.toLowerCase()) {
    throw new Error(`swap ${row.id} was given a preimage that does not hash to its payment hash ${row.paymentHash}`)
  }
  return hex.encode(bytes)
}

/**
 * Decide, from the row alone, what a server-independent exit of this lockup
 * would do — before a single sat of fee is committed.
 *
 * Every refusal here is cheaper than the same refusal later: `UnilateralExit`
 * skips a VTXO it cannot resolve a path for and reports it as one line inside a
 * package, and `prepare` broadcasts a funding splitter before any of that is
 * visible.
 *
 * Order is deliberate — the cheap, row-local questions first, the taproot
 * derivation last — so a degenerate row is refused by the check that names it
 * rather than blowing up inside script construction.
 */
export const planUnilateralExit = (row: CovenantScriptRow, input: UnilateralExitInput): UnilateralExitPlan => {
  const shape = unilateralExitShape(row, input.solverPubkey)
  return {
    ...shape,
    preimage: shape.leaf === 'unilateralClaim' ? assertClaimPreimage(row, input.preimage) : null,
  }
}

/**
 * Everything about the exit that the preimage does not decide: the role, the
 * leaf and its CSV.
 *
 * Separate from the preimage check because the two answer different questions
 * and one caller needs only the first. WHICH leaf a censored lockup's recourse
 * is, and how long it takes, is a property of the row; whether we can execute it
 * right now also depends on holding a secret. A reporting path that demanded the
 * secret would report "no recourse" for a SEND leg whose recourse plainly
 * exists, which is the opposite of what it is for.
 */
const unilateralExitShape = (row: CovenantScriptRow, solverPubkey: string): Omit<UnilateralExitPlan, 'preimage'> => {
  const role = resolveSolverRole(row, solverPubkey)
  assertLadderOrdering(row)

  // The lockup is its script, so a row that does not agree with its own
  // `pkScript` would drive an exit against something nothing is funded at. The
  // same refusal `lockupSource` makes before registering a contract, made again
  // here because this path spends money rather than merely watching.
  const derived = hex.encode(covenantScriptFromRow(row).pkScript)
  if (derived !== row.pkScript.toLowerCase()) {
    throw new Error(
      `swap ${row.id} does not derive its own pkScript: the row stores ${row.pkScript} and its fields ` +
        `build ${derived}`,
    )
  }

  const leaf: UnilateralLeaf = role === 'receiver' ? 'unilateralClaim' : 'unilateralRefundWithoutReceiver'
  const raw = leaf === 'unilateralClaim' ? row.claimDelay : row.refundWithoutReceiverDelay
  return {
    swapId: row.id,
    pkScript: row.pkScript,
    solverPubkey: solverPubkey.toLowerCase(),
    role,
    leaf,
    delay: relativeDelayFrom(raw),
    delaySeconds: rawDelaySeconds(raw),
  }
}

/**
 * One line naming this row's server-independent recourse, or naming why it has
 * none.
 *
 * NEVER THROWS, and that is its whole reason to exist separately from
 * {@link planUnilateralExit}. Its caller is a failure path — the orchestrator
 * recording why a collaborative refund gave up — and a recourse line that could
 * itself throw would replace a diagnosis an operator needs with a stack trace
 * about the diagnosis.
 *
 * It reports the SHAPE only, so a SEND leg's claim recourse is named even where
 * the caller holds no preimage to pass. Nothing signs from this: the plan is
 * rebuilt with the real secret before a witness exists.
 */
export const unilateralExitRecourse = (row: CovenantScriptRow, input: UnilateralExitInput): string => {
  try {
    const shape = unilateralExitShape(row, input.solverPubkey)
    return (
      `server-independent recourse: spend ${shape.leaf} after a unilateral exit, ` +
      `${shape.delay.value} ${shape.delay.unit} of CSV from the moment the lockup lands onchain`
    )
  } catch (error) {
    return `no server-independent recourse: ${error instanceof Error ? error.message : String(error)}`
  }
}

// ---------------------------------------------------------------------------
// Driving the exit
// ---------------------------------------------------------------------------

/** An unspent output at the lockup, as every corridor's `findLockups` already reports one. */
export interface ExitOutpoint {
  txid: string
  vout: number
}

/**
 * `UnilateralExit`, narrowed to the two entry points this module calls and
 * injected rather than imported.
 *
 * Injected because both need a live indexer, an Esplora endpoint and a funded
 * onchain wallet, and because `prepare` BROADCASTS a funding splitter as a side
 * effect — so the checks around the call have to be exercisable without one.
 * `execute` and `Executor` are deliberately absent: driving a prepared package
 * to completion is keyless and provider-only, which is what makes it the
 * operator's step rather than this module's.
 */
export interface ExitPrimitive {
  estimate(opts: ExitOptions): Promise<ExitQuote>
  prepare(opts: ExitOptions): Promise<ExitPackage>
}

/**
 * Read and patch the registered contract row the exit resolves its leaf from.
 *
 * Narrow on purpose: this is `ContractManager`'s `getContracts`/`updateContract`
 * pair seen through the one keyhole an exit needs, so nothing here can retire a
 * contract or move a lockup while arming one.
 */
export interface ExitContractAccess {
  /** The registered contract's params for a script, or null when no row exists. */
  params(script: string): Promise<Record<string, string> | null>
  /** Merge `patch` into that row's params, leaving every other key alone. */
  patchParams(script: string, patch: Record<string, string>): Promise<void>
}

export interface UnilateralExitDeps {
  exit: ExitPrimitive
  /**
   * Everything `ExitOptions` needs beyond the outpoints: the wallet, the fee
   * wallet and where the exited funds land.
   *
   * `vtxos` is excluded rather than left optional, because omitting it defaults
   * the exit to "all spendable VTXOs" — which on this wallet is the solver's
   * whole float, not one lockup.
   */
  options: Omit<ExitOptions, 'vtxos'>
  contracts: ExitContractAccess
  /** The lockup's unspent outpoints, as the corridor already reads them. */
  findLockups(pkScriptHex: string): Promise<readonly ExitOutpoint[]>
}

/** An outpoint the exit left out, with its own reason. */
export interface SkippedOutpoint {
  outpoint: string
  reason: string
}

export interface UnilateralExitOutcome<T> {
  plan: UnilateralExitPlan
  /** The outpoints the exit was asked for. */
  outpoints: ExitOutpoint[]
  /**
   * Outpoints the exit could not include. Reported rather than thrown on: an
   * uneconomic output is a true answer about that output and must not block the
   * others, but leaving money behind silently is exactly what an operator has to
   * be told.
   */
  skipped: SkippedOutpoint[]
  result: T
}

/**
 * The registered contract row must name the solver in the role the plan
 * resolved, and only that role.
 *
 * This is the SDK's `resolveRole` asked in advance, of the same row and the same
 * key. `resolveUnilateralPath` passes no explicit role, so the leaf it picks
 * follows entirely from matching our wallet's x-only key against this row's
 * `sender`/`receiver` params — meaning a row that disagrees with the swap row
 * exits through the OTHER party's leaf, or through none, and says nothing.
 *
 * The contract is registered FROM the swap row, so agreement is the normal case;
 * a disagreement means it was registered from a different shape, and the exit is
 * abandoned rather than pushed.
 */
const assertRegisteredRole = (plan: UnilateralExitPlan, params: Record<string, string>): void => {
  const isReceiver = sameKey(params.receiver ?? null, plan.solverPubkey)
  const isSender = sameKey(params.sender ?? null, plan.solverPubkey)
  if (isReceiver && isSender) {
    throw new Error(
      `the contract registered for ${plan.pkScript} names the solver as both its sender and its receiver, ` +
        'so the leaf it would resolve is undecidable',
    )
  }
  if (!(plan.role === 'receiver' ? isReceiver : isSender)) {
    throw new Error(
      `the contract registered for ${plan.pkScript} does not name the solver as its ${plan.role}, but swap ` +
        `${plan.swapId} does — the exit would resolve a different leaf than this plan chose`,
    )
  }
}

/**
 * Put the preimage on the contract row, because without it the claim leaf is not
 * merely unavailable — it is not OFFERED.
 *
 * `VHTLCV2ContractHandler.getAllSpendingPaths` gates the receiver's unilateral
 * path on `contract.params.preimage`, and `lockupContractRegistration` writes
 * none: it serializes `VHTLC.Options`, which has no preimage field. So a
 * receiver-role exit against an unarmed row yields ZERO paths, the outpoint is
 * skipped as `no unilateral path`, and `prepare` reports `no exitable vtxos` — a
 * message naming neither the cause nor the fix.
 *
 * Safe to write. `deserializeParams` reads only the keys it names, so an extra
 * `preimage` does not change the script the row derives, and `updateContract`
 * re-derives nothing anyway. It is the SDK's own channel for this: the handler
 * reads exactly this key.
 *
 * Written whenever it differs, including over an existing value:
 * {@link planUnilateralExit} has already checked this preimage against the row's
 * payment hash, and a stale one left in place would build a witness the script
 * rejects days later, at the sweep.
 */
const armContractForExit = async (deps: UnilateralExitDeps, plan: UnilateralExitPlan): Promise<void> => {
  const params = await deps.contracts.params(plan.pkScript)
  if (params === null) {
    throw new Error(
      `no contract registered for ${plan.pkScript}: the exit resolves its leaf from that row, so swap ` +
        `${plan.swapId} cannot be exited until the contract lifecycle has registered it`,
    )
  }
  assertRegisteredRole(plan, params)
  if (plan.preimage !== null && params.preimage !== plan.preimage) {
    await deps.contracts.patchParams(plan.pkScript, { preimage: plan.preimage })
  }
}

/**
 * Check that what came back names the leaf the plan chose, and collect what was
 * left out.
 *
 * IT READS THE DELAY, NOT THE LABEL. `resolveUnilateralPath` labels every
 * contract-backed path `<type>:unilateral` whichever leaf it selected, so the
 * label cannot tell the claim from the refund. The two leaves' CSVs differ by
 * the solo-refund headroom, and {@link planUnilateralExit} refuses any row where
 * they do not — which is what makes the delay a faithful stand-in for the leaf
 * rather than a coincidence.
 */
const assertExitMatchesPlan = (plan: UnilateralExitPlan, infos: readonly ExitVtxoInfo[]): SkippedOutpoint[] => {
  const skipped: SkippedOutpoint[] = []
  for (const info of infos) {
    if (info.skipped !== undefined) {
      skipped.push({ outpoint: info.outpoint, reason: info.skipped })
      continue
    }
    const delay = info.delay
    if (delay === undefined || delay.type !== plan.delay.unit || delay.value !== plan.delay.value) {
      const seen = delay === undefined ? 'no delay at all' : `${delay.value} ${delay.type}`
      throw new Error(
        `the exit resolved ${info.outpoint} to a leaf this plan did not choose: ${plan.leaf} carries ` +
          `${plan.delay.value} ${plan.delay.unit} of CSV and the exit reports ${seen}`,
      )
    }
  }
  return skipped
}

const runExit = async <T extends { vtxos: ExitVtxoInfo[] }>(
  deps: UnilateralExitDeps,
  plan: UnilateralExitPlan,
  call: (opts: ExitOptions) => Promise<T>,
): Promise<UnilateralExitOutcome<T>> => {
  const outpoints = (await deps.findLockups(plan.pkScript)).map((out) => ({ txid: out.txid, vout: out.vout }))
  if (outpoints.length === 0) {
    throw new Error(
      `swap ${plan.swapId} has nothing unspent at ${plan.pkScript}: the lockup was never funded, or it is ` +
        'already spent',
    )
  }
  // Before the call, never after: `prepare` broadcasts a funding splitter, so
  // arming afterwards would mean paying for an exit that resolved no path.
  await armContractForExit(deps, plan)
  const result = await call({ ...deps.options, vtxos: outpoints })
  return { plan, outpoints, skipped: assertExitMatchesPlan(plan, result.vtxos), result }
}

/**
 * What a server-independent exit of this lockup would cost, and which leaf it
 * would spend. Signs nothing, broadcasts nothing, touches no funds.
 *
 * The step to run first, always: it reaches every refusal
 * {@link startUnilateralExit} does, at no cost.
 */
export const quoteUnilateralExit = (
  deps: UnilateralExitDeps,
  plan: UnilateralExitPlan,
): Promise<UnilateralExitOutcome<ExitQuote>> => runExit(deps, plan, (opts) => deps.exit.estimate(opts))

/**
 * Build the pre-signed exit package for this lockup.
 *
 * NOT REVERSIBLE. `prepare` signs every transaction needed to land the VTXOs on
 * Bitcoin and BROADCASTS the fee-funding splitter as a side effect, spending the
 * solver's own onchain sats to reserve the fee budget. What it returns is
 * keyless: driving it to completion needs only an Esplora-compatible endpoint,
 * and the sweep inside it cannot confirm until the leaf's CSV has matured from
 * the moment the lockup lands onchain.
 *
 * THE LEAF CHECK LANDS AFTER THAT SPLITTER, unavoidably: the leaf is only
 * reported once the package is built. It is a backstop, not the guard —
 * {@link assertRegisteredRole} asks the SAME row the same question before the
 * call, which is what makes a late disagreement close to impossible. What
 * actually makes this cheap is running {@link quoteUnilateralExit} first: it
 * reaches this identical check with nothing signed and nothing spent.
 */
export const startUnilateralExit = (
  deps: UnilateralExitDeps,
  plan: UnilateralExitPlan,
): Promise<UnilateralExitOutcome<ExitPackage>> => runExit(deps, plan, (opts) => deps.exit.prepare(opts))
