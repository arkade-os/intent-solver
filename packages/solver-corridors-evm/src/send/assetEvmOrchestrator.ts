/**
 * The I/O shell for `arkade:<asset>->ethereum:<token>`.
 *
 * Thin, for `evmOrchestrator.ts`'s reason: every ordering rule that can lose
 * funds lives in {@link planEvmSend}, which this corridor reuses UNCHANGED. The
 * planner reads a state, two deadlines and an observation and mentions no
 * denomination anywhere — the race between the solver's EVM timeout and the
 * client's Arkade refund is the same race whatever funds the Arkade side. A
 * second copy specialised to assets would be a second place for rules 1-7 to
 * drift.
 *
 * WHAT IS ACTUALLY DIFFERENT, and it is only these:
 *
 * 1. The client locks an ASSET, so the acceptance gate and the fee are in atomic
 *    units and the covenant carries an asset id.
 * 2. The rate is `asset -> token` from a market the OPERATOR declared. Nothing
 *    composes an asset/BTC feed with a BTC/token one.
 * 3. There is no sats leg, so no `AdmissionControl` reservation is taken and
 *    this corridor contributes nothing to `maxExposedSats`. Its aggregate bound
 *    is in the asset's own units instead. @see AssetEvmSendSwapStore.committedSats.
 */

import { planEvmSend, type EvmSendAction, type EvmSendObservation } from '@arkade-os/solver-core/core/evmSendPlan.js'
import { blocksForDuration, type EvmBlockCadence } from '@arkade-os/solver-rails-evm/evm/blockTime.js'
import type { AssetEvmSendSwapRow, AssetEvmSendSwapStore } from '../db/assetEvmSendSwaps.js'
import type { EvmCall, EvmHtlcBackend, EvmTransactionOutcome } from '@arkade-os/solver-core/ports/evm.js'
import { EVM_SEND_EXPOSED } from '@arkade-os/solver-core/core/evmSwapState.js'
import type { Erc20SwapLock } from '@arkade-os/solver-rails-evm/evm/erc20Swap.js'
import type { ArkadeOps } from '@arkade-os/solver-arkade/arkade/arkadeOps.js'
import { provenDepth } from '@arkade-os/solver-rails-evm/evm/lockDepth.js'
import { QUOTE_RATE_LIMIT, QUOTE_RATE_WINDOW_SECONDS, RateLimiter } from '@arkade-os/solver-core/core/rateLimit.js'
import type { Fee } from '@arkade-os/solver-core/core/corridorPolicy.js'
import type { AssetEvmCorridorPolicy } from '@arkade-os/solver-core/core/assetEvmCorridorConfig.js'
import type { FetchPrice } from '@arkade-os/solver-core/price/feed.js'
import { convertAmount } from '@arkade-os/solver-core/core/priceFeed.js'
import {
  assetPayoutUnitsFor,
  evaluateAssetEvmSendAcceptance,
  type EvmSendAcceptanceRefusal,
} from '@arkade-os/solver-core/core/assetEvmSend.js'
import { CovenantSwapScript, parseAssetId } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { assetEvmSendCovenantRowFor } from '../evm/covenantRow.js'
import { scriptHashFromPaymentHash } from '@arkade-os/solver-core/core/preimage.js'
import { hex } from '@scure/base'
import { ArkAddress } from '@arkade-os/sdk'

export type EvmBroadcaster = (call: EvmCall) => Promise<string>

export interface AssetEvmSendServiceDeps {
  store: AssetEvmSendSwapStore
  evm: EvmHtlcBackend
  broadcast: EvmBroadcaster
  /** Is the client's asset lockup funded for the quoted ASSET amount? */
  arkadeLockupFunded(row: AssetEvmSendSwapRow): Promise<boolean>
  claimArkade(row: AssetEvmSendSwapRow, preimage: string): Promise<string>
  lockFor(row: AssetEvmSendSwapRow): Erc20SwapLock
  blockHeight(): Promise<number>
  solverEvmAddress: Uint8Array

