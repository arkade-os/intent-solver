/** The simple market form's arithmetic and column mapping. Pure, so a test can run it without a DOM. */

const STEM_SYMBOL = /^[A-Z][A-Z0-9]{0,11}$/
const MAX_DECIMALS = 36

export const isBtcLeg = (leg) =>
  leg === null || leg === undefined || ['', 'BTC'].includes(String(leg).trim().toUpperCase())

/** Which leg holds the asset: the quote, unless the base is the one that is not BTC. */
export const assetLeg = (draft) => (isBtcLeg(draft.quote) && !isBtcLeg(draft.base) ? 'base' : 'quote')

/** The order-free key a pair is stored under. */
export const pairKey = (base, quote) =>
  [base, quote]
    .map((leg) => `arkade:${isBtcLeg(leg) ? 'btc' : String(leg).trim()}`)
    .sort()
    .join('/')

export const decimalsOf = (value) => {
  const text = String(value ?? '').trim()
  return /^\d+$/.test(text) && Number(text) <= MAX_DECIMALS ? Number(text) : null
}

/** Whole units as typed, in atomic units: '' for blank, null when it is not an amount at these decimals. */
export const toAtomic = (text, decimals) => {
  const typed = String(text ?? '').trim()
  if (typed === '') return ''
  const digits = decimalsOf(decimals)
  const match = /^(\d*)(?:\.(\d*))?$/.exec(typed)
  if (digits === null || !match || typed === '.') return null
  const fraction = (match[2] ?? '').replace(/0+$/, '')
  if (fraction.length > digits) return null
  return BigInt(`${match[1]}${fraction.padEnd(digits, '0')}` || '0').toString()
}

/** Atomic units in whole units, exact and ungrouped so it can go back into an input. Anything else is returned as is. */
export const toHuman = (atomic, decimals) => {
  const raw = String(atomic ?? '').trim()
  const digits = decimalsOf(decimals)
  if (!/^\d+$/.test(raw) || digits === null) return raw
  const padded = raw.padStart(digits + 1, '0')
  const fraction = padded.slice(padded.length - digits).replace(/0+$/, '')
  const whole = BigInt(padded.slice(0, padded.length - digits)).toString()
  return fraction ? `${whole}.${fraction}` : whole
}

/** The symbol the `ASSET_MARKETS` knob gives this asset ("SYM:id, SYM2:id2"), or null. */
export const configSymbol = (knobs, assetId) => {
  const value = String((knobs ?? []).find((knob) => knob.key === 'ASSET_MARKETS')?.value ?? '')
  for (const entry of value.split(',')) {
    const [symbol = '', id] = entry.split(':').map((part) => part.trim())
    if (id === assetId && STEM_SYMBOL.test(symbol)) return symbol
  }
  return null
}

/** The issuer's ticker, only when it already reads as a symbol. */
export const tickerSymbol = (label) => {
  const symbol = String(label?.ticker ?? '')
    .trim()
    .toUpperCase()
  return STEM_SYMBOL.test(symbol) ? symbol : null
}

export const issuerDecimals = (label) => {
  const value = label?.decimals
  return Number.isInteger(value) && value >= 0 && value <= MAX_DECIMALS ? value : null
}

export const carrierModeFor = (charged) => (charged ? 'priced' : 'off')

export const carrierCharged = (mode, chargedByDefault) => mode === 'priced' || (mode === 'inherit' && chargedByDefault)

/**
 * Both directions, the one where the client gives BTC first. `sell_base` is the client giving the BASE, so which
 * columns "BTC → asset" writes depends on the leg the asset sits on. A bound is on the leg the client receives;
 * a flat fee on the leg they give.
 */
export const directions = (draft) => {
  const side = (wire) => {
    const prefix = wire === 'sell_base' ? 'sellBase' : 'buyBase'
    const gives = wire === 'sell_base' ? 'base' : 'quote'
    return {
      wire,
      gives,
      receives: gives === 'base' ? 'quote' : 'base',
      open: wire === 'sell_base' ? 'rfqSellBase' : 'rfqBuyBase',
      bound: prefix,
      min: `${prefix}Min`,
      max: `${prefix}Max`,
      flat: `${prefix}FeeFlat`,
      bps: `${prefix}FeeBps`,
    }
  }
  return assetLeg(draft) === 'base' ? [side('buy_base'), side('sell_base')] : [side('sell_base'), side('buy_base')]
}

/** Open to RFQ with no payout bound: RFQ reads a missing bound as closed, so that direction would quote nothing. */
export const unboundedOpenDirections = (body) =>
  body.enabled === false || body.servesRfq === false
    ? []
    : directions(body).filter((side) => body[side.open] !== false && !body[side.bound])

/** solver-core's `defaultPricePath`, restated because the console cannot import it; a test pins the two together. */
export const derivedPricePath = (feedUrl) => {
  const url = String(feedUrl ?? '').trim()
  if (url.includes('binance')) return '/price'
  let query
  try {
    query = new URL(url).searchParams
  } catch {
    return null
  }
  const ids = query.get('ids')
  const currencies = query.get('vs_currencies')
  return ids && currencies ? `/${ids.split(',')[0]}/${currencies.split(',')[0]}` : null
}

const twoFigures = (amount) => {
  const scale = 10n ** BigInt(Math.max(0, amount.toString().length - 2))
  return (amount / scale) * scale
}

/** A new BTC-base market's limits: 0.0001–0.01 BTC each way, the asset side at the feed price (asset per BTC). */
export const limitDefaults = (feed, assetDecimals) => {
  const digits = decimalsOf(assetDecimals)
  if (digits === null || !/^\d+$/.test(String(feed?.mantissa ?? ''))) return null
  const asset = (sats) =>
    twoFigures((sats * BigInt(feed.mantissa) * 10n ** BigInt(digits)) / (10n ** BigInt(feed.scale) * 10n ** 8n))
  const [min, max] = [asset(10_000n), asset(1_000_000n)]
  return max === 0n
    ? null
    : { btc: { min: '10000', max: '1000000' }, asset: { min: min.toString(), max: max.toString() } }
}
