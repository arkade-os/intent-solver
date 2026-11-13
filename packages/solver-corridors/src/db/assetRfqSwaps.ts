// `arkade:<X>->arkade:<Y>` negotiated over RFQ (`docs/rfq-protocol.md` § 7.2). Unlike `offerFills.ts`,
// the row precedes any funding, so it cannot be keyed on an outpoint. No `refunded` state: § 7.2's
// `cancel` needs no solver signature, so a lapsed quote ends `refused` and the deposit stays the client's.

import { betterSqliteDriver, type SqlDriver } from './driver.js'
import { assetRfqSwapsSql } from './assetRfqSwaps.sql.js'
import {
  BaseSwapStore,
  addColumns,
  numberOrNull,
  text,
  type FillPhase,
  type RawRow,
  type StoreShape,
  type SwapRepository,
} from './baseSwapStore.js'
import { pageQuery, takePage, type PageOptions, type PageRawFields } from '@arkade-os/solver-core/core/page.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import { announceTransition } from '@arkade-os/solver-core/core/businessEvent.js'
import { clampLedgerLimit, type LedgerWindow } from '@arkade-os/solver-core/analytics/economics.js'

export type AssetRfqSwapState = 'quoted' | 'funded' | 'filling' | 'filled' | 'refused' | 'stuck'

export const NON_TERMINAL: readonly AssetRfqSwapState[] = ['quoted', 'funded', 'filling']

/** Only `filling`: `fulfill` pays the client and takes the deposit in one transaction. */
export const EXPOSED: readonly AssetRfqSwapState[] = ['filling']

const LEGAL_EDGES: Record<AssetRfqSwapState, readonly AssetRfqSwapState[]> = {
  // `funded -> refused`: a deposit can be seen after the quote has expired.
  quoted: ['funded', 'refused'],
  funded: ['filling', 'refused'],
  // No edge back to `funded`: an unknown outcome is `stuck`, never a retry (`revertUnsubmitted` is off-graph).
  filling: ['filled', 'stuck'],
  filled: [],
  refused: [],
  stuck: [],
}

/** Terms are fixed at insert: the offer covenant and `offer_pk_script` are derived from them. */
const TRANSITION_COLUMNS = new Set(['deposit_txid', 'deposit_vout', 'fill_txid', 'failure_reason', 'fill_phase'])

export interface AssetRfqSwapRow {
  id: string
  state: AssetRfqSwapState
  fillPhase: FillPhase | null
  createdAt: number
  updatedAt: number
  rfqId: string
  pair: string
  /** What the client deposits. `null` is BTC, matching the offer packet. */
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
  depositTxid: string | null
  depositVout: number | null
  fillTxid: string | null
  failureReason: string | null
  /** This quote's own price (`mantissa / 10 ** scale`), not the feed's: comparing those always yields the spread. */
  quoteImpliedMantissa: bigint | null
  quoteImpliedScale: number | null
  /** Signs the mark: less quote per base is good when the solver buys base, bad when it sells. */
  quoteGivesBase: boolean | null
  /** Market price when the fill landed; null means unmeasured, never zero. */
  fillPriceMantissa: bigint | null
  fillPriceScale: number | null
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
  /** All or nothing: a price without its direction cannot be signed. */
  quotePrice?: { impliedMantissa: bigint; scale: number; givesBase: boolean }
}

type Raw = Record<string, string | number | null>

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
  quoteImpliedMantissa: bigIntOrNull(raw.quote_implied_mantissa),
  quoteImpliedScale: numberOrNull(raw.quote_implied_scale),
  quoteGivesBase:
    raw.quote_gives_base === null || raw.quote_gives_base === undefined ? null : Number(raw.quote_gives_base) === 1,
  fillPriceMantissa: bigIntOrNull(raw.fill_price_mantissa),
  fillPriceScale: numberOrNull(raw.fill_price_scale),
})

const bigIntOrNull = (value: string | number | null | undefined): bigint | null =>
  value === null || value === undefined ? null : BigInt(String(value))

const SHAPE: StoreShape<AssetRfqSwapRow, AssetRfqSwapState> = {
  table: 'asset_rfq_swap',
  eventTable: 'asset_rfq_swap_event',
  noun: 'asset rfq swap',
  lifecycleLabel: 'asset rfq lifecycle',
  searchColumns: [],
  legalEdges: LEGAL_EDGES,
  transitionColumns: TRANSITION_COLUMNS,
  patchColumns: new Set(),
  live: NON_TERMINAL,
  exposed: EXPOSED,
  toRow: (raw: RawRow) => toRow(raw as Raw),
}

export interface AssetRfqSwapRepository extends SwapRepository<AssetRfqSwapRow, AssetRfqSwapState> {
  committedSats(pair?: string): Promise<number>
  ledgerRows(window: LedgerWindow, pair?: string): Promise<{ rows: AssetRfqSwapRow[]; truncated: boolean }>
  recordFillMark(id: string, mark: { mantissa: bigint; scale: number }): Promise<void>
  insertQuote(record: AssetRfqQuoteRecord): Promise<AssetRfqSwapRow>
  findById(id: string): Promise<AssetRfqSwapRow | undefined>
  listNonTerminal(): Promise<AssetRfqSwapRow[]>
  revertUnsubmitted(id: string): Promise<boolean>
  markSubmitting(id: string): Promise<boolean>
}

