/**
 * Runtime settings overrides, layered onto the environment.
 *
 * THE CONSOLE LAYER IS NOT NARROW-ONLY, by deliberate decision. `narrow()` still
 * governs the ENV layers, but an override set here REPLACES the environment's bound in
 * either direction, including upward, and `MAX_EXPOSED_SATS` may be raised as well as
 * lowered.
 *
 * That drops the property the layering was built on — each step only ever reducing the
 * amount at risk — so the environment is a starting point rather than a ceiling. The
 * admin API has NO AUTHENTICATION of its own (see `server.ts`; a reverse proxy is
 * expected to supply it), so anything that can reach the admin port can raise this
 * solver's per-swap and total exposure caps. `adminHost` and that proxy stand in front
 * of it.
 *
 * Fees are free in both directions — a pricing question, not a safety one — and still
 * move inside the bounds `src/config.ts` validates.
 *
 * Everything here is PURE: a Config and a bag of strings in, a new Config out.
 * `AdminStore` owns persistence and the settings route owns application.
 */

import type { Config } from '../config.js'
import { CORRIDORS, FREE, type Corridor, type Fee } from '@arkade-os/solver-core/core/corridorPolicy.js'
import { descriptorFor } from '@arkade-os/solver-corridors/corridors/index.js'
import { MAX_LOCKUP_TIMEOUT } from '@arkade-os/solver-core/core/send.js'

export type KnobSource = 'env' | 'override'

export interface KnobView {
  key: string
  value: string | number | boolean
  source: KnobSource
  /** False for knobs the console shows but cannot change. */
  editable: boolean
  /** Set when a knob is editable but the change cannot take effect until restart. */
  restartRequired?: boolean
}

/**
 * The floor `config.ts` puts under `LOCKUP_TIMEOUT_SECONDS`, restated here for
 * the same reason the fee bounds are: a mismatch would let the console set what
 * the environment refuses.
 *
 * The CEILING is not restated — `MAX_LOCKUP_TIMEOUT` is imported, because it is
 * derived (`= REFUND_SAFETY_MARGIN`) and a copied number would drift from the
 * margin it is the same quantity as.
 */
const LOCKUP_TIMEOUT_MIN = 60

/** Same bounds `corridorFeesFromEnv` enforces; a mismatch would let the console set what the env refuses. */
const FEE_BPS_MAX = 9_999
const FEE_FLAT_MAX = 1_000_000

const stemOf = (corridor: Corridor): string => descriptorFor(corridor).envStem

/** Which corridor a `<STEM>_...` key belongs to, or null if the stem is unknown. */
const corridorForKey = (key: string): { corridor: Corridor; suffix: string } | null => {
  for (const corridor of CORRIDORS) {
    const stem = stemOf(corridor)
    if (key.startsWith(`${stem}_`)) return { corridor, suffix: key.slice(stem.length + 1) }
  }
  return null
}

const CORRIDOR_SUFFIXES = ['FEE_BPS', 'FEE_FLAT_SATS', 'MIN_SATS', 'MAX_SATS', 'ENABLED'] as const
/**
 * Console-editable knobs that belong to no corridor.
 *
 * `LOCKUP_TIMEOUT_SECONDS` is here rather than in the read-only block because it
 * is POLICY — how long a send quote stays fundable — and policy is what this
 * surface exists to let an operator tune. The read-only entries below are
 * deployment facts (which backend, which URL, which database) that a console
 * cannot meaningfully change.
 */
const GLOBAL_KEYS = ['MAX_EXPOSED_SATS', 'LOCKUP_TIMEOUT_SECONDS'] as const

/** Every key the console may write. Derived from the corridor list so it cannot drift from it. */
export const editableKeys = (): string[] => [
  ...CORRIDORS.flatMap((corridor) => CORRIDOR_SUFFIXES.map((suffix) => `${stemOf(corridor)}_${suffix}`)),
  ...GLOBAL_KEYS,
]

const positiveInt = (key: string, raw: string): number => {
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer, got ${raw}`)
  return value
}

const boundedInt = (key: string, raw: string, max: number): number => {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${key} must be an integer between 0 and ${max}, got ${raw}`)
  }
  return value
}

