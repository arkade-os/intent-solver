/**
 * Durable state for `arkade:<asset>->lightning:BTC` — the client locks an ASSET
 * at a VHTLC and the solver pays sats over Lightning, claiming the lockup with
 * the preimage the payment reveals. Issue #21's leg.
 *
 * The BTC send lifecycle with the lockup denominated in an asset. There is no
 * `refunding` state and its absence is the point: the client funded, and the
 * covenant's non-interactive refund needs no solver signature, so an unfilled
 * lockup is the client's to reclaim and not this solver's to push.
 *
 * ITS PAYOUT IS SATS, so unlike the mirror leg this one reports a real
 * `committedSats()` — see there.
 */

import { pageQuery, takePage, type PageOptions, type PageRawFields } from '@arkade-os/solver-core/core/page.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import type { LnAssetSendState } from '@arkade-os/solver-core/core/lnAssetPlan.js'
import { betterSqliteDriver, type SqlDriver } from './driver.js'

export type LnAssetSendSwapState = LnAssetSendState

export const NON_TERMINAL: readonly LnAssetSendSwapState[] = ['quoted', 'funded', 'paying', 'paid', 'claiming']

/** States in which the solver may have paid out and not yet been made whole. */
export const EXPOSED: readonly LnAssetSendSwapState[] = ['paying', 'paid', 'claiming']

const LEGAL_EDGES: Record<LnAssetSendSwapState, readonly LnAssetSendSwapState[]> = {
  quoted: ['funded', 'refused'],
  funded: ['paying', 'refused'],
  // No edge back to `funded`. Once the payment is submitted its outcome is
  // either known or unknown, and "unknown" is `stuck` — never a retry, which is
  // how a solver pays one invoice twice.
  paying: ['paid', 'refused', 'stuck'],
  paid: ['claiming', 'stuck'],
  claiming: ['claimed', 'stuck'],
  claimed: [],
  refused: [],
  stuck: [],
}

const TRANSITION_COLUMNS = new Set([
  'lockup_txid',
  'lockup_vout',
  'lockup_asset_held',
  'pay_attempted_at',
  'payment_id',
  'preimage',
  'claim_ark_txid',
  'failure_reason',
])

const PATCH_COLUMNS = new Set(['lockup_asset_held', 'payment_id', 'pay_attempted_at', 'claim_ark_txid'])

const assertColumns = (columns: string[], allowed: Set<string>, method: string): void => {
  for (const column of columns) {
    if (!allowed.has(column)) throw new Error(`${method} may not set column '${column}'`)
  }
}

export interface LnAssetSendSwapRow {
  id: string
  state: LnAssetSendSwapState
  createdAt: number
  updatedAt: number

  /** `H`, read off the client's invoice — the natural key. */
  paymentHash: string
  pair: string
  /** The BOLT11 the solver pays, and the sats it asks for. */
  invoice: string
  invoiceExpiresAt: number
  /** What the solver pays out. SATS — this corridor's exposure unit. */
  payoutSats: number

  assetId: string
  assetDecimals: number
  /** What the CLIENT must lock, atomic units, fixed at quote time. */
  lockupAssetAmount: bigint
  /** What the lockup was last observed holding, atomic units. */
  lockupAssetHeld: bigint | null

  /** The client's window to fund. Short, because this pair is cross-asset. */
  lockupDeadline: number
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
  /** Where the CLIENT's own refund pays. */
  refundPkScript: string
  clientRefundPubkey: string

  lockupTxid: string | null
  lockupVout: number | null
  payAttemptedAt: number | null
  paymentId: string | null
  preimage: string | null
  claimArkTxid: string | null
  failureReason: string | null
  rfqId: string | null
}

export type LnAssetSendQuoteRecord = Omit<
  LnAssetSendSwapRow,
  | 'state'
  | 'createdAt'
  | 'updatedAt'
  | 'lockupAssetHeld'
  | 'lockupTxid'
  | 'lockupVout'
  | 'payAttemptedAt'
  | 'paymentId'
  | 'preimage'
  | 'claimArkTxid'
  | 'failureReason'
>

