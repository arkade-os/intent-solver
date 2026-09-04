/**
 * The I/O shell for `ethereum:<token>->arkade:BTC`.
 *
 * Thin over {@link planEvmReceive}, same as the send shell. What it owns is the
 * ORDER in which the row and the world change, and on this leg the two orderings
 * protect different money.
 *
 * FUNDING: the row enters the exposed state before the sats go out, so a crash
 * cannot leave an Arkade lockup funded against a row that still reads `locked`.
 *
 * CLAIMING: the preimage is persisted before the ERC20 claim is broadcast. On the
 * send leg losing the preimage costs a claim; here it costs the solver its only
 * means of payment, because the sats have already gone.
 */

import {
  planEvmReceive,
  type EvmReceiveAction,
  type EvmReceiveObservation,
} from '@arkade-os/solver-core/core/evmReceivePlan.js'
import type { EvmReceiveSwapRow, EvmReceiveSwapStore } from '../db/evmReceiveSwaps.js'
import type { EvmCall, EvmHtlcBackend, EvmTransactionOutcome } from '@arkade-os/solver-core/ports/evm.js'
import type { Erc20SwapLock } from '@arkade-os/solver-rails-evm/evm/erc20Swap.js'
import { hex } from '@scure/base'
import { ArkAddress } from '@arkade-os/sdk'
import type { ReceiveArkadeOps } from '@arkade-os/solver-arkade/arkade/arkadeOps.js'
import { provenDepth } from '@arkade-os/solver-rails-evm/evm/lockDepth.js'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { QUOTE_RATE_LIMIT, QUOTE_RATE_WINDOW_SECONDS, RateLimiter } from '@arkade-os/solver-core/core/rateLimit.js'
import type { Limits } from '@arkade-os/solver-core/core/limits.js'
import { payoutSatsFor, type Fee } from '@arkade-os/solver-core/core/corridorPolicy.js'
import type { EvmMarket, EvmToken } from '@arkade-os/solver-core/core/evmCorridorConfig.js'
import type { FetchPrice } from '@arkade-os/solver-core/price/feed.js'
import { convertQuoteToBase } from '@arkade-os/solver-core/core/priceFeed.js'
import {
  arkadeRefundLocktimeFor,
  evaluateEvmReceiveFund,
  type EvmReceiveFundRefusal,
} from '@arkade-os/solver-core/core/evmReceive.js'
import { deadlineSecondsForBlock, type EvmBlockCadence } from '@arkade-os/solver-rails-evm/evm/blockTime.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { scriptHashFromPaymentHash } from '@arkade-os/solver-core/core/preimage.js'

export type EvmBroadcaster = (call: EvmCall) => Promise<string>

export interface EvmReceiveServiceDeps {
  store: EvmReceiveSwapStore
  evm: EvmHtlcBackend
  broadcast: EvmBroadcaster
  /** Fund the Arkade lockup for the client; resolves to the ark txid. */
  fundArkade(row: EvmReceiveSwapRow): Promise<string>
  /** Refund the solver's own Arkade lockup; resolves to the ark txid. */
  refundArkade(row: EvmReceiveSwapRow): Promise<string>
  /** Is the solver's Arkade lockup funded and visible? */
  arkadeLockupFunded(row: EvmReceiveSwapRow): Promise<boolean>
  /** The preimage, once the client's Arkade claim has revealed it on the Arkade side. */
  arkadePreimage(row: EvmReceiveSwapRow): Promise<string | null>
  /** The CLIENT's lock as the contract keys it - rebuilt from the ROW. */
  lockFor(row: EvmReceiveSwapRow): Erc20SwapLock
  blockHeight(): Promise<number>

  // ---- quote-time only ------------------------------------------------------
  // Read once, when a quote is admitted. Every later step rebuilds from the ROW.
  arkade: ReceiveArkadeOps
  /** Every served token, keyed by lowercase address. @see EvmSendServiceDeps.markets */
  markets: ReadonlyMap<string, EvmReceiveMarket>
  fetchPrice: FetchPrice
  /** Where the SOLVER claims the client's tokens to. */
  evmClaimAddress: string
  chain: {
    contractAddress: string
    chainId: number
    minConfirmations: number
    minAgeSeconds: number
    cadence: EvmBlockCadence
    /** How long the quoted rate binds, seconds. @see EvmChainConfig.quoteValiditySeconds */
    quoteValiditySeconds: number
  }
  /**
   * The shared reservation control — the SAME instance every other corridor
   * holds, or the cap it enforces is this corridor's alone.
   */
  admission: AdmissionControl
  maxExposedSats: number
  totalCommitted(): Promise<number>
  peerStores?: readonly { findLiveByPaymentHash(hash: string): Promise<unknown> }[]
  /**
   * Quote-admission meter override, mostly for tests. Defaults to the house
   * limiter — the same quota the Lightning send leg runs.
   */
  quoteLimiter?: RateLimiter
  now?: () => number
  onTickError?: (id: string, error: unknown) => void
}

