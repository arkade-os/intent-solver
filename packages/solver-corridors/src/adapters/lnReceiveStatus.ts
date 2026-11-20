import { rawDelaySeconds } from '@arkade-os/solver-core/core/timelocks.js'
import { UnixSeconds } from '@arkade-os/solver-core/domain/shared/time.js'
import { Preimage } from '@arkade-os/solver-core/domain/swap/hashlock.js'
import { Reference } from '@arkade-os/solver-core/domain/swap/leg.js'
import type { LegStatus, SpendStatus } from '@arkade-os/solver-core/domain/swap/observation.js'
import type { ReceiveBackend } from '@arkade-os/solver-core/ports/lightning.js'
import type { ReceiveArkadeOps } from '@arkade-os/solver-arkade/arkade/arkadeOps.js'
import type { ChainTipProvider } from '@arkade-os/solver-rails/onchain/chainTip.js'
import { hex } from '@scure/base'
import { refundDeadlineReached, refundDeadlineSeconds } from '../chainClock.js'
import type { ReceiveSwapRow } from '../db/receiveSwaps.js'
import { adoptFunding } from '../legs/arkadeLockup.js'
import type { LockupPreimageReader } from '../receive/lockupPreimage.js'
import { receiveCovenantRowFor } from '../receive/orchestrator.js'

const NOTHING: LegStatus = {
  funding: 'none',
  matured: false,
  spent: { by: 'nobody' },
  refundOpen: false,
  expiresAt: null,
  refundOpensAt: null,
  refundAloneDelay: null,
  lock: 'none',
  lockReference: null,
  claim: 'none',
  refund: 'none',
}

/** The client's held Lightning payment, as our node shows it. */
export const holdStatus = async (ln: Pick<ReceiveBackend, 'getHoldState'>, row: ReceiveSwapRow): Promise<LegStatus> => {
  const hold = await ln.getHoldState(row.paymentHash).catch((error: unknown) => {
    // Before the payout the read is needed, so its failure is the caller's. After it the node may have dropped
    // the invoice; the rules then go by the timeout saved with the lock.
    if (row.state === 'quoted' || row.state === 'armed') throw error
    return null
  })
  switch (hold?.status) {
    case undefined:
    case 'pending':
    // A status this build does not know is not `armed`, and only `armed` is acted on.
    case 'unknown':
      return NOTHING
    case 'armed':
      return {
        ...NOTHING,
        funding: 'exact',
        matured: true,
        expiresAt: hold.expiresAt === null ? null : UnixSeconds.of(hold.expiresAt),
        lockReference: Reference.of(row.paymentHash),
      }
    case 'settled':
      return { ...NOTHING, funding: 'exact', matured: true, claim: 'landed' }
    case 'cancelled':
      return { ...NOTHING, spent: { by: 'refund' } }
  }
}

export interface LockupStatusDeps {
  readonly arkade: Pick<ReceiveArkadeOps, 'findLockups' | 'findLockupOutpoints' | 'finalizePendingRefund'>
  readonly preimages: Pick<LockupPreimageReader, 'find'>
  readonly chainTip?: ChainTipProvider
  readonly now: () => number
}

/** Our payout on Arkade, as the indexer shows it. */
export const lockupStatus = async (deps: LockupStatusDeps, row: ReceiveSwapRow): Promise<LegStatus> => {
  const { arkade, preimages, chainTip, now } = deps
  const history = await arkade.findLockupOutpoints(row.pkScript)
  const recorded =
    row.arkadeLockupTxid === null || row.arkadeLockupVout === null
      ? null
      : { txid: row.arkadeLockupTxid, vout: row.arkadeLockupVout }
  const lockup = recorded ?? adoptFunding(history, row.payoutSats)
  const deadlines = {
    refundOpen: await refundDeadlineReached(row.refundLocktime, now, chainTip),
    refundOpensAt: UnixSeconds.of(await refundDeadlineSeconds(row.refundLocktime, now, chainTip, 'read the lockup')),
    refundAloneDelay: rawDelaySeconds(row.refundWithoutReceiverDelay),
  }
  if (lockup === null) return { ...NOTHING, ...deadlines }

  const same = (o: { txid: string; vout: number }): boolean => o.txid === lockup.txid && o.vout === lockup.vout
  // A claim counts on any output of the script: it reveals the same preimage.
  const preimage = await preimages.find(row, history.length > 0 ? history : [lockup])
  // A lockup taken onto Bitcoin is gone from Arkade but is still ours to refund there.
  const unspent = (await arkade.findLockups(row.pkScript)).some(same) || history.find(same)?.unrolled === true
  // Our refund can land although its response never reached us; arkd still has it and can tell.
  const lostRefund =
    preimage === null && !unspent && row.refundArkTxid === null && row.state === 'refunding'
      ? ((await arkade.finalizePendingRefund?.(receiveCovenantRowFor(row))) ?? null)
      : null
  const refunded = row.refundArkTxid !== null || lostRefund !== null
  const spent: SpendStatus =
    preimage !== null
      ? { by: 'claim', preimage: Preimage.of(hex.encode(preimage)) }
      : unspent
        ? { by: 'nobody' }
        : { by: refunded ? 'refund' : 'unknown' }
  return {
    ...NOTHING,
    ...deadlines,
    lock: 'landed',
    lockReference: Reference.of(`${lockup.txid}:${lockup.vout}`),
    spent,
    refund: !unspent && preimage === null && refunded ? 'landed' : 'none',
  }
}
