/**
 * Does LND tell us about a spend that is only in the mempool?
 *
 * This is the one claim `src/onchain/port.ts` makes that could not be checked
 * without a node, and it decides how much of the onchain claim window the
 * solver actually gets.
 *
 * The preimage becomes public the instant the client's claim is BROADCAST. If
 * `findSpendWitness` only answers once that claim is mined, the solver spends
 * a block's worth of its window waiting for something it could already read —
 * and on the send leg it is worse than slow: `whenRefundingOnchain` reads a
 * `null` as "unspent" and broadcasts the solver's own refund, which is the
 * loss that branch's own comment describes.
 *
 * The two Esplora-backed adapters get this for free (`outspend.spent` is true
 * for an unconfirmed spend). LND does not, and this test is what established
 * that — measured on a regtest node, not inferred from the library:
 *
 *   spend in mempool, watched 60s -> NO EVENT AT ALL
 *   same outpoint, after 1 block  -> event in 32ms
 *
 * So `subscribeToChainSpend` is confirmation-only. Not slow: it never
 * dispatches a mempool spend. `lightning` emits only `['confirmation',
 * 'reorg']` and documents itself as "Subscribe to confirmations of a spend",
 * and lnd gives it nothing else to emit.
 *
 * Which is exactly why the timeout must not answer `null`. On LND a spend can
 * sit in the mempool for a whole block interval while this call has nothing to
 * report, and `null` tells `whenRefundingOnchain` the output is UNSPENT — so it
 * broadcasts the solver's refund against an HTLC the client has already
 * claimed. Rejecting says "I do not know", which is the truth and is safe.
 *
 * This asserts what is TRUE rather than what would be convenient. It does not
 * demand mempool visibility, because lnd does not offer it; it demands that a
 * spend in the mempool never reads as an unspent output.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { SigHash } from '@scure/btc-signer'
import type { OnchainSigner } from '@arkade-os/solver-rails/onchain/refund.js'
import { randomBytes } from 'node:crypto'
import { requireStack } from './support/preflight.js'
import { mineBlocks } from './support/chain.js'
import { esploraUrl } from './support/preflight.js'
import { LndOnchainAdapter } from '@arkade-os/solver-rails-lnd/onchain/lnd/adapter.js'
import { buildOnchainHtlc, ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'
import { buildOnchainClaimTx, signOnchainClaimTx, estimateClaimTxVsize } from '@arkade-os/solver-rails/onchain/claim.js'
import { ONCHAIN_DUST_SATS } from '@arkade-os/solver-core/core/onchainSend.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 180_000
/** Big enough that fees never push the claim under dust, small on regtest. */
const HTLC_SATS = 200_000

const env = (key: string, fallback: string): string => process.env[key]?.trim() || fallback

const adapter = async (): Promise<LndOnchainAdapter> =>
  LndOnchainAdapter.create({
    socket: env('LND_SOCKET', 'localhost:10010'),
    cert: readFileSync(env('LND_CERT_PATH', './boltz-lnd-tls.cert')).toString('base64'),
    macaroon: readFileSync(env('LND_MACAROON_PATH', './boltz-lnd-admin.macaroon')).toString('base64'),
    // `/api` matters: :3000 bare is the mempool web UI and answers HTML.
    esploraUrl: process.env.LND_ESPLORA_URL ?? esploraUrl(),
  })

