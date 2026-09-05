/**
 * Durable state for `lightning:BTC->arkade:<asset>` — the client pays a hold
 * invoice in sats and the solver funds an ASSET lockup the client claims.
 *
 * The BTC receive lifecycle, with one column changing meaning and everything it
 * touches following: the payout is `payout_asset_amount` atomic units of
 * `asset_id`, not sats. That single change is why this is a store rather than a
 * nullable column on `receive_swap` — a sats figure and an atomic-unit figure
 * cannot share a column that anything sums.
 *
 * Amounts on the asset side are TEXT, not INTEGER, for the reason
 * `assetRfqSwaps.ts` gives: an asset amount is 256-bit and SQLite's INTEGER is a
 * signed 64-bit, so a value the protocol admits is one the column would silently
 * mangle.
 */

import { pageQuery, takePage, type PageOptions, type PageRawFields } from '@arkade-os/solver-core/core/page.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import type { LnAssetReceiveState } from '@arkade-os/solver-core/core/lnAssetPlan.js'
import { betterSqliteDriver, type SqlDriver } from './driver.js'

export type LnAssetReceiveSwapState = LnAssetReceiveState

export const NON_TERMINAL: readonly LnAssetReceiveSwapState[] = ['quoted', 'armed', 'funded', 'claimed', 'refunding']

/**
 * States where the solver's ASSET is out and not yet paid for.
 *
 * From `funded` — the moment the lockup exists — through `claimed`, where the
 * client has taken it and the held HTLC is not yet settled. `refunding` is
 * included because the asset is still out until the refund lands.
 */
export const EXPOSED: readonly LnAssetReceiveSwapState[] = ['funded', 'claimed', 'refunding']

const LEGAL_EDGES: Record<LnAssetReceiveSwapState, readonly LnAssetReceiveSwapState[]> = {
  quoted: ['armed', 'refused'],
  armed: ['funded', 'refused'],
  funded: ['claimed', 'refunding', 'stuck'],
  claimed: ['settled', 'stuck'],
  // A late-but-valid claim can land right up until a refund races it, so the
  // edge back to `claimed` is the one that stops a completed swap being recorded
  // as a refund it never performed.
  refunding: ['claimed', 'refunded', 'stuck'],
  settled: [],
  refunded: [],
  refused: [],
  stuck: [],
}

const TRANSITION_COLUMNS = new Set([
  'htlc_expires_at',
  'arkade_lockup_txid',
  'arkade_lockup_vout',
  'preimage',
  'refund_ark_txid',
  'failure_reason',
])

const PATCH_COLUMNS = new Set(['revealed_at', 'settle_attempted_at', 'refund_ark_txid'])

const assertColumns = (columns: string[], allowed: Set<string>, method: string): void => {
  for (const column of columns) {
    if (!allowed.has(column)) throw new Error(`${method} may not set column '${column}'`)
  }
}

export interface LnAssetReceiveSwapRow {
  id: string
  state: LnAssetReceiveSwapState
  createdAt: number
  updatedAt: number

  /** `H = sha256(P)`, client-chosen, hex — the natural key. */
  paymentHash: string
  pair: string
  /** What the client pays: the hold invoice's amount, sats. */
  amountSats: number
  /** The asset this lockup is denominated in — canonical 68-hex. */
  assetId: string
  /** Its precision, snapshotted so a re-configured market cannot re-read the row. */
  assetDecimals: number
  /** What the solver FUNDS into the lockup, in atomic units, fixed at quote time. */
  payoutAssetAmount: bigint

  invoice: string
  invoiceExpiresAt: number
  htlcExpiresAt: number | null

  payoutAddress: string
  payoutPkScript: string
  payoutPubkey: string
  claimPacket: string

  /** Immutable from `quoted`: `pkScript` is derived from it. */
  refundLocktime: number
  solverPubkey: string
  serverPubkey: string
  claimDelay: number
  refundDelay: number
  refundWithoutReceiverDelay: number
  emulatorPubkey: string
  pkScript: string
  lockupAddress: string
  solverRefundPkScript: string

  arkadeLockupTxid: string | null
  arkadeLockupVout: number | null
  preimage: string | null
  refundArkTxid: string | null
  revealedAt: number | null
  settleAttemptedAt: number | null
  failureReason: string | null
  rfqId: string | null
}

export type LnAssetReceiveQuoteRecord = Omit<
  LnAssetReceiveSwapRow,
  | 'state'
  | 'createdAt'
  | 'updatedAt'
  | 'htlcExpiresAt'
  | 'arkadeLockupTxid'
  | 'arkadeLockupVout'
  | 'preimage'
  | 'refundArkTxid'
  | 'revealedAt'
  | 'settleAttemptedAt'
  | 'failureReason'