  // ---- quote-time only ------------------------------------------------------
  arkade: ArkadeOps
  /** Served markets, keyed by the corridor string. @see assetEvmCorridorFor */
  markets: ReadonlyMap<string, AssetEvmCorridorPolicy>
  fetchPrice: FetchPrice
  chain: {
    contractAddress: string
    chainId: number
    minConfirmations: number
    minAgeSeconds: number
    cadence: EvmBlockCadence
    quoteValiditySeconds: number
  }
  peerStores?: readonly { findLiveByPaymentHash(hash: string): Promise<unknown> }[]
  quoteLimiter?: RateLimiter
  now?: () => number
  onTickError?: (id: string, error: unknown) => void
}

export interface AssetEvmSendQuoteRequest {
  paymentHash: string
  /** The 68-hex Asset ID the client gives. */
  assetId: string
  /** Which served token the client wants paid in. Lowercase 0x. */
  tokenAddress: string
  /** What the CLIENT gives, in the asset's atomic units. EXACT-IN ONLY. */
  assetUnits: bigint
  evmClaimAddress: string
  refundAddress: string
  clientRefundPubkey: string
  requesterKey?: string
  rfqId?: string
}

export type AssetEvmSendQuoteRefusal =
  | EvmSendAcceptanceRefusal
  | 'invalid_refund_address'
  | 'fee_consumes_swap'
  | 'duplicate_swap'
  | 'provider_at_capacity'
  | 'payout_below_dust'
  | 'price_unavailable'
  | 'rate_limited'
  | 'unsupported_pair'

export type AssetEvmSendQuoteOutcome =
  { accepted: true; swap: AssetEvmSendSwapRow } | { accepted: false; reason: AssetEvmSendQuoteRefusal }

const defaultNow = (): number => Math.floor(Date.now() / 1000)

export class AssetEvmSendSwapService {
  private readonly inFlight = new Set<string>()
  private readonly quoteLimiter: RateLimiter

  constructor(private readonly deps: AssetEvmSendServiceDeps) {
    this.quoteLimiter = deps.quoteLimiter ?? new RateLimiter(QUOTE_RATE_LIMIT, QUOTE_RATE_WINDOW_SECONDS, this.now)
  }

  private get now(): () => number {
    return this.deps.now ?? defaultNow
  }

  /** @see EvmSendSwapService.lockReverted — a node that cannot answer is not evidence of a revert. */
  private async lockReverted(row: AssetEvmSendSwapRow): Promise<boolean> {
    if (row.state !== 'locking_evm' || row.evmLockTxid === null) return false
    try {
      return (await this.deps.evm.transactionOutcome(row.evmLockTxid)) === 'reverted'
    } catch (error) {
      this.deps.onTickError?.(row.id, error)
      return false
    }
  }

  private async refundOutcome(row: AssetEvmSendSwapRow): Promise<EvmTransactionOutcome> {
    if (row.state !== 'refunding_evm' || row.evmRefundTxid === null) return 'pending'
    try {
      return await this.deps.evm.transactionOutcome(row.evmRefundTxid)
    } catch (error) {
      this.deps.onTickError?.(row.id, error)
      return 'pending'
    }
  }

  /** Everything the planner needs, read in ONE pass. @see EvmSendSwapService.observe */
  private async observe(row: AssetEvmSendSwapRow): Promise<EvmSendObservation> {
    const lock = this.deps.lockFor(row)
    const [funded, present, height, lockReverted, refundOutcome] = await Promise.all([
      this.deps.arkadeLockupFunded(row),
      this.deps.evm.isLocked(lock),
      this.deps.blockHeight(),
      this.lockReverted(row),
      this.refundOutcome(row),
    ])
    // Gated on the ROW having entered `locking_evm`, never on the lock still
    // being present: the contract deletes its flag on claim, so presence goes
    // false at exactly the moment a Claim event starts to exist. @see #243.
    let preimage = row.preimage
    if (preimage === null && (EVM_SEND_EXPOSED as readonly string[]).includes(row.state)) {
      try {
        const found = await this.deps.evm.findClaimPreimage(lock, 0n)
        preimage = found === null ? null : Buffer.from(found).toString('hex')
      } catch (error) {
        this.deps.onTickError?.(row.id, error)
      }
    }
    const depth = await provenDepth(
      this.deps.evm,
      lock,
      { present, height, minConfirmations: row.minConfirmations, nowSeconds: this.now() },
      (error) => this.deps.onTickError?.(row.id, error),
    )
    return {
      arkadeLockupFunded: funded,
      evmLockPresent: present,
      evmLockReverted: lockReverted,
      evmRefundOutcome: refundOutcome,
      evmLockConfirmations: depth.confirmations,
      evmLockAgeSeconds: depth.ageSeconds,
      preimage,
      nowSeconds: this.now(),
      evmBlockHeight: height,
    }
  }

