/**
 * The I/O shell for `arkade:BTC->ethereum:<token>`.
 *
 * Deliberately thin. Every decision that can lose funds lives in
 * {@link planEvmSend} as a pure function, so this module only observes, calls
 * the planner, and carries out what it says. That is the opposite split from the
 * onchain corridors, and the reason is testability: the ordering rules there can
 * only be exercised through fakes for a chain, a wallet and an emulator, while
 * here they are unit tests with no fixtures and this shell is left with nothing
 * to get subtly wrong.
 *
 * BROADCASTING IS INJECTED, not composed here. Turning an `EvmCall` into a mined
 * transaction needs a nonce source, a fee policy and a signer, and the nonce
 * source is PER ACCOUNT rather than per corridor - two corridors sharing one
 * solver key must share one nonce high-water mark or they will reissue each
 * other's nonces. Composing it here would make that impossible to share.
 */

import { planEvmSend, type EvmSendAction, type EvmSendObservation } from '@arkade-os/solver-core/core/evmSendPlan.js'
import { blocksForDuration, type EvmBlockCadence } from '@arkade-os/solver-rails-evm/evm/blockTime.js'
import type { EvmSendSwapRow, EvmSendSwapStore } from '../db/evmSendSwaps.js'
import type { EvmCall, EvmHtlcBackend } from '@arkade-os/solver-core/ports/evm.js'
import type { Erc20SwapLock } from '@arkade-os/solver-rails-evm/evm/erc20Swap.js'
import type { ArkadeOps } from '@arkade-os/solver-arkade/arkade/arkadeOps.js'
import { provenDepth } from '@arkade-os/solver-rails-evm/evm/lockDepth.js'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { QUOTE_RATE_LIMIT, QUOTE_RATE_WINDOW_SECONDS, RateLimiter } from '@arkade-os/solver-core/core/rateLimit.js'
import type { Limits } from '@arkade-os/solver-core/core/limits.js'
import { payoutSatsFor, type Fee } from '@arkade-os/solver-core/core/corridorPolicy.js'
import type { EvmMarket, EvmToken } from '@arkade-os/solver-core/core/evmCorridorConfig.js'
import type { FetchPrice } from '@arkade-os/solver-core/price/feed.js'
import { convertAmount } from '@arkade-os/solver-core/core/priceFeed.js'
import { evaluateEvmSendAcceptance, type EvmSendAcceptanceRefusal } from '@arkade-os/solver-core/core/evmSend.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { evmSendCovenantRowFor } from '../evm/covenantRow.js'
import { scriptHashFromPaymentHash } from '@arkade-os/solver-core/core/preimage.js'
import { hex } from '@scure/base'
import { ArkAddress } from '@arkade-os/sdk'

/** Signs and broadcasts one call, resolving to its transaction hash. */
export type EvmBroadcaster = (call: EvmCall) => Promise<string>

export interface EvmSendServiceDeps {
  store: EvmSendSwapStore
  evm: EvmHtlcBackend
  broadcast: EvmBroadcaster
  /** Is the client's Arkade lockup funded for the quoted amount? */
  arkadeLockupFunded(row: EvmSendSwapRow): Promise<boolean>
  /** Claim the Arkade lockup with the revealed preimage; resolves to the ark txid. */
  claimArkade(row: EvmSendSwapRow, preimage: string): Promise<string>
  /** The lock as the contract keys it - built from the ROW, never from live config. */
  lockFor(row: EvmSendSwapRow): Erc20SwapLock
  /** Current EVM block height. */
  blockHeight(): Promise<number>
  /**
   * The solver's own EVM address, 20 bytes.
   *
   * Needed to READ the allowance before locking. It must be the account the
   * broadcaster signs from, or the allowance read describes a different account
   * than the one the contract will pull from.
   */
  solverEvmAddress: Uint8Array

  // ---- quote-time only ------------------------------------------------------
  // Everything below is read when a quote is admitted and never again: the row
  // snapshots what it needs, and every later step rebuilds from the ROW. A
  // corridor repointed at a different contract, or an operator widening a
  // limit, must not change how a funded swap is settled.

