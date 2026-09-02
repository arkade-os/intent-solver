/**
 * The projected shape of one swap, and the bucketing every corridor shares.
 *
 * Lives in core rather than beside the console because a corridor PRODUCES this
 * — projecting a row is a corridor's knowledge of its own shape, not the
 * console's — and a corridor must not have to import the admin layer to do it.
 * The console consumes it; core only defines it.
 */
import type { CorridorPhase, CorridorSwapView } from './corridor.js'
import { explainFailure, STATE_NOTES, type RefusalExplanation } from './refusalReasons.js'

export type { CorridorPhase as AdminPhase }

/** One swap, as the console renders it: {@link CorridorSwapView} plus the detail an operator reads. */
export interface AdminSwap extends CorridorSwapView {
  corridor: string
  /** What the client brings. */
  amountSats: number
  /** What the solver delivers after fees. Null on the Lightning send leg, which has no such column. */
  payoutSats: number | null
  paymentHash: string | null
  failureReason: string | null
  /**
   * `failureReason` in operator English, or null when it explains nothing we
   * know. Derived here rather than in the browser so the prose has one home and
   * anything reading the admin API gets it too.
   */
  failureExplanation: RefusalExplanation | null
  /**
   * What this STATE means, as opposed to why a gate refused — the `stuck` note
   * above all, which is the row an operator most needs help with.
   */
  stateNote: RefusalExplanation | null
}

/**
 * Both halves of "why does this row look like this", for one swap.
 *
 * Keyed off the PRESENTED state, not the raw one: the operator is reading the
 * word the console shows them.
 */
export const diagnose = (
  state: string,
  failureReason: string | null,
): Pick<AdminSwap, 'failureExplanation' | 'stateNote'> => ({
  failureExplanation: explainFailure(failureReason),
  stateNote: STATE_NOTES[state] ?? null,
})

/**
 * Exposed is checked FIRST: a state in both sets means the solver has money
 * out, and that is the more urgent of the two facts.
 *
 * An unrecognised state falls to `failed` rather than `done`. A state this
 * module has never heard of is exactly the thing an operator should be shown
 * prominently, and `done` is the one bucket nobody looks at twice.
 *
 * That fallthrough is also what puts `refunded` in `failed`, and it is why no
 * corridor lists it as delivered: a refunded swap ended safely — the capital
 * came back — but it did not DELIVER, and folding it into `done` would hide
 * non-completions from an operator scanning for "did everything work?". It
 * belongs beside `refused`, which is the same kind of outcome: no harm, no
 * delivery. The `state` column still says which.
 *
 * Takes the STATES rather than a corridor name on purpose. Looking the
 * descriptor up here would make core reach into the corridor layer for a
 * function that needs nothing but three string lists — and the caller is
 * always the corridor itself, which already has them.
 */
export const phaseOfStates = (
  states: {
    readonly live: readonly string[]
    readonly exposed: readonly string[]
    readonly delivered: readonly string[]
  },
  state: string,
): CorridorPhase => {
  if (states.exposed.includes(state)) return 'exposed'
  if (states.live.includes(state)) return 'open'
  if (states.delivered.includes(state)) return 'done'
  return 'failed'
}
