/**
 * Our onchain HTLC script against `@arkade-os/swap`'s, byte for byte.
 *
 * ## Why this file exists
 *
 * `src/onchain/htlc.ts` and the SDK's `onchainHtlcScript` build the SAME
 * contract from the same inputs, in two repositories, by hand. They agree
 * today — this file is how we found out, and how we keep finding out.
 *
 * Nothing enforced that agreement. It held because two people were careful,
 * which is not a property you can rely on across two release cycles.
 *
 * ## Why THIS duplication, ahead of the others
 *
 * A drifted constant costs a refused quote: loud, recoverable, and
 * `clientGates.test.ts` already catches it. A drifted SCRIPT changes the
 * derived address, so the client funds one place and the solver watches
 * another. Nothing refuses. The money sits somewhere neither side is looking.
 *
 * The SDK's own comment on that function says it plainly: *"any drift here
 * changes addresses on BOTH sides of a swap."*
 *
 * ## What this does NOT do
 *
 * It does not migrate. Deleting our implementation and delegating is the
 * obvious follow-up and is now provably safe, but it is a money-path change to
 * address derivation and deserves its own diff. This pins the agreement so
 * that change can be made — or deferred indefinitely — without the two drifting
 * in the meantime.
 */

import { describe, it, expect } from 'vitest'
import { hex } from '@scure/base'
import { onchainHtlcScript } from '@arkade-os/swap'
import { buildOnchainHtlc, ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'
import type { SwapNetwork } from '@arkade-os/solver-core/core/networks.js'

/**
 * Our networks mapped onto the SDK's, and the mapping is the interesting part.
 *
 * We serve four; the SDK names three. `signet` and `mutinynet` have no SDK
 * name — both are `tb`-prefixed test networks, which is what the SDK calls
 * `testnet`, so both map there.
 *
 * This is the mapping a migration would have to make, and the one most likely
 * to be made wrong: sending `signet` to `bitcoin` yields a MAINNET address for
 * a signet swap, silently, because the script bytes are identical and only the
 * bech32 HRP differs. Mutinynet is where this service actually runs, so it is
 * the deployment with no direct SDK name and the one worth pinning hardest.
 */
const SDK_NETWORK = {
  bitcoin: 'bitcoin',
  regtest: 'regtest',
  signet: 'testnet',
  mutinynet: 'testnet',
} as const satisfies Record<SwapNetwork, 'bitcoin' | 'testnet' | 'regtest'>

/**
 * Several input sets, not one.
 *
 * A single fixture can agree by coincidence — two implementations that both
 * happen to mishandle the same edge produce the same wrong answer. Varying the
 * payment hash, both keys and the locktime means agreement has to hold across
 * the parts that are actually derived rather than copied.
 *
 * The locktimes are chosen to straddle the values BIP65 treats differently:
 * below 500,000,000 is a block height, at or above it is a unix timestamp, and
 * the encoding of the pushed number changes with its magnitude.
 */
const CASES = [
  { why: 'an ordinary swap', hash: 'a'.repeat(64), claim: '02', refund: '03', locktime: 1_800_000_000 },
  { why: 'distinct keys', hash: 'f'.repeat(64), claim: '1a', refund: 'b7', locktime: 1_900_000_123 },
  { why: 'the timestamp boundary itself', hash: '7'.repeat(64), claim: 'de', refund: 'ad', locktime: 500_000_000 },
  { why: 'a far-future locktime', hash: '3'.repeat(64), claim: '9c', refund: '41', locktime: 4_000_000_000 },
] as const

describe('the onchain HTLC script matches @arkade-os/swap byte for byte', () => {
  const networks = Object.keys(SDK_NETWORK) as SwapNetwork[]

  it.each(networks.flatMap((network) => CASES.map((c) => [network, c.why, c] as const)))(
    'on %s, for %s',
    (network, _why, c) => {
      const claimKey = hex.decode(c.claim.repeat(32))
      const refundKey = hex.decode(c.refund.repeat(32))

      const ours = buildOnchainHtlc({
        network: ONCHAIN_NETWORKS[network],
        paymentHash: c.hash,
        claimPubkey: claimKey,
        refundPubkey: refundKey,
        refundLocktime: c.locktime,
      })
      const theirs = onchainHtlcScript(
        { paymentHash: c.hash, claimKey, refundKey, refundLocktime: c.locktime },
        SDK_NETWORK[network],
      )

      // The address is what a client funds, so it is the one that loses money.
      expect(ours.address).toBe(theirs.address)
      // Everything the address is derived FROM, so a match above cannot be a
      // coincidence of two different trees hashing alike.
      expect(hex.encode(ours.pkScript)).toBe(hex.encode(theirs.pkScript))
      expect(hex.encode(ours.claimScript)).toBe(hex.encode(theirs.leaves.claim))
      expect(hex.encode(ours.refundScript)).toBe(hex.encode(theirs.leaves.refund))
      // The control blocks, which are NOT implied by the four above.
      //
      // Easy to assume they are: they are derived from the same tree, so equal
      // leaves and an equal address look like they should force equal paths.
      // They do not. A control block also carries the internal key and the
      // output key's parity bit, and taproot's merkle branch sorts each pair
      // lexicographically — so two implementations can agree on the root, and
      // therefore on the address, while disagreeing on what a spender must put
      // in the witness. That failure is invisible until someone actually spends
      // a leaf, which on this contract means a refund that will not go through.
      expect(hex.encode(ours.claimControlBlock)).toBe(hex.encode(theirs.controlBlocks.claim))
      expect(hex.encode(ours.refundControlBlock)).toBe(hex.encode(theirs.controlBlocks.refund))
    },
  )

  /**
   * The control: this suite must be able to fail.
   *
   * Every assertion above is an equality between two implementations, so if the
   * SDK import silently resolved to our own module — or to a stub — everything
   * would pass while proving nothing. Feeding the SDK a DIFFERENT input must
   * produce a different address, which is only true if it is really computing
   * one.
   */
  it('is not comparing something with itself', () => {
    const key = hex.decode('02'.repeat(32))
    const base = onchainHtlcScript(
      { paymentHash: 'a'.repeat(64), claimKey: key, refundKey: key, refundLocktime: 1_800_000_000 },
      'regtest',
    )
    const moved = onchainHtlcScript(
      { paymentHash: 'a'.repeat(64), claimKey: key, refundKey: key, refundLocktime: 1_800_000_001 },
      'regtest',
    )
    expect(base.address).not.toBe(moved.address)
  })

  /**
   * WHERE THE TWO USED TO DIVERGE, and no longer do.
   *
   * BIP65 reads an absolute locktime below `LOCKTIME_THRESHOLD` (500,000,000)
   * as a BLOCK HEIGHT rather than a unix timestamp. Every deadline in this
   * service is unix seconds, so a height-shaped value does not mean "a bit
   * earlier" — it means a different unit, and one that will not be reached for
   * millennia. The refund leaf would be dead: funds recoverable only by the
   * claim path, which needs a preimage the solver may never see.
   *
   * `assertAbsoluteLocktime` refused it and `onchainHtlcScript` did not, so
   * this was pinned as a deliberate DIFFERENCE and reported upstream
   * (arkade-os/ts-sdk#774). The SDK adopted the guard in
   * `@arkade-os/swap@0.0.9` (ts-sdk#779), so both now throw — this test keeps
   * the pin, updated, because a regression on EITHER side is what a migration
   * would silently drop.
   */
  it('refuses a height-shaped locktime, as the SDK now does too', () => {
    const key = hex.decode('02'.repeat(32))
    const belowThreshold = 499_999_999
    const args = { paymentHash: 'a'.repeat(64), claimKey: key, refundKey: key, refundLocktime: belowThreshold }

    expect(() =>
      buildOnchainHtlc({
        network: ONCHAIN_NETWORKS.regtest,
        paymentHash: 'a'.repeat(64),
        claimPubkey: key,
        refundPubkey: key,
        refundLocktime: belowThreshold,
      }),
    ).toThrow(/below LOCKTIME_THRESHOLD/)

    // The asymmetry this test once existed for is gone: since 0.0.9 the SDK
    // throws the same refusal rather than building the dead script.
    expect(() => onchainHtlcScript(args, 'regtest')).toThrow(/below LOCKTIME_THRESHOLD/)
  })

  /**
   * The mapping's own hazard, pinned rather than left to a comment.
   *
   * `signet` and `mutinynet` are both `tb`, so they share an address — that is
   * correct and expected. What must NEVER hold is a testnet address equalling
   * the mainnet one: if a migration mapped either to `bitcoin`, the script
   * bytes would still match and only this assertion would notice.
   */
  it('keeps the test networks distinct from mainnet', () => {
    const args = {
      paymentHash: 'a'.repeat(64),
      claimKey: hex.decode('02'.repeat(32)),
      refundKey: hex.decode('03'.repeat(32)),
      refundLocktime: 1_800_000_000,
    }
    const [main, signet, regtest] = (['bitcoin', 'testnet', 'regtest'] as const).map(
      (n) => onchainHtlcScript(args, n).address,
    )
    expect(signet).not.toBe(main)
    expect(regtest).not.toBe(main)
    expect(regtest).not.toBe(signet)
  })
})
