/**
 * E2E — `onchain:BTC->arkade:BTC` (receive), against a live regtest stack with
 * a real LND onchain wallet (boltz-lnd).
 *
 * Like the Lightning receive corridor, this one has NO CLI command and NO RFQ
 * ingress routing, so the test constructs `OnchainReceiveSwapService` against
 * real adapters and drives `quote`/`tick` directly.
 *
 * It is the only corridor where BOTH legs are real chains, and it closes the
 * loop the other three each cover half of:
 *
 *   client funds a real Bitcoin L1 HTLC
 *     -> solver waits for real confirmations
 *     -> solver funds a real Arkade lockup out of its own balance
 *     -> client claims that lockup, making P public
 *     -> solver reads P back out of that claim (`findClaimPreimage`)
 *     -> solver spends the real onchain HTLC with it
 *
 * THE CLIENT CLAIMS, NOT COVCLAIMD — and on this corridor that is only
 * possible because the client now holds the covenant's `receiver` key
 * (`clientPayoutPubkey`). Both receive corridors carry the SAME Arkade
 * covenant; an earlier revision of this one gave the solver both roles,
 * leaving covclaimd as the client's only route to the funds. covclaimd
 * accepts a reveal against this covenant (HTTP 200) and then silently never
 * claims — `covclaimd:v0.0.1-rc.1`, observed on regtest 2026-08-07 — so that
 * revision had no working claim path at all. covclaimd stays supported and
 * optional; this test simply does not use one.
 *
 * The `expect(claimed.preimage).toBe(...)` assertion is the same
 * ConditionWitness round-trip proof `receiveLightning.e2e.test.ts` documents,
 * and here it is additionally load-bearing for real money: without a correct
 * `P` the solver cannot claim the client's onchain HTLC at all.
 *
 * ROLES. As client the test seals `P` to covclaimd, supplies an onchain refund
 * pubkey and an Arkade payout address, and funds the HTLC. Funding goes through
 * the SOLVER's own LND wallet standing in for the client's — the same
 * both-roles-one-process shortcut `cli send-onchain` takes, and it costs only
 * fees since the claim pays back into the same wallet.
 *
 * PREREQUISITES
 *   - arkade-regtest up WITH the boltz profile: arkd, emulator, boltz-lnd,
 *     bitcoin + MINER (confirmations must actually advance), esplora.
 *     No covclaimd needed.
 *   - `.env.regtest.lnd` (or E2E_ENV_FILE): ARK_MNEMONIC, ARK_SERVER_URL,
 *     EMULATOR_URL, LND_SOCKET, LND_CERT_PATH, LND_MACAROON_PATH
 *   - the Arkade wallet funded AND SETTLED (`scripts/regtest-fund.mjs`) — the
 *     SOLVER funds the Arkade lockup here — and boltz-lnd holding confirmed
 *     onchain funds for the client-role HTLC funding
 *
 * This is the slowest test in the set: it waits on `min_confirmations` real
 * blocks. If the stack's miner is not running it says so by name rather than
 * just timing out (`explainConfirmationTimeout`).
 *
 * KNOWN TO FAIL TODAY, for a reason in `src/onchain/lnd/adapter.ts` rather
 * than here: `outputsForAddress` reports the TRANSACTION's `tokens` (amount +
 * fee — confirmed as 50156 for a 50 000-sat payment) as an output's
 * `valueSats`, and `whenQuoted` matches on the exact amount, so the client's
 * funding is never adopted and the swap sits in `quoted`. Behind that sits a
 * second one: `getChainTransactions` only returns the LND wallet's OWN
 * transactions, so a real (third-party) client's funding would be invisible
 * regardless. See that file's `outputsForAddress` doc comment for both.
 *
 * The test is kept as written — it is correct, and it is what found these —
 * so it goes green the moment the adapter grows a per-output, any-address
 * chain view. Everything up to and including the quote already runs.
 *
 * Run: `pnpm test:e2e`   (never runs in CI — `pnpm test` excludes `test/e2e`)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { Address, OutScript } from '@scure/btc-signer'
import {
  OnchainReceiveSwapStore,
  type OnchainReceiveSwapRow,
} from '@arkade-os/solver-corridors/db/onchainReceiveSwaps.js'
import { buildOnchainHtlc, ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'
import type { OnchainSendBackend } from '@arkade-os/solver-core/ports/onchain.js'
import { onchainReceiveArkadeOpsFromContext } from '@arkade-os/solver-corridors/receive/onchainArkadeOps.js'
import { OnchainReceiveSwapService } from '@arkade-os/solver-corridors/receive/onchainOrchestrator.js'
import { poll } from '@arkade-os/solver-core/util/poll.js'
import { newSealedPreimage } from './support/claimPacket.js'
import { mineBlocks } from './support/chain.js'
import { clientClaimLockup } from './support/clientClaim.js'
import { chainTip, explainConfirmationTimeout, requireStack } from './support/preflight.js'
import {
  assertArkadeSpendable,
  openArkade,
  openOnchainBackend,
  SETUP_TIMEOUT_MS,
  SWAP_TIMEOUT_MS,
  tempStoreDir,
  type E2eArkade,
} from './support/stack.js'

const AMOUNT_SATS = Number(process.env.E2E_AMOUNT_SATS ?? 50_000)

let arkade: E2eArkade
let store: OnchainReceiveSwapStore
let onchain: OnchainSendBackend & { close?(): Promise<void> }
let service: OnchainReceiveSwapService

describe('e2e onchain:BTC->arkade:BTC (receive)', () => {
  beforeAll(async () => {
    await requireStack('onchain:BTC->arkade:BTC', ['arkd', 'emulator', 'lnd', 'esplora'])
    arkade = await openArkade()
    onchain = await openOnchainBackend()
    const dir = tempStoreDir()
    store = await OnchainReceiveSwapStore.open(`${dir}/onchain-receive-swaps.sqlite`)

    // Where the solver's own claimed onchain sats land — its own LND wallet,
    // the same wallet the client-role funding comes out of here.
    const claimAddress = await onchain.newReceiveAddress()
    service = new OnchainReceiveSwapService({
      store,
      onchain,
      arkade: await onchainReceiveArkadeOpsFromContext(arkade.ctx, arkade.emulator),
      // No covclaimd: the CLIENT claims the Arkade lockup. See this file's
      // header for why that is the path under test.
      covclaimd: null,
      limits: arkade.limits,
      network: arkade.network,
      maxExposedSats: arkade.maxExposedSats,
      totalCommitted: () => store.committedSats(),
      admission: new AdmissionControl(),
      signer: { sign: (tx, indexes) => arkade.ctx.identity.sign(tx, indexes) },
      claimDestinationScript: OutScript.encode(Address(ONCHAIN_NETWORKS[arkade.network]).decode(claimAddress)),
    })
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await store?.close()
    await onchain?.close?.()
    arkade?.close()
  })

  it(
    'watches the client HTLC, funds Arkade, the client claims, and the solver claims the HTLC with the revealed P',
    async () => {
      await assertArkadeSpendable(arkade, AMOUNT_SATS)

      // CLIENT: P sealed (to nobody in particular — no covclaimd claims here),
      // an onchain refund key, and its Arkade payout address AND key. The
      // refund key is never spent: it is the client's own recourse past
      // `htlc_locktime`, hours away.
      const sealed = newSealedPreimage(hex.encode(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)))
      const clientRefundPub = schnorr.getPublicKey(schnorr.utils.randomSecretKey())
      const payoutAddress = await arkade.ctx.wallet.getAddress()
      const payoutPubkey = hex.encode(await arkade.ctx.identity.xOnlyPublicKey())

      const outcome = await service.quote({
        paymentHash: sealed.paymentHash,
        amountSats: AMOUNT_SATS,
        claimPacket: sealed.packet,
        refundPubkey: hex.encode(clientRefundPub),
        payoutAddress,
        payoutPubkey,
      })
      if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
      const swap = outcome.swap

      // CLIENT RULE: derive the onchain HTLC locally and refuse to fund an
      // address the solver's own inputs do not reproduce.
      const localHtlc = buildOnchainHtlc({
        network: ONCHAIN_NETWORKS[arkade.network],
        paymentHash: sealed.paymentHash,
        claimPubkey: hex.decode(swap.htlcPubkey),
        refundPubkey: clientRefundPub,
        refundLocktime: swap.htlcLocktime,
      })
      expect(localHtlc.address).toBe(swap.onchainAddress)

      // CLIENT: fund it, and go offline.
      const funding = await onchain.fund({
        address: swap.onchainAddress,
        amountSats: AMOUNT_SATS,
        idempotencyKey: `e2e-${swap.id}`,
      })
      expect(funding.txid).toBeTruthy()

      // MINE. `whenAwaitingConfirmations` blocks until `min_confirmations`, and
      // the stack's auto-miner produces one block every 600 SECONDS with a
      // sleep BEFORE the first — so this test can observe at most one block
      // inside its own ten-minute budget, and it did not: it timed out at
      // exactly 600000ms waiting for a confirmation that was still minutes
      // away. That is the test waiting on wall-clock mining, not a stalled
      // swap and not a stopped miner. Mining is additive and non-destructive,
      // so asking for the block is safe on a shared stack.
      //
      // Worth stating plainly for anyone reading a results table: this
      // corridor's happy path passes because something mined by hand. Left to
      // the auto-miner it does not finish, and a scenario needing two
      // confirmations could not finish at all.
      await mineBlocks(1)

      // SOLVER: notice it, wait out `min_confirmations`, fund the Arkade side.
      // The tip is captured first so a timeout here can tell "the miner is
      // stopped" apart from "the solver did not notice", which look identical
      // from the row alone.
      const tipBefore = await chainTip()
      const awaiting = await driveUntil(swap.id, new Set(['awaiting_claim', 'claimed', 'settled', ...TERMINAL])).catch(
        async (error: Error) => {
          throw await explainConfirmationTimeout(tipBefore, error)
        },
      )
      expect(awaiting.state).toBe('awaiting_claim')
      expect(awaiting.fundingTxid).toBe(funding.txid)
      expect(awaiting.arkadeFundTxid).toBeTruthy()

      // CLIENT: claim the Arkade lockup through the collaborative claim leaf.
      // This is what makes the corridor work without covclaimd, and it is only
      // possible because the client holds the covenant's `receiver` key —
      // `clientPayoutPubkey`, mirroring the Lightning receive corridor.
      const claimTxid = await clientClaimLockup(
        arkade.ctx,
        {
          payoutPubkey: awaiting.clientPayoutPubkey,
          payoutAddress,
          payoutPkScript: awaiting.clientPayoutPkScript,
          solverPubkey: awaiting.providerPubkey,
          solverRefundPkScript: awaiting.refundPkScript,
          serverPubkey: awaiting.serverPubkey,
          emulatorPubkey: awaiting.emulatorPubkey,
          paymentHash: awaiting.paymentHash,
          refundLocktime: awaiting.refundLocktime,
          claimDelay: awaiting.claimDelay,
          refundDelay: awaiting.refundDelay,
          refundWithoutReceiverDelay: awaiting.refundWithoutReceiverDelay,
          pkScript: awaiting.pkScript,
          nonInteractiveParameters: awaiting.nonInteractiveParameters ?? false,
        },
        sealed.preimage,
      )
      expect(claimTxid).toBeTruthy()

      // SOLVER: observe that claim and recover P from its witness.
      const claimed = await driveUntil(swap.id, new Set(['claimed', 'settled', ...TERMINAL]))
      // The proof: P recovered from a real Arkade claim witness.
      expect(claimed.preimage).toBe(hex.encode(sealed.preimage))

      // SOLVER: spend the client's onchain HTLC with the now-public P.
      const settled = await driveUntil(swap.id, new Set(['settled', ...TERMINAL]))
      expect(settled.state).toBe('settled')
      expect(settled.onchainClaimTxid).toBeTruthy()
    },
    SWAP_TIMEOUT_MS,
  )
})

const TERMINAL = new Set(['refused', 'stuck'])

/**
 * Generous attempt budget: this corridor waits on real block confirmations
 * (`min_confirmations`, default 1) before anything else can happen, and the
 * stack's miner sets that pace.
 */
const driveUntil = (id: string, until: ReadonlySet<string>): Promise<OnchainReceiveSwapRow> =>
  poll(
    async () => {
      const row = await service.tick(id)
      return until.has(row.state) ? row : null
    },
    {
      attempts: 200,
      intervalMs: 3000,
      whenExhausted: `onchain receive swap ${id} never reached one of [${[...until].join(', ')}]`,
    },
  )
