import { describe, it, expect } from 'vitest'
import { hex } from '@scure/base'
import {
  amountSatsOf,
  decodeInvoice,
  expiresAtOf,
  finalCltvBlocksOf,
  paymentHashOf,
  InvalidInvoice,
  MAX_CLIENT_CLTV_BLOCKS,
  MAX_CLIENT_FINAL_CLTV_BLOCKS,
  MAX_INVOICE_LENGTH,
} from '@arkade-os/solver-core/invoice/decode.js'
// Aliased on import, which is the whole point: these two were the same name.
import { MAX_FINAL_CLTV_BLOCKS as RECEIVE_MAX_FINAL_CLTV_BLOCKS } from '@arkade-os/solver-core/core/receive.js'
import { forgeInvoice, forgeInvoiceWithPreimage, type ForgeHop } from '@arkade-os/solver-rails-fake/ln/fake/bolt11.js'

// Real invoices. MAINNET asks 2100 sats; REGTEST asks 2100 sats on bcrt.
const MAINNET =
  'lnbc21u1pnk8larsp526g88ejh9ac0es9j6juxwenzdzvs6hcrphna5pp3jefpukmtk3hqpp5m206npk0fr6k45u8f90capqw48k3pzymlqhk0j98kyx4mz383pkqdz9235x2gr3w45kx6eqvfex7amwypnx77pqdf6k6urnyphhvetjyp6xsefqd3sh57fqv3hkwxqyp2xqcqz95rzjqv9ruzr6quwpsuwmyshlvenk0xm7djrtt8ugt2ja6cx3dkqtccdgvzzxeyqq28qqqqqqqqqqqqqqq9gq2y9qyysgqvu5k5w9q0xe62envhds058r9h8v5uak09hn3uzlw39sqkcuwh34j44gc53j6x6sg0u6yf6l0durxqqekytupxpf66zc7rc9cpav72ssqpcgv3p'
const REGTEST =
  'lnbcrt21u1p5tqtaypp56yzglgfgwsm5pd49996jqvtmpf8fqdk7cq2znnjw5c2j5t8ua38qdql2djkuepqw3hjqs2jfvsxzerywfjhxuccqz95xqztfsp586s5vpsdxt05rm7hr6ycwq5ffmnx2gngv820seugky6j6z2wxqwq9qxpqysgqepuxr82pvlp8lgj7nqu8yp2f5q32323jxddx9qgtjhfhsyzvftgkwx8qv4772fzz46pwyw5ex3u7lf7na8a8403ur3gyeu22gv29rpspefzz2y'

describe('decodeInvoice', () => {
  it('reads the facts the safety gates depend on', () => {
    const decoded = decodeInvoice(MAINNET)
    expect(decoded.amountSats).toBe(2100)
    expect(decoded.network).toBe('bc')
    expect(decoded.paymentHash).toHaveLength(64)
    expect(decoded.expiresAt).toBe(1734606755 + 43200)
    expect(decoded.minFinalCltvBlocks).toBeGreaterThan(0)
  })

  it('distinguishes bcrt from bc', () => {
    // 'lnbc' is a prefix of 'lnbcrt', so a startsWith check would call this
    // mainnet and let a regtest invoice through against real funds.
    expect(decodeInvoice(REGTEST).network).toBe('bcrt')
    expect(decodeInvoice(MAINNET).network).toBe('bc')
  })

  it('returns the exact lowercased string, never a re-encoding', () => {
    expect(decodeInvoice(MAINNET.toUpperCase()).invoice).toBe(MAINNET)
  })

  it('rejects an over-long input before attempting to parse it', () => {
    expect(() => decodeInvoice('lnbc' + 'q'.repeat(MAX_INVOICE_LENGTH))).toThrow(InvalidInvoice)
    try {
      decodeInvoice('lnbc' + 'q'.repeat(MAX_INVOICE_LENGTH))
    } catch (e) {
      expect((e as InvalidInvoice).reason).toBe('too_long')
    }
  })

  it('rejects mixed case, whose bech32 checksum is undefined', () => {
    const mixed = MAINNET.slice(0, 10).toUpperCase() + MAINNET.slice(10)
    try {
      decodeInvoice(mixed)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as InvalidInvoice).reason).toBe('mixed_case')
    }
  })

  it.each([
    ['not an invoice', 'hello world'],
    ['truncated', MAINNET.slice(0, 40)],
    ['empty', ''],
  ])('rejects a %s input with a closed reason', (_label, input) => {
    try {
      decodeInvoice(input)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidInvoice)
      // The decoder's own error text must not reach a client.
      expect((e as InvalidInvoice).message).toMatch(/^invoice rejected: /)
    }
  })

  it('does not leak the invoice in its error message', () => {
    try {
      decodeInvoice('lnbc1notavalidinvoice')
    } catch (e) {
      expect((e as Error).message).not.toContain('notavalidinvoice')
    }
  })
})

