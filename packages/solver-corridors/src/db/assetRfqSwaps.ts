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
 * - `filling`  an attempt holds the row — the one EXPOSED state — and
 *              `fill_phase` says how far it got (@see FillPhase). Walked back
 *              only where nothing was sent: @see revertUnsubmitted above the
 *              submission, @see revertRejectedSubmit on a refused one
 * - `filled`   the fill landed; the client is paid and the deposit is ours
 * - `refused`  declined, the quote lapsed unfunded, the deposit was spent
 *              elsewhere before a fill arkd then refused, a direct fill was beaten
 *              by its own conflict, or a carrier fill was proven never submitted
 *              or cancelled; no exposure either way
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

import type { DirectFillParentProof } from './offerFills.js'
import {
  decodeCarrierAttempt,
  decodeCarrierAttemptOrNull,
  detachJsonObject,
  encodeCarrierAttempt,
  type CarrierAttempt,
} from './carrierAttempt.js'
import { betterSqliteDriver, type SqlDriver } from './driver.js'
import {
  BaseSwapStore,
  addColumns,
  numberOrNull,
  text,
  type FillPhase,
  type RawRow,
  type StoreShape,
} from './baseSwapStore.js'
import * as sql from './assetRfqSwaps.sql.js'
import { pageQuery, takePage, type PageOptions, type PageRawFields } from '@arkade-os/solver-core/core/page.js'
import { RFQ_ASSET_SWAP_DIRECTED } from '@arkade-os/solver-core/core/rfqContract.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import { announceTransition } from '@arkade-os/solver-core/core/businessEvent.js'
import { AssetRfqMachine, type AssetRfqSwapState } from '../machines/assetRfq.js'
import { clampLedgerLimit, type LedgerWindow } from '@arkade-os/solver-core/analytics/economics.js'

export type { AssetRfqSwapState }

/** The carrier terms a negotiation was issued under: null on legacy rows, written once at insert. */
export interface AssetRfqCarrierTerms {
  mode: 'purchase' | 'recycle' | 'recycle_receiver'
  /** The Taxi quote a recycle's terms were read from. */
  quoteId?: string
  physicalSats: bigint
  loanSats: bigint
  receiptSats: bigint
  serviceFareSats: bigint
  /** What the price netted, which is not physicalSats. */
  pricedSats: bigint
  expiresAt: number
  /** recycle_receiver only: the Taxi the payee named. */
  taxiUrl?: string
  taxiKey?: string
}

export const NON_TERMINAL: readonly AssetRfqSwapState[] = AssetRfqMachine.live
export const EXPOSED: readonly AssetRfqSwapState[] = AssetRfqMachine.exposed
const LEGACY_DIRECTED_QUOTE = sql.legacyDirectedQuote(RFQ_ASSET_SWAP_DIRECTED)

/**
 * Columns a transition may set.
 *
 * The negotiated terms are fixed at insert and can never move: the offer
 * covenant is DERIVED from `to_amount`, `maker_pk_script` and `maker_public_key`,
 * so a row that could edit any of them could describe a contract that was never
 * funded — and `offer_pk_script` is what a deposit is recognised by.
 */
const TRANSITION_COLUMNS = new Set(['deposit_txid', 'deposit_vout', 'fill_txid', 'failure_reason', 'fill_phase'])

export interface AssetRfqSwapRow {
  id: string
  state: AssetRfqSwapState
  fillPhase: FillPhase | null
  createdAt: number
  updatedAt: number
  /** The client-chosen correlation key for the whole negotiation (§ 4.5). */
  rfqId: string
  pair: string
  /** What the client deposits. `null` is BTC, matching the offer packet. */
  fromAssetId: string | null
  fromAmount: bigint
  fromDecimals: number | null
  fromFlatFee: bigint | null
  /** What the covenant obliges any spend to deliver. */
  toAssetId: string | null
  toAmount: bigint
  toDecimals: number | null
  toSpread: bigint | null
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
  carrierTerms: AssetRfqCarrierTerms | null
  /** The contract version negotiated for this quote; null is the baseline, asset-swap-v2. */
  contractVersion: string | null
}

