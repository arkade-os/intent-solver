/**
 * E2E — `arkade:BTC->onchain:BTC` (send), the paths where the client does not
 * finish the swap.
 *
 * `sendOnchain.e2e.test.ts` proves the corridor when the client claims. Here
 * the client funds the wrong amount, funds nothing, tries a claim with a
 * preimage that is not `P`, or simply walks away after the solver has already
 * broadcast real Bitcoin — which is the scenario this corridor's most recently
 * changed money path exists for.
 *
 * THE ONE THAT MATTERS: `reclaims its own onchain HTLC`. On this corridor the
 * SOLVER funds a real Bitcoin L1 HTLC out of its own wallet before it has
 * collected anything, and if the client never claims, the only route back is
 * the HTLC's `<locktime> CHECKLOCKTIMEVERIFY DROP <refundPubkey> CHECKSIG`
 * leaf. Nothing but a real node can say whether that spend is valid: the
 * locktime matures against MEDIAN-TIME-PAST, the signature is over a real
 * taproot leaf, and the fee has to leave a non-dust output at a live fee
 * estimate. A unit test with a fake backend asserts only that we tried.
 *
 * TWO CLOCKS AND A MINER, and both halves are needed:
 *
 *  - The QUOTING clock runs {@link BACKDATE} into the past, so both deadlines a
 *    real quote puts hours ahead — `htlc_locktime` and `refund_locktime` — are
 *    already matured by the time the real clock looks at them. The FUNDING
 *    steps are then driven on that same backdated clock, because
 *    `evaluateOnchainSendFunding` refuses to fund inside 90 minutes of the
 *    refund deadline and would otherwise (correctly) refuse a swap whose
 *    deadline we have deliberately aged.
 *  - Blocks are MINED explicitly. Median-time-past is the median of the last
 *    eleven block timestamps, so on a 600s auto-miner it trails wall clock by
 *    ~50 minutes and only advances when a block lands. Waiting for one costs up
 *    to ten minutes of the test's budget for nothing; mining is additive,
 *    non-destructive and instant. Any scenario below that needs a block says so
 *    at the call site — see `support/chain.ts`.
 *
 * PREREQUISITES — as `sendOnchain.e2e.test.ts`: arkd, emulator, boltz-lnd,
 * esplora, a funded AND SETTLED Arkade wallet, and boltz-lnd holding confirmed
 * onchain funds. Plus an arkade-regtest checkout to mine from
 * (`ARKADE_REGTEST_DIR`, or cloned beside this repo).
 *
 * Run: `pnpm test:e2e`   (never runs in CI — `pnpm test` excludes `test/e2e`)
 */