describe('route-hint CLTV', () => {
  const forged = (routeHints: readonly (readonly ForgeHop[])[], minFinalCltvBlocks = 18): string =>
    forgeInvoiceWithPreimage({
      network: 'bc',
      amountSats: 2100,
      timestamp: 1_734_606_755,
      expirySeconds: 3600,
      minFinalCltvBlocks,
      routeHints,
    }).invoice

  it('reads the hinted delta off a real invoice', () => {
    // The mainnet fixture carries one `r` field with a single 81-block hop.
    // Ignoring it is what let a client dictate CLTV the deadline never covered.
    // One hint, so best and worst are the same reading of it.
    expect(decodeInvoice(MAINNET).worstRouteHintCltvBlocks).toBe(81)
    expect(decodeInvoice(MAINNET).bestRouteHintCltvBlocks).toBe(81)
  })

  it('is zero on both readings when the invoice carries no hints', () => {
    // The `best` half is the one worth pinning: an unguarded `Infinity` seed
    // would answer Infinity here and refuse every hintless invoice ever sent.
    expect(decodeInvoice(REGTEST).worstRouteHintCltvBlocks).toBe(0)
    expect(decodeInvoice(REGTEST).bestRouteHintCltvBlocks).toBe(0)
  })

  it('sums the hops inside a hint', () => {
    // A hint is a PATH: the payer is bound by every hop in it. And with exactly
    // one hint the best IS that sum — a 0-seeded min would answer 0 here, which
    // is the bug that turns the floor below into no bound at all.
    expect(decodeInvoice(forged([[40, 30, 20]])).worstRouteHintCltvBlocks).toBe(90)
    expect(decodeInvoice(forged([[40, 30, 20]])).bestRouteHintCltvBlocks).toBe(90)
  })

  it('reports both the worst and the best hint, since the payer picks one', () => {
    // The two are what the two-tier bound is taken over: `worst` is what a rail
    // that cannot steer may be made to pay, `best` what any rail could.
    const decoded = decodeInvoice(forged([[40, 30], [150]]))
    expect(decoded.worstRouteHintCltvBlocks).toBe(150)
    expect(decoded.bestRouteHintCltvBlocks).toBe(70)
  })

  it('refuses an invoice whose client-controlled CLTV exceeds the cap', () => {
    // The attack this closes, and the reason it is not covered by
    // MAX_CLIENT_FINAL_CLTV_BLOCKS: the final delta is inside the cap, but the hint
    // pushes the total past what any route budget reserves. On a backend that
    // cannot enforce a ceiling this becomes an HTLC outliving the refund.
    expect(() => decodeInvoice(forged([[MAX_CLIENT_CLTV_BLOCKS]]))).toThrow(InvalidInvoice)
    try {
      decodeInvoice(forged([[MAX_CLIENT_CLTV_BLOCKS]]))
    } catch (e) {
      expect((e as InvalidInvoice).reason).toBe('cltv_too_large')
    }
  })

  it('accepts a total exactly at the cap', () => {
    const hint = MAX_CLIENT_CLTV_BLOCKS - 18
    expect(decodeInvoice(forged([[hint]])).worstRouteHintCltvBlocks).toBe(hint)
  })

  it('bounds the floor on the BEST hint, so a bad alternative alone does not refuse', () => {
    // The Wallet of Satoshi shape: hints of [40] and [40000], final delta 60.
    // The worst reading is hopeless and the best is ordinary, and hints are
    // ALTERNATIVES — so this is an invoice every real payer settles. Refusing it
    // here would put it out of reach of an LND deployment that can decline the
    // bad route; whether THIS deployment can is `evaluateSendAcceptance`'s call.
    const decoded = decodeInvoice(forged([[40], [40_000]], 60))
    expect(decoded.bestRouteHintCltvBlocks).toBe(40)
    expect(decoded.worstRouteHintCltvBlocks).toBe(40_000)
  })

  it('still refuses when even the best hint blows the cap', () => {
    // No alternative to steer to, so no backend can serve it and the refusal
    // needs no backend knowledge. Order the hints worst-first: the floor must
    // read the min, not the first or the last.
    try {
      decodeInvoice(forged([[MAX_CLIENT_CLTV_BLOCKS], [MAX_CLIENT_CLTV_BLOCKS - 10]], 60))
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as InvalidInvoice).reason).toBe('cltv_too_large')
      // #196's convention, and now also which of the two gates fired.
      expect((e as InvalidInvoice).message).toContain('best route hint 278')
      expect((e as InvalidInvoice).message).toContain('best-hint floor')
    }
  })
})

