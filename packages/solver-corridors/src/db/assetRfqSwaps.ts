/**
 * Durable state for an `arkade:<X>->arkade:<Y>` NEGOTIATION — the atomic class
 * reached over RFQ (`docs/rfq-protocol.md` § 7.2).
 *
 * Distinct from `db/offerFills.ts`, which is the same settlement reached the
 * other way, and the difference is exactly one of ORDER. That store's natural
 * key is the funded outpoint, because on the packet path an offer is only ever
 * discovered after it exists on chain. Here the negotiation comes FIRST: a row
 * is written when terms are quoted, before anything is funded and possibly
 * before anything ever is. A store keyed on an outpoint cannot hold that row.
 *
 * WHAT THE ROW IS FOR, and it is not bookkeeping. The quote commits this solver
 * to a price for `valid_until`, and the client accepts by funding an offer
 * covenant that BOTH SIDES DERIVE from those terms. So the row is the only
 * record of which address this solver promised to watch and at what price — and
 * `offer_pk_script` is what a deposit is later recognised by. Lose the row and
 * a client's funded offer is one this solver has no reason to fill.
 *
 * Lifecycle, forward-only:
 *
 * - `quoted`   terms issued; awaiting the client's deposit until `valid_until`
 * - `funded`   a deposit matching the quoted terms is at the offer's script;
 *              NOTHING submitted, and no solver capital is committed yet
 * - `filling`  `fulfill` submitted — the one EXPOSED state
 * - `filled`   the fill landed; the client is paid and the deposit is ours
 * - `refused`  declined, the quote lapsed unfunded, or (only via
 *              `refuseNeverSubmittedCarrierAttempt`) a carrier fill durably
 *              proven never submitted; no exposure ever existed
 * - `stuck`    `fulfill` failed or its outcome is unknown; needs a human
 *
 * THERE IS NO `refunded` STATE, and its absence is the point. § 7.2's refund is
 * `cancel`, "a 2-of-2 of the funder and the Arkade Service" — no solver
 * signature is involved, so reclaiming an unfilled deposit is something the
 * CLIENT does and this solver cannot do on its behalf. A lapsed quote therefore
 * ends `refused` here while the deposit, if any, remains the client's to
 * withdraw. Recording it as `refunded` would claim an action this solver never
 * took and cannot take.
 */

import { betterSqliteDriver, type SqlDriver } from './driver.js'
import {
  decodeCarrierAttempt,
  decodeCarrierAttemptOrNull,
  detachJsonObject,
  encodeCarrierAttempt,
  type CarrierAttempt,
} from './carrierAttempt.js'
import { pageQuery, takePage, type PageOptions, type PageRawFields } from '@arkade-os/solver-core/core/page.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import { clampLedgerLimit, type LedgerWindow } from '@arkade-os/solver-core/analytics/economics.js'

export type AssetRfqSwapState = 'quoted' | 'funded' | 'filling' | 'filled' | 'refused' | 'stuck'

/** The carrier terms a NEGOTIATION was issued under, when the client named a
 * mode. Absent on every legacy row. IMMUTABLE: these are the Taxi obligation
 * the fill adapter must honour, and `loanSats` is never in the price. */
export interface AssetRfqCarrierTerms {
  mode: 'purchase' | 'recycle'
  /** Present on `recycle` only: the Taxi quote these terms were read from. */
  quoteId?: string
  physicalSats: bigint
  /** Always `0` on a purchase: bought sats are owned outright, not advanced. */
  loanSats: bigint
  receiptSats: bigint
  serviceFareSats: bigint
  /** What the PRICE actually netted for this carrier — not `physicalSats`. */
  pricedSats: bigint
  expiresAt: number
}

export const NON_TERMINAL: readonly AssetRfqSwapState[] = ['quoted', 'funded', 'filling']

/**
 * The one state where this solver's own capital is committed and not yet
 * recovered.
 *
 * Only `filling`. Before it nothing has been submitted; after it the fill has
 * landed, and `fulfill` pays the client and takes the deposit in the SAME
 * transaction — so there is no interval where the payout is gone and the
 * deposit is not yet ours. `quoted` and `funded` hold no exposure at all: the
 * money at the offer address is the CLIENT's until a fill spends it.
 */
export const EXPOSED: readonly AssetRfqSwapState[] = ['filling']

const LEGAL_EDGES: Record<AssetRfqSwapState, readonly AssetRfqSwapState[]> = {
  // `refused` from `quoted` is the lapsed-quote path (§ 5's late funding), and
  // from `funded` too: a deposit can be observed and the quote can still be
  // found expired at action time, which must refuse rather than fill.
  quoted: ['funded', 'refused'],
  funded: ['filling', 'refused'],
  // No edge back to `funded`. Once `fulfill` is submitted its outcome is either
  // known or unknown, and "unknown" is `stuck` — never a retry, which is how a
  // solver double-spends its own float. `refused` is absent too: it is reached
  // only through the one method that durably proves nothing was sent.
  filling: ['filled', 'stuck'],
  filled: [],
  refused: [],
  stuck: [],
}

