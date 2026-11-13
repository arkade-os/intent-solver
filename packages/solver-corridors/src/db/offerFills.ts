// `arkade:X->arkade:Y` offer fill. No refund, locktime or EXPOSED set: the covenant makes any spend pay
// `wantAmount` to the client, so the deposit is taken only by delivering in the same transaction.

import { betterSqliteDriver, type SqlDriver } from './driver.js'
import { offerFillsSql } from './offerFills.sql.js'
import { addColumns, assertColumns, text, type FillPhase } from './baseSwapStore.js'
import { pageQuery, takePage, type PageOptions, type PageRawFields } from '@arkade-os/solver-core/core/page.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import { announceTransition, type TransitionHook } from '@arkade-os/solver-core/core/businessEvent.js'

// List first, union derived: `LEGAL_EDGES` stops compiling if the two separate.
export const OFFER_FILL_STATES = ['fillable', 'filling', 'filled', 'lost', 'refused', 'stuck'] as const

export type OfferFillState = (typeof OFFER_FILL_STATES)[number]

export const NON_TERMINAL: readonly OfferFillState[] = ['fillable', 'filling']

const LEGAL_EDGES: Record<OfferFillState, readonly OfferFillState[]> = {
  // `fillable -> lost`: another solver or the funder can spend the offer before we submit.
  fillable: ['filling', 'refused', 'lost'],
  // Never back to `fillable`: a `filling` row may have spent (see `revertUnsubmitted`).
  filling: ['filled', 'lost', 'stuck'],
  filled: [],
  lost: [],
  refused: [],
  stuck: [],
}

/** The offer's identity is fixed at insert: the covenant is derived from it. */
const TRANSITION_COLUMNS = new Set(['fill_txid', 'failure_reason', 'fill_phase'])

export interface OfferFillRow {
  id: string
  state: OfferFillState
  fillPhase: FillPhase | null
  createdAt: number
  updatedAt: number
  /** The funded offer output this row is about: `txid:vout`, the natural key. */
  offerTxid: string
  offerVout: number
  offerPkScript: string
  wantAssetId: string | null
  wantAmount: bigint
  offerAssetId: string | null
  offerAmount: bigint
  fillTxid: string | null
  failureReason: string | null
  rfqId: string | null
}

export interface OfferFillRecord {
  id: string
  offerTxid: string
  offerVout: number
  offerPkScript: string
  wantAssetId: string | null
  wantAmount: bigint
  offerAssetId: string | null
  offerAmount: bigint
  rfqId?: string | null
}

type Raw = Record<string, string | number | null>

// Amounts are TEXT: an asset amount can exceed SQLite's signed 64-bit INTEGER.
const toRow = (raw: Raw): OfferFillRow => ({
  id: String(raw.id),
  state: String(raw.state) as OfferFillState,
  fillPhase: text(raw.fill_phase) as FillPhase | null,
  createdAt: Number(raw.created_at),
  updatedAt: Number(raw.updated_at),
  offerTxid: String(raw.offer_txid),
  offerVout: Number(raw.offer_vout),
  offerPkScript: String(raw.offer_pk_script),
  wantAssetId: raw.want_asset_id === null ? null : String(raw.want_asset_id),
  wantAmount: BigInt(String(raw.want_amount)),
  offerAssetId: raw.offer_asset_id === null ? null : String(raw.offer_asset_id),
  offerAmount: BigInt(String(raw.offer_amount)),
  fillTxid: raw.fill_txid === null ? null : String(raw.fill_txid),
  failureReason: raw.failure_reason === null ? null : String(raw.failure_reason),
  rfqId: raw.rfq_id === null ? null : String(raw.rfq_id),
})

export interface OfferFillRepository {
  onTransition?: TransitionHook
  insertIntent(record: OfferFillRecord): Promise<OfferFillRow>
  close(): Promise<void>
  findById(id: string): Promise<OfferFillRow | undefined>
  findLiveByOutpoint(txid: string, vout: number): Promise<OfferFillRow | undefined>
  listNonTerminal(): Promise<OfferFillRow[]>
  page(options?: PageOptions): Promise<{ rows: OfferFillRow[]; nextCursor: string | null }>
  transition(
    id: string,
    from: OfferFillState,
    to: OfferFillState,
    fields?: Partial<Record<string, unknown>>,
  ): Promise<boolean>
  revertUnsubmitted(id: string): Promise<boolean>
  markSubmitting(id: string): Promise<boolean>
  fail(id: string, from: OfferFillState, reason: string): Promise<void>
}

export class OfferFillStore implements OfferFillRepository {
  private constructor(
    readonly driver: SqlDriver,
    private readonly now: () => number,
  ) {}

