/**
 * Durable state for an Arkade offer FILL — the atomic class, `arkade:X->arkade:Y`.
 *
 * Deliberately much smaller than its four siblings, and the reason is
 * structural rather than a shortcut. In every other corridor this service goes
 * first: it funds its own lockup, or holds an htlc, and most of those stores is
 * machinery for capital that is committed and not yet made whole — a refund
 * locktime, a deadline sweep, an EXPOSED set, a stuck-capital accounting.
 *
 * None of that exists here. `docs/rfq-protocol.md` § 7.2:
 *
 *   Neither program carries a timelock. An unfilled deposit keeps its place at
 *   the swap address instead of expiring: no deadline to miss and no `expired`
 *   state to unwind.
 *
 * The client funds an offer covenant; the covenant enforces that ANY spend of
 * it pays `wantAmount` to the client. So this service takes the deposit only by
 * delivering, in the same transaction. There is no window in which it has paid
 * and not been paid, which is why there is no refund column, no locktime, and
 * no EXPOSED set. Copying the nearest sibling would import all of it and then
 * need it explained away.
 *
 * Lifecycle, forward-only:
 *
 * - `fillable`  we decided to fill and recorded the intent; NOTHING submitted
 * - `filling`   `fulfill` submitted; the spend is not yet observed
 * - `filled`    the spend confirmed and `classifySpend` read it as a fill
 * - `lost`      the offer output was spent by someone else, or cancelled by its
 *               funder — either way it is gone and this service committed
 *               nothing (see the note on why these are one state)
 * - `refused`   a client asked and this service declined
 * - `stuck`     `fulfill` failed, or the spend classified as `indeterminate`;
 *               needs a human
 */

import { betterSqliteDriver, type SqlDriver } from './driver.js'
import { pageQuery, takePage, type PageOptions, type PageRawFields } from '@arkade-os/solver-core/core/page.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'

export type OfferFillState = 'fillable' | 'filling' | 'filled' | 'lost' | 'refused' | 'stuck'

export const NON_TERMINAL: readonly OfferFillState[] = ['fillable', 'filling']

/**
 * There is no EXPOSED set, and its absence is the point.
 *
 * Its siblings use one to find rows where this service's own capital is
 * committed and not yet recovered, so the operator can be told and a sweep can
 * act. Here that set is empty in every state by construction: `fulfill` pays
 * the client and takes the deposit atomically, so a row is either before that
 * transaction or after it, never inside it.
 *
 * Stated rather than omitted, because "this store has no EXPOSED" reads like an
 * oversight next to four stores that do.
 */

const LEGAL_EDGES: Record<OfferFillState, readonly OfferFillState[]> = {
  // `lost` from `fillable` too: an offer can be filled by another solver or
  // cancelled by its funder between the decision and the submission.
  fillable: ['filling', 'refused', 'lost'],
  filling: ['filled', 'lost', 'stuck'],
  filled: [],
  lost: [],
  refused: [],
  stuck: [],
}

/**
 * Columns a transition may set. The offer's own identity — its outpoint, script
 * and the amounts the covenant binds — is fixed at insert and never moves: the
 * covenant is derived from those values, so a row that could edit them could
 * describe a contract that was never funded.
 */
const TRANSITION_COLUMNS = new Set(['fill_txid', 'failure_reason'])

const assertColumns = (columns: string[], allowed: Set<string>, method: string): void => {
  for (const column of columns) {
    if (!allowed.has(column)) throw new Error(`${method} may not set column '${column}'`)
  }
}

export interface OfferFillRow {
  id: string
  state: OfferFillState
  createdAt: number
  updatedAt: number
  /** The funded offer output this row is about: `txid:vout`, the natural key. */
  offerTxid: string
  offerVout: number
  /** The offer covenant's script, hex. What a spend must come from. */
  offerPkScript: string
  /** What the covenant obliges a filler to pay, and to whom. */
  wantAssetId: string | null
  wantAmount: bigint
  /** What the offer holds, and this service receives by filling it. */
  offerAssetId: string | null
  offerAmount: bigint
  /** Set once `fulfill` is submitted. */
  fillTxid: string | null
  failureReason: string | null
  /** Correlates with an `rfq_status_request`, when the fill came from one. */
  rfqId: string | null
}

