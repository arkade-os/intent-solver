import { describe, it, expect } from 'vitest'
import { tokenBucket, validOpenRfqPrice, type OpenRfq, type OpenRfqPrice } from '@arkade-os/solver-core/core/openRfq.js'
import { marketKeyForPair } from '@arkade-os/solver-core/core/marketKey.js'
import { RfqOpen } from '@arkade-os/solver-core/core/rfqProtocol.js'

const OPEN_ID = 'a'.repeat(64)
const PAIR = 'arkade:bitcoin/slip44:0~bolt11:bitcoin/slip44:0'
const NOW_MS = 1_800_000_000_000
const NOW_SECONDS = NOW_MS / 1000

const open = (overrides: Partial<OpenRfq> = {}): OpenRfq => ({
  v: 1,
  type: 'rfq_open',
  open_id: OPEN_ID,
  pair: PAIR,
  amount_side: 'to',
  amount: '5000',
  bids_until: NOW_SECONDS + 5,
  ...overrides,
})

const price = (overrides: Partial<OpenRfqPrice> = {}): OpenRfqPrice => ({
  from_amount: '5025',
  to_amount: '5000',
  valid_until: NOW_SECONDS + 30,
  ...overrides,
})

describe('marketKeyForPair', () => {
  it('derives the § 2 canonical key, arkade leg first', () => {
    expect(marketKeyForPair('arkade:BTC->lightning:BTC')).toBe('arkade:btc/lightning:btc')
  })

  it('gives both directions of a market the same key', () => {
    expect(marketKeyForPair('lightning:BTC->arkade:BTC')).toBe('arkade:btc/lightning:btc')
  })

  it('orders both-arkade legs lexicographically', () => {
    expect(marketKeyForPair('arkade:USDT->arkade:BTC')).toBe('arkade:btc/arkade:usdt')
    expect(marketKeyForPair('arkade:BTC->arkade:USDT')).toBe('arkade:btc/arkade:usdt')
  })

  it('orders neither-arkade legs lexicographically', () => {
    expect(marketKeyForPair('onchain:BTC->lightning:BTC')).toBe('lightning:btc/onchain:btc')
    expect(marketKeyForPair('lightning:BTC->onchain:BTC')).toBe('lightning:btc/onchain:btc')
  })

  it('refuses unknown tickers, corridors and malformed pairs loudly', () => {
    expect(() => marketKeyForPair('arkade:DOGE->lightning:BTC')).toThrow(/no canonical asset id/)
    expect(() => marketKeyForPair('liquid:BTC->arkade:BTC')).toThrow(/unknown corridor/)
    expect(() => marketKeyForPair('arkade:btc/lightning:btc')).toThrow(/not a directional pair/)
  })
})