  static async open(driver: SqlDriver | string, now: () => number = nowSeconds): Promise<OfferFillStore> {
    const store = new OfferFillStore(typeof driver === 'string' ? betterSqliteDriver(driver) : driver, now)
    await store.driver.exec(offerFillsSql.schema)
    await store.migrate()
    return store
  }

  private async migrate(): Promise<void> {
    await addColumns(this.driver, 'offer_fill', [['fill_phase', 'TEXT']])
  }

  /** Before `fulfill` is submitted. Throws on a duplicate live outpoint: the racing loser must not submit. */
  async insertIntent(record: OfferFillRecord): Promise<OfferFillRow> {
    const at = this.now()
    await this.driver.run(offerFillsSql.insertIntent, [
      record.id,
      at,
      at,
      record.offerTxid,
      record.offerVout,
      record.offerPkScript,
      record.wantAssetId,
      record.wantAmount.toString(),
      record.offerAssetId,
      record.offerAmount.toString(),
      record.rfqId ?? null,
    ])
    await this.recordEvent(record.id, null, 'fillable', null)
    const row = await this.findById(record.id)
    if (!row) throw new Error(`offer fill ${record.id} vanished immediately after insert`)
    return row
  }

  async close(): Promise<void> {
    await this.driver.close()
  }

  async findById(id: string): Promise<OfferFillRow | undefined> {
    const raw = await this.driver.get<Raw>(offerFillsSql.selectById, [id])
    return raw ? toRow(raw) : undefined
  }

  async findLiveByOutpoint(txid: string, vout: number): Promise<OfferFillRow | undefined> {
    const raw = await this.driver.get<Raw>(offerFillsSql.selectLiveByOutpoint, [txid, vout])
    return raw ? toRow(raw) : undefined
  }

  async listNonTerminal(): Promise<OfferFillRow[]> {
    const raws = await this.driver.all<Raw>(offerFillsSql.selectInStates(NON_TERMINAL.length), [...NON_TERMINAL])
    return raws.map(toRow)
  }

  async page(options: PageOptions = {}): Promise<{ rows: OfferFillRow[]; nextCursor: string | null }> {
    const { sql, params, limit } = pageQuery('offer_fill', options)
    const raw = await this.driver.all<Raw & PageRawFields>(sql, params)
    const { page, nextCursor } = takePage(raw, limit)
    return { rows: page.map(toRow), nextCursor }
  }

  async transition(
    id: string,
    from: OfferFillState,
    to: OfferFillState,
    fields: Partial<Record<string, unknown>> = {},
  ): Promise<boolean> {
    if (!LEGAL_EDGES[from].includes(to)) {
      throw new Error(`illegal transition ${from} -> ${to}: not an edge of the offer fill lifecycle`)
    }
    const columns = Object.keys(fields)
    assertColumns(columns, TRANSITION_COLUMNS, 'transition()')
    const result = await this.driver.run(offerFillsSql.updateState(columns), [
      to,
      this.now(),
      ...columns.map((c) => fields[c]),
      id,
      from,
    ])
    if (result.changes === 1) {
      await this.recordEvent(id, from, to, null)
      announceTransition(this.onTransition, id, from, to)
    }
    return result.changes === 1
  }

  /**
   * Off `LEGAL_EDGES` on purpose: valid only after `OfferNotSubmittedError`, which an edge cannot express.
   * CAS on state AND phase, since state alone would re-offer a latched fill; the phase is cleared so a
   * later claim cannot inherit it.
   */
  async revertUnsubmitted(id: string): Promise<boolean> {
    const result = await this.driver.run(offerFillsSql.revertUnsubmitted, [this.now(), id])
    if (result.changes === 1) {
      await this.recordEvent(id, 'filling', 'fillable', null)
      announceTransition(this.onTransition, id, 'filling', 'fillable')
    }
    return result.changes === 1
  }

  /** The latch before submission: no recovery may walk the row back past it. Not a transition, so no event. */
  async markSubmitting(id: string): Promise<boolean> {
    const result = await this.driver.run(offerFillsSql.markSubmitting, [this.now(), id])
    return result.changes === 1
  }

  onTransition?: TransitionHook

  /** The terminal guard only improves the error; `LEGAL_EDGES` already refuses a terminal `from`. */
  async fail(id: string, from: OfferFillState, reason: string): Promise<void> {
    if (!NON_TERMINAL.includes(from)) {
      throw new Error(`fail() cannot act on ${from}: it is terminal, so there is nothing left to fail`)
    }
    const to: OfferFillState = from === 'fillable' ? 'refused' : 'stuck'
    await this.transition(id, from, to, { failure_reason: reason })
  }

  private async recordEvent(
    id: string,
    from: OfferFillState | null,
    to: OfferFillState,
    detail: string | null,
  ): Promise<void> {
    await this.driver.run(offerFillsSql.insertEvent, [id, this.now(), from, to, detail])
  }
}