/**
 * Columns a transition may set.
 *
 * The negotiated terms are fixed at insert and can never move: the offer
 * covenant is DERIVED from `to_amount`, `maker_pk_script` and `maker_public_key`,
 * so a row that could edit any of them could describe a contract that was never
 * funded — and `offer_pk_script` is what a deposit is recognised by.
 */
const TRANSITION_COLUMNS = new Set(['deposit_txid', 'deposit_vout', 'fill_txid', 'failure_reason'])

const assertColumns = (columns: string[], allowed: Set<string>, method: string): void => {
  for (const column of columns) {
    if (!allowed.has(column)) throw new Error(`${method} may not set column '${column}'`)
  }
}

export interface AssetRfqSwapRow {
  id: string
  state: AssetRfqSwapState
  createdAt: number
  updatedAt: number
  /** The client-chosen correlation key for the whole negotiation (§ 4.5). */
  rfqId: string
  pair: string
  /** What the client deposits. `null` is BTC, matching the offer packet. */
  fromAssetId: string | null
  fromAmount: bigint
  /** What the covenant obliges any spend to deliver. */
  toAssetId: string | null
  toAmount: bigint
  /** The client's own two covenant parameters, from its request. */
  makerPkScript: string
  makerPublicKey: string
  /** This solver's derivation of the offer covenant — what a deposit is recognised by. */
  offerPkScript: string
  offerAddress: string
  solverPubkey: string
  validUntil: number
  /** The funding outpoint, once one is observed at `offer_pk_script`. */
  depositTxid: string | null
  depositVout: number | null
  fillTxid: string | null
  failureReason: string | null
  /**
   * THIS QUOTE'S OWN PRICE at the moment it was issued — quote-asset per
   * base-asset, `mantissa / 10 ** scale`, never a float. TEXT because it is a
   * bigint, for the reason the amount columns beside it are TEXT.
   *
   * Deliberately NOT the feed price it was derived from. Storing that and
   * comparing the two is a tautology: `resolveAssetQuote` computes the payout
   * from the feed, so the difference is always the configured spread.
   */
  quoteImpliedMantissa: bigint | null
  quoteImpliedScale: number | null
  /**
   * Whether the CLIENT gave the base asset. The one bit that makes the mark
   * directional: paying less quote per base is good when the solver buys base
   * and bad when it sells, so without it one subtraction means opposite things
   * on the two legs of one market.
   */
  quoteGivesBase: boolean | null
  /**
   * WHAT THE MARKET SAID WHEN THE FILL LANDED — the other half of the mark.
   *
   * Null on every row quoted before this shipped, on a fill whose feed read
   * failed, and on every row that never filled. Unmeasured, never zero.
   */
  fillPriceMantissa: bigint | null
  fillPriceScale: number | null
  /** The terms this negotiation was issued under, or null for legacy.
   * Written once at insert and never moved. */
  carrierTerms: AssetRfqCarrierTerms | null
}

export interface AssetRfqQuoteRecord {
  id: string
  rfqId: string
  pair: string
  fromAssetId: string | null
  fromAmount: bigint
  toAssetId: string | null
  toAmount: bigint
  makerPkScript: string
  makerPublicKey: string
  offerPkScript: string
  offerAddress: string
  solverPubkey: string
  validUntil: number
  /**
   * The quote's own price and direction, recorded with the terms that fixed it.
   *
   * Omitted together or not at all: a price with no direction beside it cannot
   * be signed, and an unsigned mark means opposite things on the two legs of one
   * market.
   * @see AssetRfqSwapRow.quoteImpliedMantissa
   */
  quotePrice?: { impliedMantissa: bigint; scale: number; givesBase: boolean }
  /** Spread at the call site; omitted means the market's own pass-through. */
  carrierTerms?: AssetRfqCarrierTerms
}

export interface CarrierAttemptRecord {
  row: AssetRfqSwapRow
  attempt: CarrierAttempt
}

const decimal = (value: unknown, field: string): bigint => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`carrier terms ${field} is not a canonical decimal string`)
  }
  return BigInt(value)
}

const rejectUnknown = (raw: Record<string, unknown>, mode: 'purchase' | 'recycle'): void => {
  const allowed = new Set([
    'mode',
    'physical_sats',
    'loan_sats',
    'receipt_sats',
    'service_fare_sats',
    'priced_sats',
    'expires_at',
    ...(mode === 'recycle' ? ['quote_id'] : []),
  ])
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`carrier terms has unknown key '${key}'`)
  }
}

