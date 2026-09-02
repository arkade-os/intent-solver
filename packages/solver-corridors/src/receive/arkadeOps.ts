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
 *
 * `assertScriptMatchesRow` here is a deliberate, small duplicate of
 * `send/arkadeOps.ts`'s private (unexported) helper of the same name, rather
 * than an import from it — that file is shared, actively-touched
 * infrastructure this session's sibling work also depends on, and a four-line
 * equality check is cheaper to duplicate than to risk a cross-cutting edit to
 * a file this change does not otherwise need to touch.
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
import { covenantScriptFromRow } from '../send/arkadeOps.js'
import type { CovenantScriptRow } from '../send/orchestrator.js'
import { fundLockup } from './fundLockup.js'

/** The emulator service the refund covenant is signed by — same shape `send/arkadeOps.ts`'s EmulatorInfo takes. */
export interface EmulatorInfo {
  url: string
  /** Compressed pubkey, hex, from the emulator's /v1/info. */
  pubkey: string
}

import type { ReceiveArkadeOps } from '@arkade-os/solver-arkade/arkade/arkadeOps.js'
export type { ReceiveArkadeOps }

/** Refuse to sign against a lockup whose script does not re-derive from the row — same guard `send/arkadeOps.ts` applies. */
const assertScriptMatchesRow = (script: { pkScript: Uint8Array }, row: CovenantScriptRow): void => {
  const derived = hex.encode(script.pkScript)
  if (derived !== row.pkScript) {
    throw new Error(`script rebuilt from row ${row.id} derives ${derived}, lockup is at ${row.pkScript}`)
  }
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
    fund: (address, amountSats) => fundLockup(ctx, address, amountSats),
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