  /** The Arkade side's keys, delays and destinations. */
  arkade: ArkadeOps
  /**
   * The shared reservation control — the SAME instance every other corridor
   * holds, or the cap it enforces is this corridor's alone.
   */
  admission: AdmissionControl
  /** Cap on the summed exposure across every corridor, not just this one. */
  maxExposedSats: number
  /** Sats riding on non-terminal rows everywhere. @see ops/pool.ts */
  totalCommitted(): Promise<number>
  /**
   * Every token this deployment serves on the send side, keyed by lowercase
   * address.
   *
   * A MAP, not a single token, because the store is one per DIRECTION —
   * `token_address` is a column, so one service drives every token's rows. A
   * single-token dep would have forced one service per token sharing a store,
   * which works and then quietly disagrees with itself about which rows are
   * "mine" during a sweep.
   */
  markets: ReadonlyMap<string, EvmSendMarket>
  fetchPrice: FetchPrice
  /** Chain facts the row snapshots so settlement never re-reads config. */
  chain: {
    contractAddress: string
    chainId: number
    minConfirmations: number
    minAgeSeconds: number
    /** The two cadence bounds — quoted in to convert the seconds deadline to a height. */
    cadence: EvmBlockCadence
    /** How long the quoted rate binds, seconds. @see EvmChainConfig.quoteValiditySeconds */
    quoteValiditySeconds: number
  }
  /** Every other corridor's store, so a payment hash live anywhere is spoken for. */
  peerStores?: readonly { findLiveByPaymentHash(hash: string): Promise<unknown> }[]
  /**
   * Quote-admission meter override, mostly for tests. Defaults to the house
   * limiter — the same quota the Lightning send leg runs.
   */
  quoteLimiter?: RateLimiter
  now?: () => number
  onTickError?: (id: string, error: unknown) => void
}

/** One served token's terms: what it is, what it costs, and where its price comes from. */
export interface EvmSendMarket {
  token: EvmToken
  market: EvmMarket
  /** This corridor's own bounds, already narrowed from the house limits. */
  limits: Limits
  /**
   * Optional inventory bound in the TOKEN's own atomic units — the knob that
   * stops being redundant exactly when the price has run away. Enforced at
   * quote time, not merely at lock.
   */
  tokenLimits?: { minUnits: bigint; maxUnits: bigint }
  fee: Fee
}

/** What a client asks for on `arkade:BTC->ethereum:<token>`. */
export interface EvmSendQuoteRequest {
  paymentHash: string
  /** Which served token the client wants paid in. Lowercase 0x. */
  tokenAddress: string
  /**
   * What the CLIENT gives, in sats.
   *
   * EXACT-IN ONLY, for now. On a same-asset corridor `amount_side: 'to'` is an
   * algebraic inverse of the fee; here the `to` leg is a different asset, so
   * exact-out means inverting the PRICE as well - and inverting a rate that is
   * fetched, rounded and directional is its own correctness problem rather than
   * a variation on this one. Refused by name (`exact_out_unsupported`) instead
   * of approximated.
   */
  amountSats: number
  /** Where the client claims the ERC20. */
  evmClaimAddress: string
  /** The client's Arkade address, for the covenant's refund destination. */
  refundAddress: string
  /** The client's own refund key - the `refundWithoutReceiver` leaf. */
  clientRefundPubkey: string
  /**
   * The transport's requester identity (socket IP, relay author), for quote
   * admission control. Absent for operator-local callers, who are never
   * metered — the Lightning send leg's convention.
   */
  requesterKey?: string
  rfqId?: string
}

export type EvmSendQuoteRefusal =
  | EvmSendAcceptanceRefusal
  | 'exact_out_unsupported'
  | 'invalid_refund_address'
  | 'fee_consumes_swap'
  | 'duplicate_swap'
  | 'provider_at_capacity'
  | 'payout_below_dust'
  | 'price_unavailable'
  | 'rate_limited'
  | 'unsupported_token'

export type EvmSendQuoteOutcome =
  { accepted: true; swap: EvmSendSwapRow } | { accepted: false; reason: EvmSendQuoteRefusal }

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

export class EvmSendSwapService {
  private readonly inFlight = new Set<string>()
  private readonly admission: AdmissionControl
  private readonly quoteLimiter: RateLimiter