  private async step(row: AssetEvmSendSwapRow): Promise<boolean> {
    const action: EvmSendAction = planEvmSend(row, await this.observe(row))
    const { store } = this.deps

    switch (action.do) {
      case 'wait':
        return false

      case 'refuse':
        await store.transition(row.id, row.state, 'refused', { failure_reason: action.reason })
        return false

      case 'stick':
        await store.fail(row.id, row.state, action.reason)
        return false

      case 'lock_evm': {
        // EXPOSED STATE BEFORE THE CALL. A crash between the two must leave a
        // row that claims to be locking and no lock, never a lock nobody knows
        // about against a row still reading `funded`.
        await store.transition(row.id, row.state, 'locking_evm')
        const lock = this.deps.lockFor(row)
        // APPROVE FIRST — `lock` moves tokens with `transferFrom`, and without
        // an allowance it reverts. The planner cannot tell a revert from a lock
        // that has not landed, so it would wait out the whole timeout.
        const allowance = await this.deps.evm.allowance(lock.tokenAddress, this.deps.solverEvmAddress)
        const calls = this.deps.evm.lockCalls(lock, allowance)
        if (calls.length === 0) {
          throw new Error(`lockCalls returned no calls for swap ${row.id}; the lock call is never optional`)
        }
        let txid = ''
        for (const call of calls) txid = await this.deps.broadcast(call)
        // The LAST call is the lock. Recorded before its status is known: the
        // txid is the only handle on the receipt that says whether it exists.
        await store.patch(row.id, { evm_lock_txid: txid })
        return true
      }

      case 'await_claim':
        await store.transition(row.id, row.state, 'awaiting_claim')
        return true

      case 'claim_arkade': {
        // PREIMAGE PERSISTED FIRST. A crash after claiming but before recording
        // it loses the one secret that makes the lockup spendable.
        const current = row.state === 'claiming' ? row : await store.get(row.id)
        if (current.state !== 'claiming') {
          await store.transition(row.id, current.state, 'claiming', { preimage: action.preimage })
        }
        const arkTxid = await this.deps.claimArkade(await store.get(row.id), action.preimage)
        await store.transition(row.id, 'claiming', 'claimed', { claim_ark_txid: arkTxid })
        return false
      }

      case 'refund_evm': {
        await store.transition(row.id, row.state, 'refunding_evm')
        const txid = await this.deps.broadcast(this.deps.evm.refundCall(this.deps.lockFor(row)))
        // GUARDED, not a bare patch. A row that already names a refund keeps
        // that name: overwriting it would leave the row waiting on the receipt
        // of the LOSING transaction while the winner's tokens came back
        // unrecorded — the shape of #36.
        if (!(await store.claimRefundTxid(row.id, txid))) {
          this.deps.onTickError?.(row.id, new Error(`refund ${txid} raced an already-recorded refund`))
        }
        return false
      }

      case 'record_refund':
        await store.transition(row.id, 'refunding_evm', 'refunded')
        return false
    }
  }

