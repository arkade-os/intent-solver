/**
 * E2E — `onchain:BTC->arkade:BTC` (receive), the paths where the swap does not
 * complete.
 *
 * `receiveOnchain.e2e.test.ts` walks the full loop: the client funds a real
 * Bitcoin HTLC, the solver funds a real Arkade lockup against it, the client
 * claims, and the solver spends the HTLC with the revealed `P`. This file
 * covers what happens when the client stops partway — the two moments the
 * solver's own capital is decided.
 *
 * THE TWO THAT MATTER, and they sit either side of the same decision:
 *
 *  - `does not adopt an underfunded HTLC`. `whenQuoted` matches a SINGLE
 *    output at the EXACT amount. Anything else must be ignored, because
 *    adopting it carries the swap into confirmation-watching and then into
 *    funding the FULL amount on Arkade against an HTLC holding a fraction of
 *    it. That is the solver paying out real money for a partial payment, and
 *    it is a live-stack question: the amount comes back from Esplora through
 *    `findOutputs`, and an adapter reporting a transaction's total instead of
 *    an output's value would silently defeat the check (it did, once).
 *  - `refunds its own Arkade lockup`. Once the solver has funded Arkade it is
 *    exposed, and a client who never claims leaves the covenant's
 *    `refundWithoutReceiver` leaf as the only way back. A real emulator and a
 *    real arkd both have to co-sign it, against a CLTV that matures on chain
 *    time rather than wall clock.
 *
 * CLOCKS AND MINING. Same two devices the onchain send edges use, for the same
 * reasons: the QUOTING clock runs {@link BACKDATE} back so the Arkade refund
 * deadline (`quote + MAX_REFUND_HORIZON`) is already three hours matured, the
 * funding steps are driven on that same clock because
 * `evaluateOnchainReceiveFunding` refuses to fund inside 90 minutes of it, and
 * blocks are MINED explicitly rather than waited for — this corridor blocks on
 * `min_confirmations`, and at one auto-mined block per 600s a test cannot
 * observe more than one inside its own budget.
 *
 * ROLES AND COST. As on the happy path, the client's onchain funding comes out
 * of the SOLVER's own boltz-lnd wallet. On the paths below nothing claims that
 * HTLC, so those sats stay locked until `htlc_locktime` — real, and regtest.
 * The Arkade side is returned by the refund under test.
 *
 * PREREQUISITES — as `receiveOnchain.e2e.test.ts`: arkd, emulator, boltz-lnd,
 * esplora, a funded AND SETTLED Arkade wallet, boltz-lnd holding confirmed
 * onchain funds, plus an arkade-regtest checkout to mine from.
 *
 * Run: `pnpm test:e2e`   (never runs in CI — `pnpm test` excludes `test/e2e`)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { Address, OutScript } from '@scure/btc-signer'
import { HOUR, MINUTE } from '@arkade-os/solver-core/core/timelocks.js'
import {
  OnchainReceiveSwapStore,
  type OnchainReceiveSwapRow,
} from '@arkade-os/solver-corridors/db/onchainReceiveSwaps.js'
import { buildOnchainHtlc, ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'
import type { OnchainSendBackend } from '@arkade-os/solver-core/ports/onchain.js'
import { onchainReceiveArkadeOpsFromContext } from '@arkade-os/solver-corridors/receive/onchainArkadeOps.js'
import { OnchainReceiveSwapService } from '@arkade-os/solver-corridors/receive/onchainOrchestrator.js'
import { nowSeconds, poll } from '@arkade-os/solver-core/util/poll.js'
import { newSealedPreimage } from './support/claimPacket.js'
import { mineBlocks } from './support/chain.js'
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

/** Smaller than the happy path's 50 000 — see the sibling send-edges file for why these tests economise. */
const AMOUNT_SATS = Number(process.env.E2E_ONCHAIN_EDGE_SATS ?? 20_000)

/**
 * How far back the quoting clock runs, seconds.
 *
 * `arkadeRefundLocktimeFor` caps the deadline at `quote + MAX_REFUND_HORIZON`
 * (2h), which is the binding term here, so backdating by that plus three hours
 * leaves it three hours matured — clear of the ~50-minute median-time-past lag
 * this stack's 600s block interval produces. Same figure, same reasoning as
 * `receiveLightning.e2e.test.ts`'s own five-hour backdate.
 */
const BACKDATE = 2 * HOUR + 3 * HOUR

let arkade: E2eArkade
let store: OnchainReceiveSwapStore
let onchain: OnchainSendBackend & { close?(): Promise<void> }
let claimDestinationScript: Uint8Array
let dir: string

