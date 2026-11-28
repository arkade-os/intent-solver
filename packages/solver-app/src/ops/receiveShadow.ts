import { LockupPreimageReader } from '@arkade-os/solver-arkade/arkade/lockupPreimage.js'
import type { ReceiveArkadeOps } from '@arkade-os/solver-arkade/arkade/arkadeOps.js'
import type { ReceiveAction } from '@arkade-os/solver-core/core/receivePlan.js'
import { rawDelaySeconds } from '@arkade-os/solver-core/core/timelocks.js'
import type { HoldState } from '@arkade-os/solver-core/ports/lightning.js'
import type { OnchainBackend } from '@arkade-os/solver-core/ports/onchain.js'
import { json } from '@arkade-os/solver-core/util/poll.js'
import { hex } from '@scure/base'
import { refundDeadlineReached, refundDeadlineSeconds } from '@arkade-os/solver-corridors/chainClock.js'
import type { ReceiveSwapRow } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import type { ReceiveReadsSeen } from '@arkade-os/solver-corridors/receive/readsSeen.js'
import { FromLightning } from '@arkade-os/solver-next/application/legs/from_lightning.js'
import { ToArkade } from '@arkade-os/solver-next/application/legs/to_arkade.js'
import { LightningReceive, type ReceiveStep } from '@arkade-os/solver-next/application/lightning_receive.js'
import { UnixSeconds } from '@arkade-os/solver-next/domain/shared/time.js'
import { swapFromReceiveRow } from '@arkade-os/solver-next/infrastructure/db/receive_swap_row.js'
import type { FundedOutput, LockupContract, LockupOutpoint } from '@arkade-os/solver-next/ports/arkade.js'
import type { ChainTipProvider } from '@arkade-os/solver-rails/onchain/chainTip.js'

export interface ReceiveShadowDeps {
  readonly ln: { getHoldState(paymentHash: string): Promise<HoldState> }
  readonly arkade: Pick<
    ReceiveArkadeOps,
    'findLockups' | 'findLockupOutpoints' | 'findClaimPreimage' | 'refundUnrolled'
  >
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

const NOT_COMPARED: readonly ReceiveAction['do'][] = ['arm_coupled', 'record_settled']
const SUMMARY_EVERY = 500
const DIFFS_REMEMBERED = 10_000

/**
 * Asks the new model what it would do with a `receive_swap` row and logs where that differs from what
 * today's planner decided. It answers the new model from what today's planner already read on this tick,
 * and reads for itself only what the planner did not. It holds no way to fund, settle, refund or write.
 */
export const createReceiveShadow = (deps: ReceiveShadowDeps) => {
  const preimages = new LockupPreimageReader(deps.arkade, deps.onchain, () => {})
  const counts: ShadowCounts = { compared: 0, same: 0, different: 0, skipped: 0, failed: 0 }

  const decide = (row: ReceiveSwapRow, seen: ReceiveReadsSeen): Promise<ReceiveStep> =>
    new LightningReceive(
      new FromLightning({
        getHoldState: async (hash) => seen.hold ?? deps.ln.getHoldState(hash),
        settleHold: readOnly,
      }),
      new ToArkade(
        { contract: async () => contractOf(row) },
        {
          canRefundUnrolled: deps.arkade.refundUnrolled !== undefined,
          spendable: async () =>
            (seen.spendable as FundedOutput[] | undefined) ?? deps.arkade.findLockups(row.pkScript),
          history: async () =>
            (seen.history as LockupOutpoint[] | undefined) ?? deps.arkade.findLockupOutpoints(row.pkScript),
          claimPreimage: async (_contract, outpoints) => {
            if (seen.claim === undefined) return preimages.find(row, outpoints)
            return seen.claim.preimage === null ? null : hex.decode(seen.claim.preimage)
          },
          fund: readOnly,
          refund: readOnly,
          // Asking the server to finish a refund is an action. Only its answer to today's planner is passed on.
          finalizePendingRefund: async () => seen.ownRefund ?? null,
          refundOpen: async () => seen.refundOpen ?? refundDeadlineReached(row.refundLocktime, deps.now, deps.chainTip),
          refundOpensAt: async () =>
            seen.refundDeadline ??
            refundDeadlineSeconds(row.refundLocktime, deps.now, deps.chainTip, 'compare with the new model'),
          secondsToRefundAlone: () => rawDelaySeconds(row.refundWithoutReceiverDelay),
        },
      ),
      () => UnixSeconds.of(deps.now()),
      { acceptsNoRefundAlone: deps.acceptUnilateralGap },
    ).next(swapFromReceiveRow(row))

  const logged = new Set<string>()

  const counted = (outcome: keyof ShadowCounts): void => {
    counts[outcome] += 1
    if ((counts.compared + counts.skipped + counts.failed) % SUMMARY_EVERY === 0) {
      deps.log(`receive_shadow ${json(counts)}`)
    }
  }

  // A payment between two of our own clients is not compared yet.
  const coupled = async (row: ReceiveSwapRow, old: ReceiveAction, seen: ReceiveReadsSeen): Promise<boolean> => {
    if (NOT_COMPARED.includes(old.do) || ('coupled' in old && old.coupled)) return true
    return Boolean('coupledSend' in seen ? seen.coupledSend : await deps.coupledSend(row.paymentHash))
  }

  return {
    counts: (): ShadowCounts => ({ ...counts }),

    /** Never throws: a shadow that fails is counted, and today's code goes on as if it were not there. */
    async compare(row: ReceiveSwapRow, old: ReceiveAction, seen: ReceiveReadsSeen = {}): Promise<void> {
      try {
        if (await coupled(row, old, seen)) return counted('skipped')
        const next = await decide(row, seen)
        const oldReason = 'reason' in old ? old.reason : undefined
        if (old.do === next.do && oldReason === next.reason) {
          counts.same += 1
          return counted('compared')
        }
        counts.different += 1
        // A row that keeps differing the same way is logged once, not on every tick.
        const difference = `${row.id} ${row.state} ${old.do} ${next.do}`
        if (logged.has(difference)) return counted('compared')
        if (logged.size >= DIFFS_REMEMBERED) logged.clear()
        logged.add(difference)
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
        counted('compared')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        deps.log(`receive_shadow_failed ${json({ swapId: row.id, state: row.state, error: message })}`)
        counted('failed')
      }
    },
  }
}
