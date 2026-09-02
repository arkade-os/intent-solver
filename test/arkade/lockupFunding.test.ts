import { describe, expect, it } from 'vitest'
import { selectLockupFunding, type FundingCandidate } from '@arkade-os/solver-arkade/arkade/lockupFunding.js'

const HOUR = 3600
const NOW = 1_800_000_000

const coin = (over: Partial<FundingCandidate> & { txid: string; value: number }): FundingCandidate => ({
  vout: 0,
  expiresAt: new Date((NOW + 48 * HOUR) * 1000),
  ...over,
})

const DUST = 330

const select = (
  candidates: readonly FundingCandidate[],
  amountSats = 1000,
  reserved = new Set<string>(),
  dustSats = DUST,
) => selectLockupFunding({ candidates, amountSats, horizonSeconds: 2 * HOUR, nowSeconds: NOW, reserved, dustSats })

describe('selectLockupFunding', () => {
  it('funds from a coin whose batch outlives the swap horizon', () => {
    const result = select([coin({ txid: 'a', value: 5000 })])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.inputs.map((i) => i.txid)).toEqual(['a'])
      expect(result.clearedHorizon).toBe(true)
    }
  })

  /**
   * A PREFERENCE, not a requirement — and this is the case that proves it.
   *
   * The first cut refused here, which made the corridor unusable on any
   * network whose batch lifetime is shorter than the horizon, because then no
   * coin can ever clear it. Regtest is exactly that: 6144s batches against a
   * 7200s horizon. Five e2e tests failed on it. The flag is how the caller
   * still learns the preference could not be met.
   */
  it('falls back to the best available coin rather than refusing, and flags it', () => {
    const result = select([coin({ txid: 'soon', value: 1_000_000, expiresAt: new Date((NOW + HOUR) * 1000) })])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.inputs.map((i) => i.txid)).toEqual(['soon'])
      expect(result.clearedHorizon).toBe(false)
    }
  })

  it('still prefers a horizon-clearing coin over a larger one that lapses', () => {
    const result = select([
      coin({ txid: 'big-soon', value: 1_000_000, expiresAt: new Date((NOW + HOUR) * 1000) }),
      coin({ txid: 'small-safe', value: 5000, expiresAt: new Date((NOW + 72 * HOUR) * 1000) }),
    ])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.inputs.map((i) => i.txid)).toEqual(['small-safe'])
      expect(result.clearedHorizon).toBe(true)
    }
  })

  /**
   * The middle case: preferred coins exist but cannot cover the amount alone,
   * so the fallback supplements them with ones that do not clear the horizon.
   * The two ends were covered; this documents what the accumulation does, and
   * that the flag reports the WEAKEST coin taken rather than the best.
   */
  it('supplements insufficient preferred coins, and flags the mix', () => {
    const result = select(
      [
        coin({ txid: 'safe', value: 400, expiresAt: new Date((NOW + 72 * HOUR) * 1000) }),
        coin({ txid: 'lapsing', value: 700, expiresAt: new Date((NOW + HOUR) * 1000) }),
      ],
      1000,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.inputs.map((i) => i.txid)).toEqual(['safe', 'lapsing'])
      expect(result.clearedHorizon).toBe(false)
    }
  })

  it('prefers the LATEST-expiring coin, the opposite of the SDK default', () => {
    const result = select([
      coin({ txid: 'near', value: 5000, expiresAt: new Date((NOW + 3 * HOUR) * 1000) }),
      coin({ txid: 'far', value: 5000, expiresAt: new Date((NOW + 72 * HOUR) * 1000) }),
    ])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.inputs[0]?.txid).toBe('far')
  })

  it('skips a reserved outpoint even when it would otherwise be chosen', () => {
    const result = select(
      [
        coin({ txid: 'far', value: 5000, expiresAt: new Date((NOW + 72 * HOUR) * 1000) }),
        coin({ txid: 'other', value: 5000, expiresAt: new Date((NOW + 48 * HOUR) * 1000) }),
      ],
      1000,
      new Set(['far:0']),
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.inputs.map((i) => i.txid)).toEqual(['other'])
  })

  it('accumulates several coins when no single one covers the amount', () => {
    const result = select([coin({ txid: 'a', value: 600 }), coin({ txid: 'b', value: 600 })], 1000)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.inputs).toHaveLength(2)
  })

  it('refuses rather than underfunding when the unreserved set is too small', () => {
    const result = select([coin({ txid: 'a', value: 400 })], 1000)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('insufficient_unreserved_balance')
  })

  it('refuses when every coin is reserved', () => {
    const result = select([coin({ txid: 'a', value: 5000 })], 1000, new Set(['a:0']))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('insufficient_unreserved_balance')
  })

  /**
   * A coin with no batch expiry is not a coin with a distant one, so it is the
   * LEAST preferred — but still spendable, and still flagged.
   */
  it('treats an unknown expiry as least preferred, not ineligible', () => {
    const result = select([coin({ txid: 'a', value: 5000, expiresAt: undefined })])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.clearedHorizon).toBe(false)
  })

  it('ranks a known-safe coin above one whose expiry is unknown', () => {
    const result = select([
      coin({ txid: 'unknown', value: 5000, expiresAt: undefined }),
      coin({ txid: 'known', value: 5000, expiresAt: new Date((NOW + 72 * HOUR) * 1000) }),
    ])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.inputs.map((i) => i.txid)).toEqual(['known'])
      expect(result.clearedHorizon).toBe(true)
    }
  })

  it('cannot compare a height-denominated expiry to a clock, so does not count it as clearing', () => {
    const result = select([coin({ txid: 'a', value: 5000, expiresAt: undefined, expiresAtHeight: 900_000 })])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.clearedHorizon).toBe(false)
  })

  it('has nothing to say about an empty wallet', () => {
    const result = select([])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('insufficient_unreserved_balance')
  })
})

