/**
 * The wire encoding for an amount.
 *
 * `docs/rfq-protocol.md` § 2.1: every amount is atomic units of one named
 * asset, encoded as a canonical decimal STRING. JSON numbers are IEEE-754
 * doubles in every mainstream parser, so they are exact only to 2^53 - 1 - and
 * for an 18-decimal asset that ceiling is 0.009 tokens. A quote for one whole
 * USDT would be rounded inside `JSON.parse`, before any validator here could
 * see it.
 *
 * WHAT THIS MODULE LANDS, AND WHAT IT DOES NOT. It lands the ENCODING: a
 * conforming client may now send the string form, and a value this process
 * cannot represent exactly is REFUSED rather than silently rounded. It does not
 * yet land the RANGE. Every amount downstream of here - `Limits`, the fee
 * arithmetic in `core/corridorPolicy.ts`, `amount_sats` in four tables - is a
 * `number`, so an amount above `Number.MAX_SAFE_INTEGER` still cannot be
 * carried and is refused by name. Widening those to bigint is a separate
 * change; this one is what lets clients migrate their encoding first, and turns
 * the silent failure into a loud one in the meantime.
 *
 * The refusal is the point. Today a client sending 1e18 gets a rounded amount
 * that quotes, settles, and moves the wrong money. After this it gets
 * `unsupported_payload`.
 */

import { z } from 'zod'

/**
 * § 2.1's canonical form: ASCII digits, no sign, no point, no exponent, and no
 * leading zero unless the value is exactly "0".
 *
 * Anchored, so `"1e18"` and `"1.5"` and `" 42"` are refused rather than
 * partially matched. Exponent notation especially: `1e-8` and `1E-8` and `1e+8`
 * are three spellings a sender might reach for, and quietly reading any of them
 * wrong misprices by eight orders of magnitude.
 */
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/

/**
 * An amount on the wire, in atomic units.
 *
 * Accepts the § 2.1 string form, and - for `v: 1` backward compatibility - a
 * JSON number, but ONLY where that number is provably lossless: a non-negative
 * safe integer. § 2.1 also bounds the number form to assets of 8 decimals or
 * fewer; that half cannot be checked here because this schema does not know
 * which leg it is validating, and it is enforced where the pair is resolved.
 *
 * Positive, not merely non-negative: a zero amount is not a swap. The canonical
 * form admits "0" because it is the encoding for the number zero in general;
 * an amount field rejects it.
 */
export const WIRE_AMOUNT = z
  .union([z.string(), z.number()])
  .superRefine((value, ctx) => {
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'amount must be a canonical decimal string; a JSON number is accepted only when it is a safe integer',
        })
        return
      }
      if (value <= 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'amount must be positive' })
      }
      return
    }
    if (!CANONICAL_DECIMAL.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'amount must be a canonical decimal string of atomic units (no sign, point or exponent)',
      })
      return
    }
    // Refused, not rounded. This is the range this process cannot yet carry -
    // see the module docstring. Named explicitly so the refusal is actionable
    // rather than looking like a malformed-input rejection.
    if (BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `amount ${value} exceeds what this solver can represent exactly (${Number.MAX_SAFE_INTEGER})`,
      })
      return
    }
    if (BigInt(value) <= 0n) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'amount must be positive' })
    }
  })
  .transform((value) => (typeof value === 'number' ? value : Number(value)))
