/**
 * The solver's own claim spend of a CLIENT-funded onchain HTLC — the receive
 * leg's mirror of `src/onchain/refund.ts`. On send, the CLIENT claims and the
 * solver refunds; on receive the roles swap (`buildOnchainHtlc` is fully
 * role-agnostic either way — see `htlc.ts`), and it is the SOLVER doing the
 * claiming, once covclaimd's Arkade-side claim has made `P` public.
 *
 * Signing goes through the same `OnchainSigner` port as `refund.ts` — no raw
 * key touches orchestrator code here either.
 */

import { Transaction, SigHash, TaprootControlBlock } from '@scure/btc-signer'
import { concatBytes } from '@noble/hashes/utils.js'
import type { OnchainHtlc } from './htlc.js'
import type { OnchainSigner } from './refund.js'

export interface ClaimTxParams {
  htlc: Pick<OnchainHtlc, 'pkScript' | 'claimScript' | 'claimControlBlock'>
  /** `P`, raw 32 bytes — pushed into the witness alongside the signature. */
  preimage: Uint8Array
  fundingTxid: string
  /**
   * The vout `fundingTxid` actually pays the HTLC at — the CLIENT funded
   * this one (role-reversed from `refund.ts`'s own doc comment, same
   * underlying reason: never assume 0).
   */
  fundingVout: number
  fundingValueSats: number
  destinationScript: Uint8Array
  payoutAmountSats: bigint
}

/** Standard tapscript leaf version — same literal `refund.ts` uses. */
const LEAF_VERSION = 0xc0

const addClaimInput = (tx: InstanceType<typeof Transaction>, params: ClaimTxParams): void => {
  tx.addInput({
    txid: params.fundingTxid,
    index: params.fundingVout,
    witnessUtxo: { script: params.htlc.pkScript, amount: BigInt(params.fundingValueSats) },
    // RBF-enabled, same sequence value the refund side and the CLI's client
    // self-test both use — the claim leaf carries no CLTV, so non-finality
    // is a policy choice here, not a maturity requirement.
    sequence: 0xfffffffd,
    tapLeafScript: [
      [
        TaprootControlBlock.decode(params.htlc.claimControlBlock),
        concatBytes(params.htlc.claimScript, new Uint8Array([LEAF_VERSION])),
      ],
    ],
    sighashType: SigHash.DEFAULT,
  })
}

/**
 * The unsigned claim transaction: one input (the funding output, tagged for
 * the claim leaf), one output. Unlike `buildOnchainRefundTx`, no `lockTime`:
 * `buildOnchainHtlc`'s claim script (`htlc.ts`) is `SIZE 32 EQUALVERIFY
 * HASH160 <hash20> EQUALVERIFY <claimPubkey> CHECKSIG` — no CHECKLOCKTIMEVERIFY,
 * so there is nothing for a transaction-level locktime to gate.
 */
export const buildOnchainClaimTx = (params: ClaimTxParams): InstanceType<typeof Transaction> => {
  const tx = new Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true })
  addClaimInput(tx, params)
  tx.addOutput({ script: params.destinationScript, amount: params.payoutAmountSats })
  return tx
}

/**
 * vsize this claim spend will have once signed. Same dummy-signature sizing
 * trick as `estimateRefundTxVsize`, extended with the preimage: a DEFAULT-
 * sighash schnorr signature is always exactly 64 bytes and `preimage` is a
 * known 32-byte fact at build time, so a dummy-signed build measures the
 * real size before the real (single) sign.
 */
export const estimateClaimTxVsize = (params: ClaimTxParams): number => {
  const sizing = buildOnchainClaimTx(params)
  sizing.updateInput(
    0,
    {
      finalScriptWitness: [new Uint8Array(64), params.preimage, params.htlc.claimScript, params.htlc.claimControlBlock],
    },
    true,
  )
  return sizing.vsize
}

/**
 * Sign input 0, finalize, then splice `preimage` into the witness —
 * `tx.extract()` is broadcast-ready after this.
 *
 * `finalize()` alone cannot produce the right witness: it assembles
 * `[signature, script, controlBlock]` for a single-signer tapscript leaf,
 * which is correct for `refund.ts`'s CHECKLOCKTIMEVERIFY+CHECKSIG leaf but
 * one element short here — it has no way to know a hash-preimage witness
 * element belongs between the signature and the script, since that shape is
 * specific to `buildOnchainHtlc`'s claim leaf, not a Bitcoin standard
 * pattern `@scure/btc-signer`'s generic finalizer recognises. So: let
 * `finalize()` do the part it knows how to do (produce a valid signature in
 * the right position), then splice the preimage in after — the same
 * `updateInput(..., true)` primitive `estimateClaimTxVsize` above and
 * `refund.ts`'s own sizing pass already use to set a witness directly.
 */
export const signOnchainClaimTx = async (
  tx: InstanceType<typeof Transaction>,
  signer: OnchainSigner,
  preimage: Uint8Array,
): Promise<InstanceType<typeof Transaction>> => {
  const signed = await signer.sign(tx, [0])
  signed.finalize()
  const witness = signed.getInput(0).finalScriptWitness
  if (!witness || witness.length === 0) {
    throw new Error('claim transaction has no witness after finalize — signing must have failed silently')
  }
  const [signature, ...rest] = witness
  signed.updateInput(0, { finalScriptWitness: [signature!, preimage, ...rest] }, true)
  return signed
}
