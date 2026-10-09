/**
 * vbytes each onchain corridor's solver broadcasts, sized before any swap exists from a REPRESENTATIVE
 * transaction of the same shape. The claim is exact (every field is fixed-width); funding is a model,
 * since the wallet picks its own inputs — the error `capSats` bounds. Measured through `@scure/btc-signer`
 * rather than a hand-counted constant, which goes silently wrong when a script changes underneath it.
 */

import { Transaction } from '@scure/btc-signer'
import { buildOnchainHtlc, type OnchainNetworkProfile } from './htlc.js'
import { estimateClaimTxVsize } from './claim.js'
import { estimateRefundTxVsize } from './refund.js'

/**
 * Placeholders, never signed or broadcast: only their LENGTHS matter, and each is fixed-width in the claim
 * leaf. The locktime (a variable-width CScriptNum) sits only in the refund leaf, which reaches a claim spend
 * as a sibling hash — a two-leaf control block is 65 bytes regardless — so the size is exact, not close.
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
 * The RECEIVE corridor's per-swap chain cost: the solver's claim of the client-funded HTLC. `destinationScript`
 * is the REAL destination, not a placeholder: a P2TR output costs 12 vbytes more than a P2WPKH one.
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
 * The SEND corridor's unhappy path: the solver's own refund of an HTLC the client never claimed. Not what a
 * quote is PRICED off ({@link fundingTxVsize}) — what its payout FLOOR is sized against. The refund leaf is
 * revealed in this witness, so unlike a claim spend the locktime's CScriptNum width reaches the size: a
 * locktime past 2038 measures one byte wider than the placeholder's.
 */
export const refundSpendVsize = (params: { network: OnchainNetworkProfile; destinationScript: Uint8Array }): number => {
  const htlc = placeholderHtlc(params.network)
  return estimateRefundTxVsize({
    htlc,
    fundingTxid: PLACEHOLDER_TXID,
    fundingVout: 0,
    fundingValueSats: 100_000,
    destinationScript: params.destinationScript,
    payoutAmountSats: 100_000n,
  })
}

/**
 * The SEND corridor's per-swap chain cost: the funding tx (one input, the HTLC output, change to the REAL
 * `changeScript`). NOT the refund spend — that is the unhappy path, and charging every quote for it would
 * overcharge the swaps that go right. The one key-path P2TR input is the cheapest common case, so this
 * UNDER-estimates a wallet holding older script types rather than quietly overcharging.
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