describe('LndOnchainAdapter.findSpendWitness against a real node', () => {
  let lnd: LndOnchainAdapter

  beforeAll(async () => {
    await requireStack('onchain:BTC->arkade:BTC', ['lnd', 'esplora'])
    lnd = await adapter()
  }, SETUP_TIMEOUT_MS)

  it(
    'reports an UNCONFIRMED spend, or proves it does not',
    async () => {
      // An HTLC only this test can spend: both keys are generated here, so
      // nothing else on the regtest stack can race us for the output.
      const preimage = randomBytes(32)
      const claimPriv = schnorr.utils.randomSecretKey()
      const refundPriv = schnorr.utils.randomSecretKey()
      const htlc = buildOnchainHtlc({
        network: ONCHAIN_NETWORKS.regtest,
        paymentHash: hex.encode(sha256(preimage)),
        claimPubkey: schnorr.getPublicKey(claimPriv),
        refundPubkey: schnorr.getPublicKey(refundPriv),
        // Far enough out that the refund leaf never opens during the test.
        refundLocktime: Math.floor(Date.now() / 1000) + 86_400,
      })

      const funded = await lnd.fund({
        address: htlc.address,
        amountSats: HTLC_SATS,
        idempotencyKey: `mempool-spend-${hex.encode(preimage).slice(0, 16)}`,
      })
      // Confirmed first, so the spend below is the ONLY unconfirmed thing in
      // play — otherwise a null answer could be about the funding instead.
      await mineBlocks(1)

      const unspent = await lnd.findSpendWitness({
        txid: funded.txid,
        vout: funded.vout,
        outputScript: htlc.pkScript,
      })
      expect(unspent, 'a freshly funded HTLC must read as unspent').toBeNull()

      const sizing = {
        htlc,
        preimage,
        fundingTxid: funded.txid,
        fundingVout: funded.vout,
        fundingValueSats: HTLC_SATS,
        destinationScript: htlc.pkScript,
        payoutAmountSats: BigInt(HTLC_SATS),
      }
      const fee = BigInt(Math.ceil(estimateClaimTxVsize(sizing) * (await lnd.estimateFeeRate())))
      const payoutAmountSats = BigInt(HTLC_SATS) - fee
      expect(Number(payoutAmountSats)).toBeGreaterThan(ONCHAIN_DUST_SATS)

      // Same shape as `sendOnchain.e2e.test.ts`'s `rawSigner`: an ephemeral key
      // standing in for the client's own wallet.
      const signer: OnchainSigner = {
        sign: async (tx, inputIndexes) => {
          const clone = tx.clone()
          for (const index of inputIndexes ?? [0]) clone.signIdx(claimPriv, index, [SigHash.DEFAULT])
          return clone
        },
      }
      const signed = await signOnchainClaimTx(buildOnchainClaimTx({ ...sizing, payoutAmountSats }), signer, preimage)
      // BROADCAST, NOT MINED. The whole question is what happens in this gap.
      const claim = await lnd.broadcastRaw(hex.encode(signed.extract()))

      let mempoolWitness: Uint8Array[] | null = null
      let mempoolError: unknown = null
      try {
        mempoolWitness = await lnd.findSpendWitness({
          txid: funded.txid,
          vout: funded.vout,
          outputScript: htlc.pkScript,
        })
      } catch (error) {
        // The 5s timeout now rejects rather than lying "unspent" — a perfectly
        // valid answer here, and exactly what a confirmation-only node gives.
        mempoolError = error
      }

      // eslint-disable-next-line no-console
      console.log(
        `[mempool spend] claim ${claim.txid} broadcast, unmined -> ` +
          (mempoolWitness ? `witness of ${mempoolWitness.length} items (this node IS mempool-aware)` : '') +
          (mempoolError
            ? `refused to guess: ${mempoolError instanceof Error ? mempoolError.message : String(mempoolError)}`
            : '') +
          (!mempoolWitness && !mempoolError ? 'NULL — the bug: a mempool spend read as unspent' : ''),
      )

      // Whatever the node does, it must never claim the output is unspent while
      // a spend of it sits in the mempool. Null there is the answer that costs
      // money — `whenRefundingOnchain` reads it as "go ahead and refund".
      expect(
        mempoolWitness !== null || mempoolError !== null,
        'a spend is in the mempool, so answering null (= "unspent") would send the refund path into a double-spend',
      ).toBe(true)

      // And once mined it must be visible, with the preimage recoverable —
      // this is the path the solver depends on either way.
      await mineBlocks(1)
      const confirmed = await lnd.findSpendWitness({
        txid: funded.txid,
        vout: funded.vout,
        outputScript: htlc.pkScript,
      })
      expect(confirmed, 'a mined spend must always be visible').not.toBeNull()
      expect(confirmed!.some((item) => hex.encode(item) === hex.encode(preimage))).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )
})
