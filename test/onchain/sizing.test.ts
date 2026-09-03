/**
 * The vbyte figures the two onchain corridors are priced off.
 *
 * The claim side has a stronger claim to make than "the number looks right":
 * `claimSpendVsize` sizes a PLACEHOLDER HTLC, and pricing is only honest if
 * that measures the same as the real spend the solver will later broadcast for
 * an actual swap. So the first test builds a real HTLC from real keys and a
 * real payment hash and asserts the two agree exactly — if a script ever gains
 * a variable-width field, this fails rather than quietly under-collecting on
 * every quote.
 *
 * The funding side cannot make that claim (the backend's wallet picks its own
 * inputs), so what is asserted there is the shape: it responds to the change
 * script it is handed, and it lands in the range a one-input, two-output
 * taproot spend actually occupies.
 */

import { describe, it, expect } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { OutScript, p2tr } from '@scure/btc-signer'
import { buildOnchainHtlc, ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'
import { estimateClaimTxVsize } from '@arkade-os/solver-rails/onchain/claim.js'
import { claimSpendVsize, fundingTxVsize } from '@arkade-os/solver-rails/onchain/sizing.js'

const network = ONCHAIN_NETWORKS.regtest
const p2trScript = p2tr(schnorr.getPublicKey(new Uint8Array(32).fill(3)), undefined, network).script
const p2wpkhScript = OutScript.encode({ type: 'wpkh', hash: new Uint8Array(20).fill(4) })

describe('claimSpendVsize', () => {
  it('measures exactly what a real swap-specific claim will, so a quote is not sized off a fiction', () => {
    const real = buildOnchainHtlc({
      network,
      paymentHash: hex.encode(new Uint8Array(32).fill(9)),
      claimPubkey: schnorr.getPublicKey(new Uint8Array(32).fill(1)),
      refundPubkey: schnorr.getPublicKey(new Uint8Array(32).fill(2)),
      // Deliberately a different width from the placeholder's locktime once
      // encoded as a CScriptNum: it changes the refund leaf, which changes the
      // taptree, and must still change nothing about a claim spend's size.
      refundLocktime: 2_100_000_000,
    })
    const swapSpecific = estimateClaimTxVsize({
      htlc: real,
      preimage: new Uint8Array(32).fill(42),
      fundingTxid: 'f'.repeat(64),
      fundingVout: 1,
      fundingValueSats: 50_000,
      destinationScript: p2trScript,
      payoutAmountSats: 49_500n,
    })
    expect(claimSpendVsize({ network, destinationScript: p2trScript })).toBe(swapSpecific)
  })

  it('charges the destination it will actually pay to, not an assumed one', () => {
    // A P2TR output is 43 vbytes on the wire and a P2WPKH one is 31. Sizing
    // every deployment as though it claimed to taproot would overcharge a
    // wallet handing out segwit v0 addresses by the difference, on every swap.
    const toTaproot = claimSpendVsize({ network, destinationScript: p2trScript })
    const toSegwitV0 = claimSpendVsize({ network, destinationScript: p2wpkhScript })
    expect(toTaproot - toSegwitV0).toBe(12)
  })

  it('is the size a script-path claim actually occupies', () => {
    // 152 vbytes: one taproot script-path input carrying a 64-byte signature, a
    // 32-byte preimage, the 61-byte claim leaf and a 65-byte control block,
    // plus one P2TR output. Written down so a change in any of those is a
    // deliberate edit here rather than a silent reprice.
    expect(claimSpendVsize({ network, destinationScript: p2trScript })).toBe(152)
  })
})

describe('fundingTxVsize', () => {
  it('is the size a one-input, two-output taproot funding spend actually occupies', () => {
    // 154 vbytes: one key-path P2TR input (57.5), the HTLC's P2TR output and a
    // P2TR change output (43 each), plus overhead.
    expect(fundingTxVsize({ network, changeScript: p2trScript })).toBe(154)
  })

  it('responds to the wallet script it is handed rather than assuming one', () => {
    expect(fundingTxVsize({ network, changeScript: p2trScript })).toBeGreaterThan(
      fundingTxVsize({ network, changeScript: p2wpkhScript }),
    )
  })

  it('is not the claim spend — the two directions pay for different transactions', () => {
    // The whole reason `vsize` is per corridor: on send the TAKER claims, so
    // charging a claim's worth would bill for a transaction the solver never
    // broadcasts.
    expect(fundingTxVsize({ network, changeScript: p2trScript })).not.toBe(
      claimSpendVsize({ network, destinationScript: p2trScript }),
    )
  })
})
