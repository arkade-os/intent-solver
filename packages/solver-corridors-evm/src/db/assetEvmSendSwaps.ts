/**
 * Durable state for the `arkade:<asset>->ethereum:<token>` send leg.
 *
 * The `send_evm_swap` table with its funding leg re-denominated: what the client
 * locks is atomic units of an Arkade asset, not sats, so `asset_units` and
 * `asset_id` stand where `amount_sats` does. The lifecycle is IDENTICAL and
 * shares `EvmSendSwapState` — the same planner drives both — which is the point
 * of keeping the two tables the same shape rather than inventing a second one.
 *
 * `asset_units` and `payout_units` are TEXT for `evm_amount`'s reason: an
 * 18-decimal asset's atomic amount exceeds what a JS number holds exactly, and
 * persisting one as a float silently rounds a payout.
 *
 * `asset_id` is the 68-hex serialized Asset ID in CANONICAL order — the form the
 * wire and the registry carry. It is NOT reversed here. The reversal
 * `INSPECTOUTASSETLOOKUP` needs happens once, inside the covenant builder;
 * storing a reversed id would put a second, silently different spelling of the
 * asset's identity on disk. @see arkade/covenant.ts `parseAssetId`.
 */

import { betterSqliteDriver, type SqlDriver } from '@arkade-os/solver-db/driver.js'
import { pageQuery, takePage, type PageOptions, type PageRawFields } from '@arkade-os/solver-core/core/page.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import { EVM_SEND_NON_TERMINAL, type EvmSendSwapState } from '@arkade-os/solver-core/core/evmSwapState.js'

export interface AssetEvmSendSwapRow {
  id: string
  state: EvmSendSwapState
  createdAt: number
  updatedAt: number
  paymentHash: string
  /** The 68-hex Asset ID the client locks. CANONICAL order — see the module comment. */
  assetId: string
  /** The asset's declared precision, snapshotted so a config change cannot reprice a funded row. */
  assetDecimals: number
  /** What the client locks, in the asset's atomic units. TEXT on disk. */
  assetUnits: string
  /** `assetUnits` minus this corridor's fee, fixed AT QUOTE TIME. */
  payoutUnits: string
  /** The ERC20 the solver locks, in the token's own atomic units. */
  evmAmount: string
  tokenAddress: string
  evmContractAddress: string
  evmChainId: number
  evmTimeout: number
  validUntil: number
  minConfirmations: number
  minAgeSeconds: number
  evmLockTxid: string | null
  evmRefundTxid: string | null
  evmClaimTxid: string | null
  evmClaimAddress: string
  evmRefundAddress: string
  refundLocktime: number
  providerPubkey: string
  serverPubkey: string
  claimDelay: number
  refundDelay: number
  refundWithoutReceiverDelay: number
  pkScript: string
  lockupAddress: string
  refundPkScript: string
  emulatorPubkey: string
  clientRefundPubkey: string
  receiverPkScript: string
  nonInteractiveParameters: boolean | null
  preimage: string | null
  claimArkTxid: string | null
  refundArkTxid: string | null
  refundOutcome: string | null
  rfqId: string | null
  failureReason: string | null
}