/** One served token's terms on the receive side. */
export interface EvmReceiveMarket {
  token: EvmToken
  market: EvmMarket
  /** Bounds on the SATS the solver pays out. */
  limits: Limits
  /**
   * Optional inventory bound in the TOKEN's own atomic units — the knob that
   * stops being redundant exactly when the price has run away. Enforced at
   * quote time, not merely at fund.
   */
  tokenLimits?: { minUnits: bigint; maxUnits: bigint }
  fee: Fee
}

/** What a client asks for on `ethereum:<token>->arkade:BTC`. */
export interface EvmReceiveQuoteRequest {
  paymentHash: string
  tokenAddress: string
  /** What the CLIENT locks, in the token's own atomic units. */
  evmAmount: string
  /**
   * The block height after which the CLIENT may take its tokens back.
   *
   * THE CLIENT'S CHOICE, not ours, and that is the corridor's shape: the client
   * locks first and carries this deadline, so the solver validates it and
   * derives its own from it. The send leg runs the other way round.
   */
  evmTimeout: number
  /** Where the client's own EVM refund goes. */
  evmRefundAddress: string
  /** The client's Arkade address — the covenant's receiver on this leg. */
  payoutAddress: string
  /** The client's Arkade x-only key. */
  payoutPubkey: string
  /**
   * The transport's requester identity (socket IP, relay author), for quote
   * admission control. Absent for operator-local callers, who are never
   * metered — the Lightning send leg's convention.
   */
  requesterKey?: string
  rfqId?: string
}

export type EvmReceiveQuoteRefusal =
  | EvmReceiveFundRefusal
  | 'unsupported_token'
  | 'invalid_payout_address'
  | 'amount_out_of_range'
  | 'fee_consumes_swap'
  | 'duplicate_swap'
  | 'provider_at_capacity'
  | 'price_unavailable'
  | 'rate_limited'
  | 'invalid_evm_amount'

export type EvmReceiveQuoteOutcome =
  { accepted: true; swap: EvmReceiveSwapRow } | { accepted: false; reason: EvmReceiveQuoteRefusal }

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

export class EvmReceiveSwapService {
  private readonly inFlight = new Set<string>()
  private readonly admission: AdmissionControl
  private readonly quoteLimiter: RateLimiter

  constructor(private readonly deps: EvmReceiveServiceDeps) {
    this.admission = deps.admission
    this.quoteLimiter = deps.quoteLimiter ?? new RateLimiter(QUOTE_RATE_LIMIT, QUOTE_RATE_WINDOW_SECONDS, this.now)
  }

  private get now(): () => number {
    return this.deps.now ?? nowSeconds
  }

  /** Degraded as the send shell degrades its refund read: a node that cannot answer is not a failure. */
  private async claimOutcome(row: EvmReceiveSwapRow): Promise<EvmTransactionOutcome> {
    if (row.evmClaimTxid === null) return 'pending'
    try {
      return await this.deps.evm.transactionOutcome(row.evmClaimTxid)
    } catch (error) {
      this.deps.onTickError?.(row.id, error)
      return 'pending'
    }
  }