  /**
   * Admit a swap, or refuse it by name.
   *
   * Everything the row keeps is snapshotted here — a later step that re-read
   * config would derive a different swap key or a different script the moment an
   * operator changed anything, and neither is visible until money is locked.
   */
  async quote(request: AssetEvmSendQuoteRequest): Promise<AssetEvmSendQuoteOutcome> {
    const { store, arkade, chain } = this.deps
    if (request.requesterKey !== undefined && !this.quoteLimiter.take(request.requesterKey)) {
      return { accepted: false, reason: 'rate_limited' }
    }
    // THE OPERATOR DECLARED THIS PAIR OR IT IS NOT SERVED. No fallback composes
    // a rate from the asset's BTC market and the token's — @see
    // assetEvmCorridorConfig.ts.
    const corridor = `arkade:${request.assetId}->ethereum:${request.tokenAddress.toLowerCase()}`
    const served = this.deps.markets.get(corridor)
    if (served === undefined || !served.enabled) return { accepted: false, reason: 'unsupported_pair' }

    let refundPkScript: Uint8Array
    try {
      refundPkScript = ArkAddress.decode(request.refundAddress).pkScript
      if (!request.refundAddress.toLowerCase().startsWith(`${arkade.hrp}1`)) {
        return { accepted: false, reason: 'invalid_refund_address' }
      }
    } catch {
      return { accepted: false, reason: 'invalid_refund_address' }
    }

    const nowSeconds = this.now()
    const acceptance = evaluateAssetEvmSendAcceptance({
      assetUnits: request.assetUnits,
      assetLimits: served.assetLimits,
      unilateralClaimDelay: arkade.delays.unilateralClaimDelay,
      nowSeconds,
    })
    if (!acceptance.accept) return { accepted: false, reason: acceptance.reason }

    // THE AGGREGATE BOUND, in the asset's own units, because the house
    // `maxExposedSats` cannot see this corridor at all. Read-then-check rather
    // than a reservation: `AdmissionControl` serialises a SATS figure, and
    // there is no sats figure here to hand it. The residual race admits at most
    // the quotes in flight at one instant, which is the exposure a per-swap
    // ceiling already bounds — stated rather than left to be discovered.
    if (served.maxExposedUnits !== undefined) {
      const committed = (await store.committedAssetUnits()).get(request.assetId) ?? 0n
      if (committed + request.assetUnits > served.maxExposedUnits) {
        return { accepted: false, reason: 'provider_at_capacity' }
      }
    }

    const evmTimeoutHeight =
      (await this.deps.blockHeight()) + Number(blocksForDuration(acceptance.evmTimeout - nowSeconds, chain.cadence))
    const validUntil = nowSeconds + chain.quoteValiditySeconds

    const payoutUnits = assetPayoutUnitsFor(request.assetUnits, served.fee)
    if (payoutUnits <= 0n) return { accepted: false, reason: 'fee_consumes_swap' }

    if (await store.findLiveByPaymentHash(request.paymentHash)) {
      return { accepted: false, reason: 'duplicate_swap' }
    }
    for (const peer of this.deps.peerStores ?? []) {
      if (await peer.findLiveByPaymentHash(request.paymentHash)) {
        return { accepted: false, reason: 'duplicate_swap' }
      }
    }

    // PRICED AT QUOTE TIME and persisted. A feed that is down refuses rather
    // than guessing: there is no last-known-good here, because a stale rate is
    // how a solver is arbitraged.
    let evmAmount: bigint
    try {
      const price = await this.deps.fetchPrice(served.priceFeed, served.pricePath)
      // ROUNDED DOWN — the solver pays this out, so a sub-unit remainder stays
      // with the solver rather than being given away on every swap.
      evmAmount = convertAmount({
        baseAmount: payoutUnits,
        price,
        baseDecimals: served.asset.decimals,
        quoteDecimals: served.token.decimals,
        rounding: 'down',
      })
    } catch {
      return { accepted: false, reason: 'price_unavailable' }
    }
    if (evmAmount <= 0n) return { accepted: false, reason: 'payout_below_dust' }
    if (
      served.tokenLimits !== undefined &&
      (evmAmount < served.tokenLimits.minUnits || evmAmount > served.tokenLimits.maxUnits)
    ) {
      return { accepted: false, reason: 'amount_out_of_range' }
    }

    const serverKey = hex.decode(arkade.serverPubkey)
    const id = crypto.randomUUID()
    const arkadeScript = new CovenantSwapScript({
      receiver: hex.decode(arkade.providerPubkey),
      server: serverKey,
      preimageHash: scriptHashFromPaymentHash(request.paymentHash),
      refundLocktime: acceptance.refundLocktime,
      claimDelay: arkade.delays.unilateralClaimDelay,
      client: hex.decode(request.clientRefundPubkey),
      clientRefundDelay: arkade.delays.unilateralRefundWithoutReceiverDelay,
      refundWithoutServerDelay: arkade.delays.unilateralRefundDelay,
      // CANONICAL order. `VHTLC.ScriptV2` reverses these bytes itself for
      // `OP_INSPECTOUTASSETLOOKUP`; pre-reversing here yields a lockup that
      // fails to spend with nothing but `OP_VERIFY failed` naming the cause.
      asset: parseAssetId(served.asset.assetId),
      nonInteractiveParameters: {
        emulatorPubkey: hex.decode(arkade.emulatorPubkey),
        receiverPkScript: hex.decode(arkade.receiverPkScript),
        senderPkScript: refundPkScript,
      },
    })

    try {
      const swap = await store.insertQuote({
        id,
        paymentHash: request.paymentHash,
        assetId: served.asset.assetId,
        assetDecimals: served.asset.decimals,
        assetUnits: request.assetUnits.toString(),
        payoutUnits: payoutUnits.toString(),
        evmAmount: evmAmount.toString(),
        tokenAddress: served.token.address,
        evmContractAddress: chain.contractAddress,
        evmChainId: chain.chainId,
        evmTimeout: evmTimeoutHeight,
        validUntil,
        minConfirmations: chain.minConfirmations,
        minAgeSeconds: chain.minAgeSeconds,
        evmClaimAddress: request.evmClaimAddress,
        // THE SOLVER'S OWN ADDRESS. `encodeRefund` takes the refunder from
        // `msg.sender`, so a row storing the client's would key the lock to a
        // swap the solver cannot address — and would let the client refund the
        // solver's tokens the moment the timeout matured.
        evmRefundAddress: hex.encode(this.deps.solverEvmAddress),
        refundLocktime: acceptance.refundLocktime,
        providerPubkey: arkade.providerPubkey,
        serverPubkey: arkade.serverPubkey,
        claimDelay: arkade.delays.unilateralClaimDelay,
        refundDelay: arkade.delays.unilateralRefundDelay,
        refundWithoutReceiverDelay: arkade.delays.unilateralRefundWithoutReceiverDelay,
        pkScript: hex.encode(arkadeScript.pkScript),
        lockupAddress: arkadeScript.address(arkade.hrp, serverKey).encode(),
        refundPkScript: hex.encode(refundPkScript),
        emulatorPubkey: arkade.emulatorPubkey,
        clientRefundPubkey: request.clientRefundPubkey,
        receiverPkScript: arkade.receiverPkScript,
        nonInteractiveParameters: true,
        rfqId: request.rfqId ?? null,
      })
      return { accepted: true, swap }
    } catch (error) {
      if (error instanceof Error && /UNIQUE/i.test(error.message)) {
        return { accepted: false, reason: 'duplicate_swap' }
      }
      throw error
    }
  }

