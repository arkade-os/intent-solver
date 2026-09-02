/**
 * The Arkade half of `ethereum:<token>->arkade:BTC`'s dependencies.
 *
 * The mirror of `send/evmArkadeDeps.ts`, and deliberately NOT one module
 * parameterised by direction. On this leg the solver is the FUNDER and the client
 * claims, which inverts every covenant role and - more importantly - changes
 * which Arkade read is safe. @see arkadeLockupFunded below.
 */

import { hex } from '@scure/base'
import type { ReceiveArkadeOps } from '@arkade-os/solver-arkade/arkade/arkadeOps.js'
import type { EvmReceiveServiceDeps } from './evmOrchestrator.js'
import { lockupIsFunded } from '@arkade-os/solver-core/core/lockupFunded.js'
import { evmReceiveCovenantRowFor } from '../evm/covenantRow.js'
import { receiveLockFromRow } from '../evm/lockFromRow.js'

/** The Arkade-facing subset of {@link EvmReceiveServiceDeps}. A `Pick`, for the reason the send half's is. */
export type EvmReceiveArkadeDeps = Pick<
  EvmReceiveServiceDeps,
  'fundArkade' | 'refundArkade' | 'arkadeLockupFunded' | 'arkadePreimage' | 'lockFor'
>

export const evmReceiveArkadeDeps = (arkade: ReceiveArkadeOps): EvmReceiveArkadeDeps => ({
  /**
   * Pay the client's payout into the covenant the row describes.
   *
   * `payoutSats`, not `amountSats`: the fee was taken at quote time and the row
   * carries both, so reading the gross here would pay out the fee as well on
   * every single swap.
   *
   * `lockupAddress` comes off the ROW rather than being re-derived from live
   * config, the same rule the lock and the script follow. `ops.fund` is
   * `fundLockup`, not `wallet.send` - the SDK picks soonest-batch-expiry inputs,
   * which is the one parent a lockup must not inherit. @see arkade/lockupFunding.ts
   */
  fundArkade: (row) => arkade.fund(row.lockupAddress, row.payoutSats),
  /**
   * Take the solver's own lockup back after the swap failed.
   *
   * `refundWithoutReceiver` under the hood, because on this leg the receiver is
   * the client and its signature is unobtainable. An empty read throws rather
   * than reporting a refund that never happened - `refund_ark_txid` is evidence,
   * and the sweep retries.
   */
  refundArkade: async (row) => {
    const outputs = await arkade.findLockups(row.pkScript)
    if (outputs.length === 0) {
      throw new Error(`no spendable output at the lockup for ${row.id} - nothing to refund`)
    }
    return arkade.refund(evmReceiveCovenantRowFor(row), outputs)
  },
  /**
   * Is the solver's OWN lockup already funded and visible?
   *
   * THE SPEND-AWARE READ, and this is the one place on either leg where that
   * choice is load-bearing rather than an optimisation. `findLockups` is
   * `spendableOnly`: once the client claims the payout, the outpoint stops being
   * spendable and that read goes empty. The solver is the funder here, so an
   * empty answer means "fund it" - and the honest sequence
   *
   *   fund -> client claims -> crash before the txid is patched -> re-read
   *
   * would then fund a second time and pay the client twice out of the solver's
   * own float. `findLockupOutpoints` includes SPENT outputs precisely so a
   * claimed lockup still counts as funded. Its own docstring names this hazard:
   * "on THIS leg that blind spot is a double-spend of the provider's own
   * capital, because the funding decision is made against it."
   */
  arkadeLockupFunded: async (row) => {
    const outpoints = await arkade.findLockupOutpoints(row.pkScript)
    // `kind: 'sats'` NAMED, not defaulted. Both EVM legs lock sats on the Arkade
    // side today, so this is the same comparison it always was — but the day a
    // corridor's Arkade leg is asset-denominated, this call site has to change
    // rather than keep quietly summing carriers. @see core/lockupFunded.ts
    return lockupIsFunded(outpoints, { kind: 'sats', amount: row.payoutSats })
  },
  /**
   * The preimage, read back out of whichever transaction claimed the lockup.
   *
   * The cross-leg mechanism on this corridor: the client claims the sats,
   * revealing `P`, and that is how the solver learns what it needs to claim the
   * ERC20. Verified against the row's payment hash inside `findClaimPreimage`,
   * so a transaction spending the script by some other path cannot pass a wrong
   * secret back.
   *
   * Returns hex, not bytes, because the orchestrator stores it and hands it to
   * the EVM claim as a string - the shape the row's `preimage` column holds.
   */
  arkadePreimage: async (row) => {
    const outpoints = await arkade.findLockupOutpoints(row.pkScript)
    if (outpoints.length === 0) return null
    const preimage = await arkade.findClaimPreimage(outpoints, row.paymentHash)
    return preimage === null ? null : hex.encode(preimage)
  },
  lockFor: receiveLockFromRow,
})
