/**
 * Durable state for the `onchain:BTC->arkade:<asset>` receive leg.
 *
 * The sats-out mirror is `db/onchainReceiveSwaps.ts` and the lifecycle is
 * identical to it, word for word — the client funds an L1 HTLC, the solver
 * funds an Arkade lockup, a claim reveals `P`, the solver collects. What
 * differs is the DENOMINATION of the lockup, and that shows up as four columns
 * rather than as a different state machine.
 *
 * ONE TABLE BACKS EVERY ASSET MARKET, so `pair` is a column and every reader
 * filters on it — the same shape `db/assetRfqSwaps.ts` uses, and for the same
 * reason: a market is runtime configuration, so a table per market would mean a
 * migration every time an operator adds one.
 *
 * `committedSats` IS INHERITED, deliberately. The base sums `amount_sats` over
 * the non-terminal states, and on this leg `amount_sats` is the BTC the client
 * funds the HTLC with — a real sats figure, and the natural proxy for what the
 * solver stands to lose, since the asset it pays out was priced against exactly
 * that number. Summing `payout_units` instead would add asset atomic units into
 * a sats total, which `assetRfqSwaps.ts` refuses for the same reason. Counting
 * non-terminal rather than exposed-only is the house doctrine stated in
 * `evmSendSwaps.ts`: a quote the solver has issued is capacity it may have to
 * honour.
 */

import { betterSqliteDriver, type SqlDriver } from './driver.js'
import { BaseSwapStore, type RawRow, type StoreShape } from './baseSwapStore.js'
import {
  ONCHAIN_ASSET_EXPOSED,
  ONCHAIN_ASSET_NON_TERMINAL,
  type OnchainAssetReceiveState,
} from '@arkade-os/solver-core/core/onchainAssetSwapState.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'

export type { OnchainAssetReceiveState }
export const NON_TERMINAL = ONCHAIN_ASSET_NON_TERMINAL
export const EXPOSED = ONCHAIN_ASSET_EXPOSED

const LEGAL_EDGES: Record<OnchainAssetReceiveState, readonly OnchainAssetReceiveState[]> = {
  quoted: ['awaiting_confirmations', 'refused'],
  awaiting_confirmations: ['funding_arkade', 'refused'],
  funding_arkade: ['awaiting_claim', 'refused', 'stuck'],
  awaiting_claim: ['claimed', 'refunding_arkade', 'stuck'],
  claimed: ['settled', 'stuck'],
  refunding_arkade: ['claimed', 'refunded', 'stuck'],
  settled: [],
  refunded: [],
  refused: [],
  stuck: [],
}

const TRANSITION_COLUMNS = new Set([
  'funding_txid',
  'funding_vout',
  'arkade_fund_txid',
  'preimage',
  'arkade_claim_txid',
  'onchain_claim_txid',
  'arkade_refund_txid',
  'failure_reason',
])

/**
 * `onchain_claim_txid` and `arkade_refund_txid` are in BOTH sets, for the
 * reason the sats leg documents: the automatic paths record them on an edge,
 * while an operator override runs against a `stuck` row — which has no outgoing
 * edge — and must still record the txid it broadcast.
 */
const PATCH_COLUMNS = new Set(['arkade_refund_txid', 'onchain_claim_txid'])

export interface OnchainAssetReceiveSwapRow {
  id: string
  state: OnchainAssetReceiveState
  createdAt: number
  updatedAt: number
  /** The corridor this row belongs to — one table backs every market. */
  pair: string
  paymentHash: string
  /** What the client funds the L1 HTLC with, and the exposure figure. */
  amountSats: number
  /**
   * Atomic units of the asset the solver owes, FIXED AT QUOTE TIME.
   *
   * Persisted rather than re-derived, and that is the money rule: the client
   * funded the HTLC against this number, so a price that has moved since must
   * never re-price it. A `bigint`, because an asset amount is not bounded by
   * what a double holds.
   */
  payoutUnits: bigint
  /** Canonical 68-hex id of the asset being paid out. */
  payoutAssetId: string
  /** The asset's declared precision, snapshotted so a config edit cannot restate a settled row. */
  payoutDecimals: number
  /**
   * Sats the lockup output carries ALONGSIDE the asset.
   *
   * An Arkade output is a Bitcoin output whatever it carries, so the asset
   * needs a non-dust sats carrier to ride on. Snapshotted from the network's
   * own threshold at quote time rather than fixed, because that is what
   * `fundLockup` already reads it from.
   */
  lockupSats: number
  htlcLocktime: number
  refundLocktime: number
  minConfirmations: number
  providerPubkey: string
  clientPayoutPubkey: string
  serverPubkey: string
  claimDelay: number
  refundDelay: number
  refundWithoutReceiverDelay: number
  emulatorPubkey: string
  pkScript: string
  lockupAddress: string
  refundPkScript: string
  clientPayoutPkScript: string
  nonInteractiveParameters: boolean | null
  htlcPubkey: string
  clientOnchainRefundPubkey: string
  onchainAddress: string
  onchainPkScript: string
  claimPacket: string
  fundingTxid: string | null
  fundingVout: number | null
  arkadeFundTxid: string | null
  preimage: string | null
  arkadeClaimTxid: string | null
  /** @see db/onchainReceiveSwaps.ts — null on a `settled` row means the witness-recovery path. */
  onchainClaimTxid: string | null
  arkadeRefundTxid: string | null
  failureReason: string | null
  rfqId: string | null
  /** When a worker won the exclusive right to fund. Never cleared; @see claimFundLease. */
  fundStartedAt: number | null
}

