/**
 * What an offer's own script actually holds, read from local wallet state.
 *
 * The producer for `offerFillInputFrom`'s `OfferDeposit`, which does no reading of
 * its own so that whoever calls it owns the deposit's freshness. This is the half
 * that observes.
 *
 * It stays pure — outputs in, a deposit out — because the read has its own failure
 * modes, and burying it here would make the summing untestable without them.
 *
 * LOCAL STATE, NOT A DIRECT INDEXER READ. An offer sits at the maker's script,
 * which this wallet does not own, so the naive conclusion is that only
 * `indexerProvider.getVtxos({ scripts })` can see it. That is not how this repo
 * reaches a foreign script: `registerLiveLockups` in `cli.ts` already registers
 * every live lockup with `getContractManager()`, and the manager syncs those
 * contracts' virtual outputs into the wallet's own repository. An offer's script
 * is the same kind of foreign script and takes the same route — register it,
 * then read `getContractsWithVtxos()`.
 *
 * The difference is not stylistic. A direct indexer read gives this module a
 * second, independent view of the chain that nothing else in the process shares,
 * so a fill could be decided against outputs the rest of the solver has never
 * seen — and the two views drift silently, because nothing compares them. Going
 * through the contract manager means one sync, one repository, and one answer to
 * "what is funded", which is the same discipline every other corridor here
 * already follows.
 *
 * WHICH SOURCE ALSO DECIDES THE SHAPE, and three of them disagree. Measured,
 * not read off the types, because the types are behind the runtime:
 *
 *     getContractsWithVtxos()   assets[].amount is a BIGINT   <- this module
 *     wallet.getSpendableVtxos() assets[].amount is a STRING
 *     indexerProvider.getVtxos() assets[].amount is a BIGINT
 *
 * Taking `bigint` is not a preference: an asset amount is 256-bit, and the SDK
 * says so where it declares the type — "typed as `bigint` because asset supplies
 * routinely exceed Number.MAX_SAFE_INTEGER". A module that accepted the string
 * form as well would be quietly serving a caller reading the wrong source.
 *
 * Worth knowing while reading those types: `VirtualCoin` does not declare `assets` at
 * all, though the runtime plainly returns it. The compile-time assertion in the test
 * is what pins this module to the real shape.
 *
 * SATS ARE A JS NUMBER, which is safe here and nowhere near an asset. The cap is
 * 21e14, comfortably inside 2^53 - 1, so a sats total cannot lose precision. An
 * asset amount is 256-bit and would, which is why those become `bigint` on the
 * way in and stay there.
 *
 * SPENT AND SWEPT OUTPUTS DO NOT COUNT. An offer whose deposit has already been
 * spent still has a history in the repository; summing it would resurrect a
 * deposit that is gone and let the offer be filled against nothing. Both flags
 * are optional on this shape, so absent means "not flagged" rather than unknown.
 */

import type { OfferDeposit } from './offerFill.js'

/**
 * The slice of a synced contract VTXO this reads.
 *
 * Structural rather than the SDK's `ExtendedContractVtxo`, and for the reason
 * `offerFill.ts` gives about `AssetId`: two SDK copies can be installed at once,
 * so naming a type here would tie this to whichever one an offer arrived
 * through. These fields are the whole dependency.
 */
export interface OfferOutputView {
  /** The output's pkScript, hex. Compared against the offer's own. */
  script: string
  /** Sats on the output. */
  value: number
  isSpent?: boolean
  isSwept?: boolean
  /** Assets the output carries. `bigint`, because 256 bits do not fit a double. */
  assets?: readonly { assetId: string; amount: bigint }[]
}

/**
 * A sats figure that can be summed, or a throw naming the row.
 *
 * Not defensiveness: the three shapes refused here would corrupt a total
 * silently rather than fail. A fractional value makes the sum fractional; a
 * negative one makes an offer read as holding less than it does, up to reading
 * as unfunded; a value past `MAX_SAFE_INTEGER` is already wrong before anything
 * is added to it.
 *
 * `-0` is the one value that slips through, deliberately. `Number.isSafeInteger(-0)`
 * is true and `-0 < 0` is false, so it converts to `0n` and contributes nothing —
 * which is the arithmetically correct outcome, not an escape. Refusing it would
 * be a guard against a value that cannot do harm.
 */
const satsOf = (value: number, script: string): bigint => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`output at ${script} has a nonsensical sats value: ${value}`)
  }
  return BigInt(value)
}

/**
 * The same guard for the asset side, keeping the two symmetric.
 *
 * A negative amount can only mean the repository is wrong, and it is the one shape
 * that does real damage: entries are SUMMED, so a negative on one output silently
 * cancels a positive on another and reports an offer as holding less than the chain
 * says — or as nothing, which reads as `offer_unfunded` for a deposit that exists.
 * Every other bad value is loud or inert.
 *
 * No `-0` carve-out is needed here, unlike `satsOf`: `BigInt` has no negative zero,
 * so `-0n` is `0n` and the comparison never sees it.
 *
 * The source is this process's own wallet repository today, but stops being a purely
 * internal read as soon as a foreign script's outputs join it, and the guard costs
 * one comparison.
 */
const assetAmountOf = (amount: bigint, assetId: string, script: string): bigint => {
  if (amount < 0n) {
    throw new Error(`output at ${script} has a negative amount of asset ${assetId}: ${amount}`)
  }
  return amount
}

/**
 * Sum every live output at `swapPkScript` into the deposit the decision reads.
 *
 * Summed rather than "find the one output", because nothing says a deposit
 * arrives in a single payment — `heldOf` in `offerFill.ts` sums the asset side
 * for exactly the same reason, and a sats side that took only the first output
 * would disagree with it on any offer funded twice.
 *
 * Outputs at other scripts are IGNORED rather than refused: the caller passes on
 * whatever the repository held, and being strict here would turn a broad read
 * into an error instead of a filter. What must never happen is the reverse —
 * counting another script's money toward this offer — so the match is explicit
 * and case-insensitive on hex.
 */
export const offerDepositFrom = (swapPkScript: string, outputs: readonly OfferOutputView[]): OfferDeposit => {
  const want = swapPkScript.toLowerCase()
  let sats = 0n
  const assets = new Map<string, bigint>()

  for (const output of outputs) {
    if (output.script.toLowerCase() !== want) continue
    if (output.isSpent === true || output.isSwept === true) continue

    sats += satsOf(output.value, output.script)
    for (const entry of output.assets ?? []) {
      // Accumulated by id: one output may carry several assets, and several
      // outputs may carry the same one. Either way the decision wants one total.
      assets.set(
        entry.assetId,
        (assets.get(entry.assetId) ?? 0n) + assetAmountOf(entry.amount, entry.assetId, output.script),
      )
    }
  }

  // `assets` is omitted rather than empty when there are none, matching the repository
  // and what `heldOf` already handles (`deposit.assets ?? []`).
  //
  // A ZERO-AMOUNT ENTRY IS STILL AN ENTRY, and that is a trap for the caller. An
  // output carrying `{ USD, 0n }` produces `assets: [{ USD, 0n }]`, because dropping
  // it would discard something the chain actually says. `heldOf` sums it to zero and
  // decides correctly, but a caller shortcutting to `deposit.assets?.length > 0` as
  // "carries assets" would read it as yes. Ask `heldOf` for the amount, never the
  // array for its length.
  const carried = [...assets].map(([assetId, amount]) => ({ assetId, amount }))
  return carried.length > 0 ? { sats, assets: carried } : { sats }
}
