/**
 * The wire encoding for an amount — `docs/rfq-protocol.md` § 2.1.
 *
 * The property that matters: an amount this solver cannot represent exactly is
 * REFUSED, never rounded. Today a client sending 1e18 gets a rounded figure
 * that quotes, settles, and moves the wrong money; after this it gets a
 * refusal it can act on.
 */

import { describe, it, expect } from 'vitest'
import { WIRE_AMOUNT, WIRE_ASSET_AMOUNT } from '@arkade-os/solver-core/core/wireAmount.js'

const parse = (value: unknown) => WIRE_AMOUNT.safeParse(value)

describe('the § 2.1 string form', () => {
  it('accepts a canonical decimal string', () => {
    expect(parse('50000')).toMatchObject({ success: true, data: 50000 })
  })

  it('reads the same value from either encoding', () => {
    // Both forms must land on one number, or the corridor prices the same
    // request two ways depending on how the client spelled it.
    expect(parse('50000').data).toBe(parse(50000).data)
  })

  it.each([
    ['a fraction', '1.5'],
    ['exponent notation, which has three spellings and one wrong guess is 8 orders out', '1e18'],
    ['upper-case exponent', '1E18'],
    ['a signed value', '+50000'],
    ['a negative', '-1'],
    ['a leading zero', '0100'],
    ['surrounding whitespace', ' 50000 '],
    ['an empty string', ''],
    ['hex', '0x10'],
    ['a thousands separator', '50,000'],
  ])('refuses %s', (_why, value) => {
    expect(parse(value).success).toBe(false)
  })

  it('refuses zero, because a zero amount is not a swap', () => {
    // "0" IS canonical for the number zero; an amount field still rejects it.
    expect(parse('0').success).toBe(false)
  })
})

describe('the v1 JSON-number form', () => {
  it('accepts a safe integer, so existing clients keep working', () => {
    expect(parse(2_100)).toMatchObject({ success: true, data: 2_100 })
  })

  it('refuses zero and negatives', () => {
    expect(parse(0).success).toBe(false)
    expect(parse(-1).success).toBe(false)
  })

  it('refuses a fractional number', () => {
    expect(parse(1.5).success).toBe(false)
  })

  it('refuses EVERY value past the safe range, even after JSON rounded it', () => {
    // The subtle one. JSON.parse rounds before this validator ever runs, so it
    // is fair to ask whether a rounded value could masquerade as valid. It
    // cannot: integers above 2^53 - 1 are representable only as even doubles,
    // so every one of them fails isSafeInteger whichever way it rounded.
    // Below the boundary, safe integers are exact and nothing rounds at all.
    expect(parse(Number.MAX_SAFE_INTEGER)).toMatchObject({ success: true })
    expect(parse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false)
    expect(parse(1e18).success).toBe(false)
    // 2^53 + 1 arrives here already rounded down to 2^53 - and 2^53 is itself
    // outside the safe range, so it is still caught.
    expect(parse(9007199254740993).success).toBe(false)
  })
})

describe('the range this solver cannot yet carry', () => {
  it('refuses a string above the safe integer range, and says why', () => {
    // This is the half § 2.1 specifies that the implementation does not yet
    // reach: every amount downstream is a `number`. Refused BY NAME so the
    // failure is actionable rather than looking like malformed input.
    const result = parse('1000000000000000000')
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toMatch(/exceeds what this solver can represent exactly/)
  })

  it('accepts exactly the largest value it can represent', () => {
    expect(parse(String(Number.MAX_SAFE_INTEGER))).toMatchObject({
      success: true,
      data: Number.MAX_SAFE_INTEGER,
    })
  })

  it('refuses one atomic unit above it', () => {
    expect(parse(String(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).success).toBe(false)
  })

  it('does not lose a digit on the largest accepted value', () => {
    // A string routed through the wrong parse would come back rounded. This
    // pins the boundary value exactly rather than approximately.
    expect(parse(String(Number.MAX_SAFE_INTEGER)).data).toBe(9007199254740991)
  })
})

describe('types this field is not', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a boolean', true],
    ['an object', { amount: 1 }],
    ['an array', [1]],
  ])('refuses %s', (_why, value) => {
    expect(parse(value).success).toBe(false)
  })
})

/**
 * The ASSET form of the same field — `docs/rfq-protocol.md` § 2.1 without the
 * `Number.MAX_SAFE_INTEGER` ceiling.
 *
 * {@link WIRE_AMOUNT} refuses anything above that ceiling on purpose: its own
 * docstring says it "lands the ENCODING, not the RANGE", because every amount
 * downstream of it — `Limits`, the fee arithmetic, `amount_sats` in four
 * tables — is a `number`. That is true of the four BTC corridors and false of
 * an Arkade ASSET leg, where the amount is a `bigint` end to end: `Offer.wantAmount`
 * is one, `evaluateOfferFill` compares them, and `offer_fill` already persists
 * them as TEXT for exactly this reason.
 *
 * So this is the same canonical grammar with the ceiling removed and the value
 * preserved as a bigint. Rejecting the ceiling here would refuse an ordinary
 * amount of an 18-decimal asset — 1.0 of one is 10^18, a hundred times the
 * ceiling — which is the misprice § 2.1 exists to prevent, arriving as a
 * refusal instead of a rounding.
 */
describe('WIRE_ASSET_AMOUNT — the same grammar, carried as a bigint', () => {
  const assetParse = (value: unknown) => WIRE_ASSET_AMOUNT.safeParse(value)

  it('keeps a value far above what a double represents exactly', () => {
    // 10^18 — one whole unit of an 18-decimal asset, and the § 2.1 worked example.
    expect(assetParse('1000000000000000000')).toMatchObject({ success: true, data: 10n ** 18n })
  })

  it('does not lose a digit anywhere in that range', () => {
    // The digit that a double would eat. `1e18 + 1` is indistinguishable from
    // `1e18` as a Number, so this is the assertion that would fail if the
    // schema ever routed through one.
    expect(assetParse('1000000000000000001').data).toBe(1000000000000000001n)
  })

  it('accepts a value the sats schema refuses, and agrees below the ceiling', () => {
    const beyond = String(BigInt(Number.MAX_SAFE_INTEGER) + 1n)
    expect(parse(beyond).success).toBe(false)
    expect(assetParse(beyond).success).toBe(true)
    expect(assetParse('50000').data).toBe(50000n)
  })

  it.each([
    ['a fraction', '1.5'],
    ['exponent notation', '1e18'],
    ['a signed value', '+50000'],
    ['a negative', '-1'],
    ['a leading zero', '0100'],
    ['surrounding whitespace', ' 50000 '],
    ['an empty string', ''],
    ['zero, which is not a swap', '0'],
  ])('refuses %s, exactly as the sats form does', (_why, value) => {
    expect(assetParse(value).success).toBe(false)
  })

  it('refuses a JSON number outright, unlike the sats form', () => {
    // The § 2.1 backward-compatibility carve-out is bounded to assets of 8
    // decimals or fewer. This schema is reached only for an ASSET leg, whose
    // precision is fixed by its own genesis and is not knowable here, so the
    // one encoding that cannot be checked for losslessness is refused rather
    // than guessed at. A new corridor has no legacy client to keep.
    expect(assetParse(50000).success).toBe(false)
    expect(parse(50000).success).toBe(true)
  })
})
