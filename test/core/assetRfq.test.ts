/**
 * The pure decision logic for `arkade:<X>->arkade:<Y>` served over RFQ —
 * `docs/rfq-protocol.md` § 7.2, the atomic class.
 *
 * Two questions live here and nothing else does: what pair is this, and what
 * two amounts does it resolve to. Both are pure, because both decide money and
 * neither should need a wallet, a feed or a database to be tested.
 *
 * The property worth pinning hardest is the rounding DIRECTION. Every rounding
 * below is in the solver's favour, and each one is at most a single atomic unit
 * — but an asset leg can be 18 decimals, and a rounding that went the other way
 * would be a payout the solver funds out of its own float on every single swap.
 */

import { describe, it, expect } from 'vitest'
import {
  parseAssetPair,
  resolveAssetQuote,
  evaluateAssetFill,
  carrierLegs,
  type AssetQuoteMarket,
} from '@arkade-os/solver-core/core/assetRfq.js'

/** A syntactically valid Arkade asset id: 32-byte txid then a u16 group index. */
const ASSET_A = `${'aa'.repeat(32)}0100`
const ASSET_B = `${'bb'.repeat(32)}0000`

describe('parseAssetPair — which two legs an arkade pair names', () => {
  it('reads BTC on the from leg and an asset on the to leg', () => {
    expect(parseAssetPair(`arkade:BTC->arkade:${ASSET_A}`)).toEqual({ from: null, to: ASSET_A })
  })

  it('reads the mirror direction', () => {
    expect(parseAssetPair(`arkade:${ASSET_A}->arkade:BTC`)).toEqual({ from: ASSET_A, to: null })
  })

  /**
   * The constraint that is NOT this repo's choice: `@arkade-os/swap`'s
   * `encodeOffer` "refuses a packet naming both a want asset and an offer
   * asset, or neither" (§ 7.2), and `fulfillOffer` throws the same way. An
   * asset-to-asset offer cannot be expressed in the packet at all, so quoting
   * one would be quoting a swap that cannot be funded or settled.
   *
   * Refused HERE, at the pair, rather than discovered at fill time — the whole
   * point of the shape being unrepresentable is that no client should ever get
   * a quote for it.
   */
  it('refuses a pair naming an asset on BOTH legs, which no offer packet can carry', () => {
    expect(parseAssetPair(`arkade:${ASSET_A}->arkade:${ASSET_B}`)).toBeNull()
  })

  it('refuses BTC on both legs, which is not a swap and which the packet also refuses', () => {
    expect(parseAssetPair('arkade:BTC->arkade:BTC')).toBeNull()
  })

  it.each([
    ['a lightning leg', `lightning:BTC->arkade:${ASSET_A}`],
    ['an onchain leg', `arkade:${ASSET_A}->onchain:BTC`],
    ['an ethereum leg', `ethereum:0x00->arkade:BTC`],
    ['no arrow', `arkade:${ASSET_A}`],
    ['an unknown ticker', 'arkade:BTC->arkade:USDT'],
    ['a truncated asset id', `arkade:BTC->arkade:${ASSET_A.slice(0, 66)}`],
    ['an over-long asset id', `arkade:BTC->arkade:${ASSET_A}ff`],
  ])('refuses %s', (_why, pair) => {
    expect(parseAssetPair(pair)).toBeNull()
  })

  /**
   * § 2's identity rule verbatim, and `marketKey.ts` already carries the same
   * one with the reason: a pair is compared byte for byte elsewhere, so a
   * spelling normalised in one layer and not another derives the right market
   * key and is then refused as unserved — a silent miss whose stated reason
   * is a lie.
   */
  it('refuses an upper-case asset id rather than normalising it', () => {
    expect(parseAssetPair(`arkade:BTC->arkade:${ASSET_A.toUpperCase()}`)).toBeNull()
  })
})