  async tick(id: string): Promise<AssetEvmSendSwapRow> {
    const { store } = this.deps
    if (this.inFlight.has(id)) return store.get(id)
    this.inFlight.add(id)
    try {
      while (await this.step(await store.get(id))) {
        // each successful step re-reads and tries the next
      }
      return await store.get(id)
    } finally {
      this.inFlight.delete(id)
    }
  }

  async tickAll(): Promise<AssetEvmSendSwapRow[]> {
    const rows: AssetEvmSendSwapRow[] = []
    for (const row of await this.deps.store.findLive()) {
      try {
        rows.push(await this.tick(row.id))
      } catch (error) {
        this.deps.onTickError?.(row.id, error)
        try {
          rows.push(await this.deps.store.get(row.id))
        } catch {
          // Store fault rather than a swap fault — the next sweep retries.
        }
      }
    }
    return rows
  }

  /** @see EvmSendSwapService.refundSweep — same courtesy, same empty-read discipline. */
  async refundSweep(): Promise<string[]> {
    const { store, arkade } = this.deps
    const pushed: string[] = []
    for (const row of await store.findRefundable()) {
      try {
        const outputs = await arkade.findLockups(row.pkScript)
        if (outputs.length === 0) {
          if (!(await arkade.lockupProvablySpent(row.pkScript))) continue
          await store.patch(row.id, { refund_outcome: 'external' })
          continue
        }
        const txid = await arkade.refund(assetEvmSendCovenantRowFor(row), outputs)
        await store.patch(row.id, { refund_outcome: 'pushed', refund_ark_txid: txid })
        pushed.push(row.id)
      } catch (error) {
        this.deps.onTickError?.(row.id, error)
      }
    }
    return pushed
  }
}

export type { Fee }
