/**
 * The VTXO float's shape, and the one operator action that SPENDS.
 *
 * Lives here rather than in `cli.ts` so the admin console and the CLI drive the same
 * code.
 */

import { planPool, poolTarget } from '@arkade-os/solver-arkade/arkade/vtxoPool.js'
import { outpointKey } from '@arkade-os/solver-arkade/arkade/lockupFunding.js'
import type { Services } from './services.js'
import type { CorridorReaderSet } from '@arkade-os/solver-core/core/corridor.js'

export interface PoolPlan {
  /** Every spendable VTXO's value, unsorted. */
  spendable: number[]
  target: ReturnType<typeof poolTarget>
  plan: ReturnType<typeof planPool>
}

/**
 * How many swaps this float can fund AT ONCE — not the same question as how many sats
 * it holds, since funding pins the coins it spends and one fat coin funds one swap.
 *
 * Read-only; {@link mintPool} acts on the same plan. `maxCount` and `maxOutputs` bound
 * one transaction's shape rather than deployment policy, which is why they are
 * constants: an operator who wants a different pool changes the exposure cap, and
 * `poolTarget` derives the target from that.
 */
export const poolPlan = async (services: Services): Promise<PoolPlan> => {
  // RESERVED COINS ARE NOT AVAILABLE TO SPLIT, and this is the caller that owes
  // `planPool` that filter: the ledger is process-local, so only in-process callers
  // hold the authoritative copy. Unfiltered, a split can spend a coin an in-flight
  // funding has pinned. The committed-rows gate below does not cover this — it is a
  // proxy for a SECOND process and says nothing about this one's reservations.
  //
  // NEAR-EXPIRY IS DELIBERATELY NOT FILTERED, because a split is the only way past the
  // operator's per-output ceiling: `renewExpiringVtxos` judges each candidate with its
  // running total at zero, so a coin alone exceeding `vtxoMaxAmount` is skipped on
  // every pass, and declines in wording `BENIGN_RENEWAL` matches — no failure reported
  // while the coin marches to expiry. Splitting early otherwise costs one cycle.
  //
  // @see arkade-os/lightning-swap-service#144
  const reserved = services.arkade.reservations.reserved()
  const spendable = (await services.arkade.wallet.getSpendableVtxos())
    .filter((vtxo) => !reserved.has(outpointKey(vtxo.txid, vtxo.vout)))
    .map((vtxo) => vtxo.value)
  const target = poolTarget(services.config.limits.maxSats, services.config.maxExposedSats)
  const { dust } = await services.arkade.wallet.arkProvider.getInfo()
  return {
    spendable,
    target,
    plan: planPool({ spendable, target, maxCount: 64, maxOutputs: 8, dust: Number(dust) }),
  }
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
  | { minted: readonly number[]; txid: string; committedSats: number }
  | { skipped: 'nothing-to-do' }
  | { refused: string; committedSats: number }

/**
 * Split the float into the shape {@link poolTarget} asks for.
 *
 * One Arkade transaction paying the solver's own address several times over, so N
 * pieces cost one transaction and no intent fee.
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
  const { plan } = await poolPlan(services)
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
  const txid = await services.arkade.wallet.send(first, ...rest)
  return { minted: plan.outputs, txid, committedSats: committed }
}

/**
 * Re-split the float from INSIDE the provider process, after a renewal consolidated it.
 *
 * A no-argument `settle()` sweeps every selectable coin into ONE output and carries
 * Arkade assets onto the output matching the wallet's own script. So one asset anywhere
 * in the float puts the WHOLE float on a single asset-bearing coin, which cannot fund a
 * sats lockup without destroying the asset, and every corridor then refuses against a
 * healthy-looking balance. Splitting isolates the asset onto one piece.
 * @see arkade-os/lightning-swap-service#123
 *
 * NO COMMITTED-ROWS GATE, unlike {@link mintPool}: that gate proxies for a SECOND
 * provider, and here `poolPlan` already filters this process's reservations — the
 * actual hazard — while the renewal this follows settles the same float with no such
 * gate. Passing `force` would say the wrong thing, since a provider demonstrably is
 * running: this one.
 *
 * Nothing needs to hold still between the renewal and this. {@link poolPlan} reads the
 * ledger when the split is planned, so the safety comes from re-reading rather than
 * exclusivity.
 */
export const resplitFloat = async (services: Services): Promise<{ minted: readonly number[]; txid: string } | null> => {
  const { plan } = await poolPlan(services)
  if (plan.outputs.length === 0) return null
  const address = await services.arkade.wallet.getAddress()
  const [first, ...rest] = plan.outputs.map((amount) => ({ address, amount }))
  if (!first) return null
  const txid = await services.arkade.wallet.send(first, ...rest)
  return { minted: plan.outputs, txid }
}
