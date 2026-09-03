/**
 * What is sitting at an offer's script right now — the read `offerDepositFrom`
 * deliberately does not do.
 *
 * That module is pure so that "whoever calls it owns the deposit's freshness",
 * and this is the caller that owns it: one indexer read, paged, normalised into
 * the view the summing takes.
 *
 * READ DIRECTLY, NOT THROUGH THE CONTRACT MANAGER, and `offerDeposit.ts`'s
 * header argues the other way — so the difference is worth stating. Its argument
 * is that a second, private view of the chain drifts from the wallet's own and
 * nothing compares them. That bites for scripts the solver already tracks: a
 * lockup this service funded is in the contract manager, and reading it twice
 * gives two answers to one question.
 *
 * A MAKER'S OFFER SCRIPT IS NOT ONE OF THOSE. No corridor holds it, nothing else
 * in the process reads it, and there is no second view for this one to disagree
 * with. Reaching it through the manager would mean REGISTERING every offer seen
 * on a public stream as a contract of ours — an unbounded, attacker-grown set on
 * the money path's own wallet, which is the cost `contractLifecycle.ts` exists
 * to bound. The route the manager offers for foreign scripts
 * (`registerOfferContract`) is also not exported by `@arkade-os/swap` at 0.0.10.
 *
 * So this is the narrower choice, not the lazier one. It is still a real fork,
 * and if offers ever become something the wallet tracks for its own sake, this
 * is the module that should move.
 */
import { hasTerminalSpend } from '@arkade-os/sdk'
import type { ArkadeContext } from './wallet.js'
import type { OfferOutputView } from './offerDeposit.js'

/**
 * Every output the indexer knows at `pkScriptHex`, spent ones included.
 *
 * Unfiltered on purpose: `offerDepositFrom` is what decides which outputs count,
 * and narrowing here with `spendableOnly` would hand it an answer that cannot
 * tell "the deposit was spent" from "this view has not caught up".
 *
 * Paged exactly as `findLockupOutpoints` is, and for the same reason — a
 * truncated first page undercounts the deposit, and `offer_unfunded` is what a
 * caller would see instead of an error. The empty-page stop is the hard bound
 * that keeps a misbehaving server from spinning the loop.
 */
export const offerOutputsAt = async (
  ctx: Pick<ArkadeContext, 'wallet'>,
  pkScriptHex: string,
): Promise<OfferOutputView[]> => {
  const outputs: OfferOutputView[] = []
  let pageIndex = 0
  for (;;) {
    const { vtxos, page } = await ctx.wallet.indexerProvider.getVtxos({
      scripts: [pkScriptHex],
      pageIndex,
      pageSize: 500,
    })
    const batch = vtxos ?? []
    for (const vtxo of batch) {
      outputs.push({
        script: vtxo.script,
        value: Number(vtxo.value),
        // `hasTerminalSpend` rather than `vtxo.isSpent`, for the reason
        // `lockupProvablySpent` gives: the wire contract permits `isSpent: true`
        // with an empty `spentBy`, and the SDK's own predicate is the only one
        // that unions all three spend facts. `offerDepositFrom` filters on this
        // single flag, so a spend reported only as `spentBy` would otherwise
        // resurrect a deposit that is gone and let the offer be filled against
        // nothing.
        isSpent: hasTerminalSpend(vtxo),
        // Kept SEPARATE from the spend, exactly as the SDK keeps it: a swept
        // output is not a terminal spend, and folding the two would lose the
        // distinction the deposit summing already makes.
        isSwept: vtxo.isSwept === true,
        ...(vtxo.assets ? { assets: vtxo.assets } : {}),
      })
    }
    if (batch.length === 0 || !page || page.current + 1 >= page.total) break
    pageIndex = page.current + 1
  }
  return outputs
}