/**
 * The scid denylist: hints an operator has confirmed cannot route.
 *
 * The motivating invoice is the Wallet of Satoshi one above, whose `[40000]`
 * hint is one alternative among several — payable by every real payer, refused
 * by this solver on a rail that cannot cap the route it picks. Where that hint
 * names a channel that cannot route, its CLTV was being priced into a refund
 * deadline against a route nobody can take, and dropping it is not a bound
 * being lifted but a fiction being removed from the set the bounds are taken
 * over.
 *
 * "Cannot route" is an OPERATOR's claim, established off-list (see
 * `LN_SEND_HINT_SCID_DENYLIST` and docs/runbook.md) and never inferred from the
 * scid itself: a hint may carry an `option_scid_alias`, which BOLT #2 requires
 * to be unrelated to any real `short_channel_id`. These tests are about what
 * the filter DOES with such a list, not about which scids belong on one — the
 * values below are fixtures, not verdicts.
 *
 * The filter lives here, in the backend-blind layer, rather than in the
 * acceptance gate: a dropped hint is a fact about the INVOICE, and a deployment
 * that filtered only at acceptance would still quote a ten-month deadline on
 * LND.
 */
describe('the route-hint scid denylist', () => {
  const DENIED = 'aaaaaaaaaaaaaaaa'
  const KEPT = '0102030405060708'
  const denylist = new Set([DENIED])

  const forged = (routeHints: readonly (readonly ForgeHop[])[], minFinalCltvBlocks = 18): string =>
    forgeInvoiceWithPreimage({
      network: 'bc',
      amountSats: 2100,
      timestamp: 1_734_606_755,
      expirySeconds: 3600,
      minFinalCltvBlocks,
      routeHints,
    }).invoice

  it('drops the denylisted hint and prices the ones that survive', () => {
    // The WoS shape, now with the scids that tell the two hints apart. Both
    // totals collapse onto the 40, because the 40000 was never a route.
    const invoice = forged([[{ cltv: 40, scid: KEPT }], [{ cltv: 40_000, scid: DENIED }]], 60)
    const decoded = decodeInvoice(invoice, denylist)
    expect(decoded.worstRouteHintCltvBlocks).toBe(40)
    expect(decoded.bestRouteHintCltvBlocks).toBe(40)
  })

  it('changes nothing without a denylist, whether empty or omitted', () => {
    // The inert case, which is every deployment that sets no knob: the same
    // invoice reads exactly as it did before the filter existed.
    const invoice = forged([[{ cltv: 40, scid: KEPT }], [{ cltv: 40_000, scid: DENIED }]], 60)
    for (const decoded of [decodeInvoice(invoice), decodeInvoice(invoice, new Set())]) {
      expect(decoded.worstRouteHintCltvBlocks).toBe(40_000)
      expect(decoded.bestRouteHintCltvBlocks).toBe(40)
      expect(decoded.droppedHints).toBeUndefined()
    }
  })

  it('drops the WHOLE hint when any one of its hops is denylisted', () => {
    // A hint is a PATH. Dropping the bad hop and keeping its neighbours would
    // leave a route as fictional as the one being removed — and it would price
    // 30 + 20 blocks nobody can travel. The unit is the hint.
    const decoded = decodeInvoice(forged([[40, { cltv: 30, scid: DENIED }, 20], [{ cltv: 25, scid: KEPT }]]), denylist)
    expect(decoded.worstRouteHintCltvBlocks).toBe(25)
    expect(decoded.bestRouteHintCltvBlocks).toBe(25)
    expect(decoded.droppedHints).toEqual([{ scid: DENIED, cltv: 90 }])
  })

  it('reads 0 on both when every hint is dropped, which is the no-hints case', () => {
    // An invoice whose only hint is unroutable is one a payer routes to WITHOUT
    // hints, so 0 is the honest reading rather than a bound going missing. The
    // floor below is what makes this observable: raw, the 40000 blows it.
    const invoice = forged([[{ cltv: 40_000, scid: DENIED }]], 60)
    expect(() => decodeInvoice(invoice)).toThrow(InvalidInvoice)

    const decoded = decodeInvoice(invoice, denylist)
    expect(decoded.worstRouteHintCltvBlocks).toBe(0)
    expect(decoded.bestRouteHintCltvBlocks).toBe(0)
  })

  it('still refuses when a SURVIVING hint blows the floor', () => {
    // The filter narrows what is priced; it does not soften what is priced.
    // The denylisted hint goes, the 300-block one stays, and the floor fires on
    // it exactly as it would have without a denylist.
    try {
      decodeInvoice(forged([[{ cltv: 40_000, scid: DENIED }], [{ cltv: 300, scid: KEPT }]]), denylist)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as InvalidInvoice).reason).toBe('cltv_too_large')
      expect((e as InvalidInvoice).message).toContain('best route hint 300')
    }
  })

  it('reports what it dropped, so the filter is visible in a log', () => {
    // A denylist that changes what we price without saying so cannot be audited
    // after the fact: the entry is in an env var and the effect is a number
    // inside a refund deadline.
    const decoded = decodeInvoice(forged([[{ cltv: 40, scid: KEPT }], [{ cltv: 40_000, scid: DENIED }]], 60), denylist)
    expect(decoded.droppedHints).toEqual([{ scid: DENIED, cltv: 40_000 }])
  })

  it('leaves an invoice carrying none of the listed channels alone', () => {
    const decoded = decodeInvoice(
      forged([[{ cltv: 40, scid: KEPT }], [{ cltv: 90, scid: '9999999999999999' }]]),
      denylist,
    )
    expect(decoded.worstRouteHintCltvBlocks).toBe(90)
    expect(decoded.droppedHints).toBeUndefined()
  })
})

