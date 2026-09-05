/**
 * Choosing which coins pay an ASSET out of the solver's float.
 *
 * Lives here rather than beside `selectLockupFunding` because that module says
 * so: its `assets` field is deliberately opaque, asking only WHETHER a coin
 * carries an asset, because "asset-aware coin selection belongs to the corridor
 * that pays in assets, not to the one funding a lockup denominated in sats".
 *
 * Two units, one decision. A coin must carry enough of the ASSET to cover the
 * payout, and enough SATS to carry it — an Arkade output is a Bitcoin output,
 * so the payout rides a dust carrier and any asset change rides another.
 *
 * Pure: no clock, no wallet, no network.
 */

/** The slice of a VTXO this decision reads. */
export interface AssetFundingCandidate {
  txid: string
  vout: number
  /** Sats the coin holds. */
  value: number
  expiresAt?: Date
  /** Height-typed expiry never counts as clearing the horizon. @see lockupFunding.ts */
  expiresAtHeight?: number
  /** `VirtualCoin.assets`. The SDK carries `amount` as a decimal STRING. */
  assets?: readonly { assetId: string; amount: string | bigint }[]
}

export interface AssetFundingRequest<T extends AssetFundingCandidate> {
  candidates: readonly T[]
  assetId: string
  /** Atomic units of `assetId` the payout must move. */
  units: bigint
  /** Sats the payout output carries alongside the asset. */
  carrierSats: number
  horizonSeconds: number
  nowSeconds: number
  reserved: ReadonlySet<string>
  dustSats: number
}

export type AssetFundingSelection<T> =
  { ok: true; inputs: readonly T[]; units: bigint; clearedHorizon: boolean } | { ok: false; reason: string }

const outpointKey = (c: AssetFundingCandidate): string => `${c.txid}:${c.vout}`

/** Wire strings and bigints both appear; a malformed amount reads as nothing held. */
const heldOf = (candidate: AssetFundingCandidate, assetId: string): bigint => {
  let held = 0n
  for (const entry of candidate.assets ?? []) {
    if (entry.assetId !== assetId) continue
    if (typeof entry.amount === 'bigint') {
      held += entry.amount
      continue
    }
    if (/^[0-9]+$/.test(entry.amount)) held += BigInt(entry.amount)
  }
  return held
}

const clearsHorizon = (candidate: AssetFundingCandidate, deadlineMs: number): boolean =>
  candidate.expiresAt !== undefined && candidate.expiresAt.getTime() >= deadlineMs

/**
 * Pick coins to pay `units` of `assetId` into one output carrying `carrierSats`.
 *
 * Coins outliving the swap are preferred but not required, exactly as on the
 * sats path: a lockup inheriting a batch that lapses first is a worse outcome
 * than a refusal, but refusing outright would idle a float that is merely due
 * for renewal. The caller is told which it got.
 */
export const selectAssetFunding = <T extends AssetFundingCandidate>(
  request: AssetFundingRequest<T>,
): AssetFundingSelection<T> => {
  const { candidates, assetId, units, carrierSats, horizonSeconds, nowSeconds, reserved, dustSats } = request
  if (units <= 0n) return { ok: false, reason: 'payout must be a positive number of asset units' }
  const deadlineMs = (nowSeconds + horizonSeconds) * 1000

  const usable = candidates
    .filter((c) => !reserved.has(outpointKey(c)) && heldOf(c, assetId) > 0n)
    .map((c) => ({ candidate: c, held: heldOf(c, assetId), clears: clearsHorizon(c, deadlineMs) }))
  if (usable.length === 0) return { ok: false, reason: `no unreserved coin carries asset ${assetId}` }

  // Horizon first, then the largest asset holding: fewer inputs means a smaller
  // packet and less fragmentation of what is left behind.
  // Returns 0 for equals rather than a constant -1: an inconsistent comparator
  // lets V8 reorder ties, which made a horizon-preference test pass under a
  // sort that ignored the horizon entirely.
  const byHeld = (a: bigint, b: bigint): number => (a === b ? 0 : b > a ? 1 : -1)
  usable.sort((a, b) => (a.clears === b.clears ? byHeld(a.held, b.held) : a.clears ? -1 : 1))

  const inputs: T[] = []
  let held = 0n
  let sats = 0
  for (const entry of usable) {
    inputs.push(entry.candidate)
    held += entry.held
    sats += entry.candidate.value
    if (held >= units) break
  }
  if (held < units) {
    return { ok: false, reason: `float holds ${held} of asset ${assetId}, short of the ${units} quoted` }
  }

  // The payout output carries `carrierSats`; any asset left over rides a change
  // output that must itself clear dust, or the SDK refuses to build the spend.
  const needed = carrierSats + (held > units ? dustSats : 0)
  if (sats < needed) {
    return {
      ok: false,
      reason:
        `coins carrying asset ${assetId} hold ${sats} sats, short of the ${needed} needed ` +
        `(${carrierSats} carrier${held > units ? ` plus ${dustSats} for asset change` : ''})`,
    }
  }

  return { ok: true, inputs, units: held, clearedHorizon: inputs.every((i) => clearsHorizon(i, deadlineMs)) }
}