describe('validOpenRfqPrice', () => {
  it('accepts a price that preserves the requested exact side', () => {
    expect(validOpenRfqPrice(open(), price(), NOW_SECONDS)).toBe(true)
    expect(validOpenRfqPrice(open({ amount_side: 'from', amount: '5025' }), price(), NOW_SECONDS)).toBe(true)
  })

  it('compares atomic amounts exactly beyond the JSON safe-integer range', () => {
    const amount = '100000000000000000001'
    const request = open({ amount_side: 'from', amount })
    expect(validOpenRfqPrice(request, price({ from_amount: amount }), NOW_SECONDS)).toBe(true)
    expect(validOpenRfqPrice(request, price({ from_amount: '100000000000000000002' }), NOW_SECONDS)).toBe(false)
    expect(validOpenRfqPrice(open({ amount }), price({ to_amount: amount }), NOW_SECONDS)).toBe(true)
    expect(validOpenRfqPrice(open({ amount }), price({ to_amount: '100000000000000000002' }), NOW_SECONDS)).toBe(false)
  })

  it('rejects either price leg unless it is a bounded canonical positive atomic string', () => {
    for (const amount of ['', '0', '01', '-1', '+1', '1.2', '1e3', ' 1', '1 ', '1'.repeat(129)]) {
      expect(validOpenRfqPrice(open(), price({ from_amount: amount }), NOW_SECONDS)).toBe(false)
      expect(validOpenRfqPrice(open(), price({ to_amount: amount }), NOW_SECONDS)).toBe(false)
    }
    expect(validOpenRfqPrice(open(), price({ from_amount: 5025 as unknown as string }), NOW_SECONDS)).toBe(false)
    expect(validOpenRfqPrice(open(), price({ to_amount: 5000 as unknown as string }), NOW_SECONDS)).toBe(false)
  })

  it('accepts the maximum atomic string length without number conversion', () => {
    const amount = '9'.repeat(128)
    expect(validOpenRfqPrice(open({ amount }), price({ from_amount: amount, to_amount: amount }), NOW_SECONDS)).toBe(
      true,
    )
  })

  it('requires validity strictly after both the current time and collection deadline', () => {
    for (const valid_until of [NOW_SECONDS - 1, NOW_SECONDS, NOW_SECONDS + 5]) {
      expect(validOpenRfqPrice(open(), price({ valid_until }), NOW_SECONDS)).toBe(false)
    }
    expect(validOpenRfqPrice(open(), price({ valid_until: NOW_SECONDS + 6 }), NOW_SECONDS)).toBe(true)
    expect(validOpenRfqPrice(open(), price(), NOW_SECONDS + 30)).toBe(false)
    expect(validOpenRfqPrice(open(), price({ valid_until: NOW_SECONDS + 31 }), NOW_SECONDS + 30)).toBe(true)
  })

  it('rejects fractional, non-finite and unsafe expiry seconds', () => {
    for (const valid_until of [NOW_SECONDS + 30.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(validOpenRfqPrice(open(), price({ valid_until }), NOW_SECONDS)).toBe(false)
    }
  })
})

describe('tokenBucket', () => {
  it('serves its per-minute budget, then refuses until time refills it', () => {
    const bucket = tokenBucket(2, NOW_MS)
    expect(bucket.take(NOW_MS)).toBe(true)
    expect(bucket.take(NOW_MS)).toBe(true)
    expect(bucket.take(NOW_MS)).toBe(false)
    // Half a minute refills one token at 2/min; not before.
    expect(bucket.take(NOW_MS + 29_000)).toBe(false)
    expect(bucket.take(NOW_MS + 30_000)).toBe(true)
  })

  it('caps the burst at one minute of budget however long the quiet spell', () => {
    const bucket = tokenBucket(2, NOW_MS)
    const later = NOW_MS + 3_600_000
    expect(bucket.take(later)).toBe(true)
    expect(bucket.take(later)).toBe(true)
    expect(bucket.take(later)).toBe(false)
  })

  it('does not mint tokens from a clock that goes backwards', () => {
    const bucket = tokenBucket(1, NOW_MS)
    expect(bucket.take(NOW_MS)).toBe(true)
    expect(bucket.take(NOW_MS - 120_000)).toBe(false)
  })

  it('rejects a non-positive or fractional rate', () => {
    expect(() => tokenBucket(0, NOW_MS)).toThrow()
    expect(() => tokenBucket(-1, NOW_MS)).toThrow()
    expect(() => tokenBucket(1.5, NOW_MS)).toThrow()
  })
})

describe('RfqOpen wire schema', () => {
  it('retains version 1 and preserves exact atomic strings for either amount side', () => {
    for (const amount_side of ['from', 'to'] as const) {
      const request = open({ amount_side, amount: '100000000000000000001' })
      expect(RfqOpen.parse(request)).toEqual(request)
    }
    expect(RfqOpen.parse(open({ amount: '1' })).amount).toBe('1')
    expect(RfqOpen.parse(open({ amount: '9'.repeat(128) })).amount).toBe('9'.repeat(128))
  })

  it('rejects numeric, zero, noncanonical and oversized atomic amounts', () => {
    for (const amount of [5000, '', '0', '00', '01', '-1', '+1', '1.2', '1e3', ' 1', '1 ', '1'.repeat(129)]) {
      expect(RfqOpen.safeParse({ ...open(), amount }).success).toBe(false)
    }
  })

  it('requires an exact amount and a collection deadline', () => {
    const { amount: _amount, ...withoutAmount } = open()
    const { bids_until: _deadline, ...withoutDeadline } = open()
    expect(RfqOpen.safeParse(withoutAmount).success).toBe(false)
    expect(RfqOpen.safeParse(withoutDeadline).success).toBe(false)
  })

  it('accepts canonical CAIP asset pairs across supported asset namespaces', () => {
    const asset = `arkade:bitcoin/asset:${'a'.repeat(68)}`
    const token = `eip155:1/erc20:0x${'b'.repeat(40)}`
    for (const pair of [PAIR, `bitcoin:bitcoin/slip44:0~${asset}`, `${asset}~${token}`, `${token}~${asset}`]) {
      expect(RfqOpen.parse(open({ pair })).pair).toBe(pair)
    }
  })

  it('rejects malformed, noncanonical and unbounded pairs', () => {
    for (const pair of [
      'arkade:BTC->lightning:BTC',
      PAIR.toUpperCase(),
      PAIR.replace('~', '->'),
      `${PAIR}~bolt11:bitcoin/slip44:0`,
      `arkade:bitcoin/asset:${'a'.repeat(67)}~bolt11:bitcoin/slip44:0`,
      `arkade:${'a'.repeat(512)}/slip44:0~bolt11:bitcoin/slip44:0`,
    ]) {
      expect(RfqOpen.safeParse(open({ pair })).success).toBe(false)
    }
  })

  it('accepts only positive safe-integer deadline seconds', () => {
    expect(RfqOpen.safeParse(open({ bids_until: 1 })).success).toBe(true)
    expect(RfqOpen.safeParse(open({ bids_until: Number.MAX_SAFE_INTEGER })).success).toBe(true)
    for (const bids_until of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, `${NOW_SECONDS}`]) {
      expect(RfqOpen.safeParse({ ...open(), bids_until }).success).toBe(false)
    }
  })

  it('rejects the old size bucket, unknown fields and version 2', () => {
    expect(RfqOpen.safeParse({ ...open(), size_bucket: { min: 1000, max: 10_000 } }).success).toBe(false)
    const { amount: _amount, ...withoutAmount } = open()
    expect(RfqOpen.safeParse({ ...withoutAmount, size_bucket: { min: '1000', max: '10000' } }).success).toBe(false)
    for (const field of ['invoice', 'refund_address', 'profile', 'surprise']) {
      expect(RfqOpen.safeParse({ ...open(), [field]: 'private' }).success).toBe(false)
    }
    expect(RfqOpen.safeParse({ ...open(), v: 2 }).success).toBe(false)
  })

  it('rejects malformed ids, envelope types and amount sides', () => {
    for (const open_id of ['short', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(65)]) {
      expect(RfqOpen.safeParse(open({ open_id })).success).toBe(false)
    }
    expect(RfqOpen.safeParse({ ...open(), type: 'rfq_request' }).success).toBe(false)
    expect(RfqOpen.safeParse({ ...open(), amount_side: 'both' }).success).toBe(false)
  })
})
