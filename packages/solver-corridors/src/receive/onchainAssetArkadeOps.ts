/**
 * Production {@link OnchainAssetReceiveArkadeOps}: paying an ASSET out of the
 * solver's float into a lockup.
 *
 * The sats leg's factory does everything except fund, so it is reused whole and
 * `fund` swapped for `fundAsset`. What is genuinely new is that two units have
 * to come out right at once — see `assetFunding.ts` for the selection, and
 * `fundLockup.ts` for the sats-only original this mirrors.
 */

import { onchainReceiveArkadeOpsFromContext } from './onchainArkadeOps.js'
import { selectAssetFunding } from './assetFunding.js'
import type { EmulatorInfo } from '../send/arkadeOps.js'
import type { ArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { MAX_REFUND_HORIZON } from '@arkade-os/solver-core/core/receive.js'
import { log } from '@arkade-os/solver-core/util/poll.js'
import type { OnchainAssetReceiveArkadeOps } from './onchainAssetOrchestrator.js'

export const onchainAssetReceiveArkadeOpsFromContext = async (
  ctx: ArkadeContext,
  emulator: EmulatorInfo,
): Promise<OnchainAssetReceiveArkadeOps> => {
  const { fund: _sats, ...base } = await onchainReceiveArkadeOpsFromContext(ctx, emulator)

  const dustSats = async (): Promise<number> => Number((await ctx.wallet.arkProvider.getInfo()).dust)

  return {
    ...base,
    dustSats,
    /**
     * `availableAssets`, never `assets`.
     *
     * The wider field counts gated, intent-locked, recoverable and unrolled
     * holdings — asset the solver owns and cannot currently spend. Quoting
     * against it is the "reads healthy, spends nothing" failure the sats float
     * already has a name for, arriving as `Insufficient funds` hours later on a
     * swap already quoted.
     */
    assetBalance: async () => {
      const balance = await ctx.wallet.getBalance()
      return new Map(balance.availableAssets.map(({ assetId, amount }) => [assetId, BigInt(amount)]))
    },
    fundAsset: async ({ address, assetId, units, carrierSats }) => {
      // Gated read, for `fundLockup.ts`'s reason: `getVtxos` fed to a spend
      // bypasses the generic-spending gate, which is exactly what hides another
      // swap's live escrow.
      const spendable = await ctx.wallet.getSpendableVtxos()
      const selection = selectAssetFunding({
        candidates: spendable,
        assetId,
        units,
        carrierSats,
        horizonSeconds: MAX_REFUND_HORIZON,
        nowSeconds: Math.floor(Date.now() / 1000),
        reserved: ctx.reservations.reserved(),
        dustSats: await dustSats(),
      })
      if (!selection.ok) {
        throw new Error(`refusing to fund lockup of ${units} of ${assetId}: ${selection.reason}`)
      }
      if (!selection.clearedHorizon) {
        log(
          `funding asset lockup from coins that do not outlive the ${MAX_REFUND_HORIZON}s refund horizon:`,
          'float needs renewing, or this network batches shorter than the horizon',
        )
      }
      const release = ctx.reservations.reserve(selection.inputs)
      try {
        // One recipient carrying both legs. The asset change is NOT named: the
        // SDK routes it onto the sats change itself, and naming ourselves a
        // second recipient forces it onto its own dust output, fragmenting the
        // holding a little more on every payout. @see fundLockup.ts
        return await ctx.wallet.send({
          recipients: [{ address, amount: carrierSats, assets: [{ assetId, amount: units }] }],
          selectedVtxos: [...selection.inputs],
        })
      } finally {
        release()
      }
    },
  }
}