const COLUMNS = `
  id                            TEXT PRIMARY KEY,
  state                         TEXT NOT NULL,
  created_at                    INTEGER NOT NULL,
  updated_at                    INTEGER NOT NULL,
  payment_hash                  TEXT NOT NULL,
  asset_id                      TEXT NOT NULL,
  asset_decimals                INTEGER NOT NULL,
  asset_units                   TEXT NOT NULL,
  payout_units                  TEXT NOT NULL,
  evm_amount                    TEXT NOT NULL,
  token_address                 TEXT NOT NULL,
  evm_contract_address          TEXT NOT NULL,
  evm_chain_id                  INTEGER NOT NULL,
  evm_timeout                   INTEGER NOT NULL,
  valid_until                   INTEGER NOT NULL,
  min_confirmations             INTEGER NOT NULL,
  min_age_seconds               INTEGER NOT NULL,
  evm_lock_txid                 TEXT,
  evm_refund_txid               TEXT,
  evm_claim_txid                TEXT,
  evm_claim_address             TEXT NOT NULL,
  evm_refund_address            TEXT NOT NULL,
  refund_locktime               INTEGER NOT NULL,
  provider_pubkey               TEXT NOT NULL,
  server_pubkey                 TEXT NOT NULL,
  claim_delay                   INTEGER NOT NULL,
  refund_delay                  INTEGER NOT NULL,
  refund_without_receiver_delay INTEGER NOT NULL,
  pk_script                     TEXT NOT NULL,
  lockup_address                TEXT NOT NULL,
  refund_pk_script              TEXT NOT NULL,
  emulator_pubkey               TEXT NOT NULL,
  client_refund_pubkey          TEXT NOT NULL,
  receiver_pk_script            TEXT NOT NULL,
  non_interactive_parameters    TEXT,
  preimage                      TEXT,
  claim_ark_txid                TEXT,
  refund_ark_txid               TEXT,
  refund_outcome                TEXT,
  rfq_id                        TEXT,
  failure_reason                TEXT
`

const SCHEMA = `
CREATE TABLE IF NOT EXISTS send_asset_evm_swap (${COLUMNS});
CREATE INDEX IF NOT EXISTS idx_send_asset_evm_swap_state ON send_asset_evm_swap(state);
-- One LIVE row per payment hash, as in every other corridor: two lockups
-- against one hash means whichever client loses the race is claimed with no
-- refund.
CREATE UNIQUE INDEX IF NOT EXISTS idx_send_asset_evm_swap_live_hash
  ON send_asset_evm_swap(payment_hash) WHERE state != 'refused';
CREATE INDEX IF NOT EXISTS idx_send_asset_evm_swap_rfq_id
  ON send_asset_evm_swap(rfq_id) WHERE rfq_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS send_asset_evm_swap_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  swap_id    TEXT NOT NULL REFERENCES send_asset_evm_swap(id),
  at         INTEGER NOT NULL,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_send_asset_evm_swap_event_swap ON send_asset_evm_swap_event(swap_id);
`

type Raw = Record<string, string | number | null>

const text = (value: string | number | null | undefined): string | null =>
  value === null || value === undefined ? null : String(value)

const toRow = (raw: Raw): AssetEvmSendSwapRow => ({
  id: String(raw.id),
  state: String(raw.state) as EvmSendSwapState,
  createdAt: Number(raw.created_at),
  updatedAt: Number(raw.updated_at),
  paymentHash: String(raw.payment_hash),
  assetId: String(raw.asset_id),
  assetDecimals: Number(raw.asset_decimals),
  assetUnits: String(raw.asset_units),
  payoutUnits: String(raw.payout_units),
  evmAmount: String(raw.evm_amount),
  tokenAddress: String(raw.token_address),
  evmContractAddress: String(raw.evm_contract_address),
  evmChainId: Number(raw.evm_chain_id),
  evmTimeout: Number(raw.evm_timeout),
  validUntil: Number(raw.valid_until),
  minConfirmations: Number(raw.min_confirmations),
  minAgeSeconds: Number(raw.min_age_seconds),
  evmLockTxid: text(raw.evm_lock_txid),
  evmRefundTxid: text(raw.evm_refund_txid),
  evmClaimTxid: text(raw.evm_claim_txid),
  evmClaimAddress: String(raw.evm_claim_address),
  evmRefundAddress: String(raw.evm_refund_address),
  refundLocktime: Number(raw.refund_locktime),
  providerPubkey: String(raw.provider_pubkey),
  serverPubkey: String(raw.server_pubkey),
  claimDelay: Number(raw.claim_delay),
  refundDelay: Number(raw.refund_delay),
  refundWithoutReceiverDelay: Number(raw.refund_without_receiver_delay),
  pkScript: String(raw.pk_script),
  lockupAddress: String(raw.lockup_address),
  refundPkScript: String(raw.refund_pk_script),
  emulatorPubkey: String(raw.emulator_pubkey),
  clientRefundPubkey: String(raw.client_refund_pubkey),
  receiverPkScript: String(raw.receiver_pk_script),
  nonInteractiveParameters:
    raw.non_interactive_parameters === null || raw.non_interactive_parameters === undefined
      ? null
      : raw.non_interactive_parameters === '1',
  preimage: text(raw.preimage),
  claimArkTxid: text(raw.claim_ark_txid),
  refundArkTxid: text(raw.refund_ark_txid),
  refundOutcome: text(raw.refund_outcome),
  rfqId: text(raw.rfq_id),
  failureReason: text(raw.failure_reason),
})

