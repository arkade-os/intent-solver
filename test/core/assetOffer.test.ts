import { describe, it, expect } from 'vitest'
import { evaluateOfferFill, type OfferFillInput, type OfferFillPolicy } from '@arkade-os/solver-core/core/assetOffer.js'

const USDT = 'a'.repeat(68)
const EURC = 'b'.repeat(68)
const OTHER = 'c'.repeat(68)

const policy = (over: Partial<OfferFillPolicy> = {}): OfferFillPolicy => ({
  markets: [
    { a: null, b: USDT }, // arkade:BTC <-> USDT
    { a: USDT, b: EURC }, // asset <-> asset
  ],
  available: new Map<string | null, bigint>([
    [null, 1_000_000n],
    [USDT, 5_000n],
    [EURC, 5_000n],
  ]),
  minFillAmount: 10n,
  maxFillAmount: 100_000n,
  ...over,
})

/** A maker depositing USDT and wanting BTC — the solver pays sats, collects USDT. */
const offer = (over: Partial<OfferFillInput> = {}): OfferFillInput => ({
  wantAssetId: null,
  wantAmount: 1_000n,
  offerAssetId: USDT,
  offerAmount: 900n,
  ...over,
})

describe('evaluateOfferFill', () => {
  it('fills an offer on a served market it can cover', () => {
    expect(evaluateOfferFill(offer(), policy())).toEqual({ fill: true })
  })

  it('fills asset-for-asset, not just asset-for-BTC', () => {
    // The direction pair the workstream exists for; the offer model carries
    // both legs independently, so nothing about this is a special case.
    const decision = evaluateOfferFill(offer({ wantAssetId: EURC, wantAmount: 100n, offerAssetId: USDT }), policy())
    expect(decision).toEqual({ fill: true })
  })

  it('fills in the reverse direction too — a market is unordered', () => {
    // Same market, maker on the other side. Refusing this would halve the book
    // for no reason the covenant cares about.
    expect(evaluateOfferFill(offer({ wantAssetId: USDT, wantAmount: 100n, offerAssetId: null }), policy())).toEqual({
      fill: true,
    })
  })

  it('refuses a pair we do not serve', () => {
    expect(evaluateOfferFill(offer({ offerAssetId: OTHER }), policy())).toEqual({
      fill: false,
      reason: 'unsupported_pair',
    })
  })

  it('refuses both legs being the same asset', () => {
    // Not a swap. The covenant would still oblige us to pay the want leg, so
    // this has to be refused rather than treated as a no-op.
    expect(evaluateOfferFill(offer({ wantAssetId: USDT, offerAssetId: USDT }), policy())).toEqual({
      fill: false,
      reason: 'degenerate_pair',
    })
  })

  it('refuses BTC-for-BTC as the same degeneracy, not a second reason', () => {
    // `null === null`, so this is caught by the same check as asset-for-itself.
    // An earlier draft gave it its own reason; that member was unreachable,
    // which this test is what found.
    expect(evaluateOfferFill(offer({ wantAssetId: null, offerAssetId: null }), policy())).toEqual({
      fill: false,
      reason: 'degenerate_pair',
    })
  })

  it('refuses an offer that holds nothing', () => {
    // Fillable by its covenant, but it collects nothing — the solver would pay
    // the want leg for zero.
    expect(evaluateOfferFill(offer({ offerAmount: 0n }), policy())).toEqual({
      fill: false,
      reason: 'offer_unfunded',
    })
  })

  it('refuses an amount outside the configured band, at both ends', () => {
    expect(evaluateOfferFill(offer({ wantAmount: 9n }), policy())).toEqual({
      fill: false,
      reason: 'amount_out_of_range',
    })
    expect(evaluateOfferFill(offer({ wantAmount: 100_001n }), policy())).toEqual({
      fill: false,
      reason: 'amount_out_of_range',
    })
  })

  it('accepts exactly at both bounds — they are inclusive', () => {
    expect(evaluateOfferFill(offer({ wantAmount: 10n }), policy())).toEqual({ fill: true })
    expect(evaluateOfferFill(offer({ wantAmount: 100_000n }), policy())).toEqual({ fill: true })
  })

  it('refuses what it cannot cover right now', () => {
    const decision = evaluateOfferFill(offer({ wantAssetId: USDT, wantAmount: 5_001n, offerAssetId: null }), policy())
    expect(decision).toEqual({ fill: false, reason: 'insufficient_inventory' })
  })

  it('treats an asset it holds none of as zero, not as unknown', () => {
    // A market may be served before any inventory arrives. That is a refusal
    // to fill, not a crash and not an accept.
    expect(
      evaluateOfferFill(
        offer({ wantAssetId: USDT, wantAmount: 10n, offerAssetId: null }),
        policy({
          available: new Map<string | null, bigint>([[null, 1_000_000n]]),
        }),
      ),
    ).toEqual({ fill: false, reason: 'insufficient_inventory' })
  })

  it('calls an unfunded offer on an unsupported pair unfunded, not unsupported', () => {
    // The cross-combination, pinned because the ordering is a deliberate choice
    // and not an accident of which `if` came first. An unfunded offer is
    // malformed for EVERY solver; `unsupported_pair` is only true of this
    // one's config. Reporting the config-relative reason would imply the offer
    // might be fillable elsewhere, and invite an operator to "fix" it by
    // widening `markets`.
    const decision = evaluateOfferFill(offer({ offerAssetId: OTHER, offerAmount: 0n }), policy())
    expect(decision).toEqual({ fill: false, reason: 'offer_unfunded' })
  })

  it('refuses everything when the policy band is inverted — the caller owns that', () => {
    // Not validated in `evaluateOfferFill`: it is a pure decision function with
    // no channel to report a config error. The effect of `min > max` is that
    // every offer is refused `amount_out_of_range`, which reads like a quiet
    // market rather than a misconfiguration — so it is pinned here to be at
    // least discoverable, and flagged in the `OfferFillPolicy` docstring.
    const inverted = policy({ minFillAmount: 100n, maxFillAmount: 10n })
    expect(evaluateOfferFill(offer({ wantAmount: 50n }), inverted)).toEqual({
      fill: false,
      reason: 'amount_out_of_range',
    })
  })

  it('reports the most specific reason when several would refuse', () => {
    // Unserved pair AND unaffordable AND out of range. The structural facts are
    // permanent; inventory is the only one worth retrying, so a caller that logs
    // the reason must not be told the retryable one.
    const decision = evaluateOfferFill(
      offer({ wantAssetId: OTHER, wantAmount: 500_000n, offerAssetId: EURC }),
      policy(),
    )
    expect(decision).toEqual({ fill: false, reason: 'unsupported_pair' })
  })
})
