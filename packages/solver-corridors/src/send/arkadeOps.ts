/**
 * Production {@link ArkadeOps}: the bridge from the orchestrator's row-shaped world
 * to the real Arkade wallet.
 *
 * The one rule embodied here: the script is rebuilt FROM THE ROW, never from
 * live state. The delays and the emulator key snapshotted at quote time are the
 * ones the funded script was built with; re-deriving either from a live service
 * at claim time would produce a different script the moment the operator
 * rotates a parameter, and a different script cannot spend the funded one.
 */

import { hex } from '@scure/base'
import { ArkAddress } from '@arkade-os/sdk'
import {
  claimSwapScript,
  findClaimPreimage,
  findLockupOutpoints,
  findLockups,
  findSweptLockups,
  lockupProvablySpent,
  lockupSpendEvidence,
  refundSwapScript,
  type ArkadeContext,
} from '@arkade-os/solver-arkade/arkade/wallet.js'
import { rawDelaySeconds } from '@arkade-os/solver-core/core/timelocks.js'
import { unrolledSpenderFor } from '@arkade-os/solver-arkade/arkade/unrolledSpend.js'
import { refundSweptSwapScript } from '@arkade-os/solver-arkade/arkade/sweptRefund.js'
import type { ArkadeOps, CovenantScriptRow } from './orchestrator.js'

/** The emulator service the refund covenant is signed by. */
export interface EmulatorInfo {
  url: string
  /** Compressed pubkey, hex, from the emulator's /v1/info. */
  pubkey: string
}

import { covenantScriptFromRow } from '@arkade-os/solver-arkade/arkade/covenantRow.js'
export { covenantScriptFromRow }

/** Refuse to sign against a lockup whose script does not re-derive from the row. */
export const assertScriptMatchesRow = (script: { pkScript: Uint8Array }, row: CovenantScriptRow): void => {
  const derived = hex.encode(script.pkScript)
  if (derived !== row.pkScript) {
    throw new Error(`script rebuilt from row ${row.id} derives ${derived}, lockup is at ${row.pkScript}`)
  }
}

export const unrolledLockupOf = (row: CovenantScriptRow, lockup: { txid: string; vout: number }) => {
  const script = covenantScriptFromRow(row)
  assertScriptMatchesRow(script, row)
  const exitDelaySeconds = Math.min(
    ...[row.claimDelay, row.refundDelay, row.refundWithoutReceiverDelay].map(rawDelaySeconds),
  )
  return { script, txid: lockup.txid, vout: lockup.vout, exitDelaySeconds }
}

export const arkadeOpsFromContext = async (ctx: ArkadeContext, emulator: EmulatorInfo): Promise<ArkadeOps> => {
  const providerPubkey = hex.encode(await ctx.identity.xOnlyPublicKey())
  // The same general-purpose receiving address claimSwapScript already sends
  // interactive claims to (`destination` below) — decoded to its pkScript so
  // `nonInteractiveClaim`'s covenant can commit to it at quote time.
  const receiverPkScript = hex.encode(ArkAddress.decode(await ctx.wallet.getAddress()).pkScript)
  const spender = unrolledSpenderFor(ctx)
  // assertScriptMatchesRow proves the row is self-consistent; this proves
  // the LIVE key can spend it. A rotated mnemonic would otherwise surface
  // deep in the server round-trip as a signature error naming nothing.
  const keyMismatch = (row: CovenantScriptRow): string | null =>
    row.receiverPubkey === providerPubkey
      ? null
      : `swap ${row.id} was quoted under a different provider key; the live key cannot claim it`
  return {
    providerPubkey,
    serverPubkey: hex.encode(ctx.wallet.arkServerPublicKey),
    emulatorPubkey: emulator.pubkey,
    receiverPkScript,
    delays: ctx.unilateralDelays,
    hrp: ctx.hrp,
    findLockups: (pkScriptHex) => findLockups(ctx, pkScriptHex),
    lockupProvablySpent: (pkScriptHex) => lockupProvablySpent(ctx, pkScriptHex),
    lockupSpendEvidence: (pkScriptHex) => lockupSpendEvidence(ctx, pkScriptHex),
    claim: async (row, outputs, preimageHex) => {
      const mismatch = keyMismatch(row)
      if (mismatch) throw new Error(mismatch)
      const script = covenantScriptFromRow(row)
      assertScriptMatchesRow(script, row)
      const destination = await ctx.wallet.getAddress()
      return claimSwapScript(ctx, script, outputs, hex.decode(preimageHex), destination)
    },
    refund: async (row, outputs) => {
      const script = covenantScriptFromRow(row)
      assertScriptMatchesRow(script, row)
      return refundSwapScript(ctx, emulator.url, script, outputs, hex.decode(row.refundPkScript!))
    },
    findLockupOutpoints: (pkScriptHex) => findLockupOutpoints(ctx, pkScriptHex),
    findClaimPreimage: (outpoints, paymentHashHex) => findClaimPreimage(ctx, outpoints, paymentHashHex),
    // Closed, not thrown: a held throw would keep the row claiming with nothing left to try.
    claimUnrolled: async (row, lockup, record, save, preimageHex) => {
      const reason = keyMismatch(row)
      if (reason) return { kind: 'closed', reason }
      return spender.advance({ ...unrolledLockupOf(row, lockup), preimage: hex.decode(preimageHex) }, record, save)
    },
    findSweptLockups: (pkScriptHex) => findSweptLockups(ctx, pkScriptHex),
    refundSwept: async (row, swept) => {
      const script = covenantScriptFromRow(row)
      assertScriptMatchesRow(script, row)
      return refundSweptSwapScript(ctx, emulator.url, script, swept, hex.decode(row.refundPkScript!))
    },
  }
}
