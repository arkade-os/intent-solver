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
 * - `refused`  declined, or the quote lapsed unfunded; no exposure ever existed
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
import { pageQuery, takePage, type PageOptions, type PageRawFields } from '@arkade-os/solver-core/core/page.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'

export type AssetRfqSwapState = 'quoted' | 'funded' | 'filling' | 'filled' | 'refused' | 'stuck'

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
  // solver double-spends its own float.
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
  failure_reason   TEXT
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
})

export class AssetRfqSwapStore {
  private constructor(
    readonly driver: SqlDriver,
    private readonly now: () => number,
  ) {}

  static async open(driver: SqlDriver | string, now: () => number = nowSeconds): Promise<AssetRfqSwapStore> {
    const store = new AssetRfqSwapStore(typeof driver === 'string' ? betterSqliteDriver(driver) : driver, now)
    await store.driver.exec(SCHEMA)
    return store
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
    const at = this.now()
    await this.driver.run(
      `INSERT INTO asset_rfq_swap (
         id, state, created_at, updated_at, rfq_id, pair, from_asset_id, from_amount,
         to_asset_id, to_amount, maker_pk_script, maker_public_key, offer_pk_script,
         offer_address, solver_pubkey, valid_until, deposit_txid, deposit_vout, fill_txid, failure_reason
       ) VALUES (?, 'quoted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
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
   */
  async committedSats(): Promise<number> {
    const raws = await this.driver.all<Raw>(
      `SELECT to_amount FROM asset_rfq_swap WHERE state = 'filling' AND to_asset_id IS NULL`,
    )
    return raws.reduce((total, raw) => total + Number(String(raw.to_amount)), 0)
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