/** What a caller must know to record the intent to fill. */
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

const OFFER_FILL_COLUMNS = `
  id              TEXT PRIMARY KEY,
  state           TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  offer_txid      TEXT NOT NULL,
  offer_vout      INTEGER NOT NULL,
  offer_pk_script TEXT NOT NULL,
  want_asset_id   TEXT,
  want_amount     TEXT NOT NULL,
  offer_asset_id  TEXT,
  offer_amount    TEXT NOT NULL,
  fill_txid       TEXT,
  failure_reason  TEXT,
  rfq_id          TEXT
`

const SCHEMA = `
CREATE TABLE IF NOT EXISTS offer_fill (${OFFER_FILL_COLUMNS});
CREATE INDEX IF NOT EXISTS idx_offer_fill_state ON offer_fill(state);

-- The whole reason a row exists before anything is submitted. Two workers that
-- both like the same offer must not both send fulfill for it: the second insert
-- loses here, before either spends. Partial on the live states so a lost or
-- stuck row does not block a later, legitimate re-attempt at the same outpoint.
CREATE UNIQUE INDEX IF NOT EXISTS idx_offer_fill_live_outpoint
  ON offer_fill(offer_txid, offer_vout) WHERE state IN ('fillable', 'filling', 'filled');

CREATE INDEX IF NOT EXISTS idx_offer_fill_rfq_id
  ON offer_fill(rfq_id) WHERE rfq_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS offer_fill_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  fill_id    TEXT NOT NULL REFERENCES offer_fill(id),
  at         INTEGER NOT NULL,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_offer_fill_event_fill ON offer_fill_event(fill_id);
`

type Raw = Record<string, string | number | null>