  /**
   * One pass, for the reason the send shell gives: a planner shown facts from
   * two different moments could conclude something true of neither.
   *
   * The preimage is read from the ARKADE side here, not the EVM side. That is the
   * inversion of the send leg - the client reveals by claiming the Arkade lockup,
   * and the solver then uses it against the ERC20.
   */
  private async observe(row: EvmReceiveSwapRow): Promise<EvmReceiveObservation> {
    const lock = this.deps.lockFor(row)
    const [present, funded, height, claimOutcome] = await Promise.all([
      this.deps.evm.isLocked(lock),
      this.deps.arkadeLockupFunded(row),
      this.deps.blockHeight(),
      this.claimOutcome(row),
    ])
    // Only worth asking once the lockup exists to be claimed FROM.
    const preimage = row.preimage ?? (funded ? await this.deps.arkadePreimage(row) : null)
    // PROVEN depth, not assumed — same probe as the send shell. On THIS leg it
    // is the only thing standing between a client lock that can still reorg
    // away and the solver's own sats, and the solver never sees that lock's
    // transaction: it learns the lock exists by READING THE CONTRACT, which
    // carries no transaction hash. Asking the contract at an older height needs
    // none, and answers the same question.
    const depth = await provenDepth(
      this.deps.evm,
      lock,
      { present, height, minConfirmations: row.minConfirmations, nowSeconds: this.now() },
      // A node that has pruned the probe height cannot answer, and that is
      // not the same as the lock being absent — reported so a stall has a
      // reason an operator can read.
      (error) => this.deps.onTickError?.(row.id, error),
    )
    return {
      evmLockPresent: present,
      // MEASURED, and it matters more on this leg than on the send one. Here
      // the depth check is the only thing standing between a client's lock and
      // the solver's own sats: feeding the thresholds back made it pass at
      // depth one, so the solver funded the Arkade lockup against a lock that
      // could still reorg away — after which the client claims the sats and the
      // solver's token claim finds nothing. `isLocked` reads `latest` and so
      // reports existence, never depth; `minedAt` reads the block it landed in.
      evmLockConfirmations: depth.confirmations,
      evmLockAgeSeconds: depth.ageSeconds,
      arkadeLockupFunded: funded,
      evmClaimOutcome: claimOutcome,
      preimage,
      nowSeconds: this.now(),
      evmBlockHeight: height,
    }
  }