const positiveDecimal = (value: unknown, field: string): bigint => {
  const parsed = decimal(value, field)
  if (parsed <= 0n) throw new Error(`carrier terms ${field} must be positive`)
  return parsed
}

/** The wire form: snake_case decimal strings, exactly as the profile carries them. */
export const carrierTermsToJson = (terms: AssetRfqCarrierTerms): Record<string, unknown> => ({
  mode: terms.mode,
  ...(terms.quoteId === undefined ? {} : { quote_id: terms.quoteId }),
  physical_sats: terms.physicalSats.toString(),
  loan_sats: terms.loanSats.toString(),
  receipt_sats: terms.receiptSats.toString(),
  service_fare_sats: terms.serviceFareSats.toString(),
  priced_sats: terms.pricedSats.toString(),
  expires_at: terms.expiresAt,
})

export const carrierTermsFromJson = (value: unknown): AssetRfqCarrierTerms => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('carrier terms is not an object')
  }
  const raw = value as Record<string, unknown>
  const mode = raw.mode
  if (mode !== 'purchase' && mode !== 'recycle') throw new Error(`carrier terms mode '${String(mode)}' is unknown`)
  // An unknown key in a money blob is a shape this build never wrote.
  rejectUnknown(raw, mode)
  const quoteId = raw.quote_id
  if (mode === 'recycle') {
    if (typeof quoteId !== 'string' || quoteId.length === 0 || quoteId.length > 128) {
      throw new Error('carrier terms quote_id must be a non-empty bounded string on a recycle')
    }
  } else if (quoteId !== undefined) {
    throw new Error('carrier terms quote_id is only meaningful on a recycle')
  }
  const expiresAt = raw.expires_at
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    throw new Error('carrier terms expires_at is not a safe positive unix second')
  }
  const physicalSats = positiveDecimal(raw.physical_sats, 'physical_sats')
  // From the ACTUAL serialized values, never substituted constants. A purchase
  // is not a loan: it buys the carrier outright, so loan and receipt are zero
  // and physical + service is the price. A recycle splits the dust into a
  // returnable loan and a receipt, and prices the receipt plus service.
  const loanSats = decimal(raw.loan_sats, 'loan_sats')
  const receiptSats = decimal(raw.receipt_sats, 'receipt_sats')
  const serviceFareSats = decimal(raw.service_fare_sats, 'service_fare_sats')
  const pricedSats = decimal(raw.priced_sats, 'priced_sats')
  if (mode === 'recycle') {
    positiveDecimal(raw.loan_sats, 'loan_sats')
    positiveDecimal(raw.receipt_sats, 'receipt_sats')
    if (loanSats + receiptSats !== physicalSats) {
      throw new Error('carrier terms split does not sum to the physical carrier')
    }
    if (serviceFareSats < 0n) throw new Error('carrier terms service_fare_sats must not be negative')
    if (pricedSats !== receiptSats + serviceFareSats) {
      throw new Error('carrier terms priced sats is not the receipt plus the service fare')
    }
  } else {
    if (loanSats !== 0n) throw new Error('carrier terms loan_sats must be zero on a purchase')
    if (receiptSats !== 0n) throw new Error('carrier terms receipt_sats must be zero on a purchase')
    if (serviceFareSats < 0n) throw new Error('carrier terms service_fare_sats must not be negative')
    if (pricedSats !== physicalSats + serviceFareSats) {
      throw new Error('carrier terms priced sats is not the physical carrier plus the service fare')
    }
  }
  return {
    mode,
    ...(mode === 'recycle' ? { quoteId: quoteId as string } : {}),
    physicalSats,
    loanSats,
    receiptSats,
    serviceFareSats,
    pricedSats,
    expiresAt,
  }
}

const COLUMNS = `
  id               TEXT PRIMARY KEY,
  state            TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  rfq_id           TEXT NOT NULL,
  pair             TEXT NOT NULL,
  from_asset_id    TEXT,
  from_amount      TEXT NOT NULL,
  to_asset_id      TEXT,
  to_amount        TEXT NOT NULL,
  maker_pk_script  TEXT NOT NULL,
  maker_public_key TEXT NOT NULL,
  offer_pk_script  TEXT NOT NULL,
  offer_address    TEXT NOT NULL,
  solver_pubkey    TEXT NOT NULL,
  valid_until      INTEGER NOT NULL,
  deposit_txid     TEXT,
  deposit_vout     INTEGER,
  fill_txid        TEXT,
  failure_reason   TEXT,
  quote_implied_mantissa TEXT,
  quote_implied_scale    INTEGER,
  quote_gives_base       INTEGER,
  fill_price_mantissa    TEXT,
  fill_price_scale       INTEGER,
  carrier_terms          TEXT,
  carrier_attempt        TEXT
`

