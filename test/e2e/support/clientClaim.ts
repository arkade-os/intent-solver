/**
 * The CLIENT claiming the Arkade lockup itself — the fallback both receive
 * corridors depend on when covclaimd is not driving the claim.
 *
 * A TEST FIXTURE, not a template — `examples/lib/receive-client.mjs` is the
 * reference client. That one holds a real quote and checks the funded amount
 * against `to_amount` before it signs; this one cannot, because every caller
 * takes its params off the solver's own row. It stays because an e2e playing
 * both roles needs a claim path, the same reason `packages/solver-app/src/cli.ts`'s
 * `send-onchain` carries the client's claim-transaction signing.
 *
 * The spend goes through the covenant's COLLABORATIVE claim leaf
 * (`preimage + receiver + arkade server`, `src/arkade/covenant.ts`). No CSV,
 * no unilateral exit: the client signs, arkd co-signs, and the preimage rides
 * along in the `ConditionWitness` PSBT field that `claimIdentity.ts` attaches.
 * That is precisely the field the solver then reads back out via
 * `findClaimPreimage`, which is what makes these tests a real check of that
 * round trip against a live node.
 *
 * The covenant is derived HERE from the row's own fields rather than imported
 * from the orchestrator, deliberately: a client derives the script from what
 * it holds and funds/spends only its own derivation. {@link clientClaimLockup}
 * asserts the derivation matches the funded `pkScript` before signing, so a
 * covenant role mapping that drifted between the two corridors fails loudly at
 * this line instead of producing an unspendable lockup.
 */

import { hex } from '@scure/base'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { scriptHashFromPaymentHash } from '@arkade-os/solver-core/core/preimage.js'
import { claimSwapScript, findLockups, type ArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { poll } from '@arkade-os/solver-core/util/poll.js'

/**
 * The covenant fields a client needs, named neutrally — the two receive rows
 * spell them differently (`payoutPubkey`/`solverPubkey` vs.
 * `clientPayoutPubkey`/`providerPubkey`) but mean the same thing, which is the
 * whole point of the corridors sharing one covenant.
 */
export interface ClientClaimParams {
  /** The CLIENT's own Arkade x-only key — the covenant's `receiver`. */
  payoutPubkey: string
  /** Where the claim pays — the CLIENT's own Arkade address. */
  payoutAddress: string
  /** The client's payout P2TR pkScript, pinned into `nonInteractiveClaim`. */
  payoutPkScript: string
  /** The SOLVER's x-only key — the covenant's `client`/sender. */
  solverPubkey: string
  /** The SOLVER's own refund destination pkScript. */
  solverRefundPkScript: string
  serverPubkey: string
  emulatorPubkey: string
  paymentHash: string
  refundLocktime: number
  claimDelay: number
  refundDelay: number
  refundWithoutReceiverDelay: number
  /** The funded lockup's pkScript, hex — what the local derivation must reproduce. */
  pkScript: string
  /**
   * Whether the funded lockup carries the timelocked non-interactive refund
   * leaf — read this off the row (`swap.nonInteractiveParameters`),
   * never hardcode it here: it is what makes this a live test of the row
   * round trip instead of a second constant that can drift from what the
   * solver actually quoted, which is exactly how the client-side derivations
   * fell behind when the flag was gated on stored state.
   */
  nonInteractiveParameters: boolean
}

/** Rebuild the covenant a client holds the `receiver` key for. */
export const clientCovenant = (params: ClientClaimParams): CovenantSwapScript =>
  new CovenantSwapScript({
    receiver: hex.decode(params.payoutPubkey),
    server: hex.decode(params.serverPubkey),
    preimageHash: scriptHashFromPaymentHash(params.paymentHash),
    refundLocktime: params.refundLocktime,
    claimDelay: params.claimDelay,
    client: hex.decode(params.solverPubkey),
    clientRefundDelay: params.refundWithoutReceiverDelay,
    refundWithoutServerDelay: params.refundDelay,
    nonInteractiveParameters: {
      emulatorPubkey: hex.decode(params.emulatorPubkey),
      receiverPkScript: hex.decode(params.payoutPkScript),
      senderPkScript: hex.decode(params.solverRefundPkScript),
      ...(params.nonInteractiveParameters ? {} : { legacy: 'preTimelockedRefund' as const }),
    },
  })

/**
 * Claim the lockup with `preimage`, paying the client's own payout address.
 *
 * `ctx.identity` must be the key named by `params.payoutPubkey` — in these
 * self-tests the same wallet plays both roles, so it is.
 *
 * @returns the Ark txid of the claim.
 */
export const clientClaimLockup = async (
  ctx: ArkadeContext,
  params: ClientClaimParams,
  preimage: Uint8Array,
): Promise<string> => {
  const script = clientCovenant(params)
  const derived = hex.encode(script.pkScript)
  if (derived !== params.pkScript) {
    throw new Error(
      `client derivation ${derived} does not match the funded lockup ${params.pkScript} — ` +
        'the covenant role mapping the solver used and the one the client expects have diverged',
    )
  }
  // POLLED, not read once. The client is a different wallet from the solver
  // that just funded this lockup, and the indexer does not surface a new VTXO
  // to both at the same instant — so a single read immediately after funding
  // can legitimately come back empty. Read once, this failed a receive e2e with
  // "nothing funded ... to claim" AFTER the row already carried its
  // `arkadeFundTxid`, and passed on the next run: a lag, reported as an
  // absence.
  //
  // The window is small, so this is short. `GiveUp` is not used: there is no
  // state in which an empty result here is terminal rather than early — the
  // solver's own funding txid is the proof it will arrive.
  const outputs = await poll(
    async () => {
      const found = await findLockups(ctx, params.pkScript)
      return found.length > 0 ? found : null
    },
    {
      attempts: 10,
      intervalMs: 1000,
      whenExhausted: `nothing funded at ${params.pkScript} to claim`,
    },
  )
  return claimSwapScript(ctx, script, outputs, preimage, params.payoutAddress)
}