// Amounts are TEXT, not INTEGER. An asset amount is a bigint in atomic units
// (`docs/rfq-protocol.md` § 2.1) and SQLite's INTEGER is a signed 64-bit, so a
// value the protocol admits can be one a column silently mangles. Stored as the
// canonical decimal string and parsed back, which is also what the wire does.
const toRow = (raw: Raw): OfferFillRow => ({
  id: String(raw.id),
  state: String(raw.state) as OfferFillState,
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

export class OfferFillStore {
  private constructor(
    readonly driver: SqlDriver,
    private readonly now: () => number,
  ) {}

  static async open(driver: SqlDriver | string, now: () => number = nowSeconds): Promise<OfferFillStore> {
    const store = new OfferFillStore(typeof driver === 'string' ? betterSqliteDriver(driver) : driver, now)
    await store.driver.exec(SCHEMA)
    return store
  }

  /**
   * Record the intent to fill, BEFORE `fulfill` is submitted.
   *
   * Order is the point, and it is the same discipline the send orchestrator
   * states for its own refund push: intent before the irreversible side effect.
   * A crash between this insert and the submission leaves a `fillable` row a
   * later tick can resolve against the chain; the reverse order leaves a spend
   * nothing knows about.
   *
   * Throws on a duplicate live outpoint rather than returning — two workers
   * racing the same offer is exactly what the unique index is for, and the
   * loser must not proceed to submit.
   */
  async insertIntent(record: OfferFillRecord): Promise<OfferFillRow> {
    const at = this.now()
    await this.driver.run(
      `INSERT INTO offer_fill (
         id, state, created_at, updated_at, offer_txid, offer_vout, offer_pk_script,
         want_asset_id, want_amount, offer_asset_id, offer_amount, fill_txid, failure_reason, rfq_id
       ) VALUES (?, 'fillable', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      [
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
      ],
    )
    await this.recordEvent(record.id, null, 'fillable', null)
    const row = await this.findById(record.id)
    if (!row) throw new Error(`offer fill ${record.id} vanished immediately after insert`)
    return row
  }

  async close(): Promise<void> {
    await this.driver.close()
  }

  async findById(id: string): Promise<OfferFillRow | undefined> {
    const raw = await this.driver.get<Raw>(`SELECT * FROM offer_fill WHERE id = ?`, [id])
    return raw ? toRow(raw) : undefined
  }

  /** The live row for an outpoint, if this service is already acting on it. */
  async findLiveByOutpoint(txid: string, vout: number): Promise<OfferFillRow | undefined> {
    const raw = await this.driver.get<Raw>(
      `SELECT * FROM offer_fill WHERE offer_txid = ? AND offer_vout = ? AND state IN ('fillable', 'filling', 'filled')`,
      [txid, vout],
    )
    return raw ? toRow(raw) : undefined
  }

  /**
   * The most recent row for an RFQ id.
   *
   * `rfq_id` is NOT unique, and the ordering is what makes this correct rather
   * than a tidy-up. The partial index above deliberately admits a re-attempt at
   * an outpoint whose earlier row went `lost`, and a re-attempt carries the same
   * RFQ id — so a dead row and a live one legitimately share it. Without an
   * order SQLite returns whichever it likes, and a caller asking "is this RFQ
   * still being worked?" gets the corpse and answers no.
   *
   * Same shape and same reason as `onchainSwaps.ts`'s `findByRfqId`, plus the
   * `rowid` tie-break that store omits. `created_at` is a second-resolution
   * clock, so two rows can share it and `ORDER BY created_at DESC` alone leaves
   * them an unordered pair — the same nondeterminism this ordering exists to
   * remove, in a narrower window. `page.ts` already draws that conclusion for
   * the cursor ("the tie-break on rowid is what makes the cursor total") and
   * orders by `created_at DESC, rowid DESC`; this is that, not a new idea.
   */
  async findByRfqId(rfqId: string): Promise<OfferFillRow | undefined> {
    const raw = await this.driver.get<Raw>(
      `SELECT * FROM offer_fill WHERE rfq_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [rfqId],
    )
    return raw ? toRow(raw) : undefined
  }

  /** Rows a tick must still resolve. */
  async listNonTerminal(): Promise<OfferFillRow[]> {
    const placeholders = NON_TERMINAL.map(() => '?').join(', ')
    const raws = await this.driver.all<Raw>(
      `SELECT * FROM offer_fill WHERE state IN (${placeholders}) ORDER BY created_at ASC`,
      [...NON_TERMINAL],
    )
    return raws.map(toRow)
  }

  async page(options: PageOptions = {}): Promise<{ rows: OfferFillRow[]; nextCursor: string | null }> {
    const { sql, params, limit } = pageQuery('offer_fill', options)
    const raw = await this.driver.all<Raw & PageRawFields>(sql, params)
    const { page, nextCursor } = takePage(raw, limit)
    return { rows: page.map(toRow), nextCursor }
  }

  /**
   * Compare-and-swap on `state`, so two ticks racing one row cannot both win.
   * Returns whether this caller was the one that moved it.
   */
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
    const assignments = ['state = ?', 'updated_at = ?', ...columns.map((c) => `${c} = ?`)].join(', ')
    const result = await this.driver.run(`UPDATE offer_fill SET ${assignments} WHERE id = ? AND state = ?`, [
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
   * `refused` when nothing was submitted and `stuck` when something was, which
   * is the distinction an operator acts on: a refused row spent nothing and
   * needs nobody.
   *
   * The guard is for the error message, not for safety — `LEGAL_EDGES` already
   * refuses every terminal `from`, but it says "illegal transition filled ->
   * stuck", which sends a reader looking at the lifecycle graph rather than at
   * the call that asked a finished row to fail.
   */
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
    await this.driver.run(
      `INSERT INTO offer_fill_event (fill_id, at, from_state, to_state, detail) VALUES (?, ?, ?, ?, ?)`,
      [id, this.now(), from, to, detail],
    )
  }
}
