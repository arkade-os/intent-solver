/**
 * The console's view of a swap — now assembled elsewhere, and re-exported here.
 *
 * The shape and the bucketing rule moved to `core/swapView.ts`; the four
 * per-corridor projectors moved to `corridors/projections.ts`, because
 * projecting a row is a CORRIDOR's knowledge of its own columns rather than
 * this module's. What is left is the console-facing surface: the names its
 * routes, its tests and its static assets already import.
 *
 * Kept as a re-export rather than deleted so that move cost no caller a change,
 * and so the console keeps one obvious place to look.
 */
import { phaseOfStates, type AdminPhase } from '@arkade-os/solver-core/core/swapView.js'
import { descriptorFor } from '@arkade-os/solver-corridors/corridors/index.js'
import type { Corridor } from '@arkade-os/solver-core/core/corridorPolicy.js'

export type { AdminSwap, AdminPhase } from '@arkade-os/solver-core/core/swapView.js'
export { diagnose } from '@arkade-os/solver-core/core/swapView.js'
export {
  projectSend,
  projectReceive,
  projectOnchainSend,
  projectOnchainReceive,
} from '@arkade-os/solver-corridors/corridors/projections.js'

/**
 * Which bucket a state falls in, looked up by CORRIDOR.
 *
 * The corridors themselves use `phaseOfStates` directly — they already hold
 * their own states, and core must not reach into the corridor layer. This
 * wrapper exists for the console and its tests, which know a corridor by name
 * and not by descriptor.
 *
 * @see phaseOfStates for why an unrecognised state falls to `failed`.
 */
export const phaseOf = (corridor: Corridor, state: string): AdminPhase =>
  phaseOfStates(descriptorFor(corridor).states, state)
