/**
 * What an offer's own script holds: the producer for `offerFillInputFrom`'s `OfferDeposit`.
 * Pure so the summing is testable without the read (`offerOutputs.ts`), which owns freshness.
 * Asset amounts stay `bigint` (256-bit); sats are safe as a JS number under the 21e14 cap.
 * Spent and swept outputs do not count — summing one would let an offer fill against nothing.
 */

import type { OfferDeposit } from './offerFill.js'

/** The slice of a VTXO this reads — structural, since these fields are the whole dependency. */
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
