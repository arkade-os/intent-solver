import { rawDelaySeconds } from '@arkade-os/solver-core/core/timelocks.js'
import type { OnchainBackend } from '@arkade-os/solver-core/ports/onchain.js'
import type { ReceiveArkadeOps } from '@arkade-os/solver-arkade/arkade/arkadeOps.js'
import type { FundedOutput } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { refundDeadlineReached, refundDeadlineSeconds } from '@arkade-os/solver-corridors/chainClock.js'
import type { ReceiveSwapRow } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import { claimPacketStamp } from '@arkade-os/solver-corridors/receive/claimPacket.js'
import { FundNotSubmittedError } from '@arkade-os/solver-corridors/receive/fundLockup.js'
import { LockupPreimageReader } from '@arkade-os/solver-corridors/receive/lockupPreimage.js'
import { receiveCovenantRowFor } from '@arkade-os/solver-corridors/receive/orchestrator.js'
import { covenantScriptFromRow } from '@arkade-os/solver-corridors/send/arkadeOps.js'
import type { ArkadeLockups, LockupContract } from '@arkade-os/solver-next/ports/arkade.js'
import type { ChainTipProvider } from '@arkade-os/solver-rails/onchain/chainTip.js'

export interface LegacyArkade {
  readonly arkade: ReceiveArkadeOps
  readonly onchain?: Pick<OnchainBackend, 'findSpendWitness'>
  readonly chainTip?: ChainTipProvider
  readonly now: () => number
}

export const contractFromRow = (row: ReceiveSwapRow): LockupContract => ({
  ...receiveCovenantRowFor(row),
  lockupAddress: row.lockupAddress,
  payoutSats: row.payoutSats,
  claimPacket: row.claimPacket,
})

/** The new Arkade port, served by the legacy wallet code: coin selection, signing and reads are untouched. */
export const legacyArkadeLockups = ({ arkade, onchain, chainTip, now }: LegacyArkade): ArkadeLockups => {
  const preimages = new LockupPreimageReader(arkade, onchain, () => undefined)
  const finish = arkade.finalizePendingRefund?.bind(arkade)
  return {
    spendable: (contract) => arkade.findLockups(contract.pkScript),
    history: (contract) => arkade.findLockupOutpoints(contract.pkScript),
    claimPreimage: (contract, outpoints) => preimages.find(contract, outpoints),
    fund: async (contract) => {
      const stamp = claimPacketStamp(contract.claimPacket, covenantScriptFromRow(contract))
      try {
        return await arkade.fund(contract.lockupAddress, contract.payoutSats, stamp)
      } catch (error) {
        if (error instanceof FundNotSubmittedError) return null
        throw error
      }
    },
    refund: (contract, outputs) => arkade.refund(contract, outputs as readonly FundedOutput[]),
    ...(finish ? { finishLostRefund: (contract: LockupContract) => finish(contract) } : {}),
    refundOpen: (contract) => refundDeadlineReached(contract.refundLocktime, now, chainTip),
    refundOpensAt: (contract) =>
      refundDeadlineSeconds(contract.refundLocktime, now, chainTip, 'order the refund deadline against the HTLC'),
    refundAloneDelaySeconds: (contract) => rawDelaySeconds(contract.refundWithoutReceiverDelay),
  }
}