>

const COLUMNS = `
  id                          TEXT PRIMARY KEY,
  state                       TEXT NOT NULL,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL,
  payment_hash                TEXT NOT NULL,
  pair                        TEXT NOT NULL,
  amount_sats                 INTEGER NOT NULL,
  asset_id                    TEXT NOT NULL,
  asset_decimals              INTEGER NOT NULL,
  payout_asset_amount         TEXT NOT NULL,
  invoice                     TEXT NOT NULL,
  invoice_expires_at          INTEGER NOT NULL,
  htlc_expires_at             INTEGER,
  payout_address              TEXT NOT NULL,
  payout_pk_script            TEXT NOT NULL,
  payout_pubkey               TEXT NOT NULL,
  claim_packet                TEXT NOT NULL,
  refund_locktime             INTEGER NOT NULL,
  solver_pubkey               TEXT NOT NULL,
  server_pubkey               TEXT NOT NULL,
  claim_delay                 INTEGER NOT NULL,
  refund_delay                INTEGER NOT NULL,
  refund_without_receiver_delay INTEGER NOT NULL,
  emulator_pubkey             TEXT NOT NULL,
  pk_script                   TEXT NOT NULL,
  lockup_address              TEXT NOT NULL,
  solver_refund_pk_script     TEXT NOT NULL,
  arkade_lockup_txid          TEXT,
  arkade_lockup_vout          INTEGER,
  preimage                    TEXT,
  refund_ark_txid             TEXT,
  revealed_at                 INTEGER,
  settle_attempted_at         INTEGER,
  failure_reason              TEXT,
  rfq_id                      TEXT
`

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ln_asset_receive_swap (${COLUMNS});
CREATE INDEX IF NOT EXISTS idx_ln_asset_receive_state ON ln_asset_receive_swap(state);
CREATE INDEX IF NOT EXISTS idx_ln_asset_receive_hash ON ln_asset_receive_swap(payment_hash);

-- A hold invoice is keyed BY PAYMENT HASH at the backend, so two LIVE rows on
-- one hash would have two swaps settling from one HTLC.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ln_asset_receive_live_hash
  ON ln_asset_receive_swap(payment_hash)
  WHERE state IN ('quoted', 'armed', 'funded', 'claimed', 'refunding');

CREATE TABLE IF NOT EXISTS ln_asset_receive_swap_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  swap_id    TEXT NOT NULL REFERENCES ln_asset_receive_swap(id),
  at         INTEGER NOT NULL,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_ln_asset_receive_event_swap ON ln_asset_receive_swap_event(swap_id);
