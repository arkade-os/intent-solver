/**
 * `onchain:BTC->arkade:<asset>`: quote, watch, fund, claim.
 *
 * A SHELL OVER A PLANNER, unlike the sats receive leg it mirrors. Every
 * ordering rule that can lose funds lives in
 * `core/onchainAssetReceivePlan.ts` as a pure function over a row and an
 * observation, so each is a unit test with no fakes for a chain, a wallet or an
 * emulator. What is left here is the I/O and the writes — which is exactly the
 * part that must commit intent BEFORE the irreversible act.
 *
 * The flow, and the role reversal that defines it (rfq-protocol.md § 7.1.4):
 *
 *  1. client seals `P` into a `ClaimPacket` and asks for a quote
 *  2. solver prices sats into the asset, quotes its L1 claim key and its own
 *     Arkade refund deadline
 *  3. client derives the L1 HTLC locally and funds it with BTC
 *  4. solver waits for `min_confirmations`, then funds an ASSET-denominated
 *     Arkade lockup pinned to the client's payout script
 *  5. the lockup is claimed and `P` becomes public — by the CLIENT through the
 *     collaborative leaf, or by covclaimd through `nonInteractiveClaim`
 *  6. solver uses the now-public `P` to claim the L1 HTLC
 *
 * THE ASSET ID IS PASSED CANONICAL, never pre-reversed. `CovenantSwapScript`
 * forwards it to `VHTLC.ScriptV2`, which reverses it for
 * `INSPECTOUTASSETLOOKUP` itself; a caller that reverses first builds a lockup
 * that FUNDS and is then unspendable on its covenant leaves, and the emulator
 * reports only `OP_VERIFY failed`. @see arkade/covenant.ts `parseAssetId`
 */

