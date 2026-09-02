/**
 * The solver's own refund spend of an unclaimed onchain HTLC — the mirror
 * of the claim-transaction construction `cli.ts`'s `send-onchain` self-test
 * proves out for the client's claim leaf (Task 11), built here as a
 * reusable module because production code needs it too:
 * `src/send/onchainOrchestrator.ts`'s `whenRefundingOnchain`.
 *
 * Signing goes through `OnchainSigner`, matching the Arkade SDK's own
 * `SeedIdentity.sign(tx, inputIndexes)` exactly — confirmed (reading the
 * SDK's compiled source) to be a thin wrapper over `@scure/btc-signer`'s
 * `Transaction.signIdx`, its standard general-purpose taproot script-path
 * signer. Production wiring is a direct pass-through to
 * `ArkadeContext.identity`; no raw key touches orchestrator code.
 */

import { Transaction, SigHash, TaprootControlBlock } from '@scure/btc-signer'
import { concatBytes } from '@noble/hashes/utils.js'
import type { OnchainHtlc } from './htlc.js'

export interface OnchainSigner {
  sign(tx: InstanceType<typeof Transaction>, inputIndexes?: number[]): Promise<InstanceType<typeof Transaction>>
}

export interface RefundTxParams {
  htlc: Pick<OnchainHtlc, 'pkScript' | 'refundScript' | 'refundControlBlock' | 'refundLocktime'>
  fundingTxid: string
  /**
   * The vout `fundingTxid` actually pays the HTLC at — a wallet-funded
   * transaction may carry a change output ahead of the payment, so this must
   * never be assumed to be 0 (confirmed live: a boltz-lnd regtest send put
   * change at vout 0 and the HTLC payment at vout 1).
   */
  fundingVout: number
  fundingValueSats: number
  destinationScript: Uint8Array
  payoutAmountSats: bigint
}

/** Standard tapscript leaf version — same literal Task 11's CLI code already uses. */
const LEAF_VERSION = 0xc0

const addRefundInput = (tx: InstanceType<typeof Transaction>, params: RefundTxParams): void => {
  tx.addInput({
    txid: params.fundingTxid,
    index: params.fundingVout,
    witnessUtxo: { script: params.htlc.pkScript, amount: BigInt(params.fundingValueSats) },
    // RBF-enabled AND non-final — the latter is required for CHECKLOCKTIMEVERIFY
    // to mature at all, same sequence value the claim side already uses.
    sequence: 0xfffffffd,
    tapLeafScript: [
      [
        TaprootControlBlock.decode(params.htlc.refundControlBlock),
        concatBytes(params.htlc.refundScript, new Uint8Array([LEAF_VERSION])),
      ],
    ],
    sighashType: SigHash.DEFAULT,
  })
}

/**
 * The unsigned refund transaction: one input (the funding output, tagged
 * for the refund leaf), one output. `lockTime` is required — without it
 * CHECKLOCKTIMEVERIFY never matures, regardless of the input's sequence.
 */
export const buildOnchainRefundTx = (params: RefundTxParams): InstanceType<typeof Transaction> => {
  // allowUnknownInputs: the refund leaf (CLTV + single-sig CHECKSIG) is not
  // one of @scure/btc-signer's recognised standard script patterns
  // (OutScript.decode reports 'unknown' for it), so finalize() needs this
  // to extract the signature by locating the pubkey's position in the
  // script rather than refusing outright.
  const tx = new Transaction({
    allowUnknownOutputs: true,
    allowUnknownInputs: true,
    lockTime: params.htlc.refundLocktime,
  })
  addRefundInput(tx, params)
  tx.addOutput({ script: params.destinationScript, amount: params.payoutAmountSats })
  return tx
}

/**
 * vsize this refund spend will have once signed. A DEFAULT-sighash schnorr
 * signature is always exactly 64 bytes, so a dummy-signed build measures
 * the real size before the real (single) sign — avoids calling the signer
 * twice, same reasoning as Task 11's CLI sizing pass.
 */
export const estimateRefundTxVsize = (params: RefundTxParams): number => {
  const sizing = buildOnchainRefundTx(params)
  sizing.updateInput(
    0,
    { finalScriptWitness: [new Uint8Array(64), params.htlc.refundScript, params.htlc.refundControlBlock] },
    true,
  )
  return sizing.vsize
}

/** Sign input 0 and finalize — `tx.extract()` is broadcast-ready after this. */
export const signOnchainRefundTx = async (
  tx: InstanceType<typeof Transaction>,
  signer: OnchainSigner,
): Promise<InstanceType<typeof Transaction>> => {
  const signed = await signer.sign(tx, [0])
  signed.finalize()
  return signed
}