const COLUMNS = `
  id                            TEXT PRIMARY KEY,
  state                         TEXT NOT NULL,
  created_at                    INTEGER NOT NULL,
  updated_at                    INTEGER NOT NULL,
  pair                          TEXT NOT NULL,
  payment_hash                  TEXT NOT NULL,
  amount_sats                   INTEGER NOT NULL,
  payout_units                  TEXT NOT NULL,
  payout_asset_id               TEXT NOT NULL,
  payout_decimals               INTEGER NOT NULL,
  lockup_sats                   INTEGER NOT NULL,
  htlc_locktime                 INTEGER NOT NULL,
  refund_locktime               INTEGER NOT NULL,
  min_confirmations             INTEGER NOT NULL,
  provider_pubkey               TEXT NOT NULL,
  client_payout_pubkey          TEXT NOT NULL,
  server_pubkey                 TEXT NOT NULL,
  claim_delay                   INTEGER NOT NULL,
  refund_delay                  INTEGER NOT NULL,
  refund_without_receiver_delay INTEGER NOT NULL,
  emulator_pubkey               TEXT NOT NULL,
  pk_script                     TEXT NOT NULL,
  lockup_address                TEXT NOT NULL,
  refund_pk_script              TEXT NOT NULL,
  client_payout_pk_script       TEXT NOT NULL,
  non_interactive_parameters    TEXT,
  htlc_pubkey                   TEXT NOT NULL,
  client_onchain_refund_pubkey  TEXT NOT NULL,
  onchain_address               TEXT NOT NULL,
  onchain_pk_script             TEXT NOT NULL,
  claim_packet                  TEXT NOT NULL,
  funding_txid                  TEXT,
  funding_vout                  INTEGER,
  arkade_fund_txid              TEXT,
  preimage                      TEXT,
  arkade_claim_txid             TEXT,
  onchain_claim_txid            TEXT,
  arkade_refund_txid            TEXT,
  failure_reason                TEXT,
  rfq_id                        TEXT,
  fund_started_at               INTEGER
`

const SCHEMA = `
CREATE TABLE IF NOT EXISTS receive_onchain_asset_swap (${COLUMNS});
CREATE INDEX IF NOT EXISTS idx_receive_onchain_asset_swap_state ON receive_onchain_asset_swap(state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_receive_onchain_asset_swap_live_hash
  ON receive_onchain_asset_swap(payment_hash) WHERE state != 'refused';
CREATE INDEX IF NOT EXISTS idx_receive_onchain_asset_swap_rfq_id
  ON receive_onchain_asset_swap(rfq_id) WHERE rfq_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS receive_onchain_asset_swap_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  swap_id    TEXT NOT NULL REFERENCES receive_onchain_asset_swap(id),
  at         INTEGER NOT NULL,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_receive_onchain_asset_swap_event_swap
  ON receive_onchain_asset_swap_event(swap_id);
`

type Raw = Record<string, string | number | null>