const SCHEMA = `
CREATE TABLE IF NOT EXISTS asset_rfq_swap (${COLUMNS});
CREATE INDEX IF NOT EXISTS idx_asset_rfq_swap_state ON asset_rfq_swap(state);

-- § 4.5's natural key. The atomic class has no payment hash, and the spec says
-- so outright: "a profile without one — the atomic class today — is identified
-- by rfq_id alone". UNIQUE across ALL states, not merely the live ones: a
-- reused rfq_id is a conflict whatever became of the first negotiation, which
-- is the rule the two send legs already enforce by looking the id up.
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_rfq_swap_rfq_id ON asset_rfq_swap(rfq_id);

-- Two LIVE rows must never watch one offer address. Identical terms derive an
-- identical covenant (§ 7.2), so two negotiations can legitimately land on the
-- same script — and a single deposit there would then have two rows claiming
-- it, of which at most one fill can succeed. Partial, so a lapsed or stuck
-- negotiation does not block a later legitimate one at the same address.
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_rfq_swap_live_offer
  ON asset_rfq_swap(offer_pk_script) WHERE state IN ('quoted', 'funded', 'filling', 'filled');

CREATE TABLE IF NOT EXISTS asset_rfq_swap_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  swap_id    TEXT NOT NULL REFERENCES asset_rfq_swap(id),
  at         INTEGER NOT NULL,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_asset_rfq_swap_event_swap ON asset_rfq_swap_event(swap_id);
`

type Raw = Record<string, string | number | null>

// Amounts are TEXT, not INTEGER, for the reason `offerFills.ts` gives: an asset
// amount is a bigint in atomic units (§ 2.1) and SQLite's INTEGER is a signed
// 64-bit, so a value the protocol admits is one the column would silently
// mangle. Stored as the canonical decimal string, which is also what the wire
// carries.
const toRow = (raw: Raw): AssetRfqSwapRow => ({
  id: String(raw.id),
  state: String(raw.state) as AssetRfqSwapState,
  createdAt: Number(raw.created_at),
  updatedAt: Number(raw.updated_at),
  rfqId: String(raw.rfq_id),
  pair: String(raw.pair),
  fromAssetId: raw.from_asset_id === null ? null : String(raw.from_asset_id),
  fromAmount: BigInt(String(raw.from_amount)),
  toAssetId: raw.to_asset_id === null ? null : String(raw.to_asset_id),
  toAmount: BigInt(String(raw.to_amount)),
  makerPkScript: String(raw.maker_pk_script),
  makerPublicKey: String(raw.maker_public_key),
  offerPkScript: String(raw.offer_pk_script),
  offerAddress: String(raw.offer_address),
  solverPubkey: String(raw.solver_pubkey),
  validUntil: Number(raw.valid_until),
  depositTxid: raw.deposit_txid === null ? null : String(raw.deposit_txid),
  depositVout: raw.deposit_vout === null ? null : Number(raw.deposit_vout),
  fillTxid: raw.fill_txid === null ? null : String(raw.fill_txid),
  failureReason: raw.failure_reason === null ? null : String(raw.failure_reason),
  // `?? null` on every one: a row read from a database that has not been
  // migrated yet answers `undefined`, not null, and the analytics layer reads
  // null as "unmeasured" and undefined as a missing field.
  quoteImpliedMantissa: bigIntOrNull(raw.quote_implied_mantissa),
  quoteImpliedScale: numberOrNull(raw.quote_implied_scale),
  quoteGivesBase:
    raw.quote_gives_base === null || raw.quote_gives_base === undefined ? null : Number(raw.quote_gives_base) === 1,
  fillPriceMantissa: bigIntOrNull(raw.fill_price_mantissa),
  fillPriceScale: numberOrNull(raw.fill_price_scale),
  carrierTerms: carrierTermsOrNull(raw.carrier_terms),
})

const bigIntOrNull = (value: string | number | null | undefined): bigint | null =>
  value === null || value === undefined ? null : BigInt(String(value))

const numberOrNull = (value: string | number | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value)

/** A stored blob is JSON we wrote; anything else is corruption and is refused. */
const carrierTermsOrNull = (value: unknown): AssetRfqCarrierTerms | null => {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error('carrier terms column is not text')
  return carrierTermsFromJson(JSON.parse(value))
}

export class AssetRfqSwapStore {
  private constructor(
    readonly driver: SqlDriver,
    private readonly now: () => number,
  ) {}

