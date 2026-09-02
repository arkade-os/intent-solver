/**
 * What the solver could actually pay out of, right now, keyed the way the
 * offer-fill decision reads it.
 *
 * `OfferFillPolicy.available` says "only what could be paid out RIGHT NOW — an offer
 * we cannot cover is refused rather than accepted and left to fail at submission".
 * This turns a wallet balance into exactly that, and the whole file is one judgement:
 * which bucket counts.
 *
 * AVAILABLE, NOT TOTAL. The two differ by more than rounding — observed on a live
 * regtest float:
 *
 *   settled=0  preconfirmed=0  available=0  recoverable=7811436  total=7811436
 *
 * A wallet in that state reports millions and can spend nothing: the batch expired,
 * so the coins need `recoverVtxos()` before coin selection will touch them. Building
 * inventory from `total` there would accept every offer and fail every fill, at
 * submission, after the maker has been told yes. The other buckets are excluded for
 * the same reason: `gated` and `intentLocked` are held for a cause, and
 * `pendingRecovery` is not spendable until it recovers.
 *
 * NOT a reservation. Between reading a balance and submitting a fill, another
 * corridor's tick can spend the same coins — every corridor draws on one float.
 * `evaluateOfferFill` is a gate against offering what we plainly cannot cover, not a
 * guarantee that we can; the settlement either confirms or does not, and an offer
 * fill has no exposure window to lose money in. @see core/assetOffer.ts.
 */

/**
 * The slice of the SDK's balance this reads, typed as the SDK types it.
 *
 * `amount` is `bigint` and NOT `bigint | number`, deliberately. The SDK's own `Asset`
 * says why: asset supplies routinely exceed `Number.MAX_SAFE_INTEGER` and silently
 * truncating in arithmetic would corrupt balances. `available` is `number`, matching
 * `Balance.available`, because sats are bounded by the 21M supply cap.
 *
 * THE `assetId` FORMAT IS A CONTRACT, and a silent one if it breaks. This value
 * becomes a map key that `evaluateOfferFill` looks up with
 * `policy.available.get(offer.wantAssetId)`, where `wantAssetId` came from
 * `AssetId.toString()`. If the two spellings diverge, every asset lookup misses, the
 * solver reads its float as empty, and it refuses every fill it could have taken —
 * no error, just a market that looks quiet.
 *
 * They agree today, and the evidence is behavioural rather than a shared type:
 * `assetManager.issue()` returns an id, `getBalance().assets[].assetId` compares equal
 * to it, and `AssetId.fromString()` parses that same string — all three exercised
 * together in `@arkade-os/sdk`'s asset e2e. Both are the canonical 68-hex form.
 */
export interface SpendableBalance {
  /** Sats generic spending will accept — NOT `total`. */
  available: number
  /** Assets generic spending will accept — NOT `assets`. Ids are canonical 68-hex. */
  availableAssets: readonly { assetId: string; amount: bigint }[]
}

/**
 * Inventory keyed for {@link OfferFillPolicy.available}: asset ids, with `null` for
 * BTC.
 *
 * `null` rather than a sentinel string because that is how the offer packet draws the
 * distinction — it OMITS the asset field for BTC. A stand-in string here would make
 * every BTC leg look uncovered.
 */
export const offerInventoryFrom = (balance: SpendableBalance): ReadonlyMap<string | null, bigint> => {
  const inventory = new Map<string | null, bigint>()
  // Negative is a balance this cannot represent honestly: the decision compares
  // `wantAmount <= held`, so a negative would refuse everything while reading like a
  // quiet market. Clamped, and the clamp is visible here rather than in a caller.
  inventory.set(null, balance.available > 0 ? BigInt(Math.trunc(balance.available)) : 0n)
  for (const entry of balance.availableAssets) {
    const amount = entry.amount
    if (amount <= 0n) continue
    // Summed, not assigned: nothing in the SDK's type says an asset appears once, and
    // a second entry silently replacing the first would understate the float.
    inventory.set(entry.assetId, (inventory.get(entry.assetId) ?? 0n) + amount)
  }
  return inventory
}