/**
 * Asset-bearing coins.
 *
 * They CAN fund a sats lockup — the spend routes the asset back to us in the
 * same transaction (`receive/fundLockup.ts`). What they cannot do is fund one
 * for free: an asset must ride on sats, so the change output carrying it home
 * needs its own dust carrier, and the coin yields `value - dust` toward the
 * lockup.
 *
 * An earlier cut excluded these coins outright, after observing arkd refuse a
 * plain transfer with `ASSET_VALIDATION_FAILED (33): asset packet not found in
 * tx` on a live regtest stack. The observation was real; the conclusion was
 * not. `sendBitcoin` cannot carry an asset packet, but `send({ recipients })`
 * can, so the answer was to name a recipient rather than drop the coin.
 */
describe('selectLockupFunding — asset-bearing coins', () => {
  const asset = [{ assetId: 'b227e0d9', amount: '100000' }]

  it('funds from a coin carrying an asset', () => {
    // The property the exclusion cost us. 5000 sats less one dust carrier still
    // covers 1000, so there is no reason to refuse.
    const result = select([coin({ txid: 'asset-bearing', value: 5000, assets: asset })])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.inputs.map((i) => i.txid)).toEqual(['asset-bearing'])
  })

  it('discounts it by exactly one dust carrier, not by nothing and not by more', () => {
    // The arithmetic, pinned at the boundary. value 1330 - 330 = 1000 usable,
    // which is exactly the ask; one sat less is one sat short. Counting the
    // whole value would select a set that comes up short at send time.
    expect(select([coin({ txid: 'a', value: 1330, assets: asset })], 1000).ok).toBe(true)
    expect(select([coin({ txid: 'a', value: 1329, assets: asset })], 1000).ok).toBe(false)
    // And a plain coin is NOT discounted: 1000 covers 1000.
    expect(select([coin({ txid: 'a', value: 1000 })], 1000).ok).toBe(true)
  })

  it('drops a coin that is nothing but a carrier', () => {
    // Exactly dust: usable is zero. Selecting it would add an input, add a
    // change output, and move the total not at all.
    //
    // The carrier is given MORE batch life than the plain coin on purpose. With
    // equal expiry the tie-break is usable value, so the plain coin wins and the
    // carrier is never reached — the assertion would pass with no filter at all.
    // Sorting the carrier to the FRONT is what makes this test able to fail.
    const result = select([
      coin({ txid: 'carrier', value: DUST, assets: asset, expiresAt: new Date((NOW + 96 * HOUR) * 1000) }),
      coin({ txid: 'plain', value: 5000 }),
    ])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.inputs.map((i) => i.txid)).toEqual(['plain'])
  })

  it('drops a sub-dust asset coin rather than subtracting into the negative', () => {
    // usable would be -30. Accumulating that would make a set SMALLER by adding
    // a coin to it, which is how a shortfall turns into a wrong selection.
    // Sorted to the front for the reason the carrier case above is.
    const result = select([
      coin({ txid: 'tiny', value: 300, assets: asset, expiresAt: new Date((NOW + 96 * HOUR) * 1000) }),
      coin({ txid: 'plain', value: 1000 }),
    ])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.inputs.map((i) => i.txid)).toEqual(['plain'])
  })

  it('still refuses a coin a live funding has pinned', () => {
    // The reservation rule is untouched by any of this: a pinned coin is not
    // available whether it carries an asset or not.
    const reserved = new Set(['asset-bearing:0'])
    const result = select([coin({ txid: 'asset-bearing', value: 5000, assets: asset })], 1000, reserved)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('insufficient_unreserved_balance')
  })

  it('PREFERS an asset coin with more batch life, inverting the old behaviour', () => {
    // The exclusion made this the opposite: the asset coin was passed over even
    // though it had the most batch life, which is the one property lockup
    // funding is supposed to optimise for.
    const result = select([
      coin({ txid: 'asset-bearing', value: 5000, assets: asset, expiresAt: new Date((NOW + 96 * HOUR) * 1000) }),
      coin({ txid: 'plain', value: 5000 }),
    ])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.inputs.map((i) => i.txid)).toEqual(['asset-bearing'])
  })

  it('discounts each asset coin separately when several are taken', () => {
    // Two carriers, two discounts: 800+800 raw is 1600, usable is 940, short of
    // 1000. One discount would wrongly report it covered.
    const result = select(
      [coin({ txid: 'a', value: 800, assets: asset }), coin({ txid: 'b', value: 800, assets: asset })],
      1000,
    )
    expect(result.ok).toBe(false)
  })

  it('treats an empty assets array as plain sats, with no discount', () => {
    // The SDK reports `assets` as an optional array; absent and empty must mean
    // the same thing, or a coin the indexer describes verbosely pays a carrier
    // cost for an asset it does not have.
    expect(select([coin({ txid: 'a', value: 1000, assets: [] })], 1000).ok).toBe(true)
  })
})
