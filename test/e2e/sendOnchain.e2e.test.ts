/**
 * E2E — `arkade:BTC->onchain:BTC` (send), against a live regtest stack with a
 * real LND onchain wallet (boltz-lnd).
 *
 * The in-code equivalent of `packages/solver-app/src/cli.ts`'s `send-onchain` command and of
 * `scripts/e2e-onchain-send.sh`. Plays both roles in one process, and unlike
 * the Lightning leg that means an ACTIVE CLIENT CLAIM: an onchain HTLC only
 * reveals `P` when its claim leaf is spent, so the test signs and broadcasts
 * that claim itself with an ephemeral "client" key.
 *
 * What this proves that no unit test can: the solver reads `P` back out of a
 * REAL claim witness on a real chain (`whenAwaitingClaim` ->
 * `preimageFromClaimWitness`), and then spends the Arkade covenant's claim leaf
 * with it, co-signed by a real arkd.
 *
 * The client's claim spend deliberately goes through `src/onchain/claim.ts`
 * (`buildOnchainClaimTx`/`estimateClaimTxVsize`/`signOnchainClaimTx`) rather
 * than re-assembling the transaction the way `cli.ts` does inline: the claim
 * leaf is the same leaf on both corridors, so reusing that module exercises
 * the very code the RECEIVE corridor's solver-side claim depends on, against a
 * live chain.
 *
 * PREREQUISITES
 *   - arkade-regtest up WITH the boltz profile: arkd, emulator, boltz-lnd,
 *     bitcoin + miner, esplora
 *   - `.env.regtest.lnd` (or E2E_ENV_FILE): ARK_MNEMONIC, ARK_SERVER_URL,
 *     EMULATOR_URL, LND_SOCKET, LND_CERT_PATH, LND_MACAROON_PATH
 *     (extract the cert/macaroon per docs/runbook.md's LND section)
 *   - the Arkade wallet funded AND SETTLED (`scripts/regtest-fund.mjs`), and
 *     boltz-lnd holding confirmed onchain funds (the stack's own setup does this)
 *
 * Run: `pnpm test:e2e`   (never runs in CI — `pnpm test` excludes `test/e2e`)
 */

