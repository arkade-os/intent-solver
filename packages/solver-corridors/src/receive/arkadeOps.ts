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
import { rawDelaySeconds } from '@arkade-os/solver-core/core/timelocks.js'
import { unrolledRefunderFor, type UnrolledRefunder } from '@arkade-os/solver-arkade/arkade/unrolledRefund.js'
import { assertScriptMatchesRow, covenantScriptFromRow, type EmulatorInfo } from '../send/arkadeOps.js'
import { fundLockup } from './fundLockup.js'

import type { ReceiveArkadeOps } from '@arkade-os/solver-arkade/arkade/arkadeOps.js'
export type { ReceiveArkadeOps }

/**
 * Both receive legs' refund: `refundWithoutReceiver`, NOT `refund`. On these legs the
 * receiver is the client, so `refund`'s receiver signature is unobtainable.
 */
export const refundReceiveLockup =
  (ctx: ArkadeContext): ReceiveArkadeOps['refund'] =>
  async (row, outputs) => {
    const script = covenantScriptFromRow(row)
    assertScriptMatchesRow(script, row)
    return refundWithoutReceiverSwapScript(ctx, script, [...outputs], hex.decode(row.refundPkScript!))
  }

export const refundUnrolledLockup =
  (refunder: UnrolledRefunder): NonNullable<ReceiveArkadeOps['refundUnrolled']> =>
  async (row, lockup, record, save) => {
    const script = covenantScriptFromRow(row)
    assertScriptMatchesRow(script, row)
    const exitDelaySeconds = Math.min(
      ...[row.claimDelay, row.refundDelay, row.refundWithoutReceiverDelay].map(rawDelaySeconds),
    )
    return refunder.advance(
      { script, txid: lockup.txid, vout: lockup.vout, refundLocktime: row.refundLocktime, exitDelaySeconds },
      record,
      save,
    )
  }

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
    refund: refundReceiveLockup(ctx),
    findClaimPreimage: (outpoints, paymentHashHex) => findClaimPreimage(ctx, outpoints, paymentHashHex),
    refundUnrolled: refundUnrolledLockup(unrolledRefunderFor(ctx)),
  }
}
