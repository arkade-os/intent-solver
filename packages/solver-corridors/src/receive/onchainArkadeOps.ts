/**
 * Production {@link OnchainReceiveArkadeOps}: the bridge from the receive
 * orchestrator's row-shaped world to the real Arkade wallet.
 *
 * Reuses `send/arkadeOps.ts`'s `arkadeOpsFromContext` WHOLESALE rather than
 * reimplementing `refund` here: that factory's `refund` already does exactly
 * what this leg needs (rebuild the covenant from the row via
 * `covenantScriptFromRow`, refuse a mismatch via `assertScriptMatchesRow`,
 * then spend the `nonInteractiveRefund` leaf through the emulator) — see
 * `db/onchainReceiveSwaps.ts`'s `providerPubkey` doc comment for why that
 * leaf, proven on the send leg where `receiver` is the solver too, is safely
 * reusable here with zero changes: the covenant's signing role (`receiver`)
 * and its non-interactive-claim payout pin (`receiverPkScript`) are
 * independent VHTLC.ScriptV2 params, so reusing the solver's own identity
 * for the signing role does not touch where the client's own payout lands.
 *
 * Only two capabilities are genuinely new on this leg: funding the Arkade
 * lockup at all (the solver's own action here, never the send leg's) and
 * reading a spend witness back off it (covclaimd's autonomous claim is the
 * one thing that ever spends it besides the solver's own refund).
 */

import { arkadeOpsFromContext, type EmulatorInfo } from '../send/arkadeOps.js'
import { fundLockup } from './fundLockup.js'
import { findClaimPreimage, findLockupOutpoints, type ArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'
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
  fund(params: { address: string; amountSats: number }): Promise<string>

  /**
   * Every outpoint this lockup script has ever held, spent ones included —
   * what {@link findClaimPreimage} has to be given once covclaimd's claim has
   * already spent the output, since a spendable-only view no longer shows it.
   */
  findLockupOutpoints(pkScriptHex: string): Promise<{ txid: string; vout: number }[]>

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
    refund: base.refund,
    findLockupOutpoints: (pkScriptHex) => findLockupOutpoints(ctx, pkScriptHex),
    findClaimPreimage: (outpoints, paymentHashHex) => findClaimPreimage(ctx, outpoints, paymentHashHex),
    // The SHARED funding path, not `wallet.send`. This corridor called
    // `wallet.send` while the lightning one applied coin selection and the
    // reservation ledger — the same money, the same covenant, one of them
    // guarded. Regtest cannot tell the two apart (its batches are shorter than
    // the refund horizon, so the wrong pick and the right one are the same
    // coin), so the difference would only have surfaced on mainnet.
    fund: async (params) => fundLockup(ctx, params.address, params.amountSats),
  }
}
