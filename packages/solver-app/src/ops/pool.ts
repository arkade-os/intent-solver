/**
 * The VTXO float's shape, and the one operator action that SPENDS.
 *
 * Lives here rather than in `cli.ts` so the admin console and the CLI drive the same
 * code.
 */

import type { ExtendedVirtualCoin } from '@arkade-os/sdk'
import { MAX_SPLIT_OUTPUTS, planPool, poolTarget, type PoolCoin } from '@arkade-os/solver-arkade/arkade/vtxoPool.js'
import { outpointKey, usableSatsOf } from '@arkade-os/solver-arkade/arkade/lockupFunding.js'
import { isRenewalDue } from '@arkade-os/solver-arkade/arkade/vtxoLifecycle.js'
import type { ReleaseReservation } from '@arkade-os/solver-arkade/arkade/reservations.js'
import type { Services } from './services.js'
import type { CorridorReaderSet } from '@arkade-os/solver-core/core/corridor.js'

export interface PoolPlan {
  /**
   * What each spendable VTXO can actually fund, unsorted — its value, less the dust
   * an asset it carries pins in place. Identical to the raw values for a float
   * holding no assets. @see usableSatsOf
   */
  spendable: number[]
  target: ReturnType<typeof poolTarget>
  plan: ReturnType<typeof planPool>
  /** The whole VTXOs behind `plan.inputs`: `selectedVtxos` needs their scripts. Never serialised. */
  inputCoins: ExtendedVirtualCoin[]
  /**
   * Sats the float holds and cannot fund a swap with, because they are pinned under
   * an asset. Zero for a float holding no assets.
   *
   * Reported rather than merely subtracted: silently shrinking the float leaves an
   * operator reading a smaller number than their balance with nothing saying why, and
   * "some of your money is doing another job" is the answer they need.
   */
  assetEncumberedSats: number
  /** How many spendable coins carry an asset. Zero for a float holding no assets. */
  assetBearingPieces: number
}

/**
 * How many swaps this float can fund AT ONCE — not the same question as how many sats
 * it holds, since funding pins the coins it spends and one fat coin funds one swap.
 *
 * Read-only; {@link mintPool} acts on the same plan. `maxCount`, `maxInputs` and `maxOutputs`
 * bound one transaction's shape rather than deployment policy, which is why they are
 * constants: an operator who wants a different pool changes the exposure cap, and
 * `poolTarget` derives the target from that.
 */