import { hex, base64 } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { ArkAddress } from '@arkade-os/sdk'
import type { AdmissionStrategy } from '@arkade-os/solver-core/core/admissionStrategy.js'
import {
  DEFAULT_ONCHAIN_RECEIVE_LOCKUP_TIMEOUT,
  ONCHAIN_DUST_SATS,
  evaluateOnchainReceiveAcceptance,
  type OnchainReceiveAcceptanceRefusal,
} from '@arkade-os/solver-core/core/onchainReceive.js'
import {
  evaluateOnchainAssetInventory,
  onchainAssetReceivePairFor,
  resolveOnchainAssetPayout,
  type OnchainAssetMarket,
} from '@arkade-os/solver-core/core/onchainAssetReceive.js'
import {
  planOnchainAssetReceive,
  type OnchainAssetReceiveObservation,
} from '@arkade-os/solver-core/core/onchainAssetReceivePlan.js'
import { lockupIsFunded } from '@arkade-os/solver-core/core/lockupFunded.js'
import type { Price } from '@arkade-os/solver-core/core/priceFeed.js'
import type { Limits } from '@arkade-os/solver-core/core/limits.js'
import { scriptHashFromPaymentHash } from '@arkade-os/solver-core/core/preimage.js'
import { CovenantSwapScript, parseAssetId } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { covenantScriptFromRow } from '../send/arkadeOps.js'
import type { CovenantScriptRow } from '../send/orchestrator.js'
import { buildOnchainHtlc, ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'
import { buildOnchainClaimTx, estimateClaimTxVsize, signOnchainClaimTx } from '@arkade-os/solver-rails/onchain/claim.js'
import type { OnchainSigner } from '@arkade-os/solver-rails/onchain/refund.js'
import type { OnchainReceiveBackend } from '@arkade-os/solver-core/ports/onchain.js'
import type { SwapNetwork } from '@arkade-os/solver-core/core/networks.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import { EMPTY_LOCKUP_GRACE } from './orchestrator.js'
import type { CovclaimdClient } from './covclaimd.js'
import type { OnchainReceiveArkadeOps } from './onchainArkadeOps.js'
import type { OnchainAssetReceiveSwapRow, OnchainAssetReceiveSwapStore } from '../db/onchainAssetReceiveSwaps.js'

/**
 * The Arkade capabilities this leg needs beyond the sats leg's.
 *
 * `fundAsset` rather than a widened `fund`: the two carry different units, and
 * one signature taking both would let a sats amount reach an asset lockup by
 * omission. `assetBalance` is `available`, never `total` — a coin already
 * reserved for another lockup cannot fund this one.
 */
export interface OnchainAssetReceiveArkadeOps extends Omit<OnchainReceiveArkadeOps, 'fund'> {
  fundAsset(params: {
    address: string
    assetId: string
    units: bigint
    /** Sats the output carries alongside the asset — an Arkade output is a Bitcoin output. */
    carrierSats: number
  }): Promise<string>
  assetBalance(): Promise<ReadonlyMap<string, bigint>>
  /** The network's dust threshold, which is what an asset-bearing output must carry. */
  dustSats(): Promise<number>
}

export interface OnchainAssetReceiveServiceDeps {
  store: OnchainAssetReceiveSwapStore
  onchain: OnchainReceiveBackend
  arkade: OnchainAssetReceiveArkadeOps
  /** The markets this deployment pays out on. An empty list serves none. */
  markets: readonly OnchainAssetMarket[]
  fetchPrice: (feedUrl: string, pricePath: string) => Promise<Price>
  /** @see receive/onchainOrchestrator.ts — optional, and its absence costs only the client's need to be online. */
  covclaimd?: Pick<CovclaimdClient, 'reveal'> | null
  /** The BTC side, in sats. The asset side is bounded per market. */
  limits: Limits
  network: SwapNetwork
  maxExposedSats: number
  totalCommitted: () => Promise<number>
  admission: AdmissionStrategy
  signer: OnchainSigner
  claimDestinationScript: Uint8Array
  peerStores?: readonly { findLiveByPaymentHash(paymentHash: string): Promise<unknown> }[]
  now?: () => number
}

export type OnchainAssetQuoteRefusal =
  | OnchainReceiveAcceptanceRefusal
  | 'unsupported_pair'
  | 'exact_out_unsupported'
  | 'price_unavailable'
  | 'fee_consumes_swap'
  | 'insufficient_inventory'
  | 'duplicate_swap'
  | 'provider_at_capacity'
  | 'invalid_payout_address'

export type OnchainAssetQuoteOutcome =
  | { accepted: true; swap: OnchainAssetReceiveSwapRow; lockupDeadline: number }
  | { accepted: false; reason: OnchainAssetQuoteRefusal; detail?: string }

export interface OnchainAssetReceiveQuoteRequest {
  paymentHash: string
  amountSats: number
  claimPacket: string
  refundPubkey: string
  payoutAddress: string
  payoutPubkey: string
  /** Which market — the corridor pair this request reached. */
  pair: string
  minConfirmations?: number
  rfqId?: string
}

const paymentHashOf = (preimage: Uint8Array): string => hex.encode(sha256(preimage))

/**
 * The row as `covenantScriptFromRow` needs it.
 *
 * Identical in shape to the sats leg's, because the covenant IS the sats leg's
 * plus one parameter: the client plays `receiver` and can therefore spend the
 * collaborative claim leaf itself, and the solver plays `client`/sender because
 * it funded the lockup and needs the refund recourse.
 */
export const assetReceiveCovenantRowFor = (row: OnchainAssetReceiveSwapRow): CovenantScriptRow => ({
  id: row.id,
  receiverPubkey: row.clientPayoutPubkey,
  serverPubkey: row.serverPubkey,
  paymentHash: row.paymentHash,
  refundLocktime: row.refundLocktime,
  claimDelay: row.claimDelay,
  emulatorPubkey: row.emulatorPubkey,
  refundPkScript: row.refundPkScript,
  pkScript: row.pkScript,
  clientRefundPubkey: row.providerPubkey,
  refundWithoutReceiverDelay: row.refundWithoutReceiverDelay,
  refundDelay: row.refundDelay,
  receiverPkScript: row.clientPayoutPkScript,
  nonInteractiveParameters: row.nonInteractiveParameters,
  asset: row.payoutAssetId,
})

export class OnchainAssetReceiveSwapService {
  private readonly now: () => number
  private readonly inFlight = new Set<string>()

  constructor(private readonly deps: OnchainAssetReceiveServiceDeps) {
    this.now = deps.now ?? nowSeconds
  }

  onTickError?: (id: string, error: unknown) => void
  onTickSuccess?: (id: string) => void
  shouldSkipTick?: (id: string) => boolean

  async quote(request: OnchainAssetReceiveQuoteRequest): Promise<OnchainAssetQuoteOutcome> {
    const { store, arkade, limits, network, markets } = this.deps

    const market = markets.find((m) => onchainAssetReceivePairFor(m.assetId) === request.pair)
    if (!market) return { accepted: false, reason: 'unsupported_pair' }

    let clientPayoutPkScript: Uint8Array
    let clientPayoutPubkey: Uint8Array
    try {
      const address = ArkAddress.decode(request.payoutAddress)
      clientPayoutPkScript = address.pkScript
      if (!request.payoutAddress.toLowerCase().startsWith(`${arkade.hrp}1`)) {
        return { accepted: false, reason: 'invalid_payout_address' }
      }
      clientPayoutPubkey = hex.decode(request.payoutPubkey)
      if (clientPayoutPubkey.length !== 32) return { accepted: false, reason: 'invalid_payout_address' }
    } catch {
      return { accepted: false, reason: 'invalid_payout_address' }
    }

    // EXACT-IN ONLY, so the give is the request. The sats bound and the exposure
    // cap both deal in the give; the asset bound is checked on the payout, in
    // the asset's own units, inside `resolveOnchainAssetPayout`.
    const giveSats = request.amountSats
    const acceptance = evaluateOnchainReceiveAcceptance({
      amountSats: giveSats,
      limits,
      now: this.now(),
      minConfirmations: request.minConfirmations,
    })
    if (!acceptance.accept) return { accepted: false, reason: acceptance.reason }

    // Before the feed read, so a retry storm on one hash cannot drive traffic to
    // the price source.
    if (await store.findLiveByPaymentHash(request.paymentHash)) {
      return { accepted: false, reason: 'duplicate_swap' }
    }
    for (const peer of this.deps.peerStores ?? []) {
      if (await peer.findLiveByPaymentHash(request.paymentHash)) {
        return { accepted: false, reason: 'duplicate_swap' }
      }
    }

    let feed: Price
    try {
      feed = await this.deps.fetchPrice(market.feedUrl, market.pricePath)
    } catch {
      // An unreadable feed must never become a free fill.
      return { accepted: false, reason: 'price_unavailable', detail: 'the market feed could not be read' }
    }
    const payout = resolveOnchainAssetPayout({ giveSats, market, feed })
    if (!payout.ok) return { accepted: false, reason: payout.reason }

    // Quote-time pre-check only; `funding_arkade` runs the same gate again
    // immediately before the asset moves. Quoting a payout the float already
    // cannot cover would commit this solver to a price it knows it cannot honour.
    const inventory = evaluateOnchainAssetInventory({
      payoutUnits: payout.payoutUnits,
      assetId: market.assetId,
      available: await arkade.assetBalance(),
    })
    if (!inventory.fund) return { accepted: false, reason: 'insufficient_inventory' }

    const reservation = await this.deps.admission.admit({
      pair: request.pair,
      giveSats,
      capSats: this.deps.maxExposedSats,
      committedSats: this.deps.totalCommitted,
    })
    if (reservation === null) return { accepted: false, reason: 'provider_at_capacity' }
    try {
      const serverKey = hex.decode(arkade.serverPubkey)
      const providerKey = hex.decode(arkade.providerPubkey)
      const arkadeScript = new CovenantSwapScript({
        receiver: clientPayoutPubkey,
        server: serverKey,
        preimageHash: scriptHashFromPaymentHash(request.paymentHash),
        refundLocktime: acceptance.arkadeRefundLocktime,
        claimDelay: arkade.delays.unilateralClaimDelay,
        client: providerKey,
        clientRefundDelay: arkade.delays.unilateralRefundWithoutReceiverDelay,
        refundWithoutServerDelay: arkade.delays.unilateralRefundDelay,
        // CANONICAL, unreversed — see the module header. `parseAssetId` returns
        // the id exactly as the registry publishes it and the SDK does the flip.
        asset: parseAssetId(market.assetId),
        nonInteractiveParameters: {
          emulatorPubkey: hex.decode(arkade.emulatorPubkey),
          receiverPkScript: clientPayoutPkScript,
          senderPkScript: hex.decode(arkade.receiverPkScript),
        },
      })

      const onchainHtlc = buildOnchainHtlc({
        network: ONCHAIN_NETWORKS[network],
        paymentHash: request.paymentHash,
        claimPubkey: hex.decode(arkade.providerPubkey),
        refundPubkey: hex.decode(request.refundPubkey),
        refundLocktime: acceptance.htlcLocktime,
      })

      const carrierSats = Math.max(await arkade.dustSats(), ONCHAIN_DUST_SATS)
      try {
        const swap = await store.insertQuote({
          id: crypto.randomUUID(),
          pair: request.pair,
          paymentHash: request.paymentHash,
          amountSats: giveSats,
          payoutUnits: payout.payoutUnits,
          payoutAssetId: market.assetId,
          payoutDecimals: market.decimals,
          lockupSats: carrierSats,
          htlcLocktime: acceptance.htlcLocktime,
          refundLocktime: acceptance.arkadeRefundLocktime,
          minConfirmations: acceptance.minConfirmations,
          providerPubkey: arkade.providerPubkey,
          clientPayoutPubkey: request.payoutPubkey,
          serverPubkey: arkade.serverPubkey,
          claimDelay: arkade.delays.unilateralClaimDelay,
          refundDelay: arkade.delays.unilateralRefundDelay,
          refundWithoutReceiverDelay: arkade.delays.unilateralRefundWithoutReceiverDelay,
          emulatorPubkey: arkade.emulatorPubkey,
          pkScript: hex.encode(arkadeScript.pkScript),
          lockupAddress: arkadeScript.address(arkade.hrp, serverKey).encode(),
          refundPkScript: arkade.receiverPkScript,
          clientPayoutPkScript: hex.encode(clientPayoutPkScript),
          nonInteractiveParameters: true,
          htlcPubkey: arkade.providerPubkey,
          clientOnchainRefundPubkey: request.refundPubkey,
          onchainAddress: onchainHtlc.address,
          onchainPkScript: hex.encode(onchainHtlc.pkScript),
          claimPacket: request.claimPacket,
          rfqId: request.rfqId,
        })
        return { accepted: true, swap, lockupDeadline: this.now() + DEFAULT_ONCHAIN_RECEIVE_LOCKUP_TIMEOUT }
      } catch (error) {
        if (error instanceof Error && /UNIQUE/i.test(error.message)) {
          return { accepted: false, reason: 'duplicate_swap' }
        }
        throw error
      }
    } finally {
      reservation.release()
    }
  }

  async tick(id: string): Promise<OnchainAssetReceiveSwapRow> {
    const { store } = this.deps
    if (this.inFlight.has(id)) return store.get(id)
    this.inFlight.add(id)
    try {
      while (await this.step(await store.get(id))) {
        // each successful step re-reads the row and tries the next
      }
      return await store.get(id)
    } finally {
      this.inFlight.delete(id)
    }
  }

  async tickAll(): Promise<OnchainAssetReceiveSwapRow[]> {
    const rows: OnchainAssetReceiveSwapRow[] = []
    for (const row of await this.deps.store.findRecoverable()) {
      if (this.shouldSkipTick?.(row.id) || this.inFlight.has(row.id)) {
        rows.push(row)
        continue
      }
      try {
        rows.push(await this.tick(row.id))
        this.onTickSuccess?.(row.id)
      } catch (error) {
        this.onTickError?.(row.id, error)
        try {
          rows.push(await this.deps.store.get(row.id))
        } catch {
          // Store fault, not a swap fault — the next sweep retries.
        }
      }
    }
    return rows
  }

  /**
   * What the world says, gathered per state rather than all at once.
   *
   * Every default here is the SAFE one: `lockupFunded` false cannot wrongly
   * adopt, `priorSpend` null cannot wrongly settle, and `inventorySufficient`
   * false cannot wrongly fund — which is why the funding state is the one that
   * must actually read the balance rather than inherit the default.
   */
  private async observe(row: OnchainAssetReceiveSwapRow): Promise<OnchainAssetReceiveObservation> {
    const { onchain, arkade } = this.deps
    const base: OnchainAssetReceiveObservation = {
      htlcOutputs: [],
      lockupFunded: false,
      lockupEmpty: false,
      preimage: null,
      onchainClaimOutcome: 'unknown',
      priorSpend: null,
      inventorySufficient: false,
      nowSeconds: this.now(),
    }

    if (row.state === 'quoted' || row.state === 'awaiting_confirmations') {
      const outputs = await onchain.findOutputs({ address: row.onchainAddress })
      return {
        ...base,
        htlcOutputs: outputs.map((o) => ({
          txid: o.txid,
          vout: o.vout,
          valueSats: o.valueSats,
          confirmations: o.confirmations,
        })),
      }
    }

    if (row.state === 'funding_arkade') {
      const outputs = await arkade.findLockups(row.pkScript)
      // The ASSET expectation, never a sats one: a lockup carrying the right
      // carrier sats and the wrong asset amount reads as funded to a sats check
      // and would carry the swap forward for a figure nobody quoted.
      const funded = lockupIsFunded(outputs, {
        kind: 'asset',
        assetId: row.payoutAssetId,
        amount: row.payoutUnits,
      })
      if (funded) return { ...base, lockupFunded: true }
      const available = await arkade.assetBalance()
      return {
        ...base,
        inventorySufficient: evaluateOnchainAssetInventory({
          payoutUnits: row.payoutUnits,
          assetId: row.payoutAssetId,
          available,
        }).fund,
      }
    }

    // Past funding: what matters is whether `P` is out, and what became of our
    // own L1 claim.
    const outpoints = await arkade.findLockupOutpoints(row.pkScript)
    const found = outpoints.length > 0 ? await arkade.findClaimPreimage(outpoints, row.paymentHash) : null
    const preimage = found ? hex.encode(found) : null
    const observed: OnchainAssetReceiveObservation = { ...base, preimage }

    if (row.state === 'awaiting_claim' || row.state === 'refunding_arkade') {
      const outputs = await arkade.findLockups(row.pkScript)
      observed.lockupEmpty = outputs.length === 0
    }
    if (row.state !== 'claimed' && preimage === null) return observed

    if (row.onchainClaimTxid) {
      observed.onchainClaimOutcome = (await onchain.transactionOutcome(row.onchainClaimTxid)) as
        'confirmed' | 'mempool' | 'unknown'
    }
    if (row.fundingTxid && row.fundingVout !== null && observed.onchainClaimOutcome === 'unknown') {
      const witness = await onchain.findSpendWitness({
        txid: row.fundingTxid,
        vout: row.fundingVout,
        outputScript: hex.decode(row.onchainPkScript),
      })
      if (witness) {
        // WHOSE spend? The claim path needs `P` and the refund path cannot
        // produce one, so a witness carrying this row's preimage is OUR claim —
        // which is what a process that died between broadcasting and recording
        // comes back to find.
        const target = preimage ?? row.preimage
        const bytes = target ? hex.decode(target) : null
        const ours =
          bytes !== null && witness.some((el) => el.length === bytes.length && el.every((b, i) => b === bytes[i]))
        observed.priorSpend = ours ? 'ours' : 'theirs'
      }
    }
    return observed
  }

  private async step(row: OnchainAssetReceiveSwapRow): Promise<boolean> {
    const { store } = this.deps
    const action = planOnchainAssetReceive(
      {
        state: row.state,
        amountSats: row.amountSats,
        payoutUnits: row.payoutUnits,
        minConfirmations: row.minConfirmations,
        htlcLocktime: row.htlcLocktime,
        refundLocktime: row.refundLocktime,
        refundWithoutReceiverDelay: row.refundWithoutReceiverDelay,
        fundingDeadline: row.createdAt + DEFAULT_ONCHAIN_RECEIVE_LOCKUP_TIMEOUT,
        preimage: row.preimage,
        onchainClaimTxid: row.onchainClaimTxid,
      },
      await this.observe(row),
    )

    switch (action.do) {
      case 'wait':
        // The one wait that is not idle: covclaimd is (re)asked on every tick it
        // has not produced a claim. Idempotent against an already-spent lockup,
        // so a repeat ask costs nothing and recovers a transient outage.
        if (row.state === 'awaiting_claim') await this.askCovclaimd(row)
        return false

      case 'await_confirmations':
        return store.transition(row.id, 'quoted', 'awaiting_confirmations', {
          funding_txid: action.txid,
          funding_vout: action.vout,
        })

      case 'begin_funding':
        return store.transition(row.id, 'awaiting_confirmations', 'funding_arkade', {})

      case 'adopt_lockup':
        return store.transition(row.id, 'funding_arkade', 'awaiting_claim', {})

      case 'fund_arkade':
        return this.fundArkade(row)

      case 'claim_onchain':
        return this.claimOnchain(row, action.preimage)

      case 'record_settled':
        // Always from `claimed`, and the row already carries `P` — the planner
        // records it before any settle decision, so the receipt the status
        // payload publishes is on disk before this edge is taken.
        return store.transition(row.id, 'claimed', 'settled', {})

      case 'refund_arkade':
        return this.refundArkade(row)

      case 'refuse':
        await store.fail(row.id, row.state, action.reason)
        return false

      case 'stick':
        await store.fail(row.id, row.state, action.reason)
        return false
    }
  }

  private async askCovclaimd(row: OnchainAssetReceiveSwapRow): Promise<void> {
    const { covclaimd } = this.deps
    if (!covclaimd) return
    const script = covenantScriptFromRow(assetReceiveCovenantRowFor(row))
    if (!script.nonInteractiveClaimArkadeScript) return
    await covclaimd.reveal({
      swapAddress: row.lockupAddress,
      ciphertext: row.claimPacket,
      arkadeScript: base64.encode(script.nonInteractiveClaimArkadeScript),
      taptree: hex.encode(script.encode()),
    })
  }

  /**
   * Pay the asset into the lockup.
   *
   * The lease is taken BEFORE the payment and handed back only on a throw. The
   * planner's rule-4 adoption closes the CRASH case by reading the script; this
   * closes the CONCURRENT one, which it cannot — two workers in the same window
   * both read an unfunded script and both pay, out of the solver's own float.
   */
  private async fundArkade(row: OnchainAssetReceiveSwapRow): Promise<boolean> {
    const { store, arkade } = this.deps
    if (!(await store.claimFundLease(row.id, 'funding_arkade'))) return false
    let txid: string
    try {
      txid = await arkade.fundAsset({
        address: row.lockupAddress,
        assetId: row.payoutAssetId,
        units: row.payoutUnits,
        carrierSats: row.lockupSats,
      })
    } catch (error) {
      await store.releaseFundLease(row.id)
      throw error
    }
    return store.transition(row.id, 'funding_arkade', 'awaiting_claim', { arkade_fund_txid: txid })
  }

  /**
   * Take the L1 HTLC with `P`.
   *
   * THE TXID IS RECORDED BEFORE THE BROADCAST (#14). `broadcastRaw` is
   * irreversible and the write that records it is a separate statement, so a
   * process dying in between must come back with a key it can ask about —
   * otherwise the next tick reads an unspent-looking outpoint and rebuilds a
   * second claim at a second fee.
   */
  private async claimOnchain(row: OnchainAssetReceiveSwapRow, preimageHex: string): Promise<boolean> {
    const { store, onchain, signer, network, claimDestinationScript } = this.deps
    if (!row.fundingTxid || row.fundingVout === null) {
      await store.fail(row.id, row.state, 'claim requested with no funding txid/vout')
      return false
    }
    if (row.state !== 'claimed') {
      // `P` reaches the row before anything is spent against it, and the loop
      // re-reads: the broadcast below happens on the next pass, from `claimed`.
      return store.transition(row.id, row.state as 'awaiting_claim', 'claimed', { preimage: preimageHex })
    }

    const htlc = buildOnchainHtlc({
      network: ONCHAIN_NETWORKS[network],
      paymentHash: row.paymentHash,
      claimPubkey: hex.decode(row.htlcPubkey),
      refundPubkey: hex.decode(row.clientOnchainRefundPubkey),
      refundLocktime: row.htlcLocktime,
    })
    if (hex.encode(htlc.pkScript) !== row.onchainPkScript) {
      await store.fail(row.id, 'claimed', 'onchain HTLC rebuilt from row does not match the funded pkScript')
      return false
    }

    const feeRate = await onchain.estimateFeeRate()
    const preimage = hex.decode(preimageHex)
    const sizing = {
      htlc,
      preimage,
      fundingTxid: row.fundingTxid,
      fundingVout: row.fundingVout,
      fundingValueSats: row.amountSats,
      destinationScript: claimDestinationScript,
      payoutAmountSats: BigInt(row.amountSats),
    }
    const fee = BigInt(Math.ceil(estimateClaimTxVsize(sizing) * feeRate))
    const payoutAmountSats = BigInt(row.amountSats) - fee
    if (payoutAmountSats < BigInt(ONCHAIN_DUST_SATS)) {
      await store.fail(
        row.id,
        'claimed',
        `claim fee ${fee} at ${feeRate} sat/vB leaves ${payoutAmountSats} sats from a ${row.amountSats} sat HTLC — ` +
          `below the ${ONCHAIN_DUST_SATS} sat dust limit`,
      )
      return false
    }
    const signed = await signOnchainClaimTx(buildOnchainClaimTx({ ...sizing, payoutAmountSats }), signer, preimage)
    await store.patch(row.id, { onchain_claim_txid: signed.id })
    await onchain.broadcastRaw(hex.encode(signed.extract()))
    return false
  }

  private async refundArkade(row: OnchainAssetReceiveSwapRow): Promise<boolean> {
    const { store, arkade } = this.deps
    if (row.state === 'awaiting_claim') {
      return store.transition(row.id, 'awaiting_claim', 'refunding_arkade', {})
    }
    const outputs = await arkade.findLockups(row.pkScript)
    if (outputs.length === 0) {
      // Ambiguous: our own earlier refund, or a claim not yet readable —
      // `findLockups` empties the instant a claim lands while the spending
      // transaction is still being fetched. Bounded grace, then a human.
      if (this.now() - row.updatedAt < EMPTY_LOCKUP_GRACE) return false
      await store.fail(row.id, 'refunding_arkade', 'lockup empty with no matching claim; needs review')
      return false
    }
    const txid = await arkade.refund(assetReceiveCovenantRowFor(row), outputs)
    return store.transition(row.id, 'refunding_arkade', 'refunded', { arkade_refund_txid: txid })
  }

  /**
   * Operator override: retry the L1 claim at TODAY's fee rate.
   *
   * The row is `stuck` with a dust refusal — not a lost claim, but one that was
   * uneconomic at a moment when the payout after fees fell under the dust limit.
   * Safe to repeat: every attempt spends the SAME output, so a redundant
   * broadcast is a double-spend the network rejects rather than a second payout.
   */
  async claimNow(id: string): Promise<{ txid: string } | { refused: string }> {
    const { store, onchain, signer, network, claimDestinationScript } = this.deps
    const row = await store.get(id)
    if (!row.preimage) return { refused: 'no preimage on the row: nothing to claim with' }
    if (!row.fundingTxid || row.fundingVout === null) {
      return { refused: 'no funding txid/vout on the row: nothing to claim from' }
    }
    // OUR OWN EARLIER ATTEMPT, BY NAME, and before the spend read below — which
    // cannot tell whose spend it found. `unknown` never went out: rebuild.
    if (row.onchainClaimTxid) {
      const outcome = await onchain.transactionOutcome(row.onchainClaimTxid)
      if (outcome !== 'unknown') return { txid: row.onchainClaimTxid }
    }
    const priorSpend = await onchain.findSpendWitness({
      txid: row.fundingTxid,
      vout: row.fundingVout,
      outputScript: hex.decode(row.onchainPkScript),
    })
    if (priorSpend) {
      return {
        refused: "onchain HTLC output is already spent — most likely the client's own refund past htlc_locktime",
      }
    }
    const htlc = buildOnchainHtlc({
      network: ONCHAIN_NETWORKS[network],
      paymentHash: row.paymentHash,
      claimPubkey: hex.decode(row.htlcPubkey),
      refundPubkey: hex.decode(row.clientOnchainRefundPubkey),
      refundLocktime: row.htlcLocktime,
    })
    if (hex.encode(htlc.pkScript) !== row.onchainPkScript) {
      return { refused: 'onchain HTLC rebuilt from row does not match the funded pkScript' }
    }
    const feeRate = await onchain.estimateFeeRate()
    const preimage = hex.decode(row.preimage)
    const sizing = {
      htlc,
      preimage,
      fundingTxid: row.fundingTxid,
      fundingVout: row.fundingVout,
      fundingValueSats: row.amountSats,
      destinationScript: claimDestinationScript,
      payoutAmountSats: BigInt(row.amountSats),
    }
    const fee = BigInt(Math.ceil(estimateClaimTxVsize(sizing) * feeRate))
    const payoutAmountSats = BigInt(row.amountSats) - fee
    if (payoutAmountSats < BigInt(ONCHAIN_DUST_SATS)) {
      return {
        refused:
          `still uneconomic: fee ${fee} at ${feeRate} sat/vB leaves ${payoutAmountSats} sats ` +
          `from a ${row.amountSats} sat HTLC, under the ${ONCHAIN_DUST_SATS} sat dust limit`,
      }
    }
    const signed = await signOnchainClaimTx(buildOnchainClaimTx({ ...sizing, payoutAmountSats }), signer, preimage)
    // Recorded BEFORE the broadcast, so a resumed process has a key to ask about.
    await store.patch(row.id, { onchain_claim_txid: signed.id })
    await onchain.broadcastRaw(hex.encode(signed.extract()))
    return { txid: signed.id }
  }

  /** Operator override: push this row's Arkade refund now, whatever state it is in. */
  async refundNow(id: string): Promise<string | null> {
    const { store, arkade } = this.deps
    const row = await store.get(id)
    const outputs = await arkade.findLockups(row.pkScript)
    if (outputs.length === 0) return null
    const txid = await arkade.refund(assetReceiveCovenantRowFor(row), outputs)
    await store.patch(row.id, { arkade_refund_txid: txid })
    return txid
  }
}

export { paymentHashOf }
