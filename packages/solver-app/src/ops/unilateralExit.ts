/**
 * "Exit swap X" resolved against whatever corridors this deployment registered.
 *
 * DISPATCHED THROUGH THE REGISTRY, never a closed list. A lever offered on every
 * row and keyed to one corridor's store is a bug this repo has shipped twice —
 * `tick` and `park-swap` both threw "not found" on rows that plainly existed —
 * and this is the most consequential of the three: the row it is reached for is
 * a parked one, on whichever leg the Arkade Service stopped answering. Iterating
 * the set is what makes "every corridor" structural rather than a promise.
 *
 * The reader set, not the serving set, for the same reason `refund` and
 * `park-swap` take it: an operator who switched a corridor off did not thereby
 * un-fund its in-flight lockups, and those are exactly the ones still needing a
 * way out.
 */

import { assertCovenantScriptRow } from '@arkade-os/solver-arkade/arkade/covenantRow.js'
import { planUnilateralExit, type UnilateralExitPlan } from '@arkade-os/solver-arkade/arkade/unilateralExit.js'
import type { CorridorReader } from '@arkade-os/solver-core/core/corridor.js'

export interface SwapExitPlan {
  /** Which corridor turned out to hold the row. */
  pair: string
  plan: UnilateralExitPlan
}

export interface SwapExitInput {
  /** The solver's own x-only key, hex — `ctx.identity`'s, which is what the exit matches against. */
  solverPubkey: string
  /**
   * A preimage the operator supplied. Wins over the row's own, since passing one
   * is a deliberate override; either way {@link planUnilateralExit} checks it
   * against the row's payment hash, so neither can be silently wrong.
   */
  preimage?: string | null
}

/**
 * Find the corridor holding `id`, read its lockup, and decide what a
 * server-independent exit of it would do.
 *
 * Reads only — nothing here signs, spends or writes. Every refusal a real exit
 * would make is reached at this point, which is what makes quoting first
 * worthwhile.
 */
export const planExitForSwap = async (
  corridors: Iterable<CorridorReader>,
  id: string,
  input: SwapExitInput,
): Promise<SwapExitPlan> => {
  for (const corridor of corridors) {
    // A corridor with no Arkade lockups of its own is entitled to omit this,
    // exactly as it may omit `liveLockups`. Absence is "not mine", not a fault.
    if (!corridor.lockupFor) continue
    const held = await corridor.lockupFor(id)
    if (!held) continue
    // Checked, not cast: a plugged-in corridor is third-party code, and a row
    // with a missing or mistyped field would otherwise be carried into script
    // construction and build a covenant from whatever it was handed.
    const row = assertCovenantScriptRow(held.lockup, corridor.descriptor.pair)
    return {
      pair: corridor.descriptor.pair,
      plan: planUnilateralExit(row, {
        solverPubkey: input.solverPubkey,
        preimage: input.preimage ?? held.preimage,
      }),
    }
  }
  throw new Error(`no corridor on this deployment holds swap ${id}`)
}
