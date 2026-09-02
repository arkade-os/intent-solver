import { describe, it, expect } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { SigHash } from '@scure/btc-signer'
import { buildOnchainHtlc, ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'
import { buildOnchainClaimTx, estimateClaimTxVsize, signOnchainClaimTx } from '@arkade-os/solver-rails/onchain/claim.js'
import type { OnchainSigner } from '@arkade-os/solver-rails/onchain/refund.js'

const claimPriv = new Uint8Array(32).fill(1)
const refundPriv = new Uint8Array(32).fill(2)
const destPriv = new Uint8Array(32).fill(3)
const P = new Uint8Array(32).fill(42)

const htlc = buildOnchainHtlc({
  network: ONCHAIN_NETWORKS.regtest,
  paymentHash: hex.encode(new Uint8Array(32).fill(9)),
  claimPubkey: schnorr.getPublicKey(claimPriv),
  refundPubkey: schnorr.getPublicKey(refundPriv),
  refundLocktime: 1_800_000_000,
})

/** Mirrors the SDK's own `SeedIdentity.signTxWithKey`, same as test/onchain/refund.test.ts. */
const testSigner = (privateKey: Uint8Array): OnchainSigner => ({
  sign: async (tx, inputIndexes) => {
    const clone = tx.clone()
    for (const idx of inputIndexes ?? [0]) clone.signIdx(privateKey, idx, [SigHash.DEFAULT])
    return clone
  },
})

describe('buildOnchainClaimTx / signOnchainClaimTx', () => {
  it('builds an RBF-enabled spend of the claim leaf with no locktime', () => {
    const tx = buildOnchainClaimTx({
      htlc,
      preimage: P,
      fundingTxid: 'f'.repeat(64),
      fundingVout: 1,
      fundingValueSats: 50_000,
      destinationScript: htlc.pkScript,
      payoutAmountSats: 49_500n,
    })
    // The claim leaf carries no CLTV — buildOnchainHtlc's claim script is
    // SIZE/HASH160/CHECKSIG only, so unlike the refund tx there is nothing
    // for a transaction-level lockTime to gate.
    expect(tx.lockTime).toBe(0)
    expect(tx.getInput(0).sequence).toBe(0xfffffffd)
    expect(tx.getInput(0).index).toBe(1)
  })

  it('signs, finalizes, and extracts a spendable claim transaction with the preimage in the witness', async () => {
    const unsigned = buildOnchainClaimTx({
      htlc,
      preimage: P,
      fundingTxid: 'f'.repeat(64),
      fundingVout: 1,
      fundingValueSats: 50_000,
      destinationScript: htlc.pkScript,
      payoutAmountSats: 49_500n,
    })
    const signed = await signOnchainClaimTx(unsigned, testSigner(claimPriv), P)
    const witness = signed.getInput(0).finalScriptWitness!
    // [signature, preimage, claimScript, controlBlock] — the exact shape
    // preimageFromClaimWitness (src/send/onchainOrchestrator.ts) reads
    // witness[1] out of, and cli.ts's send-onchain self-test already proves
    // for the CLIENT's claim; this is the solver's own mirror of it.
    expect(witness).toHaveLength(4)
    expect(witness[1]).toEqual(P)
    expect(witness[2]).toEqual(htlc.claimScript)
    expect(witness[3]).toEqual(htlc.claimControlBlock)
    expect(() => signed.extract()).not.toThrow()
  })

  it('rejects a signature from the wrong key', async () => {
    const unsigned = buildOnchainClaimTx({
      htlc,
      preimage: P,
      fundingTxid: 'f'.repeat(64),
      fundingVout: 1,
      fundingValueSats: 50_000,
      destinationScript: htlc.pkScript,
      payoutAmountSats: 49_500n,
    })
    await expect(signOnchainClaimTx(unsigned, testSigner(destPriv), P)).rejects.toThrow()
  })
})

describe('estimateClaimTxVsize', () => {
  it('returns a plausible vsize close to a real signed claim tx', async () => {
    const params = {
      htlc,
      preimage: P,
      fundingTxid: 'f'.repeat(64),
      fundingVout: 0,
      fundingValueSats: 50_000,
      destinationScript: htlc.pkScript,
      payoutAmountSats: 49_500n,
    }
    const estimated = estimateClaimTxVsize(params)
    const signed = await signOnchainClaimTx(buildOnchainClaimTx(params), testSigner(claimPriv), P)
    expect(estimated).toBe(signed.vsize)
  })
})