/**
 * Reject an override the console must not apply, with the reason an operator
 * needs. Throws; returns nothing.
 *
 * Called before persisting, so a refused override is never stored — a stored
 * override that is silently ignored on load would be the worst of both.
 */
export const validateOverride = (config: Config, key: string, value: string): void => {
  if (!editableKeys().includes(key)) {
    throw new Error(`${key} is not editable from the console`)
  }

  if (key === 'MAX_EXPOSED_SATS') {
    // Free in both directions. Raising this raises the total the solver can
    // have in flight at once, above whatever the environment set.
    positiveInt(key, value)
    return
  }

  if (key === 'LOCKUP_TIMEOUT_SECONDS') {
    // BOUNDED, unlike the exposure cap, and both ends earn their place.
    //
    // The floor rules out a window nobody could fund in time. The ceiling is
    // `REFUND_SAFETY_MARGIN` under another name: a funding window longer than
    // the margin would quote a deadline the swap's own refund cannot sit
    // behind. `payableCltvBlocks` enforces the real invariant at payment time
    // whatever this says, so a bad value here costs refusals rather than money
    // — but refusing at the console is where an operator can still see why.
    const seconds = positiveInt(key, value)
    if (seconds < LOCKUP_TIMEOUT_MIN || seconds > MAX_LOCKUP_TIMEOUT) {
      throw new Error(`${key} must be between ${LOCKUP_TIMEOUT_MIN} and ${MAX_LOCKUP_TIMEOUT} seconds, got ${value}`)
    }
    return
  }

  const match = corridorForKey(key)
  // editableKeys() already admitted the key, so a null here would mean the two
  // have drifted apart; say so rather than proceeding on a guess.
  if (!match) throw new Error(`${key} has no known corridor stem`)
  const { corridor, suffix } = match

  if (suffix === 'FEE_BPS') {
    boundedInt(key, value, FEE_BPS_MAX)
    return
  }
  if (suffix === 'FEE_FLAT_SATS') {
    boundedInt(key, value, FEE_FLAT_MAX)
    return
  }
  if (suffix === 'MIN_SATS' || suffix === 'MAX_SATS') {
    // Identical handling now that neither direction is refused: a positive
    // integer is the whole rule. Deliberately NOT checked against the opposing
    // bound here — this function sees one key at a time, and the route calls it
    // with the environment's Config, so the other bound may itself carry an
    // override this cannot see. Comparing against the env value would refuse
    // coherent pairs (a minimum raised above the env maximum, after the maximum
    // was raised further). The pair is checked in `applyOverrides`, which is
    // the only place both bounds are known at once.
    positiveInt(key, value)
    return
  }
  if (suffix === 'ENABLED') {
    if (value !== 'true' && value !== 'false') throw new Error(`${key} must be 'true' or 'false', got ${value}`)
    // A corridor the environment disabled has NO SERVICE OBJECT at all — see
    // createServices in src/cli.ts, which only constructs enabled corridors.
    // Accepting `true` here would store a preference that silently does
    // nothing, which is worse than refusing it.
    if (value === 'true' && !config.corridorEnabled[corridor]) {
      throw new Error(
        `${corridor} is disabled in the environment and cannot be enabled from the console; ` +
          'no service was constructed for it. Set its _ENABLED variable and restart.',
      )
    }
    return
  }
  throw new Error(`${key} is not editable from the console`)
}

/**
 * Layer overrides onto a Config, returning a NEW one. Never mutates its input.
 *
 * Silently skips any override that does not validate — a malformed value, or a
 * key that has since stopped being editable. `validateOverride` runs before
 * anything is persisted, so a stored-but-invalid override means the rules
 * changed underneath it; refusing to start in that case would take a solver
 * down over a preference.
 *
 * A stored bound is no longer skipped merely for exceeding the environment's.
 * That is the point of the change: an override REPLACES the env bound, upward
 * included. The environment is a starting point here, not a ceiling.
 */
