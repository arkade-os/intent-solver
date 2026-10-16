import { describe, it, expect } from 'vitest'
import {
  onchainClaimSizing,
  onchainReceiveFundedAmounts,
  type FundedAmountRow,
} from '@arkade-os/solver-corridors/receive/onchainFundedAmounts.js'
import { buildOnchainClaimTx } from '@arkade-os/solver-rails/onchain/claim.js'
import { buildOnchainHtlc, ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'

const P = new Uint8Array(32).fill(9)
const htlc = buildOnchainHtlc({
  network: ONCHAIN_NETWORKS.regtest,
  paymentHash: hex.encode(sha256(P)),
  claimPubkey: schnorr.getPublicKey(new Uint8Array(32).fill(7)),
  refundPubkey: new Uint8Array(32).fill(3),
  refundLocktime: 1_800_000_500,
})

const spend = {
  htlc,
  preimage: P,
  fundingTxid: 'ab'.repeat(32),
  fundingVout: 1,
  destinationScript: Uint8Array.from([0x51, 0x20, ...new Uint8Array(32).fill(12)]),
}

/** Quoted 50_000 in, 49_450 out — a 550 sat absolute fee. */
const quoted: FundedAmountRow = { amountSats: 50_000, payoutSats: 49_450, fundedValueSats: null }

describe('onchainReceiveFundedAmounts', () => {
  it('is the quoted pair, exactly, while nothing has amended the row', () => {
    expect(onchainReceiveFundedAmounts(quoted)).toEqual({ fundingValueSats: 50_000, arkadePayoutSats: 49_450 })
  })

  it('gives the client the whole overfund and the solver the same absolute fee', () => {
    const amounts = onchainReceiveFundedAmounts({ ...quoted, fundedValueSats: 55_000 })
    expect(amounts.fundingValueSats).toBe(55_000)
    expect(amounts.arkadePayoutSats).toBe(54_450)
    expect(amounts.fundingValueSats - amounts.arkadePayoutSats).toBe(550)
  })

  it('takes the whole underfund off the client, same fee again', () => {
    const amounts = onchainReceiveFundedAmounts({ ...quoted, fundedValueSats: 47_000 })
    expect(amounts.arkadePayoutSats).toBe(46_450)
    expect(amounts.fundingValueSats - amounts.arkadePayoutSats).toBe(550)
  })

  it('holds the fee across the whole range rather than re-pricing at any point', () => {
    for (const fundedValueSats of [1_000, 12_345, 50_000, 999_999]) {
      const amounts = onchainReceiveFundedAmounts({ ...quoted, fundedValueSats })
      expect(amounts.fundingValueSats - amounts.arkadePayoutSats).toBe(550)
    }
  })
})

describe('onchainClaimSizing', () => {
  it('commits the claim signature to what the output HELD, via witnessUtxo', () => {
    const sizing = onchainClaimSizing({ ...quoted, fundedValueSats: 55_000 }, spend)
    // What the BIP341 sighash commits to: wrong here and the claim is
    // unbroadcastable, not merely mispriced.
    const tx = buildOnchainClaimTx(sizing.params)
    expect(tx.getInput(0).witnessUtxo?.amount).toBe(55_000n)
    expect(tx.getInput(0).witnessUtxo?.amount).not.toBe(50_000n)
  })

  it('pays the claim output out of the same value it sized the input at', () => {
    const sizing = onchainClaimSizing({ ...quoted, fundedValueSats: 55_000 }, spend)
    const fee = 400n
    const tx = buildOnchainClaimTx({ ...sizing.params, payoutAmountSats: sizing.payoutAfterFee(fee) })
    expect(tx.getOutput(0).amount).toBe(54_600n)
    // Input and output agree: nothing of the overfund is left behind for miners.
    expect(tx.getInput(0).witnessUtxo!.amount - tx.getOutput(0).amount!).toBe(fee)
  })

  it('is the quoted amount on both sides for an unamended row', () => {
    const sizing = onchainClaimSizing(quoted, spend)
    expect(sizing.params.fundingValueSats).toBe(50_000)
    expect(sizing.payoutAfterFee(400n)).toBe(49_600n)
  })
})