export type AssetEvmSendQuoteRecord = Omit<
  AssetEvmSendSwapRow,
  | 'state'
  | 'createdAt'
  | 'updatedAt'
  | 'evmLockTxid'
  | 'evmRefundTxid'
  | 'evmClaimTxid'
  | 'preimage'
  | 'claimArkTxid'
  | 'refundArkTxid'
  | 'refundOutcome'
  | 'failureReason'
  | 'nonInteractiveParameters'
> & { nonInteractiveParameters: boolean }

const TRANSITION_COLUMNS: ReadonlySet<string> = new Set([
  'evm_lock_txid',
  'evm_refund_txid',
  'evm_claim_txid',
  'preimage',
  'claim_ark_txid',
  'refund_ark_txid',
  'refund_outcome',
  'failure_reason',
])

const assertColumns = (columns: readonly string[], allowed: ReadonlySet<string>, where: string): void => {
  for (const column of columns) {
    if (!allowed.has(column)) throw new Error(where + ': unknown column ' + column)
  }
}

export class AssetEvmSendSwapStore {
  private constructor(
    private readonly driver: SqlDriver,
    private readonly now: () => number,
  ) {}

  static async open(driver: SqlDriver | string, now: () => number = nowSeconds): Promise<AssetEvmSendSwapStore> {
    const store = new AssetEvmSendSwapStore(typeof driver === 'string' ? betterSqliteDriver(driver) : driver, now)
    await store.driver.exec(SCHEMA)
    return store
  }

  async close(): Promise<void> {
    await this.driver.close?.()
  }