const serviceWith = async (now?: () => number): Promise<OnchainReceiveSwapService> =>
  new OnchainReceiveSwapService({
    store,
    onchain,
    arkade: await onchainReceiveArkadeOpsFromContext(arkade.ctx, arkade.emulator),
    covclaimd: null,
    limits: arkade.limits,
    network: arkade.network,
    maxExposedSats: arkade.maxExposedSats,
    totalCommitted: () => store.committedSats(),
    admission: new AdmissionControl(),
    signer: { sign: (tx, indexes) => arkade.ctx.identity.sign(tx, indexes) },
    claimDestinationScript,
    ...(now ? { now } : {}),
  })

/** The client's half of a quote request. `P` is sealed to nobody: no covclaimd claims on any path here. */
const clientQuoteRequest = async (amountSats = AMOUNT_SATS) => {
  const sealed = newSealedPreimage(hex.encode(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)))
  const refundPriv = schnorr.utils.randomSecretKey()
  return {
    sealed,
    refundPubkey: schnorr.getPublicKey(refundPriv),
    request: {
      paymentHash: sealed.paymentHash,
      amountSats,
      claimPacket: sealed.packet,
      refundPubkey: hex.encode(schnorr.getPublicKey(refundPriv)),
      payoutAddress: await arkade.ctx.wallet.getAddress(),
      payoutPubkey: hex.encode(await arkade.ctx.identity.xOnlyPublicKey()),
    },
  }
}