  static async open(driver: SqlDriver | string, now: () => number = nowSeconds): Promise<AssetRfqSwapStore> {
    const store = new AssetRfqSwapStore(typeof driver === 'string' ? betterSqliteDriver(driver) : driver, now)
    await store.driver.exec(SCHEMA)
    await store.migrate()
    return store
  }

  /** A READ-ONLY caller's licence to open, since {@link open} CREATES the table
   * and a report must add no DDL to a deployment that never served this
   * corridor. `PRAGMA table_info` answers empty for a missing table rather than
   * throwing, which `migrate` already relies on. */
  static async tableExists(driver: SqlDriver): Promise<boolean> {
    return (await driver.all<{ name: string }>(`PRAGMA table_info(asset_rfq_swap)`)).length > 0
  }

  /**
   * Additive migration, for the reason the other stores state: `CREATE TABLE IF
   * NOT EXISTS` never alters an existing table, so a column added above must be
   * added here too.
   *
   * This store's FIRST, and its failure mode is why it is tested rather than
   * assumed: `insertQuote` names its columns explicitly, so a missing ALTER
   * throws inside the orchestrator's try — whose catch maps everything to
   * `duplicate_swap`. Every quote on every market would be refused, and the
   * operator told it was a duplicate-id problem.
   */
  private async migrate(): Promise<void> {
    const columns = await this.driver.all<{ name: string }>(`PRAGMA table_info(asset_rfq_swap)`)
    const existing = new Set(columns.map((c) => c.name))
    for (const [column, type] of [
      ['quote_implied_mantissa', 'TEXT'],
      ['quote_implied_scale', 'INTEGER'],
      ['quote_gives_base', 'INTEGER'],
      ['fill_price_mantissa', 'TEXT'],
      ['fill_price_scale', 'INTEGER'],
      ['carrier_terms', 'TEXT'],
      ['carrier_attempt', 'TEXT'],
    ] as const) {
      if (!existing.has(column)) await this.driver.exec(`ALTER TABLE asset_rfq_swap ADD COLUMN ${column} ${type}`)
    }
  }

  /**
   * The market price observed just AFTER a fill landed.
   *
   * A named writer rather than a general `patch`: these two columns are pure
   * observation with no bearing on the state machine, and a general column
   * setter on a money table is a larger surface than this needs. Never touches
   * `state`, so it cannot race a transition — the worst case is landing on a row
   * another worker has already moved on, and the value is still true.
   */
  async recordFillMark(id: string, mark: { mantissa: bigint; scale: number }): Promise<void> {
    // `updated_at` is deliberately NOT touched. On this corridor it is
    // settlement time — `assetRfqEconomics` reads it as `settledAt`, so it sets
    // `durationSeconds`, the x-axis of the very chart this mark is plotted on.
    // Bumping it would stretch every marked fill's duration by the feed's
    // latency, and ONLY the marked ones, biasing exactly the rows being
    // compared. It also windows `ledgerRows` (a fill could fall out of the
    // window it settled in) and is published to the client in `rfq_status`.
    await this.driver.run(`UPDATE asset_rfq_swap SET fill_price_mantissa = ?, fill_price_scale = ? WHERE id = ?`, [
      mark.mantissa.toString(),
      mark.scale,
      id,
    ])
  }