`

type Raw = Record<string, string | number | null>

const toRow = (raw: Raw): LnAssetReceiveSwapRow => ({
  id: String(raw.id),
  state: String(raw.state) as LnAssetReceiveSwapState,
  createdAt: Number(raw.created_at),
  updatedAt: Number(raw.updated_at),
  paymentHash: String(raw.payment_hash),
  pair: String(raw.pair),
  amountSats: Number(raw.amount_sats),
  assetId: String(raw.asset_id),
  assetDecimals: Number(raw.asset_decimals),
  payoutAssetAmount: BigInt(String(raw.payout_asset_amount)),
  invoice: String(raw.invoice),
  invoiceExpiresAt: Number(raw.invoice_expires_at),
  htlcExpiresAt: raw.htlc_expires_at === null ? null : Number(raw.htlc_expires_at),
  payoutAddress: String(raw.payout_address),
  payoutPkScript: String(raw.payout_pk_script),
  payoutPubkey: String(raw.payout_pubkey),
  claimPacket: String(raw.claim_packet),
  refundLocktime: Number(raw.refund_locktime),
  solverPubkey: String(raw.solver_pubkey),
  serverPubkey: String(raw.server_pubkey),
  claimDelay: Number(raw.claim_delay),
  refundDelay: Number(raw.refund_delay),
  refundWithoutReceiverDelay: Number(raw.refund_without_receiver_delay),
  emulatorPubkey: String(raw.emulator_pubkey),
  pkScript: String(raw.pk_script),
  lockupAddress: String(raw.lockup_address),
  solverRefundPkScript: String(raw.solver_refund_pk_script),
  arkadeLockupTxid: raw.arkade_lockup_txid === null ? null : String(raw.arkade_lockup_txid),
  arkadeLockupVout: raw.arkade_lockup_vout === null ? null : Number(raw.arkade_lockup_vout),
  preimage: raw.preimage === null ? null : String(raw.preimage),
  refundArkTxid: raw.refund_ark_txid === null ? null : String(raw.refund_ark_txid),
  revealedAt: raw.revealed_at === null ? null : Number(raw.revealed_at),
  settleAttemptedAt: raw.settle_attempted_at === null ? null : Number(raw.settle_attempted_at),
  failureReason: raw.failure_reason === null ? null : String(raw.failure_reason),
  rfqId: raw.rfq_id === null ? null : String(raw.rfq_id),
})

export class LnAssetReceiveSwapStore {
  private constructor(
    readonly driver: SqlDriver,
    private readonly now: () => number,
  ) {}

  static async open(driver: SqlDriver | string, now: () => number = nowSeconds): Promise<LnAssetReceiveSwapStore> {
    const store = new LnAssetReceiveSwapStore(typeof driver === 'string' ? betterSqliteDriver(driver) : driver, now)
    await store.driver.exec(SCHEMA)
    return store
  }

  async close(): Promise<void> {
    await this.driver.close()
  }

  async insertQuote(record: LnAssetReceiveQuoteRecord): Promise<LnAssetReceiveSwapRow> {
    const at = this.now()
    await this.driver.run(
      `INSERT INTO ln_asset_receive_swap (
         id, state, created_at, updated_at, payment_hash, pair, amount_sats, asset_id, asset_decimals,
         payout_asset_amount, invoice, invoice_expires_at, htlc_expires_at, payout_address, payout_pk_script,
         payout_pubkey, claim_packet, refund_locktime, solver_pubkey, server_pubkey, claim_delay, refund_delay,
         refund_without_receiver_delay, emulator_pubkey, pk_script, lockup_address, solver_refund_pk_script,
         arkade_lockup_txid, arkade_lockup_vout, preimage, refund_ark_txid, revealed_at, settle_attempted_at,
         failure_reason, rfq_id
       ) VALUES (?, 'quoted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
      [
        record.id,
        at,
        at,
        record.paymentHash,
        record.pair,
        record.amountSats,
        record.assetId,
        record.assetDecimals,
        record.payoutAssetAmount.toString(),
        record.invoice,
        record.invoiceExpiresAt,
        record.payoutAddress,
        record.payoutPkScript,
        record.payoutPubkey,
        record.claimPacket,
        record.refundLocktime,
        record.solverPubkey,
        record.serverPubkey,
        record.claimDelay,
        record.refundDelay,
        record.refundWithoutReceiverDelay,
        record.emulatorPubkey,
        record.pkScript,
        record.lockupAddress,
        record.solverRefundPkScript,
        record.rfqId,
      ],
    )
    await this.recordEvent(record.id, null, 'quoted', null)
    return this.get(record.id)
  }

  async findById(id: string): Promise<LnAssetReceiveSwapRow | undefined> {
    const raw = await this.driver.get<Raw>(`SELECT * FROM ln_asset_receive_swap WHERE id = ?`, [id])
    return raw ? toRow(raw) : undefined
  }

  async get(id: string): Promise<LnAssetReceiveSwapRow> {
    const row = await this.findById(id)
    if (!row) throw new Error(`no ln asset receive swap ${id}`)
    return row
  }

  async findByRfqId(rfqId: string): Promise<LnAssetReceiveSwapRow | undefined> {
    const raw = await this.driver.get<Raw>(`SELECT * FROM ln_asset_receive_swap WHERE rfq_id = ?`, [rfqId])
    return raw ? toRow(raw) : undefined
  }

  /** The live row on a hash, for the cross-corridor duplicate check. */
  async findLiveByPaymentHash(paymentHash: string): Promise<LnAssetReceiveSwapRow | null> {
    const placeholders = NON_TERMINAL.map(() => '?').join(', ')
    const raw = await this.driver.get<Raw>(
      `SELECT * FROM ln_asset_receive_swap WHERE payment_hash = ? AND state IN (${placeholders})`,
      [paymentHash, ...NON_TERMINAL],
    )
    return raw ? toRow(raw) : null
  }

  async findRecoverable(): Promise<LnAssetReceiveSwapRow[]> {
    const placeholders = NON_TERMINAL.map(() => '?').join(', ')
    const raws = await this.driver.all<Raw>(
      `SELECT * FROM ln_asset_receive_swap WHERE state IN (${placeholders}) ORDER BY created_at ASC`,
      [...NON_TERMINAL],
    )
    return raws.map(toRow)
  }

  /**
   * ZERO, always, and the zero is the point.
   *
   * This corridor's payout is an ASSET, so it commits no sats at all — and
   * reporting its atomic units here would add an asset amount to a sats total,
   * which is worse than reporting nothing. `assetRfqSwaps.ts` takes the same
   * position for the same reason, and `erc20Balance.ts` states it outright: the
   * conversion is not answerable without a price this store does not have.
   *
   * The bound that DOES apply to this leg is {@link committedAssetUnits}.
   */
  async committedSats(): Promise<number> {
    return 0
  }

  /**
   * Atomic units of `assetId` this corridor has promised and not yet delivered
   * or recovered — the asset analogue of `committedSats`.
   *
   * NON_TERMINAL, not exposed-only, and #21 § 2(a) argues the doctrine: a swap
   * the solver has QUOTED is capacity it may have to honour, because the quote
   * binds until `valid_until` and the client may fund any time inside it.
   * Counting only the funded states would let unlimited concurrent quotes past
   * the inventory gate and all be funded at once.
   */
  async committedAssetUnits(assetId: string): Promise<bigint> {
    const placeholders = NON_TERMINAL.map(() => '?').join(', ')
    const raws = await this.driver.all<Raw>(
      `SELECT payout_asset_amount FROM ln_asset_receive_swap WHERE asset_id = ? AND state IN (${placeholders})`,
      [assetId, ...NON_TERMINAL],
    )
    return raws.reduce((total, raw) => total + BigInt(String(raw.payout_asset_amount)), 0n)
  }

  async page(options: PageOptions = {}): Promise<{ rows: LnAssetReceiveSwapRow[]; nextCursor: string | null }> {
    const { sql, params, limit } = pageQuery('ln_asset_receive_swap', options)
    const raw = await this.driver.all<Raw & PageRawFields>(sql, params)
    const { page, nextCursor } = takePage(raw, limit)
    return { rows: page.map(toRow), nextCursor }
  }

  async history(id: string): Promise<{ at: number; from: string | null; to: string; detail: string | null }[]> {
    const raws = await this.driver.all<Raw>(
      `SELECT at, from_state, to_state, detail FROM ln_asset_receive_swap_event WHERE swap_id = ? ORDER BY id ASC`,
      [id],
    )
    return raws.map((raw) => ({
      at: Number(raw.at),
      from: raw.from_state === null ? null : String(raw.from_state),
      to: String(raw.to_state),
      detail: raw.detail === null ? null : String(raw.detail),
    }))
  }

  /** Compare-and-swap on `state`, so two ticks racing one row cannot both act. */
  async transition(
    id: string,
    from: LnAssetReceiveSwapState,
    to: LnAssetReceiveSwapState,
    fields: Record<string, unknown> = {},
  ): Promise<boolean> {
    if (!LEGAL_EDGES[from].includes(to)) {
      throw new Error(`illegal transition ${from} -> ${to}: not an edge of the ln asset receive lifecycle`)
    }
    const columns = Object.keys(fields)
    assertColumns(columns, TRANSITION_COLUMNS, 'transition()')
    const assignments = ['state = ?', 'updated_at = ?', ...columns.map((c) => `${c} = ?`)].join(', ')
    const result = await this.driver.run(
      `UPDATE ln_asset_receive_swap SET ${assignments} WHERE id = ? AND state = ?`,
      [to, this.now(), ...columns.map((c) => fields[c]), id, from],
    )
    if (result.changes === 1) await this.recordEvent(id, from, to, null)
    return result.changes === 1
  }

  async patch(id: string, fields: Record<string, unknown>): Promise<void> {
    const columns = Object.keys(fields)
    if (columns.length === 0) return
    assertColumns(columns, PATCH_COLUMNS, 'patch()')
    const assignments = ['updated_at = ?', ...columns.map((c) => `${c} = ?`)].join(', ')
    await this.driver.run(`UPDATE ln_asset_receive_swap SET ${assignments} WHERE id = ?`, [
      this.now(),
      ...columns.map((c) => fields[c]),
      id,
    ])
  }

  /**
   * Terminal failure, routed by EXPOSURE: a row that never funded is `refused`
   * and needs nobody, while one whose asset is out is `stuck` and needs a human.
   */
  async fail(id: string, from: LnAssetReceiveSwapState, reason: string): Promise<void> {
    if (!NON_TERMINAL.includes(from)) {
      throw new Error(`fail() cannot act on ${from}: it is terminal, so there is nothing left to fail`)
    }
    const to: LnAssetReceiveSwapState = EXPOSED.includes(from) ? 'stuck' : 'refused'
    await this.transition(id, from, to, { failure_reason: reason })
  }

  private async recordEvent(
    id: string,
    from: LnAssetReceiveSwapState | null,
    to: LnAssetReceiveSwapState,
    detail: string | null,
  ): Promise<void> {
    await this.driver.run(
      `INSERT INTO ln_asset_receive_swap_event (swap_id, at, from_state, to_state, detail) VALUES (?, ?, ?, ?, ?)`,
      [id, this.now(), from, to, detail],
    )
  }
}