export const poolPlan = async (services: Services): Promise<PoolPlan> => {
  // RESERVED COINS ARE NOT AVAILABLE TO SPLIT, and this is the caller that owes
  // `planPool` that filter: the ledger is process-local, so only in-process callers
  // hold the authoritative copy. Unfiltered, a split can spend a coin an in-flight
  // funding has pinned. The committed-rows gate below does not cover this — it is a
  // proxy for a SECOND process and says nothing about this one's reservations.
  // Read AFTER the wallet, so a pin taken while that read was in flight still counts.
  //
  // A COIN RENEWAL IS ABOUT TO TAKE IS RENEWAL'S — except one over the operator's
  // per-output ceiling, which `renewExpiringVtxos` refuses on every pass (#27) and only
  // a split can cut.
  //
  // AN ASSET-BEARING COIN IS NOT ORDINARY SATS INVENTORY, and counting it as such is
  // how a pool plans against float it cannot spend. The asset has to land somewhere
  // when the coin is spent, and the SDK routes it onto the sats change output, so one
  // dust of the coin is committed before the pool gets a say — the same rule the
  // funding path already applies, shared from it rather than restated here so the two
  // cannot answer "what can this coin fund" differently. A coin worth no more than
  // dust funds nothing, so it is never a piece; it still counts toward the coin
  // ceiling, and a merge may take it, its asset riding the merge's change.
  const info = await services.arkade.wallet.arkProvider.getInfo()
  const dustSats = Number(info.dust)
  const maxAmount = Number(info.vtxoMaxAmount ?? -1)
  const vtxos = await services.arkade.wallet.getSpendableVtxos()
  const reserved = services.arkade.reservations.reserved()
  const unreserved = vtxos.filter((vtxo) => !reserved.has(outpointKey(vtxo.txid, vtxo.vout)))
  const usable = unreserved.map((vtxo) => Math.max(0, usableSatsOf(vtxo, dustSats)))
  const now = Date.now()
  const coins = unreserved.map((vtxo, i): PoolCoin => ({
    key: outpointKey(vtxo.txid, vtxo.vout),
    value: vtxo.value,
    usable: usable[i]!,
    expiresAtMs: vtxo.expiresAt?.getTime(),
    hasAssets: !!vtxo.assets?.length,
    renewalDue: vtxo.expiresAt !== undefined && isRenewalDue(vtxo, now) && (maxAmount < 0 || vtxo.value <= maxAmount),
  }))
  const target = poolTarget(services.config.limits.maxSats, services.config.maxExposedSats)
  const plan = planPool({
    coins,
    target,
    maxCount: 64,
    // The SDK's own self-send migration batches at this many inputs.
    maxInputs: 50,
    maxOutputs: MAX_SPLIT_OUTPUTS,
    minOutput: Math.max(dustSats, Number(info.vtxoMinAmount ?? 0)),
    maxAmount,
  })
  const byKey = new Map(unreserved.map((vtxo) => [outpointKey(vtxo.txid, vtxo.vout), vtxo]))
  return {
    spendable: usable.filter((value) => value > 0),
    target,
    plan,
    inputCoins: plan.inputs.flatMap((key) => byKey.get(key) ?? []),
    // Derived from `usable` rather than re-deriving the dust rule, so this figure
    // tracks `usableSatsOf` instead of drifting from it the next time it changes.
    assetEncumberedSats: unreserved.reduce((sum, vtxo, i) => sum + vtxo.value - (usable[i] ?? 0), 0),
    assetBearingPieces: unreserved.filter((vtxo) => vtxo.assets?.length).length,
  }
}

/** Pin `coins` unless a funding pinned one since the plan; synchronous, so nothing lands between. */
const pinInputs = (services: Services, coins: readonly ExtendedVirtualCoin[]): ReleaseReservation | null => {
  const pinned = services.arkade.reservations.reserved()
  if (coins.some((coin) => pinned.has(outpointKey(coin.txid, coin.vout)))) return null
  return services.arkade.reservations.reserve(coins)
}

/**
 * The four corridor stores and nothing else, so `src/cli.ts` can call this during
 * startup — before a whole `Services` exists — without a cast that would go on
 * compiling if this later reached for a field the caller never passed.
 */
export type CorridorStores = Pick<Services, 'store' | 'onchainStore' | 'receiveStore' | 'onchainReceiveStore'>

/**
 * Sats riding on non-terminal rows in every corridor — money the provider may
 * still spend, and what `MAX_EXPOSED_SATS` bounds.
 *
 * Reads the READER set, so it counts corridors an operator switched off (their
 * in-flight swaps are still exposure) AND corridors this build was never
 * compiled against. It used to name the four stores, which was correct while
 * four was all there could be — and became headroom handed out twice the moment
 * a corridor could be registered rather than compiled in.
 */
export const committedAcrossCorridors = async (corridors: CorridorReaderSet): Promise<number> => {
  const totals = await Promise.all([...corridors].map((corridor) => corridor.committedSats()))
  return totals.reduce((sum, value) => sum + value, 0)
}

export type MintOutcome =
  /** `committedSats` rides along so a caller can report a forced mint honestly. */
  | { minted: readonly number[]; spent: readonly string[]; txid: string; committedSats: number }
  /** `inputs-pinned`: a funding pinned a planned coin before the spend; the next pass re-plans. */
  | { skipped: 'nothing-to-do' | 'inputs-pinned' }
  | { refused: string; committedSats: number }