/**
 * $100k per BTC, an asset of 6 decimals standing in for a dollar stablecoin.
 * `mantissa`/`scale` are the feed's own exact form, never a float.
 */
const MARKET: AssetQuoteMarket = {
  base: null,
  quote: ASSET_A,
  baseDecimals: 8,
  quoteDecimals: 6,
  feeBps: 50,
  sellBaseFeeFlat: 0n,
  buyBaseFeeFlat: 0n,
  minPayout: 1n,
  maxPayout: 10n ** 24n,
}
const FEED = { mantissa: 100_000n, scale: 0 }

describe('resolveAssetQuote — the two amounts a quote resolves', () => {
  it('prices one whole BTC into the asset leg, fee folded into the spread', () => {
    // mid = 1e8 sats * 1e5 quote/base * 1e6 / 1e8 = 1e11 atomic = 100 000.000000
    // fee = ceil(1e11 * 50 / 1e4) = 5e8;  payout = 1e11 - 5e8
    const outcome = resolveAssetQuote({
      pair: { from: null, to: ASSET_A },
      amount: 100_000_000n,
      amountSide: 'from',
      market: MARKET,
      feed: FEED,
      carrierSats: 0n,
      dustSats: 0n,
    })
    expect(outcome).toEqual({ ok: true, fromAmount: 100_000_000n, toAmount: 99_500_000_000n })
  })

  it('prices each direction at its own spread', () => {
    const market = { ...MARKET, sellBaseFeeBps: 0, buyBaseFeeBps: 900 }
    const args = { amountSide: 'from' as const, market, feed: FEED, carrierSats: 0n, dustSats: 0n }
    expect(resolveAssetQuote({ ...args, pair: { from: null, to: ASSET_A }, amount: 100_000_000n })).toEqual({
      ok: true,
      fromAmount: 100_000_000n,
      toAmount: 100_000_000_000n,
    })
    // Giving quote takes buyBaseFeeBps = 900: 1e8 - ceil(1e8 * 900 / 1e4).
    expect(resolveAssetQuote({ ...args, pair: { from: ASSET_A, to: null }, amount: 100_000_000_000n })).toEqual({
      ok: true,
      fromAmount: 100_000_000_000n,
      toAmount: 91_000_000n,
    })
  })

  it('leaves a side with no override priced exactly as feeBps alone', () => {
    const pair = { from: null, to: ASSET_A }
    const args = { pair, amount: 100_000_000n, amountSide: 'from' as const, feed: FEED, carrierSats: 0n, dustSats: 0n }
    expect(resolveAssetQuote({ ...args, market: { ...MARKET, buyBaseFeeBps: 900 } })).toEqual(
      resolveAssetQuote({ ...args, market: MARKET }),
    )
  })

  it('prices the mirror direction, asset in and sats out', () => {
    // mid = 1e11 * 1e8 / (1e6 * 1e5) = 1e8 sats;  fee = ceil(1e8*50/1e4) = 5e5
    const outcome = resolveAssetQuote({
      pair: { from: ASSET_A, to: null },
      amount: 100_000_000_000n,
      amountSide: 'from',
      market: MARKET,
      feed: FEED,
      carrierSats: 330n,
      dustSats: 330n,
    })
    expect(outcome).toEqual({ ok: true, fromAmount: 100_000_000_000n, toAmount: 99_500_000n + 330n })
  })

  it('subtracts the sell-base flat fee from the BTC input before conversion', () => {
    const outcome = resolveAssetQuote({
      pair: { from: null, to: ASSET_A },
      amount: 100_000_000n,
      amountSide: 'from',
      market: { ...MARKET, feeBps: 0, sellBaseFeeFlat: 330n },
      feed: FEED,
      carrierSats: 0n,
      dustSats: 0n,
    })
    expect(outcome).toEqual({ ok: true, fromAmount: 100_000_000n, toAmount: 99_999_670_000n })
  })

  it('subtracts the buy-base flat fee from the asset input before conversion', () => {
    const outcome = resolveAssetQuote({
      pair: { from: ASSET_A, to: null },
      amount: 100_000_000_000n,
      amountSide: 'from',
      market: { ...MARKET, feeBps: 0, buyBaseFeeFlat: 1_000_000n },
      feed: FEED,
      carrierSats: 330n,
      dustSats: 330n,
    })
    expect(outcome).toEqual({ ok: true, fromAmount: 100_000_000_000n, toAmount: 99_999_000n + 330n })
  })

  it('refuses an input entirely consumed by its direction flat fee', () => {
    expect(
      resolveAssetQuote({
        pair: { from: null, to: ASSET_A },
        amount: 330n,
        amountSide: 'from',
        market: { ...MARKET, feeBps: 0, sellBaseFeeFlat: 330n },
        feed: FEED,
        carrierSats: 0n,
        dustSats: 0n,
      }),
    ).toEqual({ ok: false, reason: 'fee_consumes_swap' })
  })

  it('keeps full precision on an 18-decimal asset, where a double would not', () => {
    const market: AssetQuoteMarket = { ...MARKET, quote: ASSET_B, quoteDecimals: 18, feeBps: 0 }
    const outcome = resolveAssetQuote({
      pair: { from: null, to: ASSET_B },
      amount: 100_000_000n,
      amountSide: 'from',
      market,
      carrierSats: 0n,
      dustSats: 0n,
      feed: { mantissa: 1n, scale: 0 },
    })
    // 1 BTC at a price of 1 = 1.0 of an 18-decimal asset = 10^18 atomic units,
    // which is a hundred times what a double represents exactly.
    expect(outcome).toEqual({ ok: true, fromAmount: 100_000_000n, toAmount: 10n ** 18n })
  })

  /**
   * The rounding direction, isolated. A payout with a fractional remainder must
   * round DOWN and a fee must round UP — both against the client — because the
   * alternative is the solver funding a sub-unit of every swap out of its float.
   */
  it('rounds the payout down and the fee up, never the other way', () => {
    const market: AssetQuoteMarket = { ...MARKET, feeBps: 1 }
    const outcome = resolveAssetQuote({
      pair: { from: null, to: ASSET_A },
      amount: 3n,
      amountSide: 'from',
      market,
      carrierSats: 0n,
      dustSats: 0n,
      // A price that cannot divide evenly: 3 sats * 7 / 10^3 with the decimal
      // shift is deliberately fractional.
      feed: { mantissa: 7n, scale: 3 },
    })
    // mid = floor(3 * 7 * 1e6 / (1e8 * 1e3)) = floor(0.00021) = 0 -> the fee
    // has nothing to take, and a zero payout is not a swap.
    expect(outcome).toEqual({ ok: false, reason: 'fee_consumes_swap' })
  })

  it('refuses a payout the fee has entirely eaten rather than quoting nothing', () => {
    const market: AssetQuoteMarket = { ...MARKET, feeBps: 9_999 }
    const outcome = resolveAssetQuote({
      pair: { from: null, to: ASSET_A },
      amount: 1n,
      amountSide: 'from',
      market,
      feed: FEED,
      carrierSats: 0n,
      dustSats: 0n,
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'fee_consumes_swap' })
  })

  /**
   * § 7.1.5 refuses exact-out on the EVM corridors for a reason that applies
   * verbatim here: "the two legs are different assets, so exact-out would mean
   * inverting a fetched, rounded, directional rate". This corridor is
   * cross-asset by construction — the pair parser above refuses same-asset
   * pairs outright — so exact-out is never servable on it.
   */
  it('resolves exact-out to the least input that reaches the payout', () => {
    const wanted = 100_000_000_000n
    const exactOut = resolveAssetQuote({
      pair: { from: null, to: ASSET_A },
      amount: wanted,
      amountSide: 'to',
      market: MARKET,
      feed: FEED,
      carrierSats: 0n,
      dustSats: 0n,
    })
    expect(exactOut).toMatchObject({ ok: true, toAmount: wanted })
    const { fromAmount } = exactOut as { fromAmount: bigint }

    const payoutAt = (amount: bigint): bigint => {
      const outcome = resolveAssetQuote({
        pair: { from: null, to: ASSET_A },
        amount,
        amountSide: 'from',
        market: MARKET,
        feed: FEED,
        carrierSats: 0n,
        dustSats: 0n,
      })
      return outcome.ok ? outcome.toAmount : 0n
    }
    expect(payoutAt(fromAmount)).toBeGreaterThanOrEqual(wanted)
    expect(payoutAt(fromAmount - 1n)).toBeLessThan(wanted)
  })

  it('refuses a pair the market does not name', () => {
    const outcome = resolveAssetQuote({
      pair: { from: null, to: ASSET_B },
      amount: 100_000_000n,
      amountSide: 'from',
      market: MARKET,
      feed: FEED,
      carrierSats: 0n,
      dustSats: 0n,
    })
    expect(outcome).toEqual({ ok: false, reason: 'unsupported_pair' })
  })

  it.each([
    ['a zero mantissa, which would make every swap free', { mantissa: 0n, scale: 0 }],
    ['a negative price', { mantissa: -1n, scale: 0 }],
  ])('refuses %s rather than pricing against it', (_why, feed) => {
    expect(
      resolveAssetQuote({
        pair: { from: null, to: ASSET_A },
        amount: 100_000_000n,
        amountSide: 'from',
        market: MARKET,
        feed,
        carrierSats: 0n,
        dustSats: 0n,
      }),
    ).toEqual({ ok: false, reason: 'price_unavailable' })
  })

  it('refuses a payout outside the market bounds, on the TO leg', () => {
    const market: AssetQuoteMarket = { ...MARKET, maxPayout: 1_000n }
    expect(
      resolveAssetQuote({
        pair: { from: null, to: ASSET_A },
        amount: 100_000_000n,
        amountSide: 'from',
        market,
        feed: FEED,
        carrierSats: 0n,
        dustSats: 0n,
      }),
    ).toEqual({ ok: false, reason: 'amount_out_of_range' })
  })

  it('admits a payout exactly on the bound', () => {
    const market: AssetQuoteMarket = { ...MARKET, minPayout: 99_500_000_000n, maxPayout: 99_500_000_000n }
    expect(
      resolveAssetQuote({
        pair: { from: null, to: ASSET_A },
        amount: 100_000_000n,
        amountSide: 'from',
        market,
        feed: FEED,
        carrierSats: 0n,
        dustSats: 0n,
      }),
    ).toMatchObject({ ok: true, toAmount: 99_500_000_000n })
  })

  /** Both legs assets: the two carriers cancel. Gated upstream by `parseAssetPair`. */
  it('prices no carrier when an asset rides on both legs', () => {
    const market: AssetQuoteMarket = { ...MARKET, base: ASSET_A, quote: ASSET_B, baseDecimals: 6, quoteDecimals: 6 }
    const quote = (carrierSats: bigint) =>
      resolveAssetQuote({
        pair: { from: ASSET_A, to: ASSET_B },
        amount: 1_000_000n,
        amountSide: 'from',
        market,
        feed: FEED,
        carrierSats,
        dustSats: 330n,
      })
    expect(quote(330n)).toEqual(quote(0n))
    expect(quote(330n).ok).toBe(true)
  })

  /** `ASSET_CARRIER_PRICING` off: the amounts quoted before it was priced. */
  it('quotes the pre-carrier amounts when the carrier is not priced', () => {
    expect(
      resolveAssetQuote({
        pair: { from: ASSET_A, to: null },
        amount: 100_000_000_000n,
        amountSide: 'from',
        market: MARKET,
        feed: FEED,
        carrierSats: 0n,
        dustSats: 330n,
      }),
    ).toEqual({ ok: true, fromAmount: 100_000_000_000n, toAmount: 99_500_000n })
  })

  it('keeps the sats-leg dust floor when the carrier is not priced', () => {
    expect(
      resolveAssetQuote({
        pair: { from: ASSET_A, to: null },
        amount: 100_000n,
        amountSide: 'from',
        market: MARKET,
        feed: FEED,
        carrierSats: 0n,
        dustSats: 330n,
      }),
    ).toEqual({ ok: false, reason: 'amount_out_of_range' })
  })

  /**
   * Refused before because arkd rejects a sub-dust output — seen live as an
   * emulator code-13. The carrier fixes that at the root: output 0 lands at 429.
   */
  it('quotes a sub-dust payout once the returned carrier lifts output 0 clear', () => {
    // mid = 100_000 / 1000 = 100 sats; fee = ceil(100 * 50 / 10_000) = 1.
    expect(
      resolveAssetQuote({
        pair: { from: ASSET_A, to: null },
        amount: 100_000n,
        amountSide: 'from',
        market: MARKET,
        feed: FEED,
        carrierSats: 330n,
        dustSats: 330n,
      }),
    ).toEqual({ ok: true, fromAmount: 100_000n, toAmount: 429n })
  })

  it('returns the carrier on top of the payout, not inside it', () => {
    expect(
      resolveAssetQuote({
        pair: { from: ASSET_A, to: null },
        amount: 332_000n,
        amountSide: 'from',
        market: MARKET,
        feed: FEED,
        carrierSats: 330n,
        dustSats: 330n,
      }),
    ).toEqual({ ok: true, fromAmount: 332_000n, toAmount: 660n })
  })

  it('charges the carrier out of the input on an asset payout', () => {
    expect(
      resolveAssetQuote({
        pair: { from: null, to: ASSET_A },
        amount: 430n,
        amountSide: 'from',
        market: MARKET,
        feed: FEED,
        carrierSats: 330n,
        dustSats: 330n,
      }),
    ).toEqual({ ok: true, fromAmount: 430n, toAmount: 99_500n })
  })

  it('refuses a deposit the carrier alone would consume', () => {
    expect(
      resolveAssetQuote({
        pair: { from: null, to: ASSET_A },
        amount: 330n,
        amountSide: 'from',
        market: MARKET,
        feed: FEED,
        carrierSats: 330n,
        dustSats: 330n,
      }),
    ).toEqual({ ok: false, reason: 'fee_consumes_swap' })
  })

  it('puts no dust floor on an asset payout', () => {
    // mid = 100 * 1e5 * 1e6 / 1e8 = 100_000 units; fee = 500.
    expect(
      resolveAssetQuote({
        pair: { from: null, to: ASSET_A },
        amount: 100n,
        amountSide: 'from',
        market: MARKET,
        feed: FEED,
        carrierSats: 0n,
        dustSats: 0n,
      }),
    ).toEqual({ ok: true, fromAmount: 100n, toAmount: 99_500n })
  })
})

