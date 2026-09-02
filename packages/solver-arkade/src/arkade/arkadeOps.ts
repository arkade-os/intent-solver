/**
 * The Arkade operations a corridor orchestrator needs, shaped for injection.
 *
 * The interfaces live in the ARKADE package, not beside one corridor's
 * orchestrator: every corridor (BTC and EVM alike) drives the same wallet
 * through these shapes, and a corridor package must compile without importing
 * another corridor's orchestrator to name them. The production bridges stay
 * corridor-side (`send/arkadeOps.ts`, `receive/arkadeOps.ts`); what moved here
 * is the CONTRACT both bridge to.
 */

import type { UnilateralDelays } from '@arkade-os/solver-core/core/timelocks.js'
import type { FundedOutput } from './wallet.js'
import type { CovenantScriptRow } from './covenantRow.js'

/** The Arkade operations the send-side orchestrators need, shaped for injection. */
export interface ArkadeOps {
  /** Provider x-only pubkey, hex. Receiver on this leg; claims with the preimage. */
  providerPubkey: string
  /** Arkade server x-only pubkey, hex. */
  serverPubkey: string
  /** Emulator pubkey (compressed hex) the refund covenant is built against. */
  emulatorPubkey: string
  /**
   * The provider's own Arkade receiving address, decoded to its pkScript
   * (hex) — where `nonInteractiveClaim` must pay. The same general-purpose
   * destination `claim()` already sends interactive claims to.
   */
  receiverPkScript: string
  delays: UnilateralDelays
  /** bech32 prefix for Arkade addresses. */
  hrp: string
  findLockups(pkScriptHex: string): Promise<FundedOutput[]>
  /**
   * Whether every output this script ever held is provably spent — the evidence
   * a refund sweep needs before recording a refund somebody else pushed.
   *
   * Answers false when the indexer knows nothing about the script: that is read
   * lag, not proof. Separate from {@link findLockups} because that read is
   * `spendableOnly`, so its empty answer cannot tell a spend apart from a view
   * that has not caught up.
   */
  lockupProvablySpent(pkScriptHex: string): Promise<boolean>
  /** Spend the claim leaf of the script the row describes, revealing the preimage. */
  claim(row: CovenantScriptRow, outputs: FundedOutput[], preimageHex: string): Promise<string>
  /** Push the covenant refund of the script the row describes. Needs no keys of ours. */
  refund(row: CovenantScriptRow, outputs: FundedOutput[]): Promise<string>
}

/** The Arkade operations the receive orchestrator needs, shaped for injection. */
export interface ReceiveArkadeOps {
  /**
   * The solver's own x-only key. Plays the covenant's `client` role on this
   * leg — the funder-refund fallback — NOT the `receiver` role: the solver
   * funds the lockup here, so it needs `client`'s "needs nobody" recourse,
   * not `receiver`'s claim path. See `src/arkade/covenant.ts`'s role-inversion
   * note.
   */
  solverPubkey: string
  serverPubkey: string
  emulatorPubkey: string
  /** Where the solver's own refund must land — the `refundWithoutReceiver` leaf's destination on this leg. */
  solverRefundPkScript: string
  delays: UnilateralDelays
  /** bech32 prefix for Arkade addresses. */
  hrp: string
  findLockups(pkScriptHex: string): Promise<FundedOutput[]>
  /**
   * Every outpoint this script has EVER held, spent ones included, with the
   * value each carried.
   *
   * The spend-aware read `findLockups` cannot be: it is `spendableOnly`, so a
   * lockup that was funded and then claimed vanishes from it — and on THIS leg
   * that blind spot is a double-spend of the provider's own capital, because
   * the funding decision is made against it. See `whenArmed`.
   */
  findLockupOutpoints(pkScriptHex: string): Promise<{ txid: string; vout: number; value: number; spent: boolean }[]>
  /** Pay `amountSats` from the solver's own Arkade balance to `address` — funds the lockup. @returns the Arkade txid. */
  fund(address: string, amountSats: number): Promise<string>
  /** Push the covenant refund of the script the row describes, back to the solver's own address. Needs no client keys. */
  refund(row: CovenantScriptRow, outputs: readonly FundedOutput[]): Promise<string>
  /** Read the preimage back out of whichever transaction claimed one of `outpoints`, verified against `paymentHashHex`. */
  findClaimPreimage(
    outpoints: readonly { txid: string; vout: number }[],
    paymentHashHex: string,
  ): Promise<Uint8Array | null>
}