const toRow = (raw: Raw): OnchainAssetReceiveSwapRow => ({
  id: String(raw.id),
  state: String(raw.state) as OnchainAssetReceiveState,
  createdAt: Number(raw.created_at),
  updatedAt: Number(raw.updated_at),
  pair: String(raw.pair),
  paymentHash: String(raw.payment_hash),
  amountSats: Number(raw.amount_sats),
  // Through the decimal STRING, never through Number: an 18-decimal payout is
  // past what a double holds exactly, and rounding it here would move money.
  payoutUnits: BigInt(String(raw.payout_units)),
  payoutAssetId: String(raw.payout_asset_id),
  payoutDecimals: Number(raw.payout_decimals),
  lockupSats: Number(raw.lockup_sats),
  htlcLocktime: Number(raw.htlc_locktime),
  refundLocktime: Number(raw.refund_locktime),
  minConfirmations: Number(raw.min_confirmations),
  providerPubkey: String(raw.provider_pubkey),
  clientPayoutPubkey: String(raw.client_payout_pubkey),
  serverPubkey: String(raw.server_pubkey),
  claimDelay: Number(raw.claim_delay),
  refundDelay: Number(raw.refund_delay),
  refundWithoutReceiverDelay: Number(raw.refund_without_receiver_delay),
  emulatorPubkey: String(raw.emulator_pubkey),
  pkScript: String(raw.pk_script),
  lockupAddress: String(raw.lockup_address),
  refundPkScript: String(raw.refund_pk_script),
  clientPayoutPkScript: String(raw.client_payout_pk_script),
  nonInteractiveParameters:
    raw.non_interactive_parameters === null || raw.non_interactive_parameters === undefined
      ? null
      : raw.non_interactive_parameters === '1',
  htlcPubkey: String(raw.htlc_pubkey),
  clientOnchainRefundPubkey: String(raw.client_onchain_refund_pubkey),
  onchainAddress: String(raw.onchain_address),
  onchainPkScript: String(raw.onchain_pk_script),
  claimPacket: String(raw.claim_packet),
  fundingTxid: raw.funding_txid === null ? null : String(raw.funding_txid),
  fundingVout: raw.funding_vout === null || raw.funding_vout === undefined ? null : Number(raw.funding_vout),
  arkadeFundTxid: raw.arkade_fund_txid === null ? null : String(raw.arkade_fund_txid),
  preimage: raw.preimage === null ? null : String(raw.preimage),
  arkadeClaimTxid: raw.arkade_claim_txid === null ? null : String(raw.arkade_claim_txid),
  onchainClaimTxid: raw.onchain_claim_txid === null ? null : String(raw.onchain_claim_txid),
  arkadeRefundTxid: raw.arkade_refund_txid === null ? null : String(raw.arkade_refund_txid),
  failureReason: raw.failure_reason === null ? null : String(raw.failure_reason),
  rfqId: raw.rfq_id === null || raw.rfq_id === undefined ? null : String(raw.rfq_id),
  fundStartedAt: raw.fund_started_at === null || raw.fund_started_at === undefined ? null : Number(raw.fund_started_at),
})

export interface OnchainAssetReceiveQuoteRecord {
  id: string
  pair: string
  paymentHash: string
  amountSats: number
  payoutUnits: bigint
  payoutAssetId: string
  payoutDecimals: number
  lockupSats: number
  htlcLocktime: number
  refundLocktime: number
  minConfirmations: number
  providerPubkey: string
  clientPayoutPubkey: string
  serverPubkey: string
  claimDelay: number
  refundDelay: number
  refundWithoutReceiverDelay: number
  emulatorPubkey: string
  pkScript: string
  lockupAddress: string
  refundPkScript: string
  clientPayoutPkScript: string
  nonInteractiveParameters: boolean
  htlcPubkey: string
  clientOnchainRefundPubkey: string
  onchainAddress: string
  onchainPkScript: string
  claimPacket: string
  rfqId?: string
}

/** Identifiers only, for the reason the sats leg gives: an amount is a filter, not a search. */
export const ONCHAIN_ASSET_RECEIVE_SEARCH_COLUMNS: readonly string[] = [
  'id',
  'payment_hash',
  'lockup_address',
  'onchain_address',
  'funding_txid',
  'arkade_fund_txid',
  'arkade_claim_txid',
  'onchain_claim_txid',
  'arkade_refund_txid',
  'rfq_id',
]

const SHAPE: StoreShape<OnchainAssetReceiveSwapRow, OnchainAssetReceiveState> = {
  table: 'receive_onchain_asset_swap',
  eventTable: 'receive_onchain_asset_swap_event',
  noun: 'onchain asset receive swap',
  lifecycleLabel: 'onchain asset receive lifecycle',
  searchColumns: ONCHAIN_ASSET_RECEIVE_SEARCH_COLUMNS,
  legalEdges: LEGAL_EDGES,
  transitionColumns: TRANSITION_COLUMNS,
  patchColumns: PATCH_COLUMNS,
  live: NON_TERMINAL,
  exposed: EXPOSED,
  failStates: { exposed: 'stuck', clean: 'refused' },
  toRow: (raw: RawRow) => toRow(raw as Raw),
}

