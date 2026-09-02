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
import { scriptHashFromPaymentHash } from '@arkade-os/solver-core/core/preimage.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import {
  claimSwapScript,
  findLockups,
  lockupProvablySpent,
  refundSwapScript,
  type ArkadeContext,
} from '@arkade-os/solver-arkade/arkade/wallet.js'
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
const assertScriptMatchesRow = (script: { pkScript: Uint8Array }, row: CovenantScriptRow): void => {
  const derived = hex.encode(script.pkScript)
  if (derived !== row.pkScript) {
    throw new Error(`script rebuilt from row ${row.id} derives ${derived}, lockup is at ${row.pkScript}`)
  }
}

export const arkadeOpsFromContext = async (ctx: ArkadeContext, emulator: EmulatorInfo): Promise<ArkadeOps> => {
  const providerPubkey = hex.encode(await ctx.identity.xOnlyPublicKey())
  // The same general-purpose receiving address claimSwapScript already sends
  // interactive claims to (`destination` below) — decoded to its pkScript so
  // `nonInteractiveClaim`'s covenant can commit to it at quote time.
  const receiverPkScript = hex.encode(ArkAddress.decode(await ctx.wallet.getAddress()).pkScript)
  return {
    providerPubkey,
    serverPubkey: hex.encode(ctx.wallet.arkServerPublicKey),
    emulatorPubkey: emulator.pubkey,
    receiverPkScript,
    delays: ctx.unilateralDelays,
    hrp: ctx.hrp,
    findLockups: (pkScriptHex) => findLockups(ctx, pkScriptHex),
    lockupProvablySpent: (pkScriptHex) => lockupProvablySpent(ctx, pkScriptHex),
    claim: async (row, outputs, preimageHex) => {
      // assertScriptMatchesRow proves the row is self-consistent; this proves
      // the LIVE key can spend it. A rotated mnemonic would otherwise surface
      // deep in the server round-trip as a signature error naming nothing.
      if (row.receiverPubkey !== providerPubkey) {
        throw new Error(`swap ${row.id} was quoted under a different provider key; the live key cannot claim it`)
      }
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
  }
}