export const applyOverrides = (config: Config, overrides: Record<string, string>): Config => {
  const corridorLimits = { ...config.corridorLimits }
  const corridorFees = { ...config.corridorFees }
  const corridorEnabled = { ...config.corridorEnabled }
  let maxExposedSats = config.maxExposedSats
  let lockupTimeoutSeconds = config.lockupTimeoutSeconds

  for (const [key, raw] of Object.entries(overrides)) {
    try {
      validateOverride(config, key, raw)
    } catch {
      continue
    }

    if (key === 'MAX_EXPOSED_SATS') {
      maxExposedSats = Number(raw)
      continue
    }
    if (key === 'LOCKUP_TIMEOUT_SECONDS') {
      lockupTimeoutSeconds = Number(raw)
      continue
    }
    const match = corridorForKey(key)
    if (!match) continue
    const { corridor, suffix } = match

    if (suffix === 'FEE_BPS' || suffix === 'FEE_FLAT_SATS') {
      const current = corridorFees[corridor]
      const next: Fee =
        suffix === 'FEE_BPS'
          ? { bps: Number(raw), flatSats: current.flatSats }
          : { bps: current.bps, flatSats: Number(raw) }
      // A whole new object rather than a mutated one, because this function
      // promises not to touch its argument — `applyOverrides` is pure and the
      // caller's Config must survive it unchanged.
      //
      // This is NOT about live-update atomicity. Nothing re-reads a running
      // service's policy: `SendSwapService` snapshots `fee` in its constructor.
      // An earlier version of this comment claimed otherwise and contradicted
      // `routes/settings.ts`'s own header.
      corridorFees[corridor] = next.bps === 0 && next.flatSats === 0 ? FREE : next
      continue
    }
    if (suffix === 'MIN_SATS' || suffix === 'MAX_SATS') {
      // Assigned, not narrowed. This used to route through `narrow()`, whose
      // Math.min/Math.max would have clamped a widening value straight back to
      // the environment's — leaving an override that validated, persisted, and
      // then did nothing. Dropping the refusal in `validateOverride` without
      // dropping this would have been exactly that silent no-op.
      const current = corridorLimits[corridor]
      corridorLimits[corridor] =
        suffix === 'MIN_SATS' ? { ...current, minSats: Number(raw) } : { ...current, maxSats: Number(raw) }
      continue
    }
    if (suffix === 'ENABLED') corridorEnabled[corridor] = raw === 'true'
  }

  // `narrow()` made a crossed range impossible; assignment does not. Both
  // bounds are known here and nowhere earlier, so this is where the pair is
  // checked. An empty range is not a safety problem — a corridor that admits
  // no amount quotes nothing — but it is a silent one, so fall back to the
  // environment's range rather than leave the corridor dark.
  for (const corridor of CORRIDORS) {
    const { minSats, maxSats } = corridorLimits[corridor]
    if (minSats > maxSats) corridorLimits[corridor] = config.corridorLimits[corridor]
  }

  return { ...config, corridorLimits, corridorFees, corridorEnabled, maxExposedSats, lockupTimeoutSeconds }
}

/**
 * Every knob the console displays, with where its value came from.
 *
 * EVERY editable knob is `restartRequired`, and that is a fact about the
 * plumbing rather than a limitation of this module. `createServices` hands
 * each service its policy at construction — `maxExposedSats` by value, the
 * others as references it then never revisits — and the orchestrator's `deps`
 * is `private readonly`, so nothing outside can hand a running service new
 * policy. Corridor toggles are read once too, when the ingress is built.
 *
 * Reported per knob anyway, rather than as one global flag, so that if the
 * plumbing ever grows a seam this becomes true incrementally instead of all at
 * once. See `routes/settings.ts` for the full derivation.
 */
