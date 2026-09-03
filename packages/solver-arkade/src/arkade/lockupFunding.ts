/**
 * Choosing which of the solver's own coins may fund a lockup.
 *
 * The SDK picks inputs for `wallet.send` itself, and it picks
 * SOONEST-BATCH-EXPIRY FIRST (`selectVirtualCoins`). That is the right rule for
 * an ordinary send — spending a near-expiry coin is how you avoid losing it —
 * and precisely the wrong one here. A VTXO created by an offchain send stays in
 * its parent's batch, so a lockup inherits the expiry of whatever funded it;
 * `vhtlc-v2` then answers `isGenericallySpendable: false`, which bars renewal
 * from re-anchoring it, and `runVtxoLifecycle`'s guard holds recovery back
 * until the refund locktime. Left to the SDK, the escrow is minted from the one
 * coin least able to survive the swap, and nothing downstream can rescue it: a
 * batch that lapses mid-swap leaves the counterparty unable to claim.
 *
 * So this module inverts the rule — LATEST-expiring first — and PREFERS coins
 * that outlive the swap, falling back to the best available and saying so
 * rather than refusing. See {@link selectLockupFunding} for why preferring and
 * requiring are not interchangeable here.
 *
 * It also carries the reservation filter, because the two are the same change.
 * A reservation ledger is worthless while the SDK chooses inputs internally:
 * there is no way to tell it "not that one". Naming the inputs is what makes
 * both the expiry rule and the reservation enforceable, which is why they land
 * together rather than as two independent guards.
 *
 * Pure: no wallet, no clock, no I/O. `src/core/` conventions, kept here because
 * the shape it reasons about is an Arkade coin.
 */

/** The outpoint key convention shared with the reservation ledger. */
export const outpointKey = (txid: string, vout: number): string => `${txid}:${vout}`

/** The slice of a VTXO this decision reads. */
export interface FundingCandidate {
  txid: string
  vout: number
  value: number
  /** Batch expiry as a timestamp, when the coin carries one. */
  expiresAt?: Date
  /**
   * Batch expiry as a block height, for coins denominated that way.
   *
   * Present so a height-typed coin is visibly the LEAST preferred rather than
   * silently treated as unbounded. Comparing a height to a clock needs a chain
   * tip this module deliberately does not take — it is pure — so such a coin
   * never counts as clearing the horizon. It stays spendable, and the caller
   * hears about it through `clearedHorizon`.
   */
  expiresAtHeight?: number
  /**
   * The assets this coin carries, when it carries any (the SDK's
   * `VirtualCoin.assets`).
   *
   * Deliberately typed as opaque: this decision only asks WHETHER a coin
   * carries an asset, never which or how much. Reading into it would be the
   * beginning of asset-aware coin selection, which belongs to the corridor that
   * pays in assets, not to the one funding a lockup denominated in sats.
   */
  assets?: readonly unknown[]
}

/**
 * How many of a coin's sats can actually fund something, given what it carries.
 *
 * An asset must ride on sats, so spending an asset-bearing coin leaves one dust
 * behind on the change output that carries the asset onward — see the long note in
 * {@link selectLockupFunding} for the measurement and the failure it prevents. A coin
 * worth no more than dust therefore funds nothing at all and returns a non-positive
 * number, which every caller drops.
 *
 * EXPORTED SO THE POOL SHARES IT. `poolPlan` answers "how many swaps can this float
 * fund at once", and this is the rule that decides what a coin can fund; two spellings
 * of that would be two different answers to one question in one process, with the pool
 * planning against sats the funding path already knows it cannot reach.
 */
export const usableSatsOf = (coin: Pick<FundingCandidate, 'value' | 'assets'>, dustSats: number): number =>
  coin.assets?.length ? coin.value - dustSats : coin.value

/**
 * Why a funding selection was refused. A closed set, like the corridors' own
 * refusal enums, so a caller cannot invent a reason or ignore one.
 *
 * Running short of batch life is NOT a refusal. See {@link selectLockupFunding}.
 *
 * Deliberately only ONE reason: asset-bearing coins are no longer excluded from
 * funding (see the carrier note below), so a second reason naming that state could
 * never fire — and a refusal that cannot fire is worse than none, inviting a caller
 * to handle a case that will not happen and trust its absence as evidence.
 */
export type LockupFundingRefusal = 'insufficient_unreserved_balance'

export type LockupFundingSelection<T extends FundingCandidate = FundingCandidate> =
  | {
      ok: true
      /**
       * The chosen coins, AS GIVEN. Generic so the caller gets its own objects
       * back rather than this module's narrow view: they go straight to
       * `sendBitcoin({ selectedVtxos })`, which needs the whole VTXO — script,
       * tapscripts and all. Narrowing them to {@link FundingCandidate} and
       * handing THAT to the SDK dropped `script`, and the spend failed with
       * "no contract registered for undefined" from `assertAnnotatable`.
       */
      inputs: readonly T[]
      /**
       * Whether every chosen coin's batch outlives the swap horizon.
       *
       * `false` means the preference could not be met and the best available
       * coins were taken anyway. The caller should say so out loud — it is the
       * signal that the float needs renewing, or that this network's batch
       * lifetime is simply shorter than the horizon.
       */
      clearedHorizon: boolean
    }
  | { ok: false; reason: LockupFundingRefusal }

