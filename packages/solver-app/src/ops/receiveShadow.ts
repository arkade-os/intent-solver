import { LockupPreimageReader } from '@arkade-os/solver-arkade/arkade/lockupPreimage.js'
import type { ReceiveArkadeOps } from '@arkade-os/solver-arkade/arkade/arkadeOps.js'
import type { ReceiveAction } from '@arkade-os/solver-core/core/receivePlan.js'
import { rawDelaySeconds } from '@arkade-os/solver-core/core/timelocks.js'
import type { HoldState } from '@arkade-os/solver-core/ports/lightning.js'
import type { OnchainBackend } from '@arkade-os/solver-core/ports/onchain.js'
import { json } from '@arkade-os/solver-core/util/poll.js'
import { refundDeadlineReached, refundDeadlineSeconds } from '@arkade-os/solver-corridors/chainClock.js'
import type { ReceiveSwapRow } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import { HoldInvoice } from '@arkade-os/solver-next/application/legs/hold_invoice.js'
import { SolverLockup } from '@arkade-os/solver-next/application/legs/solver_lockup.js'
import { LightningReceive, type ReceiveStep } from '@arkade-os/solver-next/application/lightning_receive.js'
import { UnixSeconds } from '@arkade-os/solver-next/domain/shared/time.js'
import { swapFromReceiveRow } from '@arkade-os/solver-next/infrastructure/db/receive_swap_row.js'
import type { LockupContract } from '@arkade-os/solver-next/ports/arkade.js'
import type { ChainTipProvider } from '@arkade-os/solver-rails/onchain/chainTip.js'

export interface ReceiveShadowDeps {
  readonly ln: { getHoldState(paymentHash: string): Promise<HoldState> }
  readonly arkade: Pick<ReceiveArkadeOps, 'findLockups' | 'findLockupOutpoints' | 'findClaimPreimage'>
  readonly onchain?: Pick<OnchainBackend, 'findSpendWitness'>
  readonly chainTip?: ChainTipProvider
  /** A payment between two of our own clients is not compared yet. */
  readonly coupledSend: (paymentHash: string) => Promise<unknown>
  readonly now: () => number
  readonly acceptUnilateralGap: boolean
  readonly log: (line: string) => void
}

export interface ShadowCounts {
  compared: number
  same: number
  different: number
  skipped: number
  failed: number
}

const readOnly = async (): Promise<never> => {
  throw new Error('the shadow only reads')
}

const contractOf = (row: ReceiveSwapRow): LockupContract => ({
  id: row.id,
  paymentHash: row.paymentHash,
  pkScript: row.pkScript,
  lockupAddress: row.lockupAddress,
  payoutSats: row.payoutSats,
  payoutAddress: row.payoutAddress,
  claimPacket: row.claimPacket,
  refundLocktime: row.refundLocktime,
  claimDelay: row.claimDelay,
  refundDelay: row.refundDelay,
  refundWithoutReceiverDelay: row.refundWithoutReceiverDelay,
  receiverPubkey: row.payoutPubkey,
  receiverPkScript: row.payoutPkScript,
  serverPubkey: row.serverPubkey,
  emulatorPubkey: row.emulatorPubkey,
  clientRefundPubkey: null,
  refundPkScript: row.solverRefundPkScript,
  nonInteractiveParameters: row.nonInteractiveParameters,
})

// Today's planner learns of a finished refund by asking the server to finish it, which is an action.
// The shadow never acts, so it cannot reach that answer, and neither side is compared on it.
const NOT_COMPARED: readonly ReceiveAction['do'][] = ['arm_coupled', 'record_settled', 'record_refund']

/**
 * Asks the new model what it would do with a `receive_swap` row and logs where that differs from what
 * today's planner decided. It only reads: it holds no way to fund, settle, refund or write.
 */
export const createReceiveShadow = (deps: ReceiveShadowDeps) => {
  const preimages = new LockupPreimageReader(deps.arkade, deps.onchain, () => {})
  const counts: ShadowCounts = { compared: 0, same: 0, different: 0, skipped: 0, failed: 0 }

  const decide = (row: ReceiveSwapRow): Promise<ReceiveStep> =>
    new LightningReceive(
      new HoldInvoice({ getHoldState: (hash) => deps.ln.getHoldState(hash), settleHold: readOnly }),
      new SolverLockup(
        { contract: async () => contractOf(row) },
        {
          spendable: () => deps.arkade.findLockups(row.pkScript),
          history: () => deps.arkade.findLockupOutpoints(row.pkScript),
          claimPreimage: (_contract, outpoints) => preimages.find(row, outpoints),
          fund: readOnly,
          refund: readOnly,
          refundOpen: () => refundDeadlineReached(row.refundLocktime, deps.now, deps.chainTip),
          refundOpensAt: () =>
            refundDeadlineSeconds(row.refundLocktime, deps.now, deps.chainTip, 'compare with the new model'),
          secondsToRefundAlone: () => rawDelaySeconds(row.refundWithoutReceiverDelay),
        },
      ),
      () => UnixSeconds.of(deps.now()),
      { acceptsNoRefundAlone: deps.acceptUnilateralGap },
    ).next(swapFromReceiveRow(row))

  return {
    counts: (): ShadowCounts => ({ ...counts }),

    /** Never throws: a shadow that fails is counted, and today's code goes on as if it were not there. */
    async compare(row: ReceiveSwapRow, old: ReceiveAction): Promise<void> {
      try {
        const coupled = 'coupled' in old && old.coupled
        if (coupled || NOT_COMPARED.includes(old.do) || (await deps.coupledSend(row.paymentHash))) {
          counts.skipped += 1
          return
        }
        const next = await decide(row)
        counts.compared += 1
        const oldReason = 'reason' in old ? old.reason : undefined
        if (old.do === next.do && oldReason === next.reason) {
          counts.same += 1
          return
        }
        counts.different += 1
        deps.log(
          `receive_shadow_diff ${json({
            swapId: row.id,
            state: row.state,
            old: old.do,
            next: next.do,
            ...(oldReason === undefined ? {} : { oldReason }),
            ...(next.reason === undefined ? {} : { nextReason: next.reason }),
          })}`,
        )
      } catch (error) {
        counts.failed += 1
        const message = error instanceof Error ? error.message : String(error)
        deps.log(`receive_shadow_failed ${json({ swapId: row.id, state: row.state, error: message })}`)
      }
    },
  }
}
