/**
 * The Arkade half of `arkade:BTC->ethereum:<token>`'s dependencies.
 *
 * The EVM orchestrators take FLAT FUNCTIONS where the four BTC corridors take an
 * `ArkadeOps` object whole. This module is the adapter between those two shapes,
 * and it is a module rather than an object literal in `cli.ts` for the reason
 * every other ops factory here is: `cli.ts` runs `main()` at import and exports
 * nothing, so anything assembled inline there cannot be tested.
 *
 * Nothing in it is EVM-specific. The Bitcoin side of an EVM swap is the same
 * covenant the Lightning corridor uses, reached through the same ops - which is
 * why the only `evm/` imports are the row type and the two mappers that rebuild
 * a script or a lock FROM THE ROW.
 */

import type { ArkadeOps } from '@arkade-os/solver-arkade/arkade/arkadeOps.js'
import type { EvmSendServiceDeps } from './evmOrchestrator.js'
import { lockupIsFunded } from '@arkade-os/solver-core/core/lockupFunded.js'
import { evmSendCovenantRowFor } from '../evm/covenantRow.js'
import { sendLockFromRow } from '../evm/lockFromRow.js'

/**
 * The Arkade-facing subset of {@link EvmSendServiceDeps}.
 *
 * A `Pick` of the orchestrator's own deps rather than a hand-written interface,
 * so adding a dependency there is a type error HERE instead of a silently
 * unimplemented function at the call site in `cli.ts`.
 */
export type EvmSendArkadeDeps = Pick<EvmSendServiceDeps, 'arkadeLockupFunded' | 'claimArkade' | 'lockFor'>

export const evmSendArkadeDeps = (arkade: ArkadeOps): EvmSendArkadeDeps => ({
  /**
   * Has the CLIENT locked the sats this swap quoted?
   *
   * `findLockups` is the right read on THIS leg, and the wrong one on the
   * receive leg. It is `spendableOnly`, so a lockup that was funded and then
   * claimed reads as empty - and here the claimant is the solver itself, after
   * this question has already been answered once and acted on. A false empty
   * therefore only ever delays the solver's own claim, which the next tick
   * retries.
   *
   * The receive leg inverts that: there the solver is the FUNDER, so an empty
   * read means "fund it" and funding twice spends the solver's own capital
   * twice. That leg uses the spend-aware read instead. @see receive/evmArkadeDeps.ts
   *
   * `>=` not `===`: an overpayment is still a funded lockup, and the quote
   * already fixed what the client is owed.
   */
  arkadeLockupFunded: async (row) => {
    const outputs = await arkade.findLockups(row.pkScript)
    // `kind: 'sats'` NAMED, not defaulted. Both EVM legs lock sats on the Arkade
    // side today, so this is the same comparison it always was — but the day a
    // corridor's Arkade leg is asset-denominated, this call site has to change
    // rather than keep quietly summing carriers. @see core/lockupFunded.ts
    return lockupIsFunded(outputs, { kind: 'sats', amount: row.amountSats })
  },
  /**
   * Claim the client's lockup with the preimage the client revealed on the EVM
   * side. This is how the solver gets paid on this corridor.
   *
   * An empty read THROWS rather than resolving to some empty-string txid: the
   * orchestrator records a claim txid as proof the sats arrived, and a
   * fabricated one would report a completed swap whose money never moved. A
   * throw leaves the row where it is for the next tick, which is what a read
   * that has not caught up deserves.
   */
  claimArkade: async (row, preimage) => {
    const outputs = await arkade.findLockups(row.pkScript)
    if (outputs.length === 0) {
      throw new Error(`no spendable output at the lockup for ${row.id} - nothing to claim yet`)
    }
    return arkade.claim(evmSendCovenantRowFor(row), outputs, preimage)
  },
  lockFor: sendLockFromRow,
})