/**
 * The readers that answer ONE field off an invoice this solver has already
 * accepted, without re-running the send leg's ceilings.
 *
 * They exist because those two decodes can now disagree. A hint the denylist
 * removed is still in the raw string, so a row whose every hint was dropped
 * reads `best = 0` on the path that accepted it and the raw hint's total to
 * anyone who decodes it again — and the callers here decode `row.invoice` after
 * the money has been committed. `decodeInvoice` there would throw
 * `cltv_too_large` inside `payInvoice`, on a funded row, which is a stuck swap.
 */
describe('paymentHashOf / amountSatsOf — the already-accepted readers', () => {
  const deniedOnly = forgeInvoiceWithPreimage({
    network: 'bc',
    amountSats: 2100,
    timestamp: 1_734_606_755,
    expirySeconds: 3600,
    minFinalCltvBlocks: 60,
    routeHints: [[{ cltv: 40_000, scid: 'aaaaaaaaaaaaaaaa' }]],
  })

  it('agrees with decodeInvoice wherever decodeInvoice will answer', () => {
    const decoded = decodeInvoice(MAINNET)
    expect(paymentHashOf(MAINNET)).toBe(decoded.paymentHash)
    expect(amountSatsOf(MAINNET)).toBe(decoded.amountSats)
  })

  it('answers for a row the denylist made payable, where a raw decode throws', () => {
    // The regression: this invoice is accepted with the denylist set, so a row
    // holds it — and `submitPayment` -> the LND adapter, and the RFQ quote
    // payload, both read it back.
    expect(() => decodeInvoice(deniedOnly.invoice)).toThrow(/cltv_too_large/)
    expect(paymentHashOf(deniedOnly.invoice)).toBe(hex.encode(deniedOnly.paymentHash))
    expect(amountSatsOf(deniedOnly.invoice)).toBe(2100)
  })

  it('still refuses input that is not an invoice at all', () => {
    // Narrow is not credulous: the parsing defences are exactly the ones that
    // are about parsing, and each reader validates its own field.
    expect(() => paymentHashOf('lnbc1notavalidinvoice')).toThrow(InvalidInvoice)
    expect(() => amountSatsOf('lnbc1notavalidinvoice')).toThrow(InvalidInvoice)
    expect(() => paymentHashOf('lnbc' + 'q'.repeat(MAX_INVOICE_LENGTH))).toThrow(/too_long/)
  })
})

