/**
 * Production {@link OnchainReceiveArkadeOps}: the bridge from the receive
 * orchestrator's row-shaped world to the real Arkade wallet.
 *
 * Reuses `send/arkadeOps.ts`'s `arkadeOpsFromContext` except for `refund`: that
 * one spends `nonInteractiveRefund`, signed by server + RECEIVER + emulator,
 * and here the receiver is the CLIENT. `refundWithoutReceiver` is this leg's
 * recourse, as it is the Lightning receive leg's (`receive/arkadeOps.ts`).
 */

import { hex } from '@scure/base'
import {
  arkadeOpsFromContext,
  assertScriptMatchesRow,
  covenantScriptFromRow,
  type EmulatorInfo,
} from '../send/arkadeOps.js'
import { fundLockup } from './fundLockup.js'
import type { ClaimPacketStamp } from '@arkade-os/solver-arkade/arkade/arkadeOps.js'
import {
  findClaimPreimage,
  findLockupOutpoints,
  refundWithoutReceiverSwapScript,
  type ArkadeContext,
} from '@arkade-os/solver-arkade/arkade/wallet.js'
import type { ArkadeOps } from '../send/orchestrator.js'

export interface OnchainReceiveArkadeOps extends Pick<
  ArkadeOps,
  | 'providerPubkey'
  | 'serverPubkey'
  | 'emulatorPubkey'
  | 'receiverPkScript'
  | 'delays'
  | 'hrp'
  | 'findLockups'
  | 'refund'
> {
  /**
   * Fund the Arkade lockup out of the solver's own wallet — the one
   * Arkade-side action that belongs to the receive leg alone; the send leg
   * never calls anything like this (the CLIENT funds that side there).
   */
  fund(params: { address: string; amountSats: number; stamp?: ClaimPacketStamp }): Promise<string>

  /**
   * Every outpoint this lockup script has ever held, spent ones included —
   * what {@link findClaimPreimage} has to be given once covclaimd's claim has
   * already spent the output, since a spendable-only view no longer shows it.
   * `unrolled` means it has left Arkade, so a spend of it reveals `P` in an L1
   * witness {@link findClaimPreimage} cannot read.
   */
  findLockupOutpoints(pkScriptHex: string): Promise<{ txid: string; vout: number; unrolled: boolean }[]>

  /**
   * The preimage out of whatever claimed one of `outpoints`, verified against
   * `paymentHashHex` — how the solver learns `P` once covclaimd's autonomous
   * claim lands, and the only thing that lets it claim the client's onchain
   * HTLC. Shared verbatim with the Lightning receive leg (`arkade/wallet.ts`),
   * because the covenant it reads and the discipline it applies are identical.
   */
  findClaimPreimage(
    outpoints: readonly { txid: string; vout: number }[],
    paymentHashHex: string,
  ): Promise<Uint8Array | null>
}

export const onchainReceiveArkadeOpsFromContext = async (
  ctx: ArkadeContext,
  emulator: EmulatorInfo,
): Promise<OnchainReceiveArkadeOps> => {
  const base = await arkadeOpsFromContext(ctx, emulator)
  return {
    providerPubkey: base.providerPubkey,
    serverPubkey: base.serverPubkey,
    emulatorPubkey: base.emulatorPubkey,
    receiverPkScript: base.receiverPkScript,
    delays: base.delays,
    hrp: base.hrp,
    findLockups: base.findLockups,
    refund: async (row, outputs) => {
      const script = covenantScriptFromRow(row)
      assertScriptMatchesRow(script, row)
      return refundWithoutReceiverSwapScript(ctx, script, [...outputs], hex.decode(row.refundPkScript!))
    },
    findLockupOutpoints: (pkScriptHex) => findLockupOutpoints(ctx, pkScriptHex),
    findClaimPreimage: (outpoints, paymentHashHex) => findClaimPreimage(ctx, outpoints, paymentHashHex),
    // The SHARED funding path, not `wallet.send`: coin selection and the
    // reservation ledger apply here too. @see fundLockup.ts
    fund: async (params) => fundLockup(ctx, params.address, params.amountSats, params.stamp),
  }
}