export class OnchainAssetReceiveSwapStore extends BaseSwapStore<OnchainAssetReceiveSwapRow, OnchainAssetReceiveState> {
  protected readonly shape = SHAPE

  static async open(driver: SqlDriver | string, now: () => number = nowSeconds): Promise<OnchainAssetReceiveSwapStore> {
    const store = new OnchainAssetReceiveSwapStore(
      typeof driver === 'string' ? betterSqliteDriver(driver) : driver,
      now,
    )
    await store.driver.exec(SCHEMA)
    return store
  }

  /**
   * Claim the exclusive right to fund this swap's lockup.
   *
   * Returns true to exactly ONE caller. Without it two workers in the same
   * window both read an unfunded script — the first one's payment has not
   * landed, which is why the second is still running — and both pay, out of the
   * solver's own asset float. The compare-and-swap on `state` that follows the
   * payment gates RECORDING, not spending.
   *
   * No TTL, for the reason the sats leg gives: a lease that expires is one that
   * lets a second worker pay while the first may still be in flight.
   */
  async claimFundLease(id: string, from: OnchainAssetReceiveState): Promise<boolean> {
    const result = await this.driver.run(
      `UPDATE receive_onchain_asset_swap SET fund_started_at = ?, updated_at = ?
       WHERE id = ? AND state = ? AND fund_started_at IS NULL`,
      [this.now(), this.now(), id, from],
    )
    return result.changes === 1
  }

  /** Give the lease back when the payment provably did not happen — only when `fund()` THREW. */
  async releaseFundLease(id: string): Promise<void> {
    await this.driver.run(`UPDATE receive_onchain_asset_swap SET fund_started_at = NULL WHERE id = ?`, [id])
  }

  async insertQuote(quote: OnchainAssetReceiveQuoteRecord): Promise<OnchainAssetReceiveSwapRow> {
    const at = this.now()
    await this.driver.run(
      `INSERT INTO receive_onchain_asset_swap (
        id, state, created_at, updated_at, pair, payment_hash, amount_sats,
        payout_units, payout_asset_id, payout_decimals, lockup_sats,
        htlc_locktime, refund_locktime, min_confirmations,
        provider_pubkey, client_payout_pubkey, server_pubkey, claim_delay, refund_delay,
        refund_without_receiver_delay, emulator_pubkey,
        pk_script, lockup_address, refund_pk_script, client_payout_pk_script,
        non_interactive_parameters, htlc_pubkey, client_onchain_refund_pubkey,
        onchain_address, onchain_pk_script, claim_packet, rfq_id
      ) VALUES (?, 'quoted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        quote.id,
        at,
        at,
        quote.pair,
        quote.paymentHash,
        quote.amountSats,
        // As a decimal string: SQLite INTEGER is 64-bit and an 18-decimal asset
        // amount is not, so TEXT is the only lossless column type here.
        quote.payoutUnits.toString(),
        quote.payoutAssetId,
        quote.payoutDecimals,
        quote.lockupSats,
        quote.htlcLocktime,
        quote.refundLocktime,
        quote.minConfirmations,
        quote.providerPubkey,
        quote.clientPayoutPubkey,
        quote.serverPubkey,
        quote.claimDelay,
        quote.refundDelay,
        quote.refundWithoutReceiverDelay,
        quote.emulatorPubkey,
        quote.pkScript,
        quote.lockupAddress,
        quote.refundPkScript,
        quote.clientPayoutPkScript,
        quote.nonInteractiveParameters ? '1' : null,
        quote.htlcPubkey,
        quote.clientOnchainRefundPubkey,
        quote.onchainAddress,
        quote.onchainPkScript,
        quote.claimPacket,
        quote.rfqId ?? null,
      ],
    )
    await this.recordEvent(quote.id, null, 'quoted', null)
    return this.get(quote.id)
  }

  async findLiveByPaymentHash(paymentHash: string): Promise<OnchainAssetReceiveSwapRow | null> {
    const raw = await this.driver.get<Raw>(
      `SELECT * FROM receive_onchain_asset_swap WHERE payment_hash = ? AND state != 'refused' LIMIT 1`,
      [paymentHash],
    )
    return raw ? toRow(raw) : null
  }
}