  async insertQuote(quote: AssetEvmSendQuoteRecord): Promise<AssetEvmSendSwapRow> {
    const at = this.now()
    await this.driver.run(
      `INSERT INTO send_asset_evm_swap (
         id, state, created_at, updated_at, payment_hash, asset_id, asset_decimals, asset_units, payout_units,
         evm_amount, token_address, evm_contract_address, evm_chain_id, evm_timeout, valid_until, min_confirmations,
         min_age_seconds, evm_claim_address, evm_refund_address, refund_locktime, provider_pubkey,
         server_pubkey, claim_delay, refund_delay, refund_without_receiver_delay, pk_script,
         lockup_address, refund_pk_script, emulator_pubkey, client_refund_pubkey, receiver_pk_script,
         non_interactive_parameters, rfq_id
       ) VALUES (?, 'quoted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        quote.id,
        at,
        at,
        quote.paymentHash,
        quote.assetId,
        quote.assetDecimals,
        quote.assetUnits,
        quote.payoutUnits,
        quote.evmAmount,
        quote.tokenAddress,
        quote.evmContractAddress,
        quote.evmChainId,
        quote.evmTimeout,
        quote.validUntil,
        quote.minConfirmations,
        quote.minAgeSeconds,
        quote.evmClaimAddress,
        quote.evmRefundAddress,
        quote.refundLocktime,
        quote.providerPubkey,
        quote.serverPubkey,
        quote.claimDelay,
        quote.refundDelay,
        quote.refundWithoutReceiverDelay,
        quote.pkScript,
        quote.lockupAddress,
        quote.refundPkScript,
        quote.emulatorPubkey,
        quote.clientRefundPubkey,
        quote.receiverPkScript,
        quote.nonInteractiveParameters ? '1' : null,
        quote.rfqId,
      ],
    )
    await this.driver.run(
      `INSERT INTO send_asset_evm_swap_event (swap_id, at, from_state, to_state) VALUES (?, ?, NULL, 'quoted')`,
      [quote.id, at],
    )
    return this.get(quote.id)
  }

  async get(id: string): Promise<AssetEvmSendSwapRow> {
    const rows = (await this.driver.all(`SELECT * FROM send_asset_evm_swap WHERE id = ?`, [id])) as Raw[]
    const raw = rows[0]
    if (!raw) throw new Error('no asset evm send swap ' + id)
    return toRow(raw)
  }

  async findByRfqId(rfqId: string): Promise<AssetEvmSendSwapRow | null> {
    const rows = (await this.driver.all(`SELECT * FROM send_asset_evm_swap WHERE rfq_id = ?`, [rfqId])) as Raw[]
    return rows[0] ? toRow(rows[0]) : null
  }

  async findLiveByPaymentHash(paymentHash: string): Promise<AssetEvmSendSwapRow | null> {
    const rows = (await this.driver.all(
      `SELECT * FROM send_asset_evm_swap WHERE payment_hash = ? AND state != 'refused'`,
      [paymentHash],
    )) as Raw[]
    return rows[0] ? toRow(rows[0]) : null
  }

  /**
   * ALWAYS ZERO, and that is a stated policy rather than a stub.
   *
   * Neither leg of this corridor is sats: the client locks an Arkade asset and
   * the solver pays an ERC20. `committedSats` is a sats figure by contract —
   * `ops/pool.ts` sums it against `maxExposedSats` — so there is no honest
   * number to return. The two alternatives were both rejected:
   *
   * - summing atomic units would add an asset amount to a sats total, which is
   *   the mistake `db/assetRfqSwaps.ts` names for the same reason;
   * - converting through the pair's price would make the CAP depend on the same
   *   feed that priced the swap, so one bad rate would misprice the swap AND
   *   widen the bound meant to limit the damage.
   *
   * The consequence is real and deliberate: this corridor is OUTSIDE the house
   * cap. It is bounded instead by its own required per-swap `assetLimits`, and
   * `/api/overview` names it under `exposure.uncountedCorridors` so an operator
   * reads it there rather than discovering it during an incident.
   *
   * @see arkade-os/intent-solver#22 for the full argument and the override.
   */
  async committedSats(): Promise<number> {
    return 0
  }

  /** Exposure in the ASSET's own units — what the cap cannot express. */
  async committedAssetUnits(): Promise<Map<string, bigint>> {
    const placeholders = EVM_SEND_NON_TERMINAL.map(() => '?').join(', ')
    const raws = (await this.driver.all(
      `SELECT asset_id, asset_units FROM send_asset_evm_swap WHERE state IN (${placeholders})`,
      [...EVM_SEND_NON_TERMINAL],
    )) as Raw[]
    const totals = new Map<string, bigint>()
    for (const raw of raws) {
      const assetId = String(raw.asset_id)
      totals.set(assetId, (totals.get(assetId) ?? 0n) + BigInt(String(raw.asset_units)))
    }
    return totals
  }

  async findByStates(states: readonly EvmSendSwapState[]): Promise<AssetEvmSendSwapRow[]> {
    if (states.length === 0) return []
    const placeholders = states.map(() => '?').join(', ')
    const rows = (await this.driver.all(
      'SELECT * FROM send_asset_evm_swap WHERE state IN (' + placeholders + ') ORDER BY created_at ASC',
      [...states],
    )) as Raw[]
    return rows.map(toRow)
  }

  async findLive(): Promise<AssetEvmSendSwapRow[]> {
    return this.findByStates(EVM_SEND_NON_TERMINAL)
  }

  /** @see EvmSendSwapStore.findRefundable — same rule, same eight-leaf script. */
  async findRefundable(): Promise<AssetEvmSendSwapRow[]> {
    const rows = (await this.driver.all(
      `SELECT * FROM send_asset_evm_swap
       WHERE state = 'refused' AND refund_outcome IS NULL
       ORDER BY created_at`,
    )) as Raw[]
    return rows.map(toRow)
  }

  async history(swapId: string): Promise<{ at: number; from: string | null; to: string; detail: string | null }[]> {
    const rows = (await this.driver.all(
      'SELECT at, from_state, to_state, detail FROM send_asset_evm_swap_event WHERE swap_id = ? ORDER BY id ASC',
      [swapId],
    )) as Raw[]
    return rows.map((raw) => ({
      at: Number(raw.at),
      from: text(raw.from_state),
      to: String(raw.to_state),
      detail: text(raw.detail),
    }))
  }

  async page(options: PageOptions = {}): Promise<{ rows: AssetEvmSendSwapRow[]; nextCursor: string | null }> {
    const { sql, params, limit } = pageQuery('send_asset_evm_swap', options)
    const raw = await this.driver.all<Raw & PageRawFields>(sql, params)
    const { page, nextCursor } = takePage(raw, limit)
    return { rows: page.map(toRow), nextCursor }
  }

  /** @see EvmSendSwapStore.transition — the from-state guard is the concurrency control. */
  async transition(
    id: string,
    from: EvmSendSwapState,
    to: EvmSendSwapState,
    fields: Record<string, unknown> = {},
  ): Promise<void> {
    const columns = Object.keys(fields)
    assertColumns(columns, TRANSITION_COLUMNS, 'transition()')
    const at = this.now()
    const assignments = columns.map((column) => column + ' = ?').join(', ')
    const result = await this.driver.run(
      'UPDATE send_asset_evm_swap SET state = ?, updated_at = ?' +
        (assignments ? ', ' + assignments : '') +
        ' WHERE id = ? AND state = ?',
      [to, at, ...columns.map((column) => fields[column] as string | number | null), id, from],
    )
    if ((result?.changes ?? 0) === 0) {
      throw new Error('asset evm send swap ' + id + ' is not in state ' + from)
    }
    await this.driver.run(
      'INSERT INTO send_asset_evm_swap_event (swap_id, at, from_state, to_state) VALUES (?, ?, ?, ?)',
      [id, at, from, to],
    )
  }

  async patch(id: string, fields: Record<string, unknown>): Promise<void> {
    const columns = Object.keys(fields)
    if (columns.length === 0) return
    assertColumns(columns, TRANSITION_COLUMNS, 'patch()')
    const assignments = columns.map((column) => column + ' = ?').join(', ')
    await this.driver.run('UPDATE send_asset_evm_swap SET updated_at = ?, ' + assignments + ' WHERE id = ?', [
      this.now(),
      ...columns.map((column) => fields[column] as string | number | null),
      id,
    ])
  }

  /**
   * Record the refund txid ONLY when the row carries none.
   *
   * Guarded because `patch` is `WHERE id = ?` and a resend path that skipped
   * `transition` would otherwise overwrite the id of a refund already in
   * flight — the row would then wait on a receipt for the losing transaction
   * while the winning one's tokens came back unrecorded. The same hole #36
   * opened on the sats leg.
   */
  async claimRefundTxid(id: string, txid: string): Promise<boolean> {
    const result = await this.driver.run(
      'UPDATE send_asset_evm_swap SET updated_at = ?, evm_refund_txid = ? WHERE id = ? AND evm_refund_txid IS NULL',
      [this.now(), txid, id],
    )
    return (result?.changes ?? 0) > 0
  }

  async fail(id: string, from: EvmSendSwapState, reason: string): Promise<void> {
    await this.transition(id, from, 'stuck', { failure_reason: reason })
  }
}