/**
 * `finalCltvBlocksOf` — the reader for invoices THIS SOLVER minted.
 *
 * The ceilings in `decodeInvoice` are send-leg protections: they bound what a
 * CLIENT's invoice may demand of us, because a delta outliving our refund
 * deadline is the double-collect window. On the receive leg the invoice is
 * ours, we are the payee, and a longer delta only pushes `E` later — which
 * every gate in `core/receive.ts` wants rather than fears.
 *
 * The mainnet privacy wrapper mints 420 blocks against a 288 ceiling, so
 * running those defences over our own invoice threw `cltv_too_large` on every
 * receive quote. These pin that this reader does not.
 */
/**
 * The reader for invoices this solver MINTS, whose defining property is that
 * they carry no amount — so the one thing that matters is that it answers where
 * {@link decodeInvoice} refuses.
 */
describe('expiresAtOf', () => {
  const TIMESTAMP = 1_734_606_755

  const amountless = (expirySeconds: number): string =>
    forgeInvoice({
      network: 'bcrt',
      paymentHash: new Uint8Array(32).fill(7),
      timestamp: TIMESTAMP,
      expirySeconds,
    })

  it('reads an AMOUNTLESS invoice, which decodeInvoice refuses outright', () => {
    // The bug this exists for. A deposit invoice names no amount on purpose, and
    // reading its expiry through `decodeInvoice` threw `missing_amount` on every
    // one ever minted — so the Lightning deposit option never appeared.
    const invoice = amountless(900)

    expect(() => decodeInvoice(invoice)).toThrow(/missing_amount/)
    expect(expiresAtOf(invoice)).toBe(TIMESTAMP + 900)
  })

  it('agrees with decodeInvoice wherever decodeInvoice will answer', () => {
    // Not a second parser — the same value, minus the refusals that do not apply
    // to an invoice we minted ourselves.
    for (const expirySeconds of [60, 900, 1800, 3600]) {
      const invoice = forgeInvoice({
        network: 'bcrt',
        amountSats: 50_000,
        paymentHash: new Uint8Array(32).fill(7),
        timestamp: TIMESTAMP,
        expirySeconds,
      })
      expect(expiresAtOf(invoice)).toBe(decodeInvoice(invoice).expiresAt)
    }
  })

  it('refuses a string that is not an invoice rather than answering NaN', () => {
    // `undefined + 3600` is `NaN`, and a console counting down from a non-number
    // is the exact failure this whole path was written to prevent.
    expect(() => expiresAtOf('not-an-invoice')).toThrow(InvalidInvoice)
    expect(() => expiresAtOf('x'.repeat(MAX_INVOICE_LENGTH + 1))).toThrow(/too_long/)
  })
})

describe('finalCltvBlocksOf', () => {
  const withCltv = (blocks: number): string =>
    forgeInvoice({
      network: 'bcrt',
      amountSats: 50_000,
      paymentHash: new Uint8Array(32).fill(7),
      timestamp: 1_734_606_755,
      expirySeconds: 1800,
      minFinalCltvBlocks: blocks,
    })

  it('reads a delta the send-leg ceiling would refuse', () => {
    // 420 is what the live mainnet wrapper actually mints, and 288 is the
    // ceiling that rejected it. This is the regression, at its real value.
    const invoice = withCltv(420)
    expect(finalCltvBlocksOf(invoice)).toBe(420)
    expect(() => decodeInvoice(invoice)).toThrow(/cltv_too_large/)
  })

  it('agrees with decodeInvoice wherever decodeInvoice will answer', () => {
    // Not a different parser — the same value, minus the refusals. If these ever
    // disagree, one of them is reading the wrong tag.
    for (const blocks of [18, 40, 60, 144, 288]) {
      const invoice = withCltv(blocks)
      expect(finalCltvBlocksOf(invoice)).toBe(decodeInvoice(invoice).minFinalCltvBlocks)
    }
  })

  it('returns BOLT11’s default when the invoice carries no c tag', () => {
    // An absent tag is a real 18, not "unknown" — and 18 is below everything
    // this corridor needs, so reading it as absent would silently pass a check
    // that should refuse.
    const noTag = forgeInvoice({
      network: 'bcrt',
      amountSats: 50_000,
      paymentHash: new Uint8Array(32).fill(7),
      timestamp: 1_734_606_755,
      expirySeconds: 1800,
    })
    expect(finalCltvBlocksOf(noTag)).toBe(18)
  })

  it('still refuses input it cannot parse, rather than inventing a number', () => {
    expect(() => finalCltvBlocksOf('not-an-invoice')).toThrow(/malformed/)
    expect(() => finalCltvBlocksOf('x'.repeat(MAX_INVOICE_LENGTH + 1))).toThrow(/too_long/)
  })
})