  /**
   * Record the terms BEFORE they are sent to the client.
   *
   * Order matters for the same reason it does everywhere else in this repo:
   * intent before the irreversible side effect. A quote is a signed commitment,
   * and one this solver has no row for is one it will not recognise a deposit
   * against — the client would fund an address nothing is watching.
   */
  async insertQuote(record: AssetRfqQuoteRecord): Promise<AssetRfqSwapRow> {
    // Checked here because the codec is not: a row the read refuses poisons every later `listNonTerminal`.
    const carrierTerms = record.carrierTerms === undefined ? null : carrierTermsToJson(record.carrierTerms)
    if (carrierTerms !== null) carrierTermsFromJson(carrierTerms)
    const at = this.now()
    await this.driver.run(
      `INSERT INTO asset_rfq_swap (
         id, state, created_at, updated_at, rfq_id, pair, from_asset_id, from_amount,
         to_asset_id, to_amount, maker_pk_script, maker_public_key, offer_pk_script,
         offer_address, solver_pubkey, valid_until, deposit_txid, deposit_vout, fill_txid, failure_reason,
         quote_implied_mantissa, quote_implied_scale, quote_gives_base, carrier_terms
       ) VALUES (?, 'quoted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
      [
        record.id,
        at,
        at,
        record.rfqId,
        record.pair,
        record.fromAssetId,
        record.fromAmount.toString(),
        record.toAssetId,
        record.toAmount.toString(),
        record.makerPkScript,
        record.makerPublicKey,
        record.offerPkScript,
        record.offerAddress,
        record.solverPubkey,
        record.validUntil,
        // All three or none — the spread at the call site is all-or-nothing, so
        // a half-recorded mark cannot reach the column.
        record.quotePrice?.impliedMantissa.toString() ?? null,
        record.quotePrice?.scale ?? null,
        record.quotePrice === undefined ? null : record.quotePrice.givesBase ? 1 : 0,
        carrierTerms === null ? null : JSON.stringify(carrierTerms),
      ],
    )
    await this.recordEvent(record.id, null, 'quoted', null)
    const row = await this.findById(record.id)
    if (!row) throw new Error(`asset rfq swap ${record.id} vanished immediately after insert`)
    return row
  }

  async close(): Promise<void> {
    await this.driver.close()
  }

  async findById(id: string): Promise<AssetRfqSwapRow | undefined> {
    const raw = await this.driver.get<Raw>(`SELECT * FROM asset_rfq_swap WHERE id = ?`, [id])
    return raw ? toRow(raw) : undefined
  }

  /** Throws on an unknown id, matching the shape `parkVia` and `detail` expect. */
  async get(id: string): Promise<AssetRfqSwapRow> {
    const row = await this.findById(id)
    if (!row) throw new Error(`no asset rfq swap ${id}`)
    return row
  }

  /** The negotiation for an rfq id. UNIQUE, so there is at most one. */
  async findByRfqId(rfqId: string): Promise<AssetRfqSwapRow | undefined> {
    const raw = await this.driver.get<Raw>(`SELECT * FROM asset_rfq_swap WHERE rfq_id = ?`, [rfqId])
    return raw ? toRow(raw) : undefined
  }

  /** The live negotiation watching an offer script, if this solver has one. */
  async findLiveByOfferScript(offerPkScript: string): Promise<AssetRfqSwapRow | undefined> {
    const raw = await this.driver.get<Raw>(
      `SELECT * FROM asset_rfq_swap WHERE offer_pk_script = ? AND state IN ('quoted', 'funded', 'filling', 'filled')`,
      [offerPkScript],
    )
    return raw ? toRow(raw) : undefined
  }

  async listNonTerminal(): Promise<AssetRfqSwapRow[]> {
    const placeholders = NON_TERMINAL.map(() => '?').join(', ')
    const raws = await this.driver.all<Raw>(
      `SELECT * FROM asset_rfq_swap WHERE state IN (${placeholders}) ORDER BY created_at ASC`,
      [...NON_TERMINAL],
    )
    return raws.map(toRow)
  }

  /**
   * Rows the sweep should drive, with the script worth watching.
   *
   * The offer script rather than a lockup of ours, because on this corridor the
   * funded contract is the CLIENT's deposit — that is the script whose activity
   * means anything has happened.
   */
  async findRecoverable(): Promise<AssetRfqSwapRow[]> {
    return this.listNonTerminal()
  }

  /**
   * Solver capital committed and not yet recovered, in sats.
   *
   * Zero unless a row is `filling` AND the payout leg is BTC. A payout in an
   * ASSET commits no sats, and reporting its atomic units here would add an
   * asset amount to a sats total — two different units summed into one number,
   * which is worse than reporting nothing. Asset exposure is visible on the row
   * itself; this figure is the one the float dashboard reads, and it is a sats
   * figure by contract.
   *
   * One table backs every market, so a corridor asks for its own `pair` and a
   * caller summing whole STORES omits it. Both callers exist.
   */
  async committedSats(pair?: string): Promise<number> {
    const raws = await this.driver.all<Raw>(
      `SELECT to_amount FROM asset_rfq_swap WHERE state = 'filling' AND to_asset_id IS NULL` +
        (pair === undefined ? '' : ' AND pair = ?'),
      pair === undefined ? [] : [pair],
    )
    return raws.reduce((total, raw) => total + Number(String(raw.to_amount)), 0)
  }

  /**
   * Rows whose last movement falls in a window. @see BaseSwapStore.ledgerRows
   *
   * Duplicated rather than inherited because this store is not a
   * `BaseSwapStore` — its amounts are bigints in TEXT columns and its lifecycle
   * is its own — and the shared base is the wrong place to grow a second
   * hierarchy for one method.
   *
   * `pair` NARROWS IN SQL, AND MUST. One table backs every asset market, so a
   * caller that took the whole window and filtered afterwards would be applying
   * `LIMIT` across every market and then discarding — a busy market's rows push
   * a quiet one's out of the result entirely, and the quiet corridor reports no
   * profit for a window in which it settled fills. Silent, and the screen looks
   * healthy. The same reason `committedSats` above takes a pair.
   */
  async ledgerRows(window: LedgerWindow, pair?: string): Promise<{ rows: AssetRfqSwapRow[]; truncated: boolean }> {
    const limit = clampLedgerLimit(window.limit)
    const raw = await this.driver.all<Raw>(
      `SELECT * FROM asset_rfq_swap WHERE updated_at >= ? AND updated_at < ?` +
        (pair === undefined ? '' : ' AND pair = ?') +
        ` ORDER BY updated_at DESC LIMIT ?`,
      pair === undefined ? [window.since, window.until, limit + 1] : [window.since, window.until, pair, limit + 1],
    )
    return { rows: raw.slice(0, limit).map(toRow), truncated: raw.length > limit }
  }

  async page(options: PageOptions = {}): Promise<{ rows: AssetRfqSwapRow[]; nextCursor: string | null }> {
    const { sql, params, limit } = pageQuery('asset_rfq_swap', options)
    const raw = await this.driver.all<Raw & PageRawFields>(sql, params)
    const { page, nextCursor } = takePage(raw, limit)
    return { rows: page.map(toRow), nextCursor }
  }

  async history(id: string): Promise<{ at: number; from: string | null; to: string; detail: string | null }[]> {
    const raws = await this.driver.all<Raw>(
      `SELECT at, from_state, to_state, detail FROM asset_rfq_swap_event WHERE swap_id = ? ORDER BY id ASC`,
      [id],
    )
    return raws.map((raw) => ({
      at: Number(raw.at),
      from: raw.from_state === null ? null : String(raw.from_state),
      to: String(raw.to_state),
      detail: raw.detail === null ? null : String(raw.detail),
    }))
  }

  /**
   * Compare-and-swap on `state`, so two ticks racing one row cannot both win.
   * Returns whether this caller was the one that moved it.
   */
  async transition(
    id: string,
    from: AssetRfqSwapState,
    to: AssetRfqSwapState,
    fields: Partial<Record<string, unknown>> = {},
  ): Promise<boolean> {
    if (!LEGAL_EDGES[from].includes(to)) {
      throw new Error(`illegal transition ${from} -> ${to}: not an edge of the asset rfq lifecycle`)
    }
    const columns = Object.keys(fields)
    assertColumns(columns, TRANSITION_COLUMNS, 'transition()')
    const assignments = ['state = ?', 'updated_at = ?', ...columns.map((c) => `${c} = ?`)].join(', ')
    const result = await this.driver.run(`UPDATE asset_rfq_swap SET ${assignments} WHERE id = ? AND state = ?`, [
      to,
      this.now(),
      ...columns.map((c) => fields[c]),
      id,
      from,
    ])
    if (result.changes === 1) await this.recordEvent(id, from, to, null)
    return result.changes === 1
  }

  /**
   * Terminal failure with a reason a human will read.
   *
   * Routed by EXPOSURE, which is the distinction an operator acts on: a row
   * that never submitted anything is `refused` and needs nobody, while one
   * that did is `stuck` and needs a human to find out what became of it.
   */
  async fail(id: string, from: AssetRfqSwapState, reason: string): Promise<void> {
    if (!NON_TERMINAL.includes(from)) {
      throw new Error(`fail() cannot act on ${from}: it is terminal, so there is nothing left to fail`)
    }
    const to: AssetRfqSwapState = EXPOSED.includes(from) ? 'stuck' : 'refused'
    await this.transition(id, from, to, { failure_reason: reason })
  }

  /** Its own read, because {@link AssetRfqSwapRow} is projected to the client. */
  async readCarrierAttempt(id: string): Promise<CarrierAttempt | null> {
    const raw = await this.driver.get<Raw>(`SELECT carrier_attempt FROM asset_rfq_swap WHERE id = ?`, [id])
    if (!raw) throw new Error(`no asset rfq swap ${id}`)
    return decodeCarrierAttemptOrNull(raw.carrier_attempt)
  }

  /**
   * Pin the attempt BEFORE the first carrier quote is asked for. Null ->
   * `prepared`, once, and only while this row's own fill is in flight.
   *
   * The recycle check reads `carrier_terms` separately and the predicate does
   * not: the terms are fixed at insert and no method can move them, so that
   * read cannot go stale — while the two things that CAN move underneath this
   * caller, the parent state and the checkpoint, are in the one predicate.
   */
  async prepareCarrierAttempt(id: string, snapshot: unknown): Promise<boolean> {
    const attempt: CarrierAttempt = { phase: 'prepared', snapshot: detachJsonObject(snapshot, 'snapshot') }
    const terms = (await this.get(id)).carrierTerms
    if (terms?.mode !== 'recycle') {
      throw new Error(`asset rfq swap ${id} was not quoted as a recycle, so it has no carrier attempt to make`)
    }
    const result = await this.driver.run(
      `UPDATE asset_rfq_swap SET carrier_attempt = ? WHERE id = ? AND state = 'filling' AND carrier_attempt IS NULL`,
      [encodeCarrierAttempt(attempt), id],
    )
    return result.changes === 1
  }

  async bindCarrierAttempt(id: string, expected: CarrierAttempt, binding: unknown): Promise<boolean> {
    const bound = detachJsonObject(binding, 'binding')
    if (expected.phase !== 'prepared') {
      throw new Error(`carrier attempt ${id} is '${expected.phase}', not prepared: its binding is already fixed`)
    }
    return this.casCarrierAttempt(id, expected, { phase: 'quoted', snapshot: expected.snapshot, binding: bound })
  }

  async markCarrierAttemptSubmitting(id: string, expected: CarrierAttempt): Promise<boolean> {
    if (expected.phase !== 'quoted') {
      throw new Error(`carrier attempt ${id} is '${expected.phase}', not quoted: there is no verified quote to submit`)
    }
    return this.casCarrierAttempt(id, expected, { ...expected, phase: 'submitting' })
  }

  /** Records WHICH transaction the caller proved; it proves nothing itself. */
  async settleCarrierAttempt(id: string, expected: CarrierAttempt, fillTxid: string): Promise<boolean> {
    if (expected.phase !== 'submitting') {
      throw new Error(`carrier attempt ${id} is '${expected.phase}', not submitting: nothing was sent to settle`)
    }
    return this.casCarrierAttempt(id, expected, { ...expected, phase: 'settled', fillTxid })
  }

  /**
   * The one `filling` -> `refused` this lifecycle has, and it is not an edge:
   * `LEGAL_EDGES` still forbids the generic move, because a row that MAY have
   * submitted keeps its liability and ends `stuck`.
   *
   * ONE statement. The terminal checkpoint and the parent row move together or
   * not at all: `SqlDriver.transaction` is best effort on D1, and a half-applied
   * refusal would either lose the proof or leave a live attempt behind it.
   */
  async refuseNeverSubmittedCarrierAttempt(id: string, expected: CarrierAttempt, reason: string): Promise<boolean> {
    if (expected.phase !== 'prepared' && expected.phase !== 'quoted') {
      throw new Error(`carrier attempt ${id} is '${expected.phase}', which is not proven never-submitted`)
    }
    const result = await this.driver.run(
      `UPDATE asset_rfq_swap SET carrier_attempt = ?, state = 'refused', failure_reason = ?, updated_at = ?
         WHERE id = ? AND state = 'filling' AND carrier_attempt = ?`,
      [
        encodeCarrierAttempt({ ...expected, phase: 'not_submitted' }),
        reason,
        this.now(),
        id,
        encodeCarrierAttempt(expected),
      ],
    )
    if (result.changes !== 1) return false
    // After the fact it records, so a failure here is loud and leaves the
    // terminal state standing — it can neither undo it nor reopen the attempt.
    await this.recordEvent(id, 'filling', 'refused', null)
    return true
  }

  /**
   * Every attempt that can still hold ambiguous liability. NOT `NON_TERMINAL`:
   * a `stuck` parent is precisely the row whose outcome is unknown, and a
   * `settled` attempt on a parent that never reached `filled` is the window
   * between those two writes. Nothing here expires.
   */
  async listUnresolvedCarrierAttempts(): Promise<CarrierAttemptRecord[]> {
    const raws = await this.driver.all<Raw>(
      `SELECT * FROM asset_rfq_swap WHERE carrier_attempt IS NOT NULL ORDER BY created_at ASC, id ASC`,
    )
    const records: CarrierAttemptRecord[] = []
    for (const raw of raws) {
      const attempt = decodeCarrierAttempt(raw.carrier_attempt)
      if (attempt.phase === 'not_submitted') continue
      const row = toRow(raw)
      if (attempt.phase === 'settled' && row.state === 'filled') continue
      records.push({ row, attempt })
    }
    return records
  }

  private async casCarrierAttempt(id: string, expected: CarrierAttempt, next: CarrierAttempt): Promise<boolean> {
    const result = await this.driver.run(
      `UPDATE asset_rfq_swap SET carrier_attempt = ? WHERE id = ? AND state = 'filling' AND carrier_attempt = ?`,
      [encodeCarrierAttempt(next), id, encodeCarrierAttempt(expected)],
    )
    return result.changes === 1
  }

  private async recordEvent(
    id: string,
    from: AssetRfqSwapState | null,
    to: AssetRfqSwapState,
    detail: string | null,
  ): Promise<void> {
    await this.driver.run(
      `INSERT INTO asset_rfq_swap_event (swap_id, at, from_state, to_state, detail) VALUES (?, ?, ?, ?, ?)`,
      [id, this.now(), from, to, detail],
    )
  }
}