const COLUMNS = `
  id                          TEXT PRIMARY KEY,
  state                       TEXT NOT NULL,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL,
  payment_hash                TEXT NOT NULL,
  pair                        TEXT NOT NULL,
  invoice                     TEXT NOT NULL,
  invoice_expires_at          INTEGER NOT NULL,
  payout_sats                 INTEGER NOT NULL,
  asset_id                    TEXT NOT NULL,
  asset_decimals              INTEGER NOT NULL,
  lockup_asset_amount         TEXT NOT NULL,
  lockup_asset_held           TEXT,
  lockup_deadline             INTEGER NOT NULL,
  refund_locktime             INTEGER NOT NULL,
  solver_pubkey               TEXT NOT NULL,
  server_pubkey               TEXT NOT NULL,
  claim_delay                 INTEGER NOT NULL,
  refund_delay                INTEGER NOT NULL,
  refund_without_receiver_delay INTEGER NOT NULL,
  emulator_pubkey             TEXT NOT NULL,
  pk_script                   TEXT NOT NULL,
  lockup_address              TEXT NOT NULL,
  refund_pk_script            TEXT NOT NULL,
  client_refund_pubkey        TEXT NOT NULL,
  lockup_txid                 TEXT,
  lockup_vout                 INTEGER,
  pay_attempted_at            INTEGER,
  payment_id                  TEXT,
  preimage                    TEXT,
  claim_ark_txid              TEXT,
  failure_reason              TEXT,
  rfq_id                      TEXT
`

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ln_asset_send_swap (${COLUMNS});
CREATE INDEX IF NOT EXISTS idx_ln_asset_send_state ON ln_asset_send_swap(state);
CREATE INDEX IF NOT EXISTS idx_ln_asset_send_hash ON ln_asset_send_swap(payment_hash);

-- Two LIVE rows on one hash would pay one invoice twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ln_asset_send_live_hash
  ON ln_asset_send_swap(payment_hash)
  WHERE state IN ('quoted', 'funded', 'paying', 'paid', 'claiming');

CREATE TABLE IF NOT EXISTS ln_asset_send_swap_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  swap_id    TEXT NOT NULL REFERENCES ln_asset_send_swap(id),
  at         INTEGER NOT NULL,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_ln_asset_send_event_swap ON ln_asset_send_swap_event(swap_id);
