import { describe, it, expect } from 'vitest'

import { ASSET_ID_HEX_LENGTH, MAX_PAIR_LENGTH, marketKeyForPair } from '@arkade-os/solver-core/core/marketKey.js'
import { RfqRequest } from '@arkade-os/solver-corridors/wire/payloads.js'

/** A well-formed Arkade asset id: 64 hex of txid, then 4 of the u16 group index. */
const assetId = (txidNibble: string, gidx = '0000'): string => txidNibble.repeat(64) + gidx

const ASSET = assetId('a')
const OTHER_ASSET = assetId('f')

describe('marketKeyForPair — registered tickers', () => {
  it('resolves a ticker through the registry, arkade leg first', () => {
    expect(marketKeyForPair('arkade:BTC->lightning:BTC')).toBe('arkade:btc/lightning:btc')
    expect(marketKeyForPair('lightning:BTC->arkade:BTC')).toBe('arkade:btc/lightning:btc')
  })

  it('still rejects a ticker that is not registered', () => {
    expect(() => marketKeyForPair('arkade:XYZ->lightning:BTC')).toThrow(/no canonical asset id for ticker/)
  })
})

describe('marketKeyForPair — Arkade asset ids', () => {
  it('accepts a literal asset id on the arkade corridor and resolves it to itself', () => {
    // No registry entry exists for this asset and none is needed: the id is
    // already canonical. This is the case that threw before — every Arkade
    // asset pair was unnameable.
    expect(marketKeyForPair(`arkade:${ASSET}->lightning:BTC`)).toBe(`arkade:${ASSET}/lightning:btc`)
  })

  it('puts the arkade leg first regardless of direction', () => {
    const key = `arkade:${ASSET}/lightning:btc`
    expect(marketKeyForPair(`arkade:${ASSET}->lightning:BTC`)).toBe(key)
    expect(marketKeyForPair(`lightning:BTC->arkade:${ASSET}`)).toBe(key)
  })

  it('refuses an upper-case asset id rather than normalising it', () => {
    // Hex is case-insensitive, so accepting either spelling and lowercasing it
    // looks like the friendly choice. It is the dangerous one. `pair` is
    // compared byte for byte elsewhere — `decideOpenRfqBid` tests `open.pair
    // !== servedPair` — so an upper-case pair normalised only here would
    // derive the correct market key, reach our subscription, and then be
    // skipped as "unserved pair". Refusing at the edge keeps the layers from
    // disagreeing, and § 2's identity rule (`^(btc|[0-9a-f]{68})$`) already
    // says lowercase.
    expect(() => marketKeyForPair(`arkade:${ASSET.toUpperCase()}->lightning:BTC`)).toThrow(
      /no canonical asset id for ticker/,
    )
  })

  it('refuses an asset id on a corridor where it means nothing', () => {
    // Not a pedantic check. `ethereum:<arkade asset id>` is well-formed and
    // would yield a perfectly valid-looking market key that no counterparty
    // could ever subscribe to.
    for (const corridor of ['lightning', 'onchain', 'ethereum']) {
      expect(() => marketKeyForPair(`${corridor}:${ASSET}->arkade:BTC`)).toThrow(
        /only meaningful on the arkade corridor/,
      )
    }
  })

  it('refuses a 68-character string that is not hex', () => {
    // `[A-Za-z0-9]+` in the pair regex admits letters past `f`, so length alone
    // is not enough to call something an asset id.
    const notHex = 'z'.repeat(68)
    expect(notHex).toHaveLength(ASSET_ID_HEX_LENGTH)
    expect(() => marketKeyForPair(`arkade:${notHex}->lightning:BTC`)).toThrow(/no canonical asset id for ticker/)
  })

  it('refuses an asset id of the wrong length', () => {
    for (const wrong of ['a'.repeat(67), 'a'.repeat(69), 'a'.repeat(64)]) {
      expect(() => marketKeyForPair(`arkade:${wrong}->lightning:BTC`)).toThrow(/no canonical asset id for ticker/)
    }
  })

  it('orders two asset legs deterministically, both directions agreeing', () => {
    // Asset-to-asset is the case workstream B is for. Both sides must derive
    // the same tag from opposite-facing pair strings.
    expect(marketKeyForPair(`arkade:${ASSET}->arkade:${OTHER_ASSET}`)).toBe(
      marketKeyForPair(`arkade:${OTHER_ASSET}->arkade:${ASSET}`),
    )
    expect(marketKeyForPair(`arkade:${ASSET}->arkade:${OTHER_ASSET}`)).toBe(`arkade:${ASSET}/arkade:${OTHER_ASSET}`)
  })

  it('orders an asset against arkade BTC deterministically', () => {
    expect(marketKeyForPair(`arkade:${ASSET}->arkade:BTC`)).toBe(marketKeyForPair(`arkade:BTC->arkade:${ASSET}`))
  })

  it('does not let an asset id shadow a registered ticker', () => {
    // The registry is checked first. Nothing 68 characters long is in it
    // today, but the precedence is the point: explicit config wins over a
    // shape match.
    expect(marketKeyForPair('arkade:BTC->lightning:BTC')).toBe('arkade:btc/lightning:btc')
  })
})