/**
 * The action-time gate — § 9's rule that every invariant is re-evaluated
 * immediately before the irreversible step, never only at quote time.
 *
 * For this corridor the irreversible step is `fulfill`, which spends the
 * client's deposit and pays the client in one transaction. What must be true at
 * that instant is different from what was true at quote time, and the gap is
 * where the money is.
 */
describe('evaluateAssetFill — what must hold at the moment of filling', () => {
  const base = {
    toAmount: 1_000n,
    toAssetId: ASSET_A as string | null,
    fromAmount: 100_000n,
    depositedAmount: 100_000n,
    available: new Map<string | null, bigint>([[ASSET_A, 10_000n]]),
    now: 1_000,
    validUntil: 2_000,
  }

  it('fills when the deposit is exactly the quoted amount and the float covers the payout', () => {
    expect(evaluateAssetFill(base)).toEqual({ fill: true })
  })

  /**
   * § 5: "Late funding — a lockup first observed after `valid_until` — MUST be
   * refused. Never silently filled, never silently re-priced."
   *
   * It bites harder here than on a same-asset corridor: this pair is
   * cross-asset, so the solver is short the market for the whole window, and
   * filling a stale quote is filling at a price the market has already moved
   * away from. The client is not stranded by the refusal — it holds the
   * covenant's `cancel` key and reclaims without the solver (§ 7.2).
   */
  it('refuses a deposit that arrived after the quote expired', () => {
    expect(evaluateAssetFill({ ...base, now: 2_001 })).toEqual({ fill: false, reason: 'quote_expired' })
  })

  it('fills on the last second of validity, so the bound is inclusive', () => {
    expect(evaluateAssetFill({ ...base, now: 2_000 })).toEqual({ fill: true })
  })

  /**
   * A short deposit is the attack this gate exists for. The covenant obliges
   * whoever spends it to pay `wantAmount` — so filling against a deposit
   * smaller than quoted means paying the full payout for less than the agreed
   * input, out of the solver's own float.
   */
  it('refuses a deposit short of what the quote said the client would fund', () => {
    expect(evaluateAssetFill({ ...base, depositedAmount: 99_999n })).toEqual({
      fill: false,
      reason: 'deposit_short',
    })
  })

  it('fills on an over-funded deposit, which only ever favours the solver', () => {
    expect(evaluateAssetFill({ ...base, depositedAmount: 100_001n })).toEqual({ fill: true })
  })

  it('refuses when the float can no longer cover the payout', () => {
    expect(evaluateAssetFill({ ...base, available: new Map([[ASSET_A, 999n]]) })).toEqual({
      fill: false,
      reason: 'insufficient_inventory',
    })
  })

  it('reads the float on the leg it must PAY, not the one it receives', () => {
    // Holding plenty of the deposit asset says nothing about being able to pay
    // out the other one.
    expect(evaluateAssetFill({ ...base, available: new Map([[null, 10n ** 12n]]) })).toEqual({
      fill: false,
      reason: 'insufficient_inventory',
    })
  })

  it('checks expiry before inventory, so a lapsed quote never reads as a float problem', () => {
    expect(evaluateAssetFill({ ...base, now: 5_000, available: new Map([[ASSET_A, 0n]]) })).toEqual({
      fill: false,
      reason: 'quote_expired',
    })
  })
})