`

type Raw = Record<string, string | number | null>

const toRow = (raw: Raw): LnAssetSendSwapRow => ({
  id: String(raw.id),
  state: String(raw.state) as LnAssetSendSwapState,
  createdAt: Number(raw.created_at),
  updatedAt: Number(raw.updated_at),
  paymentHash: String(raw.payment_hash),
  pair: String(raw.pair),
  invoice: String(raw.invoice),
  invoiceExpiresAt: Number(raw.invoice_expires_at),
  payoutSats: Number(raw.payout_sats),
  assetId: String(raw.asset_id),
  assetDecimals: Number(raw.asset_decimals),
  lockupAssetAmount: BigInt(String(raw.lockup_asset_amount)),
  lockupAssetHeld: raw.lockup_asset_held === null ? null : BigInt(String(raw.lockup_asset_held)),
  lockupDeadline: Number(raw.lockup_deadline),
  refundLocktime: Number(raw.refund_locktime),
  solverPubkey: String(raw.solver_pubkey),
  serverPubkey: String(raw.server_pubkey),
  claimDelay: Number(raw.claim_delay),
  refundDelay: Number(raw.refund_delay),
  refundWithoutReceiverDelay: Number(raw.refund_without_receiver_delay),
  emulatorPubkey: String(raw.emulator_pubkey),
  pkScript: String(raw.pk_script),
  lockupAddress: String(raw.lockup_address),
  refundPkScript: String(raw.refund_pk_script),
  clientRefundPubkey: String(raw.client_refund_pubkey),
  lockupTxid: raw.lockup_txid === null ? null : String(raw.lockup_txid),
  lockupVout: raw.lockup_vout === null ? null : Number(raw.lockup_vout),
  payAttemptedAt: raw.pay_attempted_at === null ? null : Number(raw.pay_attempted_at),
  paymentId: raw.payment_id === null ? null : String(raw.payment_id),
  preimage: raw.preimage === null ? null : String(raw.preimage),
  claimArkTxid: raw.claim_ark_txid === null ? null : String(raw.claim_ark_txid),
  failureReason: raw.failure_reason === null ? null : String(raw.failure_reason),
  rfqId: raw.rfq_id === null ? null : String(raw.rfq_id),
})

export class LnAssetSendSwapStore {
  private constructor(
    readonly driver: SqlDriver,
    private readonly now: () => number,
  ) {}

  static async open(driver: SqlDriver | string, now: () => number = nowSeconds): Promise<LnAssetSendSwapStore> {
    const store = new LnAssetSendSwapStore(typeof driver === 'string' ? betterSqliteDriver(driver) : driver, now)
    await store.driver.exec(SCHEMA)
    return store
  }

  async close(): Promise<void> {
    await this.driver.close()
  }

  async insertQuote(record: LnAssetSendQuoteRecord): Promise<LnAssetSendSwapRow> {
    const at = this.now()
    await this.driver.run(
      `INSERT INTO ln_asset_send_swap (
         id, state, created_at, updated_at, payment_hash, pair, invoice, invoice_expires_at, payout_sats,
         asset_id, asset_decimals, lockup_asset_amount, lockup_asset_held, lockup_deadline, refund_locktime,
         solver_pubkey, server_pubkey, claim_delay, refund_delay, refund_without_receiver_delay, emulator_pubkey,
         pk_script, lockup_address, refund_pk_script, client_refund_pubkey, lockup_txid, lockup_vout,
         pay_attempted_at, payment_id, preimage, claim_ark_txid, failure_reason, rfq_id
       ) VALUES (?, 'quoted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
      [
        record.id,
        at,
        at,
        record.paymentHash,
        record.pair,
        record.invoice,
        record.invoiceExpiresAt,
        record.payoutSats,
        record.assetId,
        record.assetDecimals,
        record.lockupAssetAmount.toString(),
        record.lockupDeadline,
        record.refundLocktime,
        record.solverPubkey,
        record.serverPubkey,
        record.claimDelay,
        record.refundDelay,
        record.refundWithoutReceiverDelay,
        record.emulatorPubkey,
        record.pkScript,
        record.lockupAddress,
        record.refundPkScript,
        record.clientRefundPubkey,
        record.rfqId,
      ],
    )
    await this.recordEvent(record.id, null, 'quoted', null)
    return this.get(record.id)
  }

  async findById(id: string): Promise<LnAssetSendSwapRow | undefined> {
    const raw = await this.driver.get<Raw>(`SELECT * FROM ln_asset_send_swap WHERE id = ?`, [id])
    return raw ? toRow(raw) : undefined
  }

  async get(id: string): Promise<LnAssetSendSwapRow> {
    const row = await this.findById(id)
    if (!row) throw new Error(`no ln asset send swap ${id}`)
    return row
  }

  async findByRfqId(rfqId: string): Promise<LnAssetSendSwapRow | undefined> {
    const raw = await this.driver.get<Raw>(`SELECT * FROM ln_asset_send_swap WHERE rfq_id = ?`, [rfqId])
    return raw ? toRow(raw) : undefined
  }

  async findLiveByPaymentHash(paymentHash: string): Promise<LnAssetSendSwapRow | null> {
    const placeholders = NON_TERMINAL.map(() => '?').join(', ')
    const raw = await this.driver.get<Raw>(
      `SELECT * FROM ln_asset_send_swap WHERE payment_hash = ? AND state IN (${placeholders})`,
      [paymentHash, ...NON_TERMINAL],
    )
    return raw ? toRow(raw) : null
  }

  async findRecoverable(): Promise<LnAssetSendSwapRow[]> {
    const placeholders = NON_TERMINAL.map(() => '?').join(', ')
    const raws = await this.driver.all<Raw>(
      `SELECT * FROM ln_asset_send_swap WHERE state IN (${placeholders}) ORDER BY created_at ASC`,
      [...NON_TERMINAL],
    )
    return raws.map(toRow)
  }

  /**
   * Total sats committed across every non-terminal swap — this corridor's
   * contribution to the house cap, in the house's own unit.
   *
   * NEEDS NO NEW DENOMINATION, which is #21 § 1's finding: the payout on this
   * leg IS the BTC leg, so `payout_sats` is directly the figure. Contrast the
   * EVM legs, which count `amount_sats` as the BTC side of a BTC/token pair, and
   * contrast this corridor's MIRROR, whose payout is an asset and whose
   * `committedSats` is therefore zero.
   *
   * NON_TERMINAL, not exposed-only: a swap the solver has QUOTED is capacity it
   * may have to honour, and counting only the exposed states would let unlimited
   * concurrent quotes slip past the cap and all be paid at once.
   */
  async committedSats(): Promise<number> {
    const placeholders = NON_TERMINAL.map(() => '?').join(', ')
    const raw = await this.driver.get<Raw>(
      `SELECT COALESCE(SUM(payout_sats), 0) AS total FROM ln_asset_send_swap WHERE state IN (${placeholders})`,
      [...NON_TERMINAL],
    )
    return Number(raw?.total ?? 0)
  }

  /**
   * Atomic units of `assetId` this corridor expects to RECEIVE and has not yet
   * claimed — what the inventory ceiling must count against.
   *
   * The opposite direction from the mirror leg's identically-named method, and
   * the two must never be summed: one is asset the solver owes, the other asset
   * it is about to be owed.
   */
  async committedAssetUnits(assetId: string): Promise<bigint> {
    const placeholders = NON_TERMINAL.map(() => '?').join(', ')
    const raws = await this.driver.all<Raw>(
      `SELECT lockup_asset_amount FROM ln_asset_send_swap WHERE asset_id = ? AND state IN (${placeholders})`,
      [assetId, ...NON_TERMINAL],
    )
    return raws.reduce((total, raw) => total + BigInt(String(raw.lockup_asset_amount)), 0n)
  }

  async page(options: PageOptions = {}): Promise<{ rows: LnAssetSendSwapRow[]; nextCursor: string | null }> {
    const { sql, params, limit } = pageQuery('ln_asset_send_swap', options)
    const raw = await this.driver.all<Raw & PageRawFields>(sql, params)
    const { page, nextCursor } = takePage(raw, limit)
    return { rows: page.map(toRow), nextCursor }
  }

  async history(id: string): Promise<{ at: number; from: string | null; to: string; detail: string | null }[]> {
    const raws = await this.driver.all<Raw>(
      `SELECT at, from_state, to_state, detail FROM ln_asset_send_swap_event WHERE swap_id = ? ORDER BY id ASC`,
      [id],
    )
    return raws.map((raw) => ({
      at: Number(raw.at),
      from: raw.from_state === null ? null : String(raw.from_state),
      to: String(raw.to_state),
      detail: raw.detail === null ? null : String(raw.detail),
    }))
  }

  async transition(
    id: string,
    from: LnAssetSendSwapState,
    to: LnAssetSendSwapState,
    fields: Record<string, unknown> = {},
  ): Promise<boolean> {
    if (!LEGAL_EDGES[from].includes(to)) {
      throw new Error(`illegal transition ${from} -> ${to}: not an edge of the ln asset send lifecycle`)
    }
    const columns = Object.keys(fields)
    assertColumns(columns, TRANSITION_COLUMNS, 'transition()')
    const assignments = ['state = ?', 'updated_at = ?', ...columns.map((c) => `${c} = ?`)].join(', ')
    const result = await this.driver.run(`UPDATE ln_asset_send_swap SET ${assignments} WHERE id = ? AND state = ?`, [
      to,
      this.now(),
      ...columns.map((c) => fields[c]),
      id,
      from,
    ])
    if (result.changes === 1) await this.recordEvent(id, from, to, null)
    return result.changes === 1
  }

  async patch(id: string, fields: Record<string, unknown>): Promise<void> {
    const columns = Object.keys(fields)
    if (columns.length === 0) return
    assertColumns(columns, PATCH_COLUMNS, 'patch()')
    const assignments = ['updated_at = ?', ...columns.map((c) => `${c} = ?`)].join(', ')
    await this.driver.run(`UPDATE ln_asset_send_swap SET ${assignments} WHERE id = ?`, [
      this.now(),
      ...columns.map((c) => fields[c]),
      id,
    ])
  }

  async fail(id: string, from: LnAssetSendSwapState, reason: string): Promise<void> {
    if (!NON_TERMINAL.includes(from)) {
      throw new Error(`fail() cannot act on ${from}: it is terminal, so there is nothing left to fail`)
    }
    const to: LnAssetSendSwapState = EXPOSED.includes(from) ? 'stuck' : 'refused'
    await this.transition(id, from, to, { failure_reason: reason })
  }

  private async recordEvent(
    id: string,
    from: LnAssetSendSwapState | null,
    to: LnAssetSendSwapState,
    detail: string | null,
  ): Promise<void> {
    await this.driver.run(
      `INSERT INTO ln_asset_send_swap_event (swap_id, at, from_state, to_state, detail) VALUES (?, ?, ?, ?, ?)`,
      [id, this.now(), from, to, detail],
    )
  }
}