import { randomBytes } from 'node:crypto'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { Address, OutScript, SigHash, p2tr } from '@scure/btc-signer'
import { HOUR } from '@arkade-os/solver-core/core/timelocks.js'
import { OnchainSendSwapStore, type OnchainSendSwapRow } from '@arkade-os/solver-corridors/db/onchainSwaps.js'
import { buildOnchainClaimTx, estimateClaimTxVsize, signOnchainClaimTx } from '@arkade-os/solver-rails/onchain/claim.js'
import { buildOnchainHtlc, ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'
import type { OnchainSendBackend } from '@arkade-os/solver-core/ports/onchain.js'
import type { OnchainSigner } from '@arkade-os/solver-rails/onchain/refund.js'
import { arkadeOpsFromContext } from '@arkade-os/solver-corridors/send/arkadeOps.js'
import { OnchainSendSwapService } from '@arkade-os/solver-corridors/send/onchainOrchestrator.js'
import { nowSeconds, poll } from '@arkade-os/solver-core/util/poll.js'
import { mineBlocks } from './support/chain.js'
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

/**
 * Smaller than the happy path's 50 000. These tests lock capital up for the
 * length of a refund rather than round-tripping it through a claim, and the
 * shared regtest wallet funds every corridor in the suite; 20 000 is still an
 * order of magnitude clear of `ONCHAIN_DUST_SATS` once a real fee comes out.
 */
const AMOUNT_SATS = Number(process.env.E2E_ONCHAIN_EDGE_SATS ?? 20_000)

/**
 * How far back the quoting clock runs, seconds.
 *
 * Sized off the LATER of the two deadlines a quote derives.
 * `onchainRefundLocktimeFor` puts `refund_locktime` at `quote + 25 800s`
 * (`htlc_locktime`'s own `quote + 11 400s`, plus `2 * ONCHAIN_ORDER_MARGIN`),
 * so backdating by that plus three hours leaves BOTH matured by at least three
 * hours — comfortably past the ~50-minute median-time-past lag this stack's
 * 600s block interval produces. The three hours is the same figure `cli
 * test-refund` defaults to, for the same reason.
 */
const BACKDATE = 25_800 + 3 * HOUR

let arkade: E2eArkade
let store: OnchainSendSwapStore
let onchain: OnchainSendBackend & { close?(): Promise<void> }
let refundDestinationScript: Uint8Array
let dir: string

/** A raw ephemeral key standing in for the client's own wallet — mirrors the happy-path file's signer. */
const rawSigner = (privateKey: Uint8Array): OnchainSigner => ({
  sign: async (tx, inputIndexes) => {
    const clone = tx.clone()
    for (const index of inputIndexes ?? [0]) clone.signIdx(privateKey, index, [SigHash.DEFAULT])
    return clone
  },
})

const serviceWith = async (now?: () => number): Promise<OnchainSendSwapService> =>
  new OnchainSendSwapService({
    store,
    onchain,
    arkade: await arkadeOpsFromContext(arkade.ctx, arkade.emulator),
    limits: arkade.limits,
    network: arkade.network,
    maxExposedSats: arkade.maxExposedSats,
    totalCommitted: () => store.committedSats(),
    admission: new AdmissionControl(),
    signer: { sign: (tx, indexes) => arkade.ctx.identity.sign(tx, indexes) },
    refundDestinationScript,
    ...(now ? { now } : {}),
  })

/** The client's half of a quote request: fresh keys, a fresh `P`, and this wallet's own Arkade refund address. */
const clientQuoteRequest = async (amountSats = AMOUNT_SATS) => {
  const claimPriv = schnorr.utils.randomSecretKey()
  const preimage = randomBytes(32)
  return {
    claimPriv,
    preimage,
    request: {
      paymentHash: hex.encode(sha256(preimage)),
      amountSats,
      payoutPubkey: hex.encode(schnorr.getPublicKey(claimPriv)),
      refundAddress: await arkade.ctx.wallet.getAddress(),
      clientRefundPubkey: hex.encode(schnorr.getPublicKey(schnorr.utils.randomSecretKey())),
    },
  }
}

describe('e2e arkade:BTC->onchain:BTC (send) — refusals, wrong preimages and the solver reclaiming its own HTLC', () => {
  beforeAll(async () => {
    await requireStack('arkade:BTC->onchain:BTC edges', ['arkd', 'emulator', 'lnd', 'esplora'])
    arkade = await openArkade()
    onchain = await openOnchainBackend()
    dir = tempStoreDir()
    store = await OnchainSendSwapStore.open(`${dir}/onchain-swaps.sqlite`)
    const refundAddress = await onchain.newReceiveAddress()
    refundDestinationScript = OutScript.encode(Address(ONCHAIN_NETWORKS[arkade.network]).decode(refundAddress))
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

  it('refuses a quote whose Arkade lockup never arrives, without broadcasting anything onchain', async () => {
    const { request } = await clientQuoteRequest()
    const outcome = await (await serviceWith()).quote(request)
    if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)

    // Past DEFAULT_ONCHAIN_LOCKUP_TIMEOUT with nothing at the script. Critically,
    // no L1 transaction was ever broadcast — the solver only funds the HTLC
    // once it has seen the client's Arkade lockup.
    const row = await (await serviceWith(() => nowSeconds() + 20 * 60)).tick(outcome.swap.id)
    expect(row.state).toBe('refused')
    expect(row.failureReason).toBe('lockup timeout')
    expect(row.fundingTxid).toBeNull()
  })

  it(
    'refuses an overfunded Arkade lockup and returns it through the covenant refund',
    async () => {
      await assertArkadeSpendable(arkade, AMOUNT_SATS * 2)
      const { request } = await clientQuoteRequest()
      const quoteAt = nowSeconds() - BACKDATE

      const outcome = await (await serviceWith(() => quoteAt)).quote(request)
      if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
      const swap = outcome.swap
      // Backdating is what makes the refund below pushable at all.
      expect(swap.refundLocktime).toBeLessThan(nowSeconds())

      const overfunded = AMOUNT_SATS + 1000
      await arkade.ctx.wallet.send({ address: swap.lockupAddress, amount: overfunded })

      const service = await serviceWith()
      const overfundedReason = `overfunded lockup: ${overfunded} > ${AMOUNT_SATS} sats`
      const refused = await driveUntilRefused(service, swap.id, overfundedReason)
      expect(refused.state).toBe('refused')
      expect(refused.failureReason).toBe(overfundedReason)
      // Nothing went out onchain: the solver refuses before it funds.
      expect(refused.fundingTxid).toBeNull()
      // Recorded on the LIGHTNING send leg, not this one: `whenQuoted` patches
      // `lockup_value` before failing there and does not here, so the refused
      // row carries no record of what actually arrived. Harmless — this leg's
      // `findRefundable` and `pushRefund` place no value condition, so the
      // sweep below still returns it — but asserted so the asymmetry is a
      // known, deliberate one rather than a surprise to the next reader.
      expect(refused.onchainLockupValue).toBeNull()

      const swept = await poll(
        async () => {
          const pushed = await service.refundSweep()
          return pushed.includes(swap.id) ? pushed : null
        },
        { attempts: 12, intervalMs: 15_000, whenExhausted: `covenant refund for ${swap.id} was never accepted` },
      )
      expect(swept).toContain(swap.id)
      expect((await store.get(swap.id)).refundArkTxid).toBeTruthy()
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'reclaims its own onchain HTLC once htlcLocktime matures with no client claim, and refuses a wrong-preimage claim on the way',
    async () => {
      await assertArkadeSpendable(arkade, AMOUNT_SATS)
      const { claimPriv, request } = await clientQuoteRequest()
      const quoteAt = nowSeconds() - BACKDATE

      // Quote and fund on the BACKDATED clock. `evaluateOnchainSendFunding`
      // refuses to fund inside 90 minutes of `refund_locktime`, and that
      // deadline has deliberately been aged into the past — so the funding
      // steps have to be driven by the clock that quoted them, exactly as a
      // real solver would have done at the time.
      const backdated = await serviceWith(() => quoteAt)
      const outcome = await backdated.quote(request)
      if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
      const swap = outcome.swap
      expect(swap.htlcLocktime).toBeLessThan(nowSeconds())

      await arkade.ctx.wallet.send({ address: swap.lockupAddress, amount: AMOUNT_SATS })

      // The solver sees the Arkade lockup and puts real Bitcoin into the HTLC.
      const funded = await driveUntil(backdated, swap.id, new Set(['awaiting_claim', ...TERMINAL]))
      expect(funded.state).toBe('awaiting_claim')
      expect(funded.fundingTxid).toBeTruthy()
      expect(funded.fundingVout).not.toBeNull()

      // A block, so the funding output is confirmed and — the reason that
      // matters — median-time-past advances. MTP is the median of the last
      // eleven block timestamps and only moves when a block lands; the refund
      // spend below is non-final until it passes `htlcLocktime`. Waiting for
      // the 600s auto-miner would spend the whole budget for one block.
      await mineBlocks(2)

      const htlc = buildOnchainHtlc({
        network: ONCHAIN_NETWORKS[arkade.network],
        paymentHash: swap.paymentHash,
        claimPubkey: schnorr.getPublicKey(claimPriv),
        refundPubkey: hex.decode(swap.htlcPubkey),
        refundLocktime: swap.htlcLocktime,
      })
      expect(htlc.address).toBe(swap.onchainAddress)

      // FIRST ASSERTION: the HTLC's hash branch is real. A claim carrying 32
      // random bytes instead of `P` is a valid-looking transaction that only a
      // node running the script can reject — the `HASH160 <h> EQUALVERIFY` in
      // `claimLeafScript` is enforced nowhere in this process.
      const feeRate = await onchain.estimateFeeRate()
      const destinationScript = p2tr(
        schnorr.getPublicKey(claimPriv),
        undefined,
        ONCHAIN_NETWORKS[arkade.network],
      ).script
      const sizing = {
        htlc,
        preimage: randomBytes(32),
        fundingTxid: funded.fundingTxid!,
        fundingVout: funded.fundingVout!,
        fundingValueSats: AMOUNT_SATS,
        destinationScript,
        payoutAmountSats: BigInt(AMOUNT_SATS),
      }
      const fee = BigInt(Math.ceil(estimateClaimTxVsize(sizing) * feeRate))
      const bogus = await signOnchainClaimTx(
        buildOnchainClaimTx({ ...sizing, payoutAmountSats: BigInt(AMOUNT_SATS) - fee }),
        rawSigner(claimPriv),
        sizing.preimage,
      )
      await expect(onchain.broadcastRaw(hex.encode(bogus.extract()))).rejects.toBeDefined()

      // SECOND ASSERTION, and the one this test is named for: nothing claimed
      // the HTLC, `htlcLocktime + HTLC_REFUND_MTP_MARGIN` is past on the real
      // clock, so the solver rebuilds the refund leaf FROM THE ROW, signs it,
      // and gets its own sats back.
      const present = await serviceWith()
      const refunded = await driveUntil(present, swap.id, new Set(['refunded', ...TERMINAL]))
      expect(refunded.state).toBe('refunded')
      expect(refunded.onchainRefundTxid).toBeTruthy()

      // The client's Arkade lockup is untouched by any of that and is theirs to
      // recover. `refundNow` is the operator override for exactly this — a
      // terminal row the automatic sweep will not revisit — and it is what
      // returns the sats this test locked up.
      const returned = await poll(() => present.refundNow(swap.id), {
        attempts: 12,
        intervalMs: 15_000,
        whenExhausted: `operator covenant refund for ${swap.id} was never accepted`,
      })
      expect(returned).toBeTruthy()
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'adopts a claim that lands after the refund deadline instead of broadcasting a refund that can only lose',
    async () => {
      await assertArkadeSpendable(arkade, AMOUNT_SATS)
      const { claimPriv, preimage, request } = await clientQuoteRequest()
      const quoteAt = nowSeconds() - BACKDATE

      const backdated = await serviceWith(() => quoteAt)
      const outcome = await backdated.quote(request)
      if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
      const swap = outcome.swap

      await arkade.ctx.wallet.send({ address: swap.lockupAddress, amount: AMOUNT_SATS })
      const funded = await driveUntil(backdated, swap.id, new Set(['awaiting_claim', ...TERMINAL]))
      expect(funded.state).toBe('awaiting_claim')
      await mineBlocks(1)

      // THE OTHER ORDER OF THE RACE. The refund deadline has passed and the
      // solver has already committed to refunding — but the HTLC's claim leaf
      // carries NO locktime (`src/onchain/htlc.ts`), so a client can still
      // claim, and here does. Parked in `refunding_onchain` through the
      // orchestrator's own legal edge because the transition and the broadcast
      // happen inside ONE tick, leaving no instant a test could interleave.
      expect(await store.transition(swap.id, 'awaiting_claim', 'refunding_onchain', {})).toBe(true)

      const htlc = buildOnchainHtlc({
        network: ONCHAIN_NETWORKS[arkade.network],
        paymentHash: swap.paymentHash,
        claimPubkey: schnorr.getPublicKey(claimPriv),
        refundPubkey: hex.decode(swap.htlcPubkey),
        refundLocktime: swap.htlcLocktime,
      })
      const feeRate = await onchain.estimateFeeRate()
      const sizing = {
        htlc,
        preimage,
        fundingTxid: funded.fundingTxid!,
        fundingVout: funded.fundingVout!,
        fundingValueSats: AMOUNT_SATS,
        destinationScript: p2tr(schnorr.getPublicKey(claimPriv), undefined, ONCHAIN_NETWORKS[arkade.network]).script,
        payoutAmountSats: BigInt(AMOUNT_SATS),
      }
      const fee = BigInt(Math.ceil(estimateClaimTxVsize(sizing) * feeRate))
      const signed = await signOnchainClaimTx(
        buildOnchainClaimTx({ ...sizing, payoutAmountSats: BigInt(AMOUNT_SATS) - fee }),
        rawSigner(claimPriv),
        preimage,
      )
      const { txid } = await onchain.broadcastRaw(hex.encode(signed.extract()))
      expect(txid).toBeTruthy()
      // Confirmed, so the witness is unambiguously readable rather than merely
      // in a mempool the indexer may not have caught up with.
      await mineBlocks(1)

      // Without the recheck this row would retry a doomed double-spend forever:
      // `LEGAL_EDGES` offers no way back to `claiming`, `P` is never recovered,
      // the Arkade lockup is never claimed, and the client can still refund it
      // once `refundLocktime` passes. Solver pays onchain AND loses the lockup.
      const claimed = await driveUntil(await serviceWith(), swap.id, new Set(['claimed', 'refused', 'stuck']))
      expect(claimed.state).toBe('claimed')
      expect(claimed.preimage).toBe(hex.encode(preimage))
      expect(claimed.claimArkTxid).toBeTruthy()
      expect(claimed.onchainRefundTxid).toBeNull()
    },
    SWAP_TIMEOUT_MS,
  )
})

const TERMINAL = new Set(['claimed', 'refused', 'stuck'])

const driveUntil = (
  service: OnchainSendSwapService,
  id: string,
  until: ReadonlySet<string>,
): Promise<OnchainSendSwapRow> =>
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

/**
 * Tick until the swap is refused FOR THE EXPECTED REASON.
 *
 * Keyed on the reason rather than on a value column because this leg does not
 * record one on the overfunded path (see the assertion at that call site). The
 * wait is the same one the Lightning leg's twin helper needs: an Arkade send
 * returns as soon as it is accepted, and a tick landing before the indexer
 * catches up sees an empty script and refuses for "lockup timeout" — a real
 * terminal state that would otherwise end the poll on the wrong refusal.
 */
const driveUntilRefused = (service: OnchainSendSwapService, id: string, reason: string): Promise<OnchainSendSwapRow> =>
  poll(
    async () => {
      const row = await service.tick(id)
      if (!TERMINAL.has(row.state)) return null
      return row.failureReason === reason ? row : null
    },
    {
      attempts: 60,
      intervalMs: 3000,
      whenExhausted: `onchain swap ${id} was never refused with "${reason}"`,
    },
  )