import { randomBytes } from 'node:crypto'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ArkAddress } from '@arkade-os/sdk'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { Address, OutScript, SigHash, p2tr } from '@scure/btc-signer'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { scriptHashFromPaymentHash } from '@arkade-os/solver-core/core/preimage.js'
import { OnchainSendSwapStore, type OnchainSendSwapRow } from '@arkade-os/solver-corridors/db/onchainSwaps.js'
import { buildOnchainClaimTx, estimateClaimTxVsize, signOnchainClaimTx } from '@arkade-os/solver-rails/onchain/claim.js'
import { buildOnchainHtlc, ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'
import type { OnchainSendBackend } from '@arkade-os/solver-core/ports/onchain.js'
import type { OnchainSigner } from '@arkade-os/solver-rails/onchain/refund.js'
import { arkadeOpsFromContext } from '@arkade-os/solver-corridors/send/arkadeOps.js'
import { OnchainSendSwapService } from '@arkade-os/solver-corridors/send/onchainOrchestrator.js'
import { poll } from '@arkade-os/solver-core/util/poll.js'
import { requireStack } from './support/preflight.js'
import {
  assertArkadeSpendable,
  openArkade,
  openOnchainBackend,
  SETUP_TIMEOUT_MS,
  SWAP_TIMEOUT_MS,
  tempStoreDir,
  type E2eArkade,
} from './support/stack.js'

/** Above the taproot dust limit by a wide margin once a real fee is taken out of it. */
const AMOUNT_SATS = Number(process.env.E2E_AMOUNT_SATS ?? 50_000)

let arkade: E2eArkade
let store: OnchainSendSwapStore
let onchain: OnchainSendBackend & { close?(): Promise<void> }
let service: OnchainSendSwapService

/** A raw ephemeral key standing in for the client's own wallet — mirrors `test/onchain/refund.test.ts`'s signer. */
const rawSigner = (privateKey: Uint8Array): OnchainSigner => ({
  sign: async (tx, inputIndexes) => {
    const clone = tx.clone()
    for (const index of inputIndexes ?? [0]) clone.signIdx(privateKey, index, [SigHash.DEFAULT])
    return clone
  },
})

describe('e2e arkade:BTC->onchain:BTC (send)', () => {
  beforeAll(async () => {
    await requireStack('arkade:BTC->onchain:BTC', ['arkd', 'emulator', 'lnd', 'esplora'])
    arkade = await openArkade()
    onchain = await openOnchainBackend()
    const dir = tempStoreDir()
    store = await OnchainSendSwapStore.open(`${dir}/onchain-swaps.sqlite`)

    // Where the solver's own reclaimed HTLC sats land, resolved once — exactly
    // as `cli.ts`'s createServices resolves it.
    const refundAddress = await onchain.newReceiveAddress()
    service = new OnchainSendSwapService({
      store,
      onchain,
      arkade: await arkadeOpsFromContext(arkade.ctx, arkade.emulator),
      limits: arkade.limits,
      network: arkade.network,
      maxExposedSats: arkade.maxExposedSats,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      signer: { sign: (tx, indexes) => arkade.ctx.identity.sign(tx, indexes) },
      refundDestinationScript: OutScript.encode(Address(ONCHAIN_NETWORKS[arkade.network]).decode(refundAddress)),
    })
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await store?.close()
    await onchain?.close?.()
    arkade?.close()
  })

  it(
    'quotes, funds the Arkade lockup, sees the solver fund the HTLC, claims it, and the solver reads P back out',
    async () => {
      await assertArkadeSpendable(arkade, AMOUNT_SATS)

      // The client's own key material. A real integration holds these in its
      // wallet; here they are generated fresh and discarded.
      const claimPriv = schnorr.utils.randomSecretKey()
      const claimPub = schnorr.getPublicKey(claimPriv)
      const clientRefundPub = schnorr.getPublicKey(schnorr.utils.randomSecretKey())
      const preimage = randomBytes(32)
      const paymentHash = hex.encode(sha256(preimage))
      const refundAddress = await arkade.ctx.wallet.getAddress()

      const outcome = await service.quote({
        paymentHash,
        amountSats: AMOUNT_SATS,
        payoutPubkey: hex.encode(claimPub),
        refundAddress,
        clientRefundPubkey: hex.encode(clientRefundPub),
      })
      if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
      const swap = outcome.swap

      // CLIENT RULE, both scripts: derive locally, refuse to fund a mismatch.
      const serverKey = arkade.ctx.wallet.arkServerPublicKey
      const localArkade = new CovenantSwapScript({
        receiver: hex.decode(swap.providerPubkey),
        server: serverKey,
        preimageHash: scriptHashFromPaymentHash(paymentHash),
        refundLocktime: swap.refundLocktime,
        claimDelay: arkade.ctx.unilateralDelays.unilateralClaimDelay,
        client: clientRefundPub,
        clientRefundDelay: arkade.ctx.unilateralDelays.unilateralRefundWithoutReceiverDelay,
        refundWithoutServerDelay: arkade.ctx.unilateralDelays.unilateralRefundDelay,
        nonInteractiveParameters: {
          emulatorPubkey: hex.decode(arkade.emulator.pubkey),
          receiverPkScript: hex.decode(swap.receiverPkScript),
          senderPkScript: ArkAddress.decode(refundAddress).pkScript,
          // Read off the row, not hardcoded — see sendLightning.e2e.test.ts's
          // clientDerivedAddress for why.
          ...(swap.nonInteractiveParameters ? {} : { legacy: 'preTimelockedRefund' as const }),
        },
      })
      expect(localArkade.address(arkade.ctx.hrp, serverKey).encode()).toBe(swap.lockupAddress)

      const localHtlc = buildOnchainHtlc({
        network: ONCHAIN_NETWORKS[arkade.network],
        paymentHash,
        claimPubkey: claimPub,
        refundPubkey: hex.decode(swap.htlcPubkey),
        refundLocktime: swap.htlcLocktime,
      })
      expect(localHtlc.address).toBe(swap.onchainAddress)

      await arkade.ctx.wallet.send({ address: swap.lockupAddress, amount: AMOUNT_SATS })

      // The solver notices the Arkade lockup and funds the onchain HTLC.
      const funded = await driveUntil(swap.id, new Set(['awaiting_claim', ...TERMINAL]))
      expect(funded.state).toBe('awaiting_claim')
      expect(funded.fundingTxid).toBeTruthy()
      expect(funded.fundingVout).not.toBeNull()

      // The client claims — the only thing that ever makes `P` public on this
      // corridor. Payout goes to a key-path taproot output under the same
      // ephemeral key, standing in for the client's real wallet.
      const feeRate = await onchain.estimateFeeRate()
      const destinationScript = p2tr(claimPub, undefined, ONCHAIN_NETWORKS[arkade.network]).script
      const sizing = {
        htlc: localHtlc,
        preimage,
        fundingTxid: funded.fundingTxid!,
        fundingVout: funded.fundingVout!,
        fundingValueSats: AMOUNT_SATS,
        destinationScript,
        payoutAmountSats: BigInt(AMOUNT_SATS),
      }
      const fee = BigInt(Math.ceil(estimateClaimTxVsize(sizing) * feeRate))
      const payoutAmountSats = BigInt(AMOUNT_SATS) - fee
      expect(payoutAmountSats).toBeGreaterThan(0n)

      const signed = await signOnchainClaimTx(
        buildOnchainClaimTx({ ...sizing, payoutAmountSats }),
        rawSigner(claimPriv),
        preimage,
      )
      const { txid: claimTxid } = await onchain.broadcastRaw(hex.encode(signed.extract()))
      expect(claimTxid).toBeTruthy()

      // The solver observes that claim, reads P out of its witness, and uses it
      // on the Arkade side.
      const claimed = await driveUntil(swap.id, TERMINAL)
      expect(claimed.state).toBe('claimed')
      // The preimage the solver learned is the one the client actually used —
      // proof it came from the witness, not from anywhere it was told.
      expect(claimed.preimage).toBe(hex.encode(preimage))
      expect(claimed.claimArkTxid).toBeTruthy()
    },
    SWAP_TIMEOUT_MS,
  )
})

const TERMINAL = new Set(['claimed', 'refused', 'stuck'])

/** Tick one onchain swap until it reaches any state in `until`. Same `tick` the watch loop calls. */
const driveUntil = (id: string, until: ReadonlySet<string>): Promise<OnchainSendSwapRow> =>
  poll(
    async () => {
      const row = await service.tick(id)
      return until.has(row.state) ? row : null
    },
    {
      attempts: 200,
      intervalMs: 3000,
      whenExhausted: `onchain swap ${id} never reached one of [${[...until].join(', ')}]`,
    },
  )