describe('MAX_PAIR_LENGTH', () => {
  it('covers the longest pair that can legally be named', () => {
    // Asset ids are arkade-only, so this — 152 characters — is the real
    // maximum a `marketKeyForPair` caller can produce.
    const longest = `arkade:${ASSET}->arkade:${OTHER_ASSET}`
    expect(longest).toHaveLength(152)
    expect(() => marketKeyForPair(longest)).not.toThrow()
    expect(longest.length).toBeLessThanOrEqual(MAX_PAIR_LENGTH)
  })

  it('is derived from the vocabulary, so it over-covers the legal maximum on purpose', () => {
    // The bound is the longest string the VOCABULARY can spell — longest
    // corridor name plus a full asset id, twice — which is 158, six more than
    // any legal pair. `lightning:<asset id>` is a string of that length and is
    // NOT a nameable pair, so the slack is real rather than an oversight.
    expect(() => marketKeyForPair(`lightning:${ASSET}->lightning:${OTHER_ASSET}`)).toThrow(
      /only meaningful on the arkade corridor/,
    )
    expect(MAX_PAIR_LENGTH).toBe(158)
    // Deriving rather than writing 152 down is what keeps a longer corridor
    // name, or a later decision to allow asset ids elsewhere, from silently
    // outgrowing the schema.
    expect(MAX_PAIR_LENGTH).toBeGreaterThan(`arkade:${ASSET}->arkade:${OTHER_ASSET}`.length)
  })

  it('admits the asset-to-asset pair the old flat bound of 100 rejected', () => {
    const pair = `arkade:${ASSET}->arkade:${OTHER_ASSET}`
    expect(pair.length).toBeGreaterThan(100)
    expect(pair.length).toBeLessThanOrEqual(MAX_PAIR_LENGTH)
  })
})

describe('the RFQ schema accepts an asset pair', () => {
  // The derivation and the wire bound are separate layers, and either one
  // alone leaves assets unnameable: a pair the schema rejects never reaches
  // the code that would derive its key.
  const request = (pair: string) => ({
    v: 1 as const,
    type: 'rfq_request' as const,
    rfq_id: 'a'.repeat(64),
    pair,
    amount_side: 'from' as const,
    profile: { invoice: 'lnbc1', refund_address: 'ark1qexample', client_refund_pubkey: 'b'.repeat(64) },
  })

  /** Errors on the `pair` field only — so a pass or a failure cannot come from elsewhere in the payload. */
  const pairErrors = (pair: string): string[] =>
    (RfqRequest.safeParse(request(pair)).error?.issues ?? [])
      .filter((issue) => issue.path[0] === 'pair')
      .map((issue) => issue.message)

  it('parses an asset-to-asset pair', () => {
    expect(RfqRequest.safeParse(request(`arkade:${ASSET}->arkade:${OTHER_ASSET}`))).toMatchObject({ success: true })
  })

  it('still rejects a pair beyond the bound', () => {
    expect(pairErrors('a'.repeat(MAX_PAIR_LENGTH + 1))).toHaveLength(1)
    // And the rest of the payload is what makes that meaningful: at the bound
    // itself there is no complaint about `pair` at all.
    expect(pairErrors('a'.repeat(MAX_PAIR_LENGTH))).toEqual([])
  })
})