export const describeSettings = (config: Config, overrides: Record<string, string>): KnobView[] => {
  const effective = applyOverrides(config, overrides)
  const sourceOf = (key: string): KnobSource => (overrides[key] === undefined ? 'env' : 'override')

  const knobs: KnobView[] = []
  for (const corridor of CORRIDORS) {
    const stem = stemOf(corridor)
    knobs.push(
      {
        key: `${stem}_ENABLED`,
        value: effective.corridorEnabled[corridor],
        source: sourceOf(`${stem}_ENABLED`),
        // Only ever narrowable to false; enabling needs a restart because no
        // service object exists for an env-disabled corridor.
        editable: config.corridorEnabled[corridor],
        restartRequired: true,
      },
      {
        key: `${stem}_FEE_BPS`,
        value: effective.corridorFees[corridor].bps,
        source: sourceOf(`${stem}_FEE_BPS`),
        editable: true,
        restartRequired: true,
      },
      {
        key: `${stem}_FEE_FLAT_SATS`,
        value: effective.corridorFees[corridor].flatSats,
        source: sourceOf(`${stem}_FEE_FLAT_SATS`),
        editable: true,
        restartRequired: true,
      },
      {
        key: `${stem}_MIN_SATS`,
        value: effective.corridorLimits[corridor].minSats,
        source: sourceOf(`${stem}_MIN_SATS`),
        editable: true,
        restartRequired: true,
      },
      {
        key: `${stem}_MAX_SATS`,
        value: effective.corridorLimits[corridor].maxSats,
        source: sourceOf(`${stem}_MAX_SATS`),
        editable: true,
        restartRequired: true,
      },
    )
  }

  knobs.push(
    {
      key: 'MAX_EXPOSED_SATS',
      value: effective.maxExposedSats,
      source: sourceOf('MAX_EXPOSED_SATS'),
      editable: true,
      restartRequired: true,
    },
    {
      key: 'LOCKUP_TIMEOUT_SECONDS',
      value: effective.lockupTimeoutSeconds,
      source: sourceOf('LOCKUP_TIMEOUT_SECONDS'),
      editable: true,
      restartRequired: true,
    },
    // Read-only below: everything a restart would be needed for anyway, and
    // nothing carrying key material. Secrets are never surfaced at all — not
    // redacted, simply absent, so there is no field for a bug to un-redact.
    { key: 'SWAP_NETWORK', value: config.network, source: 'env', editable: false },
    // `'unset'` rather than an omitted row: no rail is a real deployment state
    // (it serves no BTC corridor), and a missing row would read as a console
    // that failed to look rather than as an answer.
    { key: 'LN_BACKEND', value: config.lnBackend ?? 'unset', source: 'env', editable: false },
    // Surfaced BECAUSE it is dangerous, not despite it. This is the one knob
    // here that accepts a loss, so an operator auditing a deployment has to be
    // able to see whether it is on without reading the unit's environment.
    // Read-only like its neighbours: turning it off is a restart either way,
    // and this port has no authentication.
    {
      key: 'LN_RECEIVE_ACCEPT_UNILATERAL_GAP',
      value: config.lnReceiveAcceptUnilateralGap,
      source: 'env',
      editable: false,
    },
    { key: 'ARK_SERVER_URL', value: config.arkade.arkServerUrl, source: 'env', editable: false },
    { key: 'EMULATOR_URL', value: config.emulatorUrl, source: 'env', editable: false },
    // Both RESOLVED, which is what an operator needs from this page: `DB_DIR`
    // places them unless one of the two path knobs names a file, so the raw
    // directory is not the answer to "which files is this process using" — and
    // a `DB_DIR` that lost to an explicit path would read as though it had won.
    { key: 'SWAP_DB_PATH', value: config.swapDbPath, source: 'env', editable: false },
    { key: 'ARK_DB_PATH', value: config.arkade.databasePath, source: 'env', editable: false },
    { key: 'SWEEP_CONCURRENCY', value: config.sweepConcurrency, source: 'env', editable: false },
    // On this page for the same reason `LN_RECEIVE_ACCEPT_UNILATERAL_GAP` is:
    // a WRONG entry here is a fund-risk rather than a lost swap — a real
    // channel listed is priced out of a refund deadline a route can still take
    // — so an operator auditing a deployment must be able to see the list
    // without reading the unit's environment. Read-only like its neighbours,
    // and emphatically not editable: this port has no authentication, and the
    // knob's failure mode is the double-collect window.
    {
      key: 'LN_SEND_HINT_SCID_DENYLIST',
      value: Array.from(config.sendHintScidDenylist).join(', ') || '(empty)',
      source: 'env',
      editable: false,
    },
    { key: 'RELAY_URL', value: config.relayUrl ?? '(unset)', source: 'env', editable: false },
    { key: 'RELAY_PROTOCOL', value: config.relayProtocol, source: 'env', editable: false },
    { key: 'OPEN_RFQ_MAX_BIDS_PER_MIN', value: config.openRfqMaxBidsPerMinute, source: 'env', editable: false },
  )

  return knobs
}