/**
 * Reshape the float toward {@link poolTarget}: split below the coin ceiling, merge at it.
 *
 * One Arkade transaction paying the solver's own address several times over, so N
 * pieces cost one transaction and no intent fee. Its inputs are named and pinned, so
 * neither a funding nor a renewal can spend one under it.
 *
 * The hazard is a CONCURRENT PROVIDER: funding pins its coins through a PROCESS-LOCAL
 * ledger, so a mint from a second process can spend a coin out from under an in-flight
 * funding. Non-terminal rows are the only shared signal about that process, so that is
 * the default gate — a deliberately loose proxy, hence `force`. Liveness itself is
 * undetectable: `watch` and `serve` leave no heartbeat.
 *
 * NOTE the admin console runs INSIDE the provider process, so the hazard does not
 * apply to it the same way. The gate is kept because a second provider elsewhere on
 * the same database is still possible and this function cannot tell which case it is
 * in.
 */
export const mintPool = async (services: Services, opts: { force?: boolean } = {}): Promise<MintOutcome> => {
  const { plan, inputCoins } = await poolPlan(services)
  if (plan.outputs.length === 0) return { skipped: 'nothing-to-do' }

  const committed = await committedAcrossCorridors(services.readers)
  if (committed > 0 && opts.force !== true) {
    return {
      refused:
        `${committed} sat committed across non-terminal swaps. ` +
        'A running provider reserves coins in memory this process cannot see. ' +
        'Stop it and re-run, or force if you know none is running.',
      committedSats: committed,
    }
  }

  // Destructured rather than spread because `send` wants a non-empty tuple.
  const address = await services.arkade.wallet.getAddress()
  const [first, ...rest] = plan.outputs.map((amount) => ({ address, amount }))
  if (!first) return { skipped: 'nothing-to-do' }
  const release = pinInputs(services, inputCoins)
  if (release === null) return { skipped: 'inputs-pinned' }
  try {
    const txid = await services.arkade.wallet.send({ recipients: [first, ...rest], selectedVtxos: inputCoins })
    return { minted: plan.outputs, spent: plan.inputs, txid, committedSats: committed }
  } finally {
    release()
  }
}

/**
 * Reshape the float from INSIDE the provider process, after a renewal consolidated it.
 *
 * A no-argument `settle()` sweeps every selectable coin into ONE output and carries
 * Arkade assets onto the output matching the wallet's own script. So one asset anywhere
 * in the float puts the WHOLE float on a single asset-bearing coin, which cannot fund a
 * sats lockup without destroying the asset, and every corridor then refuses against a
 * healthy-looking balance. Splitting isolates the asset onto one piece.
 *
 * NO COMMITTED-ROWS GATE, unlike {@link mintPool}: that gate proxies for a SECOND
 * provider, and here `poolPlan` already filters this process's reservations — the
 * actual hazard — while the renewal this follows settles the same float with no such
 * gate. Passing `force` would say the wrong thing, since a provider demonstrably is
 * running: this one.
 *
 * Nothing needs to hold still between the renewal and this. {@link poolPlan} reads the
 * ledger when the split is planned and the inputs are pinned for the spend, so the
 * safety comes from re-reading rather than exclusivity.
 */
export const resplitFloat = async (services: Services): Promise<{ minted: readonly number[]; txid: string } | null> => {
  const { plan, inputCoins } = await poolPlan(services)
  if (plan.outputs.length === 0) return null
  const address = await services.arkade.wallet.getAddress()
  const [first, ...rest] = plan.outputs.map((amount) => ({ address, amount }))
  if (!first) return null
  const release = pinInputs(services, inputCoins)
  if (release === null) return null
  try {
    const txid = await services.arkade.wallet.send({ recipients: [first, ...rest], selectedVtxos: inputCoins })
    return { minted: plan.outputs, txid }
  } finally {
    release()
  }
}