/**
 * The two CLTV ceilings in this codebase are different quantities, and until a
 * rename they shared the name `MAX_FINAL_CLTV_BLOCKS`.
 *
 * This one caps a CLIENT's invoice — what we are willing to PAY, protecting the
 * solver from an HTLC outliving its own refund deadline. `core/receive.ts`'s
 * caps an invoice WE mint, protecting the corridor from asking for a delta no
 * stock payer will route. Opposite directions, 288 against 2016.
 *
 * Pinned as a test rather than left to the comment because the confusion has
 * already cost real time: reading 2016 and applying it here made a 420-block
 * invoice look acceptable to a check that refuses anything over 288.
 */
describe('the two CLTV ceilings are not the same bound', () => {
  it('the client-invoice ceiling is the stricter one, and they must not converge', () => {
    expect(MAX_CLIENT_FINAL_CLTV_BLOCKS).toBeLessThan(RECEIVE_MAX_FINAL_CLTV_BLOCKS)
  })

  it('the receive ceiling is LND’s own max-cltv-expiry, which is why it is larger', () => {
    // 2016 is not a number this repo chose — it is the default a stock payer
    // refuses beyond, so an invoice we mint above it is simply unpayable. The
    // client-side bound is a risk decision (~2 days) and owes nothing to it.
    expect(RECEIVE_MAX_FINAL_CLTV_BLOCKS).toBe(2016)
    expect(MAX_CLIENT_FINAL_CLTV_BLOCKS).toBe(288)
  })
})

/**
 * Which ceiling fired, and by how much.
 *
 * TWO separate bounds raise `cltv_too_large`, and on 2026-08-21 a mainnet send
 * was refused with no way to tell them apart from the log. The distinction is
 * the whole decision: a 500-block final delta is an unusual payee and refusing
 * it is correct, while 18 plus a 400-block route hint is the shape an ordinary
 * LSP-backed wallet produces and an argument that the bound is too tight for
 * real invoices.
 *
 * The closed reason is unchanged either way. The numbers ride in the message,
 * which every catch site puts in a log `detail` while answering the client from
 * the enum — so no bound and no value can reach a client.
 */
describe('cltv_too_large says WHICH ceiling and by how much', () => {
  const forge = (minFinalCltvBlocks: number, routeHints: readonly (readonly number[])[] = []): string =>
    forgeInvoiceWithPreimage({
      network: 'bc',
      amountSats: 2100,
      timestamp: 1_734_606_755,
      expirySeconds: 3600,
      minFinalCltvBlocks,
      routeHints,
    }).invoice

  const rejectionOf = (invoice: string): InvalidInvoice => {
    try {
      decodeInvoice(invoice)
      return expect.unreachable('expected a rejection') as never
    } catch (error) {
      return error as InvalidInvoice
    }
  }

  it('keeps the closed reason for both ceilings', () => {
    expect(rejectionOf(forge(MAX_CLIENT_FINAL_CLTV_BLOCKS + 1)).reason).toBe('cltv_too_large')
    expect(rejectionOf(forge(18, [[MAX_CLIENT_CLTV_BLOCKS]])).reason).toBe('cltv_too_large')
  })

  it('names the final delta and its bound when the `c` field alone is too big', () => {
    const { message } = rejectionOf(forge(MAX_CLIENT_FINAL_CLTV_BLOCKS + 1))
    expect(message).toContain(`final delta ${MAX_CLIENT_FINAL_CLTV_BLOCKS + 1}`)
    expect(message).toContain(String(MAX_CLIENT_FINAL_CLTV_BLOCKS))
  })

  it('shows the sum when a route hint is what pushes it over', () => {
    const { message } = rejectionOf(forge(18, [[MAX_CLIENT_CLTV_BLOCKS]]))
    expect(message).toContain('route hint')
    expect(message).toContain(String(MAX_CLIENT_CLTV_BLOCKS))
    // The operator needs the total, not just the parts, to see the margin.
    expect(message).toContain(String(18 + MAX_CLIENT_CLTV_BLOCKS))
  })

  it('tells the two apart, which is the whole reason this exists', () => {
    expect(rejectionOf(forge(MAX_CLIENT_FINAL_CLTV_BLOCKS + 1)).message).not.toBe(
      rejectionOf(forge(18, [[MAX_CLIENT_CLTV_BLOCKS]])).message,
    )
  })
})