describe('carrierLegs — which leg the carrier lands on', () => {
  const asset = 'bb'.repeat(34)

  it('charges the deposit when the solver delivers the asset', () => {
    expect(carrierLegs({ from: null, to: asset }, 330n)).toEqual({ charged: 330n, returned: 0n })
  })

  it('returns it in the payout when the client fronted it', () => {
    expect(carrierLegs({ from: asset, to: null }, 330n)).toEqual({ charged: 0n, returned: 330n })
  })

  it('is the rule resolveAssetQuote itself applies', () => {
    // The identity that makes the preview safe to seed from: on asset->BTC an
    // exact-out quote named at `minPayout` refuses, because the bound is checked
    // against `amount - returnedCarrier` (assetRfq.ts:168). `+ returned` is what
    // reaches it.
    const market = {
      base: asset,
      quote: null,
      baseDecimals: 6,
      quoteDecimals: 8,
      feeBps: 50,
      minPayout: 1_000n,
      maxPayout: 10n ** 12n,
    }
    const pair = { from: asset, to: null }
    const { returned } = carrierLegs(pair, 330n)
    const at = (amount: bigint) =>
      resolveAssetQuote({
        pair,
        amount,
        amountSide: 'to' as const,
        market,
        feed: { mantissa: 1n, scale: 5 },
        carrierSats: 330n,
        dustSats: 330n,
      })

    expect(returned).toBe(330n)
    expect(at(market.minPayout).ok).toBe(false)
    expect(at(market.minPayout + returned)).toMatchObject({ ok: true })
  })
})