export class AssetRfqSwapStore
  extends BaseSwapStore<AssetRfqSwapRow, AssetRfqSwapState>
  implements AssetRfqSwapRepository
{
  protected readonly shape = SHAPE

  static async open(driver: SqlDriver | string, now: () => number = nowSeconds): Promise<AssetRfqSwapStore> {
    const store = new AssetRfqSwapStore(typeof driver === 'string' ? betterSqliteDriver(driver) : driver, now)
    await store.driver.exec(assetRfqSwapsSql.schema)
    await store.migrate()
    return store
  }

  /** For read-only callers: {@link open} creates the table, and a report must add no DDL. */
  static async tableExists(driver: SqlDriver): Promise<boolean> {
    return (await driver.all<{ name: string }>(assetRfqSwapsSql.tableInfo)).length > 0
  }

  /** A missing column makes `insertQuote` throw, which the orchestrator reports as `duplicate_swap`. */
  private async migrate(): Promise<void> {
    await addColumns(this.driver, 'asset_rfq_swap', [
      ['quote_implied_mantissa', 'TEXT'],
      ['quote_implied_scale', 'INTEGER'],
      ['quote_gives_base', 'INTEGER'],
      ['fill_price_mantissa', 'TEXT'],
      ['fill_price_scale', 'INTEGER'],
      ['fill_phase', 'TEXT'],
    ])
  }

  /** Observation only: never touches `state`, so it cannot race a transition. */
  async recordFillMark(id: string, mark: { mantissa: bigint; scale: number }): Promise<void> {
    // Leaves `updated_at` alone: it is settlement time for economics, ledger windows and `rfq_status`.
    await this.driver.run(assetRfqSwapsSql.recordFillMark, [mark.mantissa.toString(), mark.scale, id])
  }

  /** Written before the quote is sent: a deposit with no row would go unwatched. */
  async insertQuote(record: AssetRfqQuoteRecord): Promise<AssetRfqSwapRow> {
    const at = this.now()
    await this.driver.run(assetRfqSwapsSql.insertQuote, [
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
      record.quotePrice?.impliedMantissa.toString() ?? null,
      record.quotePrice?.scale ?? null,
      record.quotePrice === undefined ? null : record.quotePrice.givesBase ? 1 : 0,
    ])
    await this.recordEvent(record.id, null, 'quoted', null)
    const row = await this.findById(record.id)
    if (!row) throw new Error(`asset rfq swap ${record.id} vanished immediately after insert`)
    return row
  }

  async findById(id: string): Promise<AssetRfqSwapRow | undefined> {
    const raw = await this.driver.get<Raw>(assetRfqSwapsSql.selectById, [id])
    return raw ? toRow(raw) : undefined
  }

  override async get(id: string): Promise<AssetRfqSwapRow> {
    const row = await this.findById(id)
    if (!row) throw new Error(`no asset rfq swap ${id}`)
    return row
  }

  async listNonTerminal(): Promise<AssetRfqSwapRow[]> {
    return this.findRecoverable()
  }

  /** BTC payouts in `filling` only: asset units must never be summed into sats. */
  override async committedSats(pair?: string): Promise<number> {
    const raws = await this.driver.all<Raw>(
      assetRfqSwapsSql.selectFillingBtcPayouts(pair !== undefined),
      pair === undefined ? [] : [pair],
    )
    return raws.reduce((total, raw) => total + Number(String(raw.to_amount)), 0)
  }

  /** `pair` filters in SQL, before `LIMIT`, or a busy market crowds a quiet one out of the window. */
  override async ledgerRows(
    window: LedgerWindow,
    pair?: string,
  ): Promise<{ rows: AssetRfqSwapRow[]; truncated: boolean }> {
    const limit = clampLedgerLimit(window.limit)
    const raw = await this.driver.all<Raw>(
      assetRfqSwapsSql.selectUpdatedInWindow(pair !== undefined),
      pair === undefined ? [window.since, window.until, limit + 1] : [window.since, window.until, pair, limit + 1],
    )
    return { rows: raw.slice(0, limit).map(toRow), truncated: raw.length > limit }
  }

  // Not the base's, which would turn `searchTerm` into a search this store never ran.
  override async page(options: PageOptions = {}): Promise<{ rows: AssetRfqSwapRow[]; nextCursor: string | null }> {
    const { sql, params, limit } = pageQuery('asset_rfq_swap', options)
    const raw = await this.driver.all<Raw & PageRawFields>(sql, params)
    const { page, nextCursor } = takePage(raw, limit)
    return { rows: page.map(toRow), nextCursor }
  }

  /** @see OfferFillStore.revertUnsubmitted */
  async revertUnsubmitted(id: string): Promise<boolean> {
    const result = await this.driver.run(assetRfqSwapsSql.revertUnsubmitted, [this.now(), id])
    if (result.changes === 1) {
      await this.recordEvent(id, 'filling', 'funded', null)
      announceTransition(this.onTransition, id, 'filling', 'funded')
    }
    return result.changes === 1
  }

  /** @see OfferFillStore.markSubmitting */
  async markSubmitting(id: string): Promise<boolean> {
    const result = await this.driver.run(assetRfqSwapsSql.markSubmitting, [this.now(), id])
    return result.changes === 1
  }

  override async fail(id: string, from: AssetRfqSwapState, reason: string): Promise<void> {
    if (!NON_TERMINAL.includes(from)) {
      throw new Error(`fail() cannot act on ${from}: it is terminal, so there is nothing left to fail`)
    }
    await super.fail(id, from, reason)
  }
}
