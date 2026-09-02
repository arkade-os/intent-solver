import { describe, it, expect } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { SigHash } from '@scure/btc-signer'
import { buildOnchainHtlc, ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'
import {
  buildOnchainRefundTx,
  estimateRefundTxVsize,
  signOnchainRefundTx,
  type OnchainSigner,
} from '@arkade-os/solver-rails/onchain/refund.js'

const claimPriv = new Uint8Array(32).fill(1)
const refundPriv = new Uint8Array(32).fill(2)
const destPriv = new Uint8Array(32).fill(3)

const htlc = buildOnchainHtlc({
  network: ONCHAIN_NETWORKS.regtest,
  paymentHash: hex.encode(new Uint8Array(32).fill(9)),
  claimPubkey: schnorr.getPublicKey(claimPriv),
  refundPubkey: schnorr.getPublicKey(refundPriv),
  refundLocktime: 1_800_000_000,
})

/** Mirrors the SDK's own `SeedIdentity.signTxWithKey` exactly — a raw key
 * standing in for `ArkadeContext.identity` in production. */
const testSigner = (privateKey: Uint8Array): OnchainSigner => ({
  sign: async (tx, inputIndexes) => {
    const clone = tx.clone()
    for (const idx of inputIndexes ?? [0]) clone.signIdx(privateKey, idx, [SigHash.DEFAULT])
    return clone
  },
})

describe('buildOnchainRefundTx / signOnchainRefundTx', () => {
  it('builds a CLTV-locked, RBF-enabled spend of the refund leaf', () => {
    const tx = buildOnchainRefundTx({
      htlc,
      fundingTxid: 'f'.repeat(64),
      fundingVout: 1,
      fundingValueSats: 50_000,
      destinationScript: htlc.pkScript,
      payoutAmountSats: 49_500n,
    })
    expect(tx.lockTime).toBe(htlc.refundLocktime)
    expect(tx.getInput(0).sequence).toBe(0xfffffffd)
    // Spends the ACTUAL funding vout, not a hardcoded 0 — a funding tx with
    // a change output ahead of the payment (confirmed live against boltz-lnd)
    // would otherwise sign against the wrong output entirely.
    expect(tx.getInput(0).index).toBe(1)
  })

  it('signs, finalizes, and extracts a spendable refund transaction', async () => {
    const unsigned = buildOnchainRefundTx({
      htlc,
      fundingTxid: 'f'.repeat(64),
      fundingVout: 1,
      fundingValueSats: 50_000,
      destinationScript: htlc.pkScript,
      payoutAmountSats: 49_500n,
    })
    const signed = await signOnchainRefundTx(unsigned, testSigner(refundPriv))
    const witness = signed.getInput(0).finalScriptWitness!
    expect(witness).toHaveLength(3) // [signature, refundScript, controlBlock] — no preimage, unlike the claim leaf
    expect(witness[1]).toEqual(htlc.refundScript)
    expect(witness[2]).toEqual(htlc.refundControlBlock)
    expect(() => signed.extract()).not.toThrow()
  })

  it('rejects a signature from the wrong key', async () => {
    const unsigned = buildOnchainRefundTx({
      htlc,
      fundingTxid: 'f'.repeat(64),
      fundingVout: 1,
      fundingValueSats: 50_000,
      destinationScript: htlc.pkScript,
      payoutAmountSats: 49_500n,
    })
    await expect(signOnchainRefundTx(unsigned, testSigner(destPriv))).rejects.toThrow()
  })

  it('estimateRefundTxVsize matches the real signed size, so the fee pass is exact', async () => {
    const params = {
      htlc,
      fundingTxid: 'f'.repeat(64),
      fundingVout: 1,
      fundingValueSats: 50_000,
      destinationScript: htlc.pkScript,
      payoutAmountSats: 49_500n,
    }
    const estimated = estimateRefundTxVsize(params)
    const signed = await signOnchainRefundTx(buildOnchainRefundTx(params), testSigner(refundPriv))
    expect(estimated).toBe(signed.vsize)
  })
})
