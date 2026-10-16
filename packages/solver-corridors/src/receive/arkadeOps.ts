/**
 * Production {@link ReceiveArkadeOps}: the bridge from the receive
 * orchestrator's row-shaped world to the real Arkade wallet — the
 * receive-leg counterpart of `src/send/arkadeOps.ts`.
 *
 * The covenant machinery underneath (`CovenantSwapScript`, `covenantScriptFromRow`,
 * `refundSwapScript`, `findLockups`, `findClaimPreimage`) is fully REUSED, not
 * reimplemented — only the ROLE MAPPING differs, and that mapping lives in
 * `src/receive/orchestrator.ts`'s `receiveCovenantRowFor` (mirroring how
 * `src/send/onchainOrchestrator.ts`'s `covenantRowFor` bridges ITS OWN
 * differently-shaped row onto the same `CovenantScriptRow`). This file stays
 * as thin as `send/arkadeOps.ts` is: no covenant-reconstruction logic of its
 * own, just wiring to the real wallet.
 */

import { hex } from '@scure/base'
import { ArkAddress } from '@arkade-os/sdk'
import {
  findLockups,
  findLockupOutpoints,
  findClaimPreimage,
  refundWithoutReceiverSwapScript,
  type ArkadeContext,
} from '@arkade-os/solver-arkade/arkade/wallet.js'
import { assertScriptMatchesRow, covenantScriptFromRow, type EmulatorInfo } from '../send/arkadeOps.js'
import { fundLockup } from './fundLockup.js'

import type { ReceiveArkadeOps } from '@arkade-os/solver-arkade/arkade/arkadeOps.js'
export type { ReceiveArkadeOps }

export const receiveArkadeOpsFromContext = async (
  ctx: ArkadeContext,
  emulator: EmulatorInfo,
): Promise<ReceiveArkadeOps> => {
  const solverPubkey = hex.encode(await ctx.identity.xOnlyPublicKey())
  const solverRefundPkScript = hex.encode(ArkAddress.decode(await ctx.wallet.getAddress()).pkScript)
  return {
    solverPubkey,
    serverPubkey: hex.encode(ctx.wallet.arkServerPublicKey),
    emulatorPubkey: emulator.pubkey,
    solverRefundPkScript,
    delays: ctx.unilateralDelays,
    hrp: ctx.hrp,
    findLockups: (pkScriptHex) => findLockups(ctx, pkScriptHex),
    findLockupOutpoints: (pkScriptHex) => findLockupOutpoints(ctx, pkScriptHex),
    // NOT `wallet.send`: that lets the SDK choose inputs, and it chooses
    // soonest-batch-expiry first — the one coin a lockup must not inherit from.
    // @see lockupFunding.ts for why, and reservations.ts for the other half.
    fund: (address, amountSats, stamp) => fundLockup(ctx, address, amountSats, stamp),
    refund: async (row, outputs) => {
      const script = covenantScriptFromRow(row)
      assertScriptMatchesRow(script, row)
      // `refundWithoutReceiver`, NOT `refund`: on this leg the receiver is the
      // client-user, so `refund`'s receiver signature is unobtainable. See the
      // role note on `solverPubkey` above.
      return refundWithoutReceiverSwapScript(ctx, script, [...outputs], hex.decode(row.refundPkScript!))
    },
    findClaimPreimage: (outpoints, paymentHashHex) => findClaimPreimage(ctx, outpoints, paymentHashHex),
  }
}