  constructor(private readonly deps: EvmSendServiceDeps) {
    this.admission = deps.admission
    this.quoteLimiter = deps.quoteLimiter ?? new RateLimiter(QUOTE_RATE_LIMIT, QUOTE_RATE_WINDOW_SECONDS, this.now)
  }

  private get now(): () => number {
    return this.deps.now ?? nowSeconds
  }

  /**
   * Asked only from `locking_evm`, the one state where "the lock is absent" is
   * ambiguous. A failed read degrades to `false` as the other reads do — a node
   * that cannot answer is not evidence the lock failed.
   */
  private async lockReverted(row: EvmSendSwapRow): Promise<boolean> {
    if (row.state !== 'locking_evm' || row.evmLockTxid === null) return false
    try {
      return (await this.deps.evm.transactionOutcome(row.evmLockTxid)) === 'reverted'
    } catch (error) {
      this.deps.onTickError?.(row.id, error)
      return false
    }
  }

  /**
   * Everything the planner needs, gathered before any decision is taken.
   *
   * Read in ONE pass on purpose: a planner shown the lock as present and the
   * preimage as absent from two different moments could conclude something that
   * was true of neither.
   */
  private async observe(row: EvmSendSwapRow): Promise<EvmSendObservation> {
    const lock = this.deps.lockFor(row)
    const [funded, present, height, lockReverted] = await Promise.all([
      this.deps.arkadeLockupFunded(row),
      this.deps.evm.isLocked(lock),
      this.deps.blockHeight(),
      this.lockReverted(row),
    ])
    // Scanned once WE HAVE LOCKED, not while the lock is still present.
    //
    // `present` is `isLocked`, and the contract DELETES its flag on claim — so
    // `present` goes false at exactly the moment a Claim event starts existing.
    // Gating the scan on it made the preimage impossible to find: the client
    // took the tokens, the solver never learned the secret, and the Arkade
    // lockup sat until the client's own refund opened. The client ends up with
    // both sides. The lock's ABSENCE is the signal here, not a reason to stop
    // looking.
    //
    // `evmLockTxid !== null` is the honest guard, and it keeps what the old one
    // was reaching for: a Claim cannot precede the lock it spends, so before we
    // have locked there is nothing to find.
    let preimage = row.preimage
    if (preimage === null && row.evmLockTxid !== null) {
      // Reported and survived, as `provenDepth` treats its failed reads below.
      // The scan asks genesis-to-latest and many providers cap an `eth_getLogs`
      // range, so this THROWS every tick against one of those. Propagating
      // leaves `observe` before the planner runs, so the row never reaches
      // `refund_evm` and the lock stays put past its timeout.
      //
      // Degrading to "not found yet" is safe: the preimage gates the CLAIM, so
      // a scan that never succeeds spends nothing.
      try {
        const found = await this.deps.evm.findClaimPreimage(lock, 0n)
        preimage = found === null ? null : Buffer.from(found).toString('hex')
      } catch (error) {
        this.deps.onTickError?.(row.id, error)
      }
    }
    // PROVEN depth, not assumed. Ask the contract whether this lock was already
    // there `minConfirmations` blocks back; if it was, it is at least that
    // deep, and the probe block's own timestamp bounds its age from below.
    // Costs two reads, and only while the lock is present at all.
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
      arkadeLockupFunded: funded,
      evmLockPresent: present,
      evmLockReverted: lockReverted,
      // MEASURED, not assumed. Feeding the row's own thresholds back here made
      // the planner's `>= minConfirmations` check true the instant any block
      // carried the lock, whatever depth the operator configured — the policy
      // still read as enforced while enforcing nothing.
      //
      // `isLocked` cannot supply this: it asks the contract at `latest`, so it
      // answers whether the lock EXISTS and never how buried it is. Depth needs
      // the block the lock was mined in, which is what `minedAt` reads.
      //
      // Zero for a lock that is not mined yet, and the planner requires both
      // depth and age, so an absent or pending lock cannot advance.
      evmLockConfirmations: depth.confirmations,
      evmLockAgeSeconds: depth.ageSeconds,
      preimage,
      nowSeconds: this.now(),
      evmBlockHeight: height,
    }
  }

  /** One step. Returns true when the row moved, so the caller can try again. */
  private async step(row: EvmSendSwapRow): Promise<boolean> {
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
        // The row enters the EXPOSED state BEFORE the call goes out. A crash
        // between the two must not leave a lock nobody knows about: better to
        // re-observe a row that claims to be locking and find no lock, than to
        // have locked tokens against a row still reading `funded`.
        await store.transition(row.id, row.state, 'locking_evm')
        const lock = this.deps.lockFor(row)
        // APPROVE FIRST. `ERC20Swap.lock` moves the tokens with `transferFrom`,
        // so without an allowance the lock REVERTS — and `planEvmSend` cannot
        // tell a revert from a lock that has not landed, so it would wait out
        // `evmTimeout` and then refund a lock that never existed. Silent, and it
        // costs the whole timeout on every swap.
        //
        // The allowance is READ rather than assumed, because a previous lock
        // that reverted leaves its approval behind and some tokens (USDT) refuse
        // a non-zero-to-non-zero change. `lockCalls` decides how many
        // transactions that costs; here we only sequence them.
        const allowance = await this.deps.evm.allowance(lock.tokenAddress, this.deps.solverEvmAddress)
        const calls = this.deps.evm.lockCalls(lock, allowance)
        // `lockCalls` always ends with the lock itself, so an empty list is a
        // broken binding rather than a state to carry on from. Said here because
        // the alternative is silent: the loop below would leave `txid` at its
        // initial value and the row would record an EMPTY lock id, which reads
        // downstream as "we locked, and here is where" — pointing at nothing.
        // The row is already `locking_evm` by this point, so that row would sit
        // in the exposed state naming a transaction that does not exist.
        if (calls.length === 0) {
          throw new Error(`lockCalls returned no calls for swap ${row.id}; the lock call is never optional`)
        }
        let txid = ''
        for (const call of calls) txid = await this.deps.broadcast(call)
        // The LAST call is the lock, and its id is the one the row keeps: an
        // approval txid recorded as the lock would send anyone reading the row
        // to a transaction that moved nothing.
        //
        // Recorded before its status is known, deliberately: the txid is the only
        // handle on the receipt that answers whether the lock exists, so a
        // restart in that window could not otherwise ask.
        await store.patch(row.id, { evm_lock_txid: txid })
        return true
      }

      case 'await_claim':
        await store.transition(row.id, row.state, 'awaiting_claim')
        return true

      case 'claim_arkade': {
        // PREIMAGE PERSISTED FIRST. It is the money: a crash after claiming but
        // before recording it loses the one secret that makes the lockup
        // spendable, and no amount of chain reading recovers it once the Claim
        // event has aged out of the scan window.
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
        await store.transition(row.id, 'refunding_evm', 'refunded', { evm_refund_txid: txid })
        return false
      }
    }
  }

  /**
   * Drive one swap as far as it will go.
   *
   * Guarded against re-entry: the watch loop and an operator command can both
   * reach this, and two ticks stepping one row would each read a state the other
   * is about to change. The store's from-state guard catches it, but as a thrown
   * error rather than as nothing happening.
   */
  /**
   * Admit a swap, or refuse it by name.
   *
   * Mirrors `OnchainSendSwapService.quote` in shape, and differs in the two
   * places this corridor differs: the deadlines are derived the other way round
   * (@see evaluateEvmSendAcceptance) and the payout is in a DIFFERENT ASSET, so
   * a price is fetched rather than a fee merely subtracted.
   *
   * Everything the row keeps is snapshotted here. A later step that re-read
   * config would derive a different swap key or a different script the moment an
   * operator changed anything, and neither failure is visible until the money is
   * already locked.
   */
  async quote(request: EvmSendQuoteRequest): Promise<EvmSendQuoteOutcome> {
    const { store, arkade, chain } = this.deps
    // Admission first, like the Lightning send leg: a quote is free to request
    // but holds provider capacity for its whole validity window and costs a
    // feed fetch apiece, so the meter runs before any work happens.
    if (request.requesterKey !== undefined && !this.quoteLimiter.take(request.requesterKey)) {
      return { accepted: false, reason: 'rate_limited' }
    }
    // Refused by name rather than falling through to a default: a client that
    // named a token this deployment does not serve should hear that, not get a
    // quote priced off somebody else's feed.
    const served = this.deps.markets.get(request.tokenAddress.toLowerCase())
    if (served === undefined) return { accepted: false, reason: 'unsupported_token' }
    const { token, market, limits, fee } = served

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
    const acceptance = evaluateEvmSendAcceptance({
      amountSats: request.amountSats,
      limits,
      unilateralClaimDelay: arkade.delays.unilateralClaimDelay,
      nowSeconds,
    })
    if (!acceptance.accept) return { accepted: false, reason: acceptance.reason }

    // The acceptance gate ran in SECONDS; the contract reads a block HEIGHT.
    // Convert once, here, floored on the SLOWEST cadence — the "setting our own
    // timelock" direction per blockTime.ts, so the solver's refund opens no
    // later than the seconds deadline sized it. The row stores the HEIGHT: it
    // is the only domain `lockFor` can rebuild the lock from, the quote
    // exposes it to the client as the on-chain deadline, and the contract keys
    // the lock by exactly this timelock. Storing seconds here put a ~1.75e9
    // "height" into the contract — centuries at any real cadence — and the
    // refund branch could never be reached (#223).
    const evmTimeoutHeight =
      (await this.deps.blockHeight()) + Number(blocksForDuration(acceptance.evmTimeout - nowSeconds, chain.cadence))
    // The quote binds for the configured window, NOT until the refund locktime:
    // every second past it is an unhedged option on a live pair (rfq-protocol.md
    // §5). Snapshotted onto the row so a later config change can neither
    // reprice a live quote nor resurrect an expired one.
    const validUntil = nowSeconds + chain.quoteValiditySeconds

    // The client locks the full give; the solver pays out the give MINUS this
    // corridor's fee, converted into the token. `payoutSatsFor` does not clamp,
    // so a payout at or below zero is "the fee ate the swap" and is refused by
    // its own name rather than folded into an out-of-range answer.
    const payoutSats = payoutSatsFor(request.amountSats, fee)
    if (payoutSats <= 0) return { accepted: false, reason: 'fee_consumes_swap' }

    if (await store.findLiveByPaymentHash(request.paymentHash)) {
      return { accepted: false, reason: 'duplicate_swap' }
    }
    for (const peer of this.deps.peerStores ?? []) {
      if (await peer.findLiveByPaymentHash(request.paymentHash)) {
        return { accepted: false, reason: 'duplicate_swap' }
      }
    }

    // PRICED AT QUOTE TIME, and the figure is persisted rather than recomputed:
    // once the client has locked, the rate that priced their payout is a fact
    // whatever the feed says later. A feed that is down refuses the quote rather
    // than guessing - there is no last-known-good here on purpose, because a
    // stale rate is how a solver is arbitraged.
    let evmAmount: bigint
    // RESERVED, not merely observed. The read-then-check this replaces let two
    // concurrent quotes both see the same headroom and both take it: a swap is
    // invisible to `totalCommitted()` until its row lands, so the window
    // between the check and the insert admitted more than the cap allows
    // (#105). `reserve` does the comparison and the claim in one serialised
    // step, so the second caller sees the first one's claim.
    //
    // Taken HERE rather than before the price fetch, deliberately: a
    // reservation held across a network round trip serialises every quote
    // behind the feed's latency, which is the trade `core/admission.ts`
    // declines to make for the same reason on the receive leg.
    const reservation = await this.admission.reserve(
      request.amountSats,
      this.deps.totalCommitted,
      this.deps.maxExposedSats,
    )
    if (reservation === null) return { accepted: false, reason: 'provider_at_capacity' }

    try {
      const price = await this.deps.fetchPrice(market.priceFeed, market.pricePath)
      // ROUNDED DOWN: the solver is paying this out, so a sub-unit remainder
      // stays with the solver rather than being given away on every swap.
      evmAmount = convertAmount({
        baseAmount: BigInt(payoutSats),
        price,
        baseDecimals: 8,
        quoteDecimals: token.decimals,
        rounding: 'down',
      })
    } catch {
      return { accepted: false, reason: 'price_unavailable' }
    }
    if (evmAmount <= 0n) return { accepted: false, reason: 'payout_below_dust' }
    // The inventory bound, in the token's own units, enforced at QUOTE time —
    // the sats bound above is width-limited and reads generous precisely when
    // the price has run away; this is the knob that still refuses then.
    if (
      served.tokenLimits !== undefined &&
      (evmAmount < served.tokenLimits.minUnits || evmAmount > served.tokenLimits.maxUnits)
    ) {
      return { accepted: false, reason: 'amount_out_of_range' }
    }

    const serverKey = hex.decode(arkade.serverPubkey)
    const id = crypto.randomUUID()
    // Constructed from parts rather than through `covenantScriptFromRow`: that
    // helper rebuilds a script from a row that already carries its `pkScript`,
    // and here the pkScript is what we are deriving. The field mapping is the
    // one `evmSendCovenantRowFor` uses in the other direction — the SOLVER is
    // the receiver on this leg, because the solver claims the client's sats.
    const arkadeScript = new CovenantSwapScript({
      receiver: hex.decode(arkade.providerPubkey),
      server: serverKey,
      // The 20-byte ripemd160(sha256(P)) the script wants, never a raw decode of
      // the wire's sha256 form.
      preimageHash: scriptHashFromPaymentHash(request.paymentHash),
      refundLocktime: acceptance.refundLocktime,
      claimDelay: arkade.delays.unilateralClaimDelay,
      client: hex.decode(request.clientRefundPubkey),
      clientRefundDelay: arkade.delays.unilateralRefundWithoutReceiverDelay,
      refundWithoutServerDelay: arkade.delays.unilateralRefundDelay,
      // Every quote from here on carries the current, full covenant suite —
      // no legacy selector. See `NonInteractiveParameters.legacy`'s own doc comment
      // for why that is not simply always omitted.
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
        amountSats: request.amountSats,
        payoutSats,
        evmAmount: evmAmount.toString(),
        tokenAddress: token.address,
        evmContractAddress: chain.contractAddress,
        evmChainId: chain.chainId,
        // A block height, never seconds — the conversion above is the only
        // place the two domains meet.
        evmTimeout: evmTimeoutHeight,
        validUntil,
        minConfirmations: chain.minConfirmations,
        minAgeSeconds: chain.minAgeSeconds,
        evmClaimAddress: request.evmClaimAddress,
        // THE SOLVER'S OWN ADDRESS, never the client's. This is the field the
        // contract stores as `refundAddress`, and `encodeRefund` does NOT carry
        // it in calldata — its signature is five arguments and the contract
        // takes the refunder from `msg.sender`. So the key the solver's own
        // refund computes uses the SOLVER's address; a row that stored the
        // client's would key the lock to a swap the solver cannot address.
        //
        // The refund would revert, and worse: the client, being the stored
        // refundAddress, could call `refund` itself and take the solver's
        // tokens the moment the timeout matured. Every send swap that expired
        // without a preimage would be a total loss.
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
    } finally {
      // On every path. The inserted row is what `totalCommitted()` counts from
      // here on, so holding the claim past this point would double-count it.
      reservation.release()
    }
  }

  async tick(id: string): Promise<EvmSendSwapRow> {
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

  /**
   * Every live row, one tick each.
   *
   * A failing row must not stop the others: this shares a loop with the other
   * corridors, and one stuck swap taking the sweep down would stall all of them.
   */
  async tickAll(): Promise<EvmSendSwapRow[]> {
    const rows: EvmSendSwapRow[] = []
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

  /**
   * Push the covenant refund for every refused swap whose lockup is still at
   * the script.
   *
   * The same courtesy the Lightning corridor's refundSweep is: the refund can
   * only pay the client's committed address, so pushing it costs the provider
   * nothing and makes a refused client whole IMMEDIATELY rather than at the
   * timelocked refund leaves hours later. The non-interactive leaf has no
   * timelock — `refused` EVM rows are always RFQ-family, so the eight-leaf
   * script with that leaf is what the lockup was funded against.
   *
   * The empty-read discipline is the Lightning sweep's, for the same reason:
   * recording "external" on one empty read is a one-way door that would report
   * a client's sats as refunded while they still sit at the script.
   */
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
        const txid = await arkade.refund(evmSendCovenantRowFor(row), outputs)
        await store.patch(row.id, { refund_outcome: 'pushed', refund_ark_txid: txid })
        pushed.push(row.id)
      } catch (error) {
        this.deps.onTickError?.(row.id, error)
      }
    }
    return pushed
  }
}
