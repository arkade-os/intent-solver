/**
 * How big the transaction each onchain corridor's solver BROADCASTS is, in
 * vbytes, answered before any swap exists.
 *
 * `estimateClaimTxVsize` and `estimateRefundTxVsize` size a spend the solver is
 * about to make, from that swap's own HTLC. Quoting needs the same number a
 * swap earlier — before there is a payment hash, a client key or a locktime to
 * build one from — so these size a REPRESENTATIVE transaction of the same
 * shape instead, and hand it to `onchainCostSats` as the `vsize` that corridor
 * pays per swap.
 *
 * Representative is exact on the receive side and a model on the send side,
 * which is not a symmetry worth pretending to:
 *
 *  - The CLAIM spend is fully determined. Every field that contributes to its
 *    size is fixed-width — a 32-byte preimage the script's SIZE gate pins, a
 *    64-byte DEFAULT-sighash signature, a claim leaf of fixed-length opcodes
 *    and keys, a 65-byte control block for a two-leaf tree — so a claim built
 *    from placeholder values measures exactly what the real one will.
 *  - The FUNDING transaction is not ours to size. The backend's wallet chooses
 *    its own inputs and change, so this is a model of the common case, and a
 *    wallet that consolidates several inputs into one funding spend costs more
 *    than this says. That is the error `capSats` exists to bound, and the
 *    reason dynamic pricing is off until an operator sets one.
 *
 * Measured through `@scure/btc-signer` rather than written down as a constant:
 * a hand-counted vbyte total is right until a script or an output type changes
 * underneath it, and then it is silently wrong in the direction of the solver
 * paying the difference.
 */

import { Transaction } from '@scure/btc-signer'
import { buildOnchainHtlc, type OnchainNetworkProfile } from './htlc.js'
import { estimateClaimTxVsize } from './claim.js'

/**
 * Placeholder HTLC parameters. None of these reach a transaction that is ever
 * signed or broadcast — they exist only to produce scripts of the right
 * LENGTHS, and every one of them is fixed-width in the claim leaf.
 *
 * The locktime is the one value with a variable encoding (a CScriptNum), and it
 * appears only in the REFUND leaf. That leaf contributes its hash to the
 * taptree and nothing else to a claim spend: the control block for a two-leaf
 * tree is 65 bytes whatever the sibling hashes to. So a claim sized against
 * these placeholders is not merely close to the real one, it is the same size.
 */
const PLACEHOLDER_PAYMENT_HASH = '00'.repeat(32)
/** The outpoint being spent. Its own constant, because a txid is not a payment hash. */
const PLACEHOLDER_TXID = 'ff'.repeat(32)
const PLACEHOLDER_KEY = new Uint8Array(32)
/** Above `LOCKTIME_THRESHOLD`, so `assertAbsoluteLocktime` reads it as seconds rather than a block height. */
const PLACEHOLDER_LOCKTIME = 1_700_000_000

const placeholderHtlc = (network: OnchainNetworkProfile) =>
  buildOnchainHtlc({
    network,
    paymentHash: PLACEHOLDER_PAYMENT_HASH,
    claimPubkey: PLACEHOLDER_KEY,
    refundPubkey: PLACEHOLDER_KEY,
    refundLocktime: PLACEHOLDER_LOCKTIME,
  })

/**
 * The RECEIVE corridor's per-swap chain cost: the solver's own claim of the
 * client-funded HTLC, paying out to `destinationScript`.
 *
 * `destinationScript` is the corridor's REAL claim destination, not a
 * placeholder, because the output is the one part of this transaction whose
 * size the solver's own wallet decides — a P2TR destination costs 12 vbytes
 * more than a P2WPKH one, and that is a real difference in what the corridor
 * pays.
 */
export const claimSpendVsize = (params: { network: OnchainNetworkProfile; destinationScript: Uint8Array }): number => {
  const htlc = placeholderHtlc(params.network)
  return estimateClaimTxVsize({
    htlc,
    preimage: new Uint8Array(32),
    fundingTxid: PLACEHOLDER_TXID,
    fundingVout: 0,
    // Any value: an amount's size on the wire is a fixed 8 bytes, and no input
    // selection happens here — this transaction has exactly one input by
    // construction.
    fundingValueSats: 100_000,
    destinationScript: params.destinationScript,
    payoutAmountSats: 100_000n,
  })
}

/**
 * The SEND corridor's per-swap chain cost: the funding transaction that pays
 * the HTLC address, modelled as one input, the HTLC output, and change.
 *
 * NOT the refund spend. The solver does broadcast one of those when a client
 * never claims, and `estimateRefundTxVsize` sizes it exactly — but that is the
 * unhappy path, and charging every quote for it would collect a refund's worth
 * of fee on the swaps that go right.
 *
 * `changeScript` is the solver's own wallet script, passed in for the same
 * reason the claim's destination is: it is evidence of what THIS wallet's
 * outputs look like, where the input count and type are guesses. One input is
 * modelled because that is the common case for a wallet with a float in it;
 * a key-path P2TR spend is modelled because it is the cheapest, which makes
 * this an UNDER-estimate on a wallet holding older script types rather than an
 * over-estimate that would quietly overcharge.
 */
export const fundingTxVsize = (params: { network: OnchainNetworkProfile; changeScript: Uint8Array }): number => {
  const htlc = placeholderHtlc(params.network)
  const tx = new Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true })
  tx.addInput({
    txid: PLACEHOLDER_TXID,
    index: 0,
    // A P2TR script, reused rather than built: `witnessUtxo` describes the
    // output being SPENT, which a transaction does not serialize at all — it
    // is here so the input is well-formed, and its size cannot reach `vsize`.
    witnessUtxo: { script: htlc.pkScript, amount: 1_000_000n },
    sequence: 0xfffffffd,
  })
  tx.addOutput({ script: htlc.pkScript, amount: 100_000n })
  tx.addOutput({ script: params.changeScript, amount: 800_000n })
  // The same dummy-witness trick `estimateClaimTxVsize` uses, with the witness
  // of a key-path taproot spend: a single 64-byte DEFAULT-sighash signature.
  tx.updateInput(0, { finalScriptWitness: [new Uint8Array(64)] }, true)
  return tx.vsize
}