export interface LockupFundingRequest<T extends FundingCandidate = FundingCandidate> {
  candidates: readonly T[]
  /** What the lockup must hold. */
  amountSats: number
  /** How long the lockup must remain spendable — the corridor's refund horizon. */
  horizonSeconds: number
  nowSeconds: number
  /** Outpoints another operation has pinned; see the reservation ledger. */
  reserved: ReadonlySet<string>
  /**
   * The network's dust threshold, from `arkProvider.getInfo()`.
   *
   * Load-bearing, not incidental. An asset-bearing coin can fund a lockup: the
   * SDK's `send` routes the asset onto the spend's SATS CHANGE OUTPUT by itself.
   * But an asset must ride on sats, so that change output has to clear dust — and
   * the SDK throws when it would not. Counting only `value - dustSats` toward the
   * lockup is what guarantees it does. Counting the whole value would let a coin
   * be spent to the sat, leaving the asset with nowhere to sit, and the failure
   * would surface as a thrown send rather than a refusal we chose.
   */
  dustSats: number
}

/**
 * Pick coins to fund a lockup, preferring those that outlive the swap.
 *
 * **A PREFERENCE, not a requirement, and the difference is load-bearing.** Requiring
 * it makes the receive corridor unusable on any network whose batch lifetime is
 * SHORTER than the horizon, because then no coin can ever clear it and every swap is
 * refused. Regtest is exactly that network: `ARKD_VTXO_TREE_EXPIRY=6144` (~102 min)
 * against a `MAX_REFUND_HORIZON` of 120 min, and five e2e tests failed with
 * `no_coin_outlives_horizon` while this was a requirement.
 *
 * ArkLabsHQ/coinflip documents the same trap on its own splitter: "PREFER, don't
 * REQUIRE. Requiring it starves the splitter on any network whose batch lifetime is
 * shorter than the renewal buffer."
 *
 * So: take the coins that clear the horizon when they exist; otherwise take the best
 * available and SAY SO through `clearedHorizon`. The SDK's rule picks the WORST
 * parent, and picking the best is the whole fix — refusing converts "this could be
 * better" into "this cannot proceed".
 *
 * Ordering is latest-expiring first either way. Coins with no known expiry sort
 * last rather than being excluded — an unknown is not a distant one, so it is
 * the least preferred, not ineligible.
 */
export const selectLockupFunding = <T extends FundingCandidate>(
  request: LockupFundingRequest<T>,
): LockupFundingSelection<T> => {
  const { candidates, amountSats, horizonSeconds, nowSeconds, reserved, dustSats } = request
  const deadlineMs = (nowSeconds + horizonSeconds) * 1000

  // AN ASSET-BEARING COIN CAN FUND A LOCKUP — it just cannot be drained to the
  // last sat.
  //
  // Spending one moves its asset, so the transaction must carry an asset packet
  // saying where that asset went. `sendBitcoin` builds a plain sats transfer and
  // no packet, and arkd rejects the result outright:
  //
  //   ASSET_VALIDATION_FAILED (33): asset packet not found in tx <txid>
  //
  // observed against a live regtest stack. But `send` DOES build the packet and route
  // the asset change itself, so the coin is usable. @see receive/fundLockup.ts
  //
  // WHAT IT COSTS is one dust of headroom, not a whole output. Measured: a spend of a
  // coin holding 8,370,456 sats and 500 asset units, naming no asset recipient,
  // produced the requested output plus a change output carrying all 500 units. The
  // asset rides the sats change, so that change must clear dust and the SDK throws
  // when it would not. Discounting each asset-bearing coin by `dustSats` is what keeps
  // that true; a coin holding only dust contributes nothing and is dropped, since it
  // can pay for its own change and nothing else.
  //
  // Excluding asset coins would also get worse over time: once asset corridors exist
  // the solver holding assets is the normal state, so the exclusion would shrink the
  // sats float by most of it.
  const usableSats = (coin: T): number => usableSatsOf(coin, dustSats)
  const unreserved = candidates
    .filter((coin) => !reserved.has(outpointKey(coin.txid, coin.vout)))
    .filter((coin) => usableSats(coin) > 0)
  const outlivesHorizon = (coin: T): boolean => coin.expiresAt !== undefined && coin.expiresAt.getTime() > deadlineMs

  // Latest-expiring first, the inverse of the SDK's rule, so the lockup is
  // minted from the coin with the most batch life to inherit. Unknown expiry
  // sorts last. Value descending breaks ties, keeping the input count down.
  const ordered = [...unreserved].sort((a, b) => {
    const byExpiry = (b.expiresAt?.getTime() ?? 0) - (a.expiresAt?.getTime() ?? 0)
    return byExpiry !== 0 ? byExpiry : usableSats(b) - usableSats(a)
  })

  const take = (from: readonly T[]): readonly T[] | null => {
    const inputs: T[] = []
    let total = 0
    for (const coin of from) {
      inputs.push(coin)
      total += usableSats(coin)
      if (total >= amountSats) return inputs
    }
    return null
  }

  const preferred = take(ordered.filter(outlivesHorizon))
  if (preferred) return { ok: true, inputs: preferred, clearedHorizon: true }

  const fallback = take(ordered)
  if (fallback) return { ok: true, inputs: fallback, clearedHorizon: false }

  return { ok: false, reason: 'insufficient_unreserved_balance' }
}
