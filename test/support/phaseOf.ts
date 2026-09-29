import { phaseOfStates, type AdminPhase } from '@arkade-os/solver-core/core/swapView.js'
import { descriptorFor } from '@arkade-os/solver-corridors/corridors/index.js'
import type { Corridor } from '@arkade-os/solver-core/core/corridorPolicy.js'

export const phaseOf = (corridor: Corridor, state: string): AdminPhase =>
  phaseOfStates(descriptorFor(corridor).states, state)