  /** One step. Returns true when the row moved, so the caller can try again. */
  private async step(row: EvmReceiveSwapRow): Promise<boolean> {
    const action: EvmReceiveAction = planEvmReceive(row, await this.observe(row))
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

      case 'fund_arkade': {
        // Exposed BEFORE the sats go out. A crash between the two must not leave
        // a funded lockup against a row that still reads `locked` - that lockup
        // would be invisible to the exposure accounting and to the refund sweep.
        await store.transition(row.id, row.state, 'funding_arkade')
        const txid = await this.deps.fundArkade(await store.get(row.id))
        await store.patch(row.id, { fund_ark_txid: txid })
        return true
      }

      case 'await_claim':
        await store.transition(row.id, row.state, 'awaiting_claim')
        return true

      case 'claim_evm': {
        // PREIMAGE FIRST. On this leg it is the solver's only means of payment -
        // the sats have already gone out, so losing it between claiming and
        // recording costs the swap's whole value rather than delaying it.
        if (row.state !== 'claiming') {
          await store.transition(row.id, row.state, 'claiming', { preimage: action.preimage })
        }
        const preimage = Uint8Array.from(Buffer.from(action.preimage, 'hex'))
        const txid = await this.deps.broadcast(
          this.deps.evm.claimCall(preimage, this.deps.lockFor(await store.get(row.id))),
        )
        // PATCHED, not transitioned: `claiming` means "awaiting outcome".
        await store.patch(row.id, { evm_claim_txid: txid })
        return false
      }

      case 'record_claim':
        await store.transition(row.id, 'claiming', 'claimed')
        return false

      case 'refund_arkade': {
        // Skipped when the row is already here: the re-drive is past this CAS,
        // and repeating it would append a self-loop edge per tick.
        if (row.state !== 'refunding_arkade') {
          await store.transition(row.id, row.state, 'refunding_arkade')
        }
        const txid = await this.deps.refundArkade(await store.get(row.id))
        await store.transition(row.id, 'refunding_arkade', 'refunded', { refund_ark_txid: txid })
        return false
      }
    }
  }

  /**
   * Admit a receive swap, or refuse it by name.
   *
   * The mirror of the send leg's quote with the roles exchanged, and two things
   * follow. The CLIENT carries `evmTimeout` here, so this VALIDATES a deadline
   * rather than choosing one, and derives `refundLocktime` from it -
   * `refundLocktime + margin <= evmTimeout`, the inverse of the send
   * constraint. And the price runs the other way, because the client gives
   * tokens and receives sats, so the conversion is `convertQuoteToBase` and its
   * reciprocal stays implicit rather than being rounded into a decimal first.
   */
  async quote(request: EvmReceiveQuoteRequest): Promise<EvmReceiveQuoteOutcome> {
    const { store, arkade, chain } = this.deps
    // Admission first, like every other corridor: a quote is free to request
    // but holds provider capacity for its whole validity window and costs a
    // feed fetch apiece, so the meter runs before any work happens.
    if (request.requesterKey !== undefined && !this.quoteLimiter.take(request.requesterKey)) {
      return { accepted: false, reason: 'rate_limited' }
    }
    const served = this.deps.markets.get(request.tokenAddress.toLowerCase())
    if (served === undefined) return { accepted: false, reason: 'unsupported_token' }
    const { token, market, limits, fee } = served

    let payoutPkScript: Uint8Array
    try {
      payoutPkScript = ArkAddress.decode(request.payoutAddress).pkScript
      if (!request.payoutAddress.toLowerCase().startsWith(`${arkade.hrp}1`)) {
        return { accepted: false, reason: 'invalid_payout_address' }
      }
    } catch {
      return { accepted: false, reason: 'invalid_payout_address' }
    }

    // The client's own figure, parsed rather than trusted: a non-decimal would
    // otherwise reach `BigInt` and throw out of the quote instead of being
    // refused by name.
    if (!/^(0|[1-9][0-9]*)$/.test(request.evmAmount)) {
      return { accepted: false, reason: 'invalid_evm_amount' }
    }
    const locked = BigInt(request.evmAmount)
    if (locked <= 0n) return { accepted: false, reason: 'invalid_evm_amount' }
    // The inventory bound, in the token's own units, at QUOTE time: the sats
    // bound below is width-limited and reads generous precisely when the price
    // has run away — this is the knob that still refuses then. Also a free
    // guard against absurd wire amounts before the feed fetch spends on them.
    if (
      served.tokenLimits !== undefined &&
      (locked < served.tokenLimits.minUnits || locked > served.tokenLimits.maxUnits)
    ) {
      return { accepted: false, reason: 'amount_out_of_range' }
    }

    let grossSats: number
    try {
      const price = await this.deps.fetchPrice(market.priceFeed, market.pricePath)
      // ROUNDED DOWN: this is what the solver OWES for the tokens, so a
      // sub-unit remainder stays with the solver rather than being paid away on
      // every swap.
      const sats = convertQuoteToBase({
        quoteAmount: locked,
        price,
        baseDecimals: 8,
        quoteDecimals: token.decimals,
        rounding: 'down',
      })
      // Past 2^53 the sats side stops being representable and every limit and
      // fee below is a `number`. Refused rather than truncated.
      if (sats > BigInt(Number.MAX_SAFE_INTEGER)) return { accepted: false, reason: 'amount_out_of_range' }
      grossSats = Number(sats)
    } catch {
      return { accepted: false, reason: 'price_unavailable' }
    }

    if (grossSats < limits.minSats || grossSats > limits.maxSats) {
      return { accepted: false, reason: 'amount_out_of_range' }
    }
    const payoutSats = payoutSatsFor(grossSats, fee)
    if (payoutSats <= 0) return { accepted: false, reason: 'fee_consumes_swap' }

    if (await store.findLiveByPaymentHash(request.paymentHash)) {
      return { accepted: false, reason: 'duplicate_swap' }
    }
    for (const peer of this.deps.peerStores ?? []) {
      if (await peer.findLiveByPaymentHash(request.paymentHash)) {
        return { accepted: false, reason: 'duplicate_swap' }
      }
    }

    // The client's deadline is a HEIGHT and the ordering gate is in seconds. The
    // conversion uses the FASTEST plausible block time, so the deadline is read
    // as the earliest it could arrive - the safe direction when it bounds
    // somebody else's recourse rather than our own.
    const nowSeconds = this.now()
    const evmTimeoutSeconds = deadlineSecondsForBlock({
      timeoutBlock: BigInt(request.evmTimeout),
      currentBlock: BigInt(await this.deps.blockHeight()),
      nowSeconds,
      cadence: chain.cadence,
    })
    const refundLocktime = arkadeRefundLocktimeFor({ evmTimeout: evmTimeoutSeconds, nowSeconds })
    if (refundLocktime === null) {
      // Recovered rather than collapsed, same as the send leg: null means no
      // safe value exists, and WHICH rule bit is what an operator can act on.
      const decision = evaluateEvmReceiveFund({
        evmTimeout: evmTimeoutSeconds,
        refundLocktime: evmTimeoutSeconds,
        nowSeconds,
      })
      return { accepted: false, reason: decision.ok ? 'deadlines_cannot_be_ordered' : decision.reason }
    }

    const serverKey = hex.decode(arkade.serverPubkey)
    // Roles exchanged from the send leg: the CLIENT is the receiver because the
    // client claims, and the SOLVER plays the covenant's `client` role because
    // it funded and needs the funder-refund fallback.
    const arkadeScript = new CovenantSwapScript({
      receiver: hex.decode(request.payoutPubkey),
      server: serverKey,
      preimageHash: scriptHashFromPaymentHash(request.paymentHash),
      refundLocktime,
      claimDelay: arkade.delays.unilateralClaimDelay,
      client: hex.decode(arkade.solverPubkey),
      clientRefundDelay: arkade.delays.unilateralRefundWithoutReceiverDelay,
      refundWithoutServerDelay: arkade.delays.unilateralRefundDelay,
      // Every quote from here on carries the current, full covenant suite.
      nonInteractiveParameters: {
        emulatorPubkey: hex.decode(arkade.emulatorPubkey),
        receiverPkScript: payoutPkScript,
        senderPkScript: hex.decode(arkade.solverRefundPkScript),
      },
    })

    // RESERVED, not merely observed. The read-then-check this replaces let two
    // concurrent quotes both see the same headroom and both take it: a swap is
    // invisible to `totalCommitted()` until its row lands, so the window
    // between check and insert admitted more than the cap allows (#105).
    //
    // The exposure is the PAYOUT, not what the client locked — the solver funds
    // this leg out of its own capital.
    const reservation = await this.admission.reserve(payoutSats, this.deps.totalCommitted, this.deps.maxExposedSats)
    if (reservation === null) return { accepted: false, reason: 'provider_at_capacity' }

    try {
      const swap = await store.insertQuote({
        id: crypto.randomUUID(),
        paymentHash: request.paymentHash,
        amountSats: grossSats,
        payoutSats,
        evmAmount: request.evmAmount,
        tokenAddress: token.address,
        evmContractAddress: chain.contractAddress,
        evmChainId: chain.chainId,
        evmTimeout: request.evmTimeout,
        validUntil: nowSeconds + chain.quoteValiditySeconds,
        minConfirmations: chain.minConfirmations,
        minAgeSeconds: chain.minAgeSeconds,
        evmClaimAddress: this.deps.evmClaimAddress,
        evmRefundAddress: request.evmRefundAddress,
        refundLocktime,
        providerPubkey: arkade.solverPubkey,
        serverPubkey: arkade.serverPubkey,
        claimDelay: arkade.delays.unilateralClaimDelay,
        refundDelay: arkade.delays.unilateralRefundDelay,
        refundWithoutReceiverDelay: arkade.delays.unilateralRefundWithoutReceiverDelay,
        pkScript: hex.encode(arkadeScript.pkScript),
        lockupAddress: arkadeScript.address(arkade.hrp, serverKey).encode(),
        refundPkScript: arkade.solverRefundPkScript,
        emulatorPubkey: arkade.emulatorPubkey,
        clientRefundPubkey: arkade.solverPubkey,
        receiverPkScript: hex.encode(payoutPkScript),
        payoutPubkey: request.payoutPubkey,
        nonInteractiveParameters: true,
        rfqId: request.rfqId ?? null,
      })
      return { accepted: true, swap }
    } catch (error) {
      if (error instanceof Error && /UNIQUE/i.test(error.message)) {
        return { accepted: false, reason: 'duplicate_swap' }
      }
      throw error
    } finally {
      // On every path. The inserted row is what `totalCommitted()` counts from
      // here on, so holding the claim past this point would double-count it.
      reservation.release()
    }
  }

  async tick(id: string): Promise<EvmReceiveSwapRow> {
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

  async tickAll(): Promise<EvmReceiveSwapRow[]> {
    const rows: EvmReceiveSwapRow[] = []
    for (const row of await this.deps.store.findLive()) {
      try {
        rows.push(await this.tick(row.id))
      } catch (error) {
        this.deps.onTickError?.(row.id, error)
        try {
          rows.push(await this.deps.store.get(row.id))
        } catch {
          // Store fault rather than a swap fault - the next sweep retries.
        }
      }
    }
    return rows
  }
}
