/**
 * The § 2 corridor/asset vocabulary and the canonical market key
 * (docs/rfq-protocol.md § 2) — wire-contract data, in one place: the market
 * key is the on-wire subscription tag both sides of § 4.6 must derive
 * identically, and the asset ids are the ones the registry card publishes.
 * Drift between this table and a published card is a subscription that
 * silently misses every open RFQ.
 */

/** The § 2 corridor registry. A pair naming anything else is a config error. */
const CORRIDORS = new Set(['arkade', 'lightning', 'onchain', 'ethereum'])

/**
 * An Arkade asset id on the wire: `txid` (32 bytes) then `gidx` (u16), hex —
 * the `serializeAssetId` form. 68 characters.
 *
 * LOWERCASE ONLY, § 2's identity rule verbatim (`^(btc|[0-9a-f]{68})$`). Hex is
 * case-insensitive, so normalising here is tempting — and wrong, because
 * `decideOpenRfqBid` compares `open.pair !== servedPair` byte for byte. An upper-case
 * pair would then derive the RIGHT market key, arrive at our subscription, and be
 * skipped as "unserved pair": a silent miss whose stated reason is a lie.
 */
const ASSET_ID_HEX = /^[0-9a-f]{68}$/
export const ASSET_ID_HEX_LENGTH = 68

/**
 * The longest pair string the wire can be asked to carry, derived rather than
 * guessed: two legs at the longest corridor name plus a full asset id, and the
 * arrow between them.
 *
 * Derived because the number is not obvious and the failure is silent: a flat bound of
 * 100 fits every ticker pair but not `arkade:<asset>->arkade:<asset>` at 152
 * characters, so an asset-to-asset RFQ would be rejected as malformed at the schema,
 * before any code could refuse it for a readable reason.
 */
const LONGEST_CORRIDOR = Math.max(...[...CORRIDORS].map((corridor) => corridor.length))
export const MAX_PAIR_LENGTH = (LONGEST_CORRIDOR + ':'.length + ASSET_ID_HEX_LENGTH) * 2 + '->'.length

/** The § 2 asset registry: ticker → canonical id plus card metadata. */
export const ASSETS: Record<string, { id: string; name: string; decimals: number }> = {
  BTC: { id: 'btc', name: 'Bitcoin', decimals: 8 },
  USDT: { id: 'usdt', name: 'Tether USD', decimals: 6 },
  USDC: { id: 'usdc', name: 'USD Coin', decimals: 6 },
  DePix: { id: 'depix', name: 'DePix', decimals: 8 },
}

/**
 * The canonical corridor-qualified market key for a directional pair string —
 * the § 2 derivation: legs as `<corridor>:<asset-id>`, arkade leg first when
 * exactly one leg is arkade, lexicographic otherwise.
 * `arkade:BTC->lightning:BTC` → `arkade:btc/lightning:btc`.
 *
 * A leg's asset is either a **registered ticker** from the table above or, on the
 * arkade corridor only, a **literal Arkade asset id** — which resolves to itself
 * rather than through the registry, so there is no table to keep in sync.
 *
 * Throws on anything unrecognised: this runs at startup on our own configured pair, and
 * a solver subscribed under a misderived key silently misses every open RFQ.
 */
export const marketKeyForPair = (pair: string): string => {
  const match = /^([a-z]+):([A-Za-z0-9]+)->([a-z]+):([A-Za-z0-9]+)$/.exec(pair)
  if (!match) throw new Error(`not a directional pair string: ${JSON.stringify(pair)}`)
  const leg = (corridor: string, ticker: string): string => {
    if (!CORRIDORS.has(corridor)) throw new Error(`unknown corridor ${corridor} in pair ${pair}`)
    // A registered ticker wins. The registry is explicit operator-facing
    // config; the asset-id form below is the open-ended fallback, so a name
    // someone put in the table can never be shadowed by one that merely
    // matches a shape.
    const asset = ASSETS[ticker]
    if (asset) return `${corridor}:${asset.id}`
    // An Arkade asset id is already canonical and globally unique, so it needs no
    // registry entry — but it means nothing on another corridor, where accepting it
    // would mint a well-formed market key nobody subscribes to.
    if (ASSET_ID_HEX.test(ticker)) {
      if (corridor !== 'arkade')
        throw new Error(`asset id is only meaningful on the arkade corridor, not ${corridor}, in pair ${pair}`)
      return `${corridor}:${ticker}`
    }
    throw new Error(`no canonical asset id for ticker ${ticker} in pair ${pair}`)
  }
  const from = leg(match[1]!, match[2]!)
  const to = leg(match[3]!, match[4]!)
  // The spec rule, literally: arkade first when exactly one leg is arkade.
  // (Today plain lexicographic ordering would coincide — every other corridor
  // sorts after "arkade" — but the explicit branch stays correct if one ever
  // does not.)
  const fromArkade = match[1] === 'arkade'
  const toArkade = match[3] === 'arkade'
  if (fromArkade !== toArkade) return fromArkade ? `${from}/${to}` : `${to}/${from}`
  return from <= to ? `${from}/${to}` : `${to}/${from}`
}
