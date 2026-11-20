import { rawDelaySeconds } from '@arkade-os/solver-core/core/timelocks.js'
import { UnixSeconds } from '@arkade-os/solver-next/domain/shared/time.js'
import { Preimage } from '@arkade-os/solver-next/domain/swap/hashlock.js'
import { Reference } from '@arkade-os/solver-next/domain/swap/leg.js'
import { NOT_SEEN, type LegStatus, type SpendStatus } from '@arkade-os/solver-next/domain/swap/observation.js'
import type { Swap } from '@arkade-os/solver-next/domain/swap/swap.js'
import type { ReceiveArkadeOps } from '@arkade-os/solver-arkade/arkade/arkadeOps.js'
import type { ChainTipProvider } from '@arkade-os/solver-rails/onchain/chainTip.js'
import { hex } from '@scure/base'
import { refundDeadlineReached, refundDeadlineSeconds } from '@arkade-os/solver-corridors/chainClock.js'
import type { ReceiveSwapRow } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import { adoptFunding } from '@arkade-os/solver-corridors/legs/arkadeLockup.js'
import type { LockupPreimageReader } from '@arkade-os/solver-corridors/receive/lockupPreimage.js'
import { receiveCovenantRowFor } from '@arkade-os/solver-corridors/receive/orchestrator.js'

export interface LockupStatusDeps {
  readonly arkade: Pick<ReceiveArkadeOps, 'findLockups' | 'findLockupOutpoints' | 'finalizePendingRefund'>
  readonly preimages: Pick<LockupPreimageReader, 'find'>
  readonly chainTip?: ChainTipProvider
  readonly now: () => number
}

/** Our payout on Arkade, as the indexer shows it. */
// `row` gives the contract as quoted; what happened since is read from the swap, never from the row.
export const lockupStatus = async (deps: LockupStatusDeps, row: ReceiveSwapRow, swap: Swap): Promise<LegStatus> => {
  const { arkade, preimages, chainTip, now } = deps
  const history = await arkade.findLockupOutpoints(row.pkScript)
  const lockup = recordedLockup(swap, history) ?? adoptFunding(history, row.payoutSats)
  const refund = swap.to.reference('refund')
  const deadlines = {
    refundOpen: await refundDeadlineReached(row.refundLocktime, now, chainTip),
    refundOpensAt: UnixSeconds.of(await refundDeadlineSeconds(row.refundLocktime, now, chainTip, 'read the lockup')),
    refundAloneDelay: rawDelaySeconds(row.refundWithoutReceiverDelay),
  }
  if (lockup === null) return { ...NOT_SEEN, ...deadlines }

  const same = (o: { txid: string; vout: number }): boolean => o.txid === lockup.txid && o.vout === lockup.vout
  // A claim counts on any output of the script: it reveals the same preimage.
  const preimage = await preimages.find(row, history.length > 0 ? history : [lockup])
  // A lockup taken onto Bitcoin is gone from Arkade but is still ours to refund there.
  const unspent = (await arkade.findLockups(row.pkScript)).some(same) || history.find(same)?.unrolled === true
  // Our refund can land although its response never reached us; arkd still has it and can tell.
  const lostRefund =
    preimage === null && !unspent && refund === null && swap.to.state === 'refunding'
      ? ((await arkade.finalizePendingRefund?.(receiveCovenantRowFor(row))) ?? null)
      : null
  const refunded = refund !== null || lostRefund !== null
  const spent: SpendStatus =
    preimage !== null
      ? { by: 'claim', preimage: Preimage.of(hex.encode(preimage)) }
      : unspent
        ? { by: 'nobody' }
        : { by: refunded ? 'refund' : 'unknown' }
  return {
    ...NOT_SEEN,
    ...deadlines,
    lock: 'landed',
    lockReference: Reference.of(`${lockup.txid}:${lockup.vout}`),
    spent,
    refund: !unspent && preimage === null && refunded ? 'landed' : 'none',
  }
}

type Outpoint = { readonly txid: string; readonly vout: number }

// The reference is `txid:vout` once the output was seen, and a bare txid straight after the payout was sent.
const recordedLockup = (swap: Swap, history: readonly Outpoint[]): Outpoint | null => {
  const reference = swap.to.reference('funding')
  if (reference === null) return null
  const [txid = '', vout] = reference.split(':')
  return vout === undefined ? (history.find((o) => o.txid === txid) ?? null) : { txid, vout: Number(vout) }
}