describe('e2e onchain:BTC->arkade:BTC (receive) — refusals, underfunding and the solver refunding itself', () => {
  beforeAll(async () => {
    await requireStack('onchain:BTC->arkade:BTC edges', ['arkd', 'emulator', 'lnd', 'esplora'])
    arkade = await openArkade()
    onchain = await openOnchainBackend()
    dir = tempStoreDir()
    store = await OnchainReceiveSwapStore.open(`${dir}/onchain-receive-swaps.sqlite`)
    const claimAddress = await onchain.newReceiveAddress()
    claimDestinationScript = OutScript.encode(Address(ONCHAIN_NETWORKS[arkade.network]).decode(claimAddress))
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await store?.close()
    await onchain?.close?.()
    arkade?.close()
  })

  it('refuses a second live quote for the same payment hash', async () => {
    const { request } = await clientQuoteRequest()
    const service = await serviceWith()

    expect((await service.quote(request)).accepted).toBe(true)
    expect(await service.quote(request)).toEqual({ accepted: false, reason: 'duplicate_swap' })
  })

  it('refuses an amount below the network minimum', async () => {
    const { request } = await clientQuoteRequest(arkade.limits.minSats - 1)
    expect(await (await serviceWith()).quote(request)).toEqual({ accepted: false, reason: 'amount_out_of_range' })
  })

  it('refuses a payout address that is not an Arkade address on this network', async () => {
    const { request } = await clientQuoteRequest()
    const outcome = await (
      await serviceWith()
    ).quote({
      ...request,
      payoutAddress: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080',
    })
    expect(outcome).toEqual({ accepted: false, reason: 'invalid_payout_address' })
  })

  it('refuses a quote the client never funds, with nothing of the solver’s at risk', async () => {
    const { request } = await clientQuoteRequest()
    const outcome = await (await serviceWith()).quote(request)
    if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)

    const row = await (await serviceWith(() => nowSeconds() + 20 * MINUTE)).tick(outcome.swap.id)
    expect(row.state).toBe('refused')
    expect(row.failureReason).toBe('lockup timeout')
    // `EXPOSED` starts at `funding_arkade`; nothing of the solver's moved.
    expect(row.arkadeFundTxid).toBeNull()
  })

  it(
    'does not adopt an underfunded HTLC, and refuses it as soon as it confirms',
    async () => {
      const { request } = await clientQuoteRequest()
      const outcome = await (await serviceWith()).quote(request)
      if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
      const swap = outcome.swap

      // The client pays a QUARTER of what it asked to swap, to the right
      // address. A partial payment is not a funding: adopting it would carry
      // this swap all the way to the solver funding the FULL amount on Arkade.
      const short = Math.floor(AMOUNT_SATS / 4)
      const funding = await onchain.fund({
        address: swap.onchainAddress,
        amountSats: short,
        idempotencyKey: `e2e-short-${swap.id}`,
      })
      expect(funding.txid).toBeTruthy()

      // Mine, so the payment is unambiguously visible to Esplora rather than
      // merely unconfirmed — otherwise "not adopted" could just mean "not seen
      // yet", which would make this assertion prove nothing.
      await mineBlocks(1)
      const seen = await poll(
        async () => {
          const outputs = await onchain.findOutputs({ address: swap.onchainAddress })
          return outputs.find((o) => o.valueSats === short) ?? null
        },
        { attempts: 40, intervalMs: 3000, whenExhausted: `the underfunding at ${swap.onchainAddress} never showed up` },
      )
      expect(seen.valueSats).toBe(short)

      // Visible, confirmed, and refused ON THE SPOT — note the clock is NOT
      // advanced here. It used to be: the underfunding sat untouched until the
      // 20-minute lockup window lapsed and the swap died of `lockup timeout`,
      // which told the client nothing while their sats waited behind their own
      // CLTV. A confirmed mismatch cannot become the right amount (it cannot be
      // fee-bumped away, and a second output cannot rescue it because adoption
      // wants one output and the claim builder spends one input), so there is
      // nothing to wait for.
      const row = await (await serviceWith()).tick(swap.id)
      expect(row.state).toBe('refused')
      expect(row.failureReason).toMatch(/funding mismatch/)
      // Both amounts, so the client can see what went wrong without a log dive.
      expect(row.failureReason).toContain(String(short))
      expect(row.failureReason).toContain(String(AMOUNT_SATS))
      expect(row.fundingTxid).toBeNull()
      expect(row.arkadeFundTxid).toBeNull()
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'refunds its own Arkade lockup through refundWithoutReceiver when the client never claims',
    async () => {
      await assertArkadeSpendable(arkade, AMOUNT_SATS)
      const { request, refundPubkey } = await clientQuoteRequest()
      const quoteAt = nowSeconds() - BACKDATE

      // Quote AND drive the funding on the backdated clock:
      // `evaluateOnchainReceiveFunding` gates both `awaiting_confirmations`
      // and `awaiting_claim` on 90 minutes of headroom before the Arkade
      // refund deadline, and that deadline has deliberately been aged past.
      const backdated = await serviceWith(() => quoteAt)
      const outcome = await backdated.quote(request)
      if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
      const swap = outcome.swap
      expect(swap.refundLocktime).toBeLessThan(nowSeconds())

      // CLIENT RULE, kept even here: derive the HTLC locally, fund only a match.
      const localHtlc = buildOnchainHtlc({
        network: ONCHAIN_NETWORKS[arkade.network],
        paymentHash: request.paymentHash,
        claimPubkey: hex.decode(swap.htlcPubkey),
        refundPubkey,
        refundLocktime: swap.htlcLocktime,
      })
      expect(localHtlc.address).toBe(swap.onchainAddress)

      const funding = await onchain.fund({
        address: swap.onchainAddress,
        amountSats: AMOUNT_SATS,
        idempotencyKey: `e2e-${swap.id}`,
      })
      expect(funding.txid).toBeTruthy()

      // `min_confirmations` is what this state waits on, and the auto-miner
      // produces one block per 600s. Mining here is the difference between a
      // test that finishes and one that times out looking like a stalled swap.
      await mineBlocks(1)

      const tipBefore = await chainTip()
      const awaiting = await driveUntil(backdated, swap.id, new Set(['awaiting_claim', 'claimed', ...TERMINAL])).catch(
        async (error: Error) => {
          throw await explainConfirmationTimeout(tipBefore, error)
        },
      )
      expect(awaiting.state).toBe('awaiting_claim')
      expect(awaiting.fundingTxid).toBe(funding.txid)
      expect(awaiting.arkadeFundTxid).toBeTruthy()

      // The client goes dark. On the real clock the Arkade refund deadline is
      // three hours gone, so the solver stops waiting and takes its own
      // capital back — `refundWithoutReceiver`, the leaf that needs the client
      // key and the server but NOT the receiver, co-signed for real.
      const present = await serviceWith()
      const refunded = await driveUntil(present, swap.id, new Set(['refunded', ...TERMINAL]))
      expect(refunded.state).toBe('refunded')
      expect(refunded.arkadeRefundTxid).toBeTruthy()
      // And it did not settle: nothing revealed `P`, so the client's onchain
      // HTLC is untouched and remains theirs to reclaim past `htlc_locktime`.
      expect(refunded.preimage).toBeNull()
      expect(refunded.onchainClaimTxid).toBeNull()
    },
    SWAP_TIMEOUT_MS,
  )
})

const TERMINAL = ['refused', 'stuck']

const driveUntil = (
  service: OnchainReceiveSwapService,
  id: string,
  until: ReadonlySet<string>,
): Promise<OnchainReceiveSwapRow> =>
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