export interface AssetRfqQuoteRecord {
  id: string
  rfqId: string
  pair: string
  fromAssetId: string | null
  fromAmount: bigint
  fromDecimals?: number
  fromFlatFee?: bigint
  toAssetId: string | null
  toAmount: bigint
  toDecimals?: number
  toSpread?: bigint
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
  carrierTerms?: AssetRfqCarrierTerms
  /** Omitted when the request named no `contract_versions`. */
  contractVersion?: string
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

const rejectUnknown = (raw: Record<string, unknown>, mode: 'purchase' | 'recycle' | 'recycle_receiver'): void => {
  const allowed = new Set([
    'mode',
    'physical_sats',
    'loan_sats',
    'receipt_sats',
    'service_fare_sats',
    'priced_sats',
    'expires_at',
    ...(mode === 'recycle' || mode === 'recycle_receiver' ? ['quote_id'] : []),
    ...(mode === 'recycle_receiver' ? ['taxi_url', 'taxi_key'] : []),
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

export const carrierTermsToJson = (terms: AssetRfqCarrierTerms): Record<string, unknown> => ({
  mode: terms.mode,
  ...(terms.quoteId === undefined ? {} : { quote_id: terms.quoteId }),
  physical_sats: terms.physicalSats.toString(),
  loan_sats: terms.loanSats.toString(),
  receipt_sats: terms.receiptSats.toString(),
  service_fare_sats: terms.serviceFareSats.toString(),
  priced_sats: terms.pricedSats.toString(),
  expires_at: terms.expiresAt,
  ...(terms.taxiUrl === undefined ? {} : { taxi_url: terms.taxiUrl }),
  ...(terms.taxiKey === undefined ? {} : { taxi_key: terms.taxiKey }),
})

export const carrierTermsFromJson = (value: unknown): AssetRfqCarrierTerms => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('carrier terms is not an object')
  }
  const raw = value as Record<string, unknown>
  const mode = raw.mode
  if (mode !== 'purchase' && mode !== 'recycle' && mode !== 'recycle_receiver') {
    throw new Error(`carrier terms mode '${String(mode)}' is unknown`)
  }
  // An unknown key in a money blob is a shape this build never wrote.
  rejectUnknown(raw, mode)
  const quoteId = raw.quote_id
  if (mode === 'recycle' || mode === 'recycle_receiver') {
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
  // A purchase buys the carrier outright; a recycle splits it into a returnable loan and a priced
  // receipt; a receiver-paid carrier is the payee's Taxi loaning the whole dust at no price.
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
  } else if (mode === 'recycle_receiver') {
    if (loanSats !== physicalSats)
      throw new Error('carrier terms loan_sats must equal physical_sats on a recycle_receiver')
    if (receiptSats !== 0n) throw new Error('carrier terms receipt_sats must be zero on a recycle_receiver')
    if (serviceFareSats !== 0n) throw new Error('carrier terms service_fare_sats must be zero on a recycle_receiver')
    if (pricedSats !== 0n) throw new Error('carrier terms priced_sats must be zero on a recycle_receiver')
  } else {
    if (loanSats !== 0n) throw new Error('carrier terms loan_sats must be zero on a purchase')
    if (receiptSats !== 0n) throw new Error('carrier terms receipt_sats must be zero on a purchase')
    if (serviceFareSats < 0n) throw new Error('carrier terms service_fare_sats must not be negative')
    if (pricedSats !== physicalSats + serviceFareSats) {
      throw new Error('carrier terms priced sats is not the physical carrier plus the service fare')
    }
  }
  const taxiUrl = raw.taxi_url
  const taxiKey = raw.taxi_key
  if (mode === 'recycle_receiver') {
    if (typeof taxiUrl !== 'string' || taxiUrl.length === 0 || taxiUrl.length > 512) {
      throw new Error('carrier terms taxi_url must be a non-empty bounded string on a recycle_receiver')
    }
    if (typeof taxiKey !== 'string' || !/^[0-9a-f]{64}$/.test(taxiKey)) {
      throw new Error('carrier terms taxi_key must be 64 lowercase hex on a recycle_receiver')
    }
  }
  return {
    mode,
    ...(mode === 'recycle' || mode === 'recycle_receiver' ? { quoteId: quoteId as string } : {}),
    physicalSats,
    loanSats,
    receiptSats,
    serviceFareSats,
    pricedSats,
    expiresAt,
    ...(mode === 'recycle_receiver' ? { taxiUrl: taxiUrl as string, taxiKey: taxiKey as string } : {}),
  }
}

type Raw = Record<string, string | number | null>

// Amounts are TEXT, not INTEGER, for the reason `offerFills.ts` gives: an asset
// amount is a bigint in atomic units (§ 2.1) and SQLite's INTEGER is a signed
// 64-bit, so a value the protocol admits is one the column would silently
// mangle. Stored as the canonical decimal string, which is also what the wire
// carries.
const toRow = (raw: Raw): AssetRfqSwapRow => ({
  id: String(raw.id),
  state: String(raw.state) as AssetRfqSwapState,
  fillPhase: text(raw.fill_phase) as FillPhase | null,
  createdAt: Number(raw.created_at),
  updatedAt: Number(raw.updated_at),
  rfqId: String(raw.rfq_id),
  pair: String(raw.pair),
  fromAssetId: raw.from_asset_id === null ? null : String(raw.from_asset_id),
  fromAmount: BigInt(String(raw.from_amount)),
  fromDecimals: numberOrNull(raw.from_decimals),
  fromFlatFee: bigIntOrNull(raw.from_flat_fee),
  toAssetId: raw.to_asset_id === null ? null : String(raw.to_asset_id),
  toAmount: BigInt(String(raw.to_amount)),
  toDecimals: numberOrNull(raw.to_decimals),
  toSpread: bigIntOrNull(raw.to_spread),
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
  contractVersion: text(raw.contract_version),
})

const carrierTermsOrNull = (value: unknown): AssetRfqCarrierTerms | null => {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error('carrier terms column is not text')
  return carrierTermsFromJson(JSON.parse(value))
}

const bigIntOrNull = (value: string | number | null | undefined): bigint | null =>
  value === null || value === undefined ? null : BigInt(String(value))

const SHAPE: StoreShape<AssetRfqSwapRow, AssetRfqSwapState> = {
  table: 'asset_rfq_swap',
  eventTable: 'asset_rfq_swap_event',
  noun: 'asset rfq swap',
  lifecycleLabel: 'asset rfq lifecycle',
  searchColumns: [],
  legalEdges: AssetRfqMachine.edges,
  transitionColumns: TRANSITION_COLUMNS,
  patchColumns: new Set(),
  live: NON_TERMINAL,
  exposed: EXPOSED,
  toRow: (raw: RawRow) => toRow(raw as Raw),
}

export class AssetRfqSwapStore extends BaseSwapStore<AssetRfqSwapRow, AssetRfqSwapState> {
  protected readonly shape = SHAPE

  static async open(driver: SqlDriver | string, now: () => number = nowSeconds): Promise<AssetRfqSwapStore> {
    const store = new AssetRfqSwapStore(typeof driver === 'string' ? betterSqliteDriver(driver) : driver, now)
    await store.driver.exec(sql.schema(AssetRfqMachine.sqlList(AssetRfqMachine.where('holdsOfferScript'))))
    await store.migrate()
    return store
  }

  /** A READ-ONLY caller's licence to open, since {@link open} CREATES the table
   * and a report must add no DDL to a deployment that never served this
   * corridor. `PRAGMA table_info` answers empty for a missing table rather than
   * throwing, which `migrate` already relies on. */
  static async tableExists(driver: SqlDriver): Promise<boolean> {
    return (await driver.all<{ name: string }>(sql.tableInfo)).length > 0
  }

  /**
   * Additive migration, for the reason the other stores state: `CREATE TABLE IF
   * NOT EXISTS` never alters an existing table, so a column added to the schema must be
   * added to `ADDED_COLUMNS` too.
   *
   * This store's FIRST, and its failure mode is why it is tested rather than
   * assumed: `insertQuote` names its columns explicitly, so a missing ALTER
   * throws inside the orchestrator's try — whose catch maps everything to
   * `duplicate_swap`. Every quote on every market would be refused, and the
   * operator told it was a duplicate-id problem.
   */
  private async migrate(): Promise<void> {
    await addColumns(this.driver, 'asset_rfq_swap', sql.ADDED_COLUMNS)
    await this.driver.exec(sql.createLegacyDirectedOfferIndex(LEGACY_DIRECTED_QUOTE))
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
    await this.driver.run(sql.recordFillMark, [mark.mantissa.toString(), mark.scale, id])
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
    return this.driver.transaction(() => this.insertQuoteRows(record))
  }

  private async insertQuoteRows(record: AssetRfqQuoteRecord): Promise<AssetRfqSwapRow> {
    // Checked here because the read is: a row it refuses would poison every later listNonTerminal.
    const carrierTerms = record.carrierTerms === undefined ? null : carrierTermsToJson(record.carrierTerms)
    if (carrierTerms !== null) carrierTermsFromJson(carrierTerms)
    const at = this.now()
    await this.driver.run(sql.insertQuote, [
      record.id,
      at,
      at,
      record.rfqId,
      record.pair,
      record.fromAssetId,
      record.fromAmount.toString(),
      record.fromDecimals ?? null,
      record.fromFlatFee?.toString() ?? null,
      record.toAssetId,
      record.toAmount.toString(),
      record.toDecimals ?? null,
      record.toSpread?.toString() ?? null,
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
      record.contractVersion ?? null,
    ])
    await this.recordEvent(record.id, null, 'quoted', null)
    const row = await this.findById(record.id)
    if (!row) throw new Error(`asset rfq swap ${record.id} vanished immediately after insert`)
    return row
  }

  async findById(id: string): Promise<AssetRfqSwapRow | undefined> {
    const raw = await this.driver.get<Raw>(sql.byId, [id])
    return raw ? toRow(raw) : undefined
  }

  /** Throws on an unknown id, matching the shape `parkVia` and `detail` expect. */
  override async get(id: string): Promise<AssetRfqSwapRow> {
    const row = await this.findById(id)
    if (!row) throw new Error(`no asset rfq swap ${id}`)
    return row
  }

  /** The live negotiation watching an offer script, if this solver has one. */
  async findLiveByOfferScript(offerPkScript: string): Promise<AssetRfqSwapRow | undefined> {
    const raw = await this.driver.get<Raw>(
      sql.liveByOfferScript(AssetRfqMachine.sqlList(AssetRfqMachine.where('holdsOfferScript'))),
      [offerPkScript],
    )
    return raw ? toRow(raw) : undefined
  }

  /** Narrower than `findLiveByOfferScript`, which counts `filled` — and a later
   * offer at the same address (identical terms derive an identical covenant) is
   * legitimate once our row is done. @see AssetOfferDeps.rfqHolds */
  async heldByLiveNegotiation(offerPkScript: string): Promise<boolean> {
    const raw = await this.driver.get<Raw>(sql.heldByLiveNegotiation(AssetRfqMachine.sqlList(AssetRfqMachine.live)), [
      offerPkScript,
    ])
    return raw !== undefined && raw !== null
  }

  async hasLegacyDirectedQuote(offerPkScript: string): Promise<boolean> {
    const raw = await this.driver.get(sql.hasLegacyDirectedQuote(LEGACY_DIRECTED_QUOTE), [offerPkScript])
    return raw !== undefined && raw !== null
  }

  async listNonTerminal(): Promise<AssetRfqSwapRow[]> {
    return this.findRecoverable()
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
  override async committedSats(pair?: string): Promise<number> {
    const raws = await this.driver.all<Raw>(
      sql.committedSats(AssetRfqMachine.sqlList(AssetRfqMachine.where('outgoing')), pair !== undefined),
      pair === undefined ? [] : [pair],
    )
    return raws.reduce((total, raw) => total + Number(String(raw.to_amount)), 0)
  }

  /**
   * Rows whose last movement falls in a window. @see BaseSwapStore.ledgerRows
   *
   * `pair` NARROWS IN SQL, AND MUST. One table backs every asset market, so a
   * caller that took the whole window and filtered afterwards would be applying
   * `LIMIT` across every market and then discarding — a busy market's rows push
   * a quiet one's out of the result entirely, and the quiet corridor reports no
   * profit for a window in which it settled fills. Silent, and the screen looks
   * healthy. The same reason `committedSats` above takes a pair.
   */
  override async ledgerRows(
    window: LedgerWindow,
    pair?: string,
  ): Promise<{ rows: AssetRfqSwapRow[]; truncated: boolean }> {
    const limit = clampLedgerLimit(window.limit)
    const raw = await this.driver.all<Raw>(
      sql.ledgerRows(pair !== undefined),
      pair === undefined ? [window.since, window.until, limit + 1] : [window.since, window.until, pair, limit + 1],
    )
    return { rows: raw.slice(0, limit).map(toRow), truncated: raw.length > limit }
  }

  // Not the base's, which would turn `searchTerm` into a search this store never ran.
  override async page(options: PageOptions = {}): Promise<{ rows: AssetRfqSwapRow[]; nextCursor: string | null }> {
    const paged = pageQuery('asset_rfq_swap', options)
    const raw = await this.driver.all<Raw & PageRawFields>(paged.sql, paged.params)
    const { page, nextCursor } = takePage(raw, paged.limit)
    return { rows: page.map(toRow), nextCursor }
  }

  /**
   * The ONE edge back out of `filling`, and sound only for its one caller: a fill
   * refused with `OfferNotSubmittedError`, raised above the call that submits.
   * Compare-and-swap on the state AND the phase, for the reason `OfferFillStore` gives. Deliberately
   * absent from `AssetRfqMachine.edges`, so the generic `filling -> funded` keeps throwing —
   * an edge cannot say "only when nothing was sent", so this is reached by name.
   */
  async revertUnsubmitted(id: string): Promise<boolean> {
    return this.revertFilling(id, 'selecting')
  }

  /** The SECOND off-graph edge out, for a fill arkd rejected over one of OUR
   * coins. Gated on `submitting`: the latch has flipped. @see OfferSubmitRejectedError */
  async revertRejectedSubmit(id: string): Promise<boolean> {
    return this.revertFilling(id, 'submitting')
  }

  private async revertFilling(id: string, phase: FillPhase): Promise<boolean> {
    const result = await this.driver.run(sql.revertFilling, [this.now(), id, phase])
    if (result.changes === 1) {
      await this.recordEvent(id, 'filling', 'funded', null)
      announceTransition(this.onTransition, id, 'filling', 'funded')
    }
    return result.changes === 1
  }

  /** The deposit was spent elsewhere, so nothing was submitted and no exposure
   * exists to unwind — the difference from `fail`. ON the graph: `refused` is
   * where a negotiation that committed nothing belongs. */
  async refuseRejectedSubmit(id: string, reason: string): Promise<boolean> {
    return this.transitionWhere(
      id,
      'filling',
      'refused',
      { failure_reason: reason, fill_phase: null },
      sql.phaseIsSubmitting,
    )
  }

  /** THE LATCH. @see OfferFillStore.markSubmitting */
  async markSubmitting(id: string): Promise<boolean> {
    const result = await this.driver.run(sql.markSubmitting, [this.now(), id])
    return result.changes === 1
  }

  async recoverDirectFill(proof: DirectFillParentProof, fillTxid: string): Promise<boolean> {
    return this.resolveDirectFill(proof, fillTxid, false)
  }

  async cancelDirectFill(proof: DirectFillParentProof, conflictTxid: string): Promise<boolean> {
    return this.resolveDirectFill(proof, conflictTxid, true)
  }

  private async resolveDirectFill(proof: DirectFillParentProof, txid: string, cancelled: boolean): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(txid)) return false
    const moved = await this.driver.transaction(async () => {
      const row = await this.findById(proof.id)
      if (
        !row ||
        row.depositTxid !== proof.depositTxid ||
        row.depositVout !== proof.depositVout ||
        row.offerPkScript !== proof.offerPkScript
      )
        return false
      // A carrier fill settles through its own adapter, never this resolver.
      const carrier = await this.driver.get<Raw>(sql.carrierAttemptById, [proof.id])
      if (
        row.carrierTerms?.mode === 'recycle' ||
        row.carrierTerms?.mode === 'recycle_receiver' ||
        carrier?.carrier_attempt != null
      )
        return false
      const reason = `direct fill cancelled by confirmed conflict ${txid}`
      const recovered = `direct fill recovered as ${txid}`
      if (cancelled && row.state === 'refused' && row.fillTxid === null && row.failureReason === reason) return true
      if (!cancelled && row.fillTxid === txid && (row.state === 'filled' || row.failureReason?.startsWith(recovered)))
        return true
      if (row.state !== 'filling' && row.state !== 'stuck') return false
      if (row.failureReason?.startsWith('direct fill cancelled by confirmed conflict ')) return false
      if (row.fillTxid !== null && (cancelled || row.fillTxid !== txid)) return false
      // A stuck row gave up its script and a later negotiation may hold it now, with a deposit of its own:
      // record the fill, never displace that negotiation.
      const holder =
        cancelled || row.state !== 'stuck' ? undefined : await this.findLiveByOfferScript(row.offerPkScript)
      const next: AssetRfqSwapState = cancelled ? 'refused' : holder ? 'stuck' : 'filled'
      const result = await this.driver.run(sql.resolveDirectFill, [
        next,
        this.now(),
        cancelled ? null : txid,
        cancelled ? reason : holder ? `${recovered} after ${holder.id} took its offer script` : null,
        proof.id,
        row.state,
        proof.depositTxid,
        proof.depositVout,
        proof.offerPkScript,
        row.fillTxid,
        row.failureReason,
      ])
      if (result.changes !== 1) return false
      await this.recordEvent(proof.id, row.state, next, cancelled ? reason : txid)
      return { from: row.state, to: next }
    })
    if (typeof moved === 'boolean') return moved
    if (moved.from !== moved.to) announceTransition(this.onTransition, proof.id, moved.from, moved.to)
    return true
  }

  override async fail(id: string, from: AssetRfqSwapState, reason: string): Promise<boolean> {
    if (!NON_TERMINAL.includes(from)) {
      throw new Error(`fail() cannot act on ${from}: it is terminal, so there is nothing left to fail`)
    }
    return super.fail(id, from, reason)
  }

  /** Its own read: {@link AssetRfqSwapRow} is projected to the client. */
  async readCarrierAttempt(id: string): Promise<CarrierAttempt | null> {
    const raw = await this.driver.get<Raw>(sql.carrierAttemptById, [id])
    if (!raw) throw new Error(`no asset rfq swap ${id}`)
    return decodeCarrierAttemptOrNull(raw.carrier_attempt)
  }

  /** Pinned before the first carrier quote is asked for: once, and only while this row's own fill is in flight. */
  async prepareCarrierAttempt(id: string, snapshot: unknown): Promise<boolean> {
    const attempt: CarrierAttempt = { phase: 'prepared', snapshot: detachJsonObject(snapshot, 'snapshot') }
    const terms = (await this.get(id)).carrierTerms
    if (terms?.mode !== 'recycle' && terms?.mode !== 'recycle_receiver') {
      throw new Error(`asset rfq swap ${id} was not quoted as a recycle, so it has no carrier attempt to make`)
    }
    const result = await this.driver.run(sql.prepareCarrierAttempt, [encodeCarrierAttempt(attempt), id])
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

  /** Records which transaction the caller proved. A cancelling attempt settles too: the fill can beat its conflict. */
  async settleCarrierAttempt(id: string, expected: CarrierAttempt, fillTxid: string): Promise<boolean> {
    if (expected.phase !== 'submitting' && expected.phase !== 'cancelling') {
      throw new Error(`carrier attempt ${id} is '${expected.phase}', not submitting: nothing was sent to settle`)
    }
    return this.casCarrierAttempt(id, expected, { ...expected, phase: 'settled', fillTxid })
  }

  /** Records the conflict's bytes before they are sent, only extending the binding: the fill graph must survive. */
  async cancelCarrierAttempt(id: string, expected: CarrierAttempt, next: CarrierAttempt): Promise<boolean> {
    if (expected.phase !== 'submitting' || next.phase !== 'cancelling') {
      throw new Error(
        `carrier attempt ${id} cannot go '${expected.phase}' -> '${next.phase}': only a submit is cancelled`,
      )
    }
    const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
    const before = detachJsonObject(expected.binding ?? {}, 'binding')
    const after = detachJsonObject(next.binding ?? {}, 'binding')
    if (!same(detachJsonObject(next.snapshot, 'snapshot'), detachJsonObject(expected.snapshot, 'snapshot'))) {
      throw new Error(`carrier attempt ${id} cannot replace its snapshot while cancelling`)
    }
    if (Object.keys(before).some((key) => !same(after[key], before[key]))) {
      throw new Error(`carrier attempt ${id} cannot rewrite its binding while cancelling, only extend it`)
    }
    return this.casCarrierAttempt(id, expected, next)
  }

  /** No attempt is durable proof nothing was sent: its write precedes every request naming a coin. */
  async refuseUnattemptedCarrierFill(id: string, reason: string): Promise<boolean> {
    const terms = (await this.get(id)).carrierTerms
    if (terms?.mode !== 'recycle' && terms?.mode !== 'recycle_receiver') return false
    const result = await this.driver.run(sql.refuseUnattemptedCarrierFill, [reason, this.now(), id])
    if (result.changes !== 1) return false
    await this.recordEvent(id, 'filling', 'refused', null)
    announceTransition(this.onTransition, id, 'filling', 'refused')
    return true
  }

  async refuseNeverSubmittedCarrierAttempt(id: string, expected: CarrierAttempt, reason: string): Promise<boolean> {
    if (expected.phase !== 'prepared' && expected.phase !== 'quoted') {
      throw new Error(`carrier attempt ${id} is '${expected.phase}', which is not proven never-submitted`)
    }
    return this.refuseCarrierAttempt(id, expected, { ...expected, phase: 'not_submitted' }, reason)
  }

  /** Only for a caller the chain has shown the conflict spend to. */
  async refuseCancelledCarrierAttempt(id: string, expected: CarrierAttempt, reason: string): Promise<boolean> {
    if (expected.phase !== 'cancelling') {
      throw new Error(`carrier attempt ${id} is '${expected.phase}', not cancelling: no conflict spend was recorded`)
    }
    return this.refuseCarrierAttempt(id, expected, { ...expected, phase: 'cancelled' }, reason)
  }

  /** Not NON_TERMINAL: a stuck parent, or a settled attempt whose parent is not yet filled, is still ambiguous. */
  async listUnresolvedCarrierAttempts(): Promise<CarrierAttemptRecord[]> {
    const records: CarrierAttemptRecord[] = []
    for (const raw of await this.driver.all<Raw>(sql.unresolvedCarrierAttempts)) {
      const attempt = decodeCarrierAttempt(raw.carrier_attempt)
      if (attempt.phase === 'not_submitted' || attempt.phase === 'cancelled') continue
      const row = toRow(raw)
      if (attempt.phase === 'settled' && row.state === 'filled') continue
      records.push({ row, attempt })
    }
    return records
  }

  private async casCarrierAttempt(id: string, expected: CarrierAttempt, next: CarrierAttempt): Promise<boolean> {
    const result = await this.driver.run(sql.casCarrierAttempt, [
      encodeCarrierAttempt(next),
      id,
      encodeCarrierAttempt(expected),
    ])
    return result.changes === 1
  }

  /** One statement, since SqlDriver.transaction is best effort on D1: the checkpoint and the parent move together. */
  private async refuseCarrierAttempt(
    id: string,
    expected: CarrierAttempt,
    next: CarrierAttempt,
    reason: string,
  ): Promise<boolean> {
    const result = await this.driver.run(sql.refuseCarrierAttempt, [
      encodeCarrierAttempt(next),
      reason,
      this.now(),
      id,
      encodeCarrierAttempt(expected),
    ])
    if (result.changes !== 1) return false
    await this.recordEvent(id, 'filling', 'refused', null)
    announceTransition(this.onTransition, id, 'filling', 'refused')
    return true
  }
}
