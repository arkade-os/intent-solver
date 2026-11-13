/**
 * `refund_locktime` and the delays derive the script: without them on disk a funded lockup is
 * unrefundable, not merely unclaimable. Commit intent BEFORE an irreversible side effect.
 */

import { betterSqliteDriver, type SqlDriver } from './driver.js'
import {
  BaseSwapStore,
  addColumns,
  numberOrNull,
  text,
  type RawRow,
  type StoreShape,
  type SwapRepository,
} from './baseSwapStore.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import { UniqueConstraintError } from '@arkade-os/solver-core/core/driver.js'
import { LnSendMachine, type LnSendSwapState } from '../machines/lnSend.js'
import { swapsSql } from './swaps.sql.js'

export type SendSwapState = LnSendSwapState
export const NON_TERMINAL: readonly SendSwapState[] = LnSendMachine.live
export const EXPOSED: readonly SendSwapState[] = LnSendMachine.exposed
export const LEGAL_EDGES_FOR_TEST: Record<SendSwapState, readonly SendSwapState[]> = LnSendMachine.edges

/** The only caller keys that reach the column names interpolated into the UPDATE builders. */
const TRANSITION_COLUMNS = new Set([
  'lockup_txid',
  'lockup_vout',
  'lockup_value',
  'idempotency_key',
  'pay_attempted_at',
  // Set with funded -> paying so the identity is never lost between two writes.
  'payment_backend',
  'payment_wallet',
  'payment_id',
  'preimage',
  'claim_ark_txid',
  'failure_reason',
  'lockup_outpoints',
])
const PATCH_COLUMNS = new Set([
  'lockup_value',
  'payment_id',
  'pay_attempted_at',
  'refund_ark_txid',
  'refund_outcome',
  'payment_evidence',
  'payment_failure_reason',
  'refund_attempt',
  'payment_backend',
  'payment_wallet',
  'routing_fee_paid_sats',
  'unrolled_claim',
  'claim_batch',
  'claim_ark_txid',
])

export interface SendSwapRow {
  id: string
  state: SendSwapState
  createdAt: number
  updatedAt: number
  invoice: string
  paymentHash: string
  amountSats: number
  invoiceExpiresAt: number
  /** The unix-seconds deadline the quote was priced against; `refundLocktime` may be in another unit. */
  quotedRefundDeadline: number | null
  /** Everything below reconstructs the script. Losing any of it loses the funds. */
  refundLocktime: number
  senderPubkey: string
  receiverPubkey: string
  serverPubkey: string
  claimDelay: number
  refundDelay: number
  refundWithoutReceiverDelay: number
  pkScript: string
  lockupAddress: string
  refundPkScript: string | null
  emulatorPubkey: string | null
  /** Null on older rows and CLI self-test quotes; both rebuild the three-leaf script. */
  clientRefundPubkey: string | null
  /** Where `nonInteractiveClaim` pays; snapshotted at quote time, never re-fetched. */
  receiverPkScript: string | null
  /** Null means "rebuild the eight-leaf shape", not a refusal. */
  nonInteractiveParameters: boolean | null
  refundArkTxid: string | null
  /** `external`: someone else moved the funds. */
  refundOutcome: 'pushed' | 'external' | null
  /**
   * Not `refundOutcome`, which tells the CLIENT they were refunded: a failed attempt must never read as one.
   * `'pushed'` | `'nothing-at-script'` | `'failed: <reason>'` | null (never ran).
   */
  refundAttempt: string | null
  /** A payment id means nothing outside the backend and wallet that issued it. Null is unknown, never a match. */
  paymentBackend: string | null
  paymentWallet: string | null
  quotedRoutingFeeSats: number | null
  lockupTxid: string | null
  lockupVout: number | null
  lockupValue: number | null
  idempotencyKey: string | null
  payAttemptedAt: number | null
  paymentId: string | null
  preimage: string | null
  claimArkTxid: string | null
  claimBatch: string | null
  /** JSON, by outpoint: the last step of each L1 claim of a lockup output the client unrolled. */
  unrolledClaim: string | null
  /** JSON `[{txid, vout, value}]`: the lockup outputs adopted at funding, each to be collected. Null on older rows. */
  lockupOutpoints: string | null
  failureReason: string | null
  /** Diagnostic only: decides nothing about whether money moves. */
  paymentEvidence: string | null
  /** The backend's verdict on the payment; `failureReason` is ours about the swap, and they can disagree. */
  paymentFailureReason: string | null
  /** Realized routing cost. NULL is unmeasured, never free. */
  routingFeePaidSats: number | null
  rfqId: string | null
}

type Raw = Record<string, string | number | null>

const toRow = (raw: Raw): SendSwapRow => ({
  id: String(raw.id),
  state: String(raw.state) as SendSwapState,
  createdAt: Number(raw.created_at),
  updatedAt: Number(raw.updated_at),
  invoice: String(raw.invoice),
  paymentHash: String(raw.payment_hash),
  amountSats: Number(raw.amount_sats),
  invoiceExpiresAt: Number(raw.invoice_expires_at),
  quotedRefundDeadline: numberOrNull(raw.quoted_refund_deadline),
  refundLocktime: Number(raw.refund_locktime),
  senderPubkey: String(raw.sender_pubkey),
  receiverPubkey: String(raw.receiver_pubkey),
  serverPubkey: String(raw.server_pubkey),
  claimDelay: Number(raw.claim_delay),
  refundDelay: Number(raw.refund_delay),
  refundWithoutReceiverDelay: Number(raw.refund_without_receiver_delay),
  pkScript: String(raw.pk_script),
  lockupAddress: String(raw.lockup_address),
  refundPkScript: raw.refund_pk_script === null ? null : String(raw.refund_pk_script),
  emulatorPubkey: raw.emulator_pubkey === null ? null : String(raw.emulator_pubkey),
  clientRefundPubkey: text(raw.client_refund_pubkey),
  receiverPkScript: text(raw.receiver_pk_script),
  nonInteractiveParameters:
    raw.non_interactive_parameters === null || raw.non_interactive_parameters === undefined
      ? null
      : raw.non_interactive_parameters === '1',
  refundArkTxid: raw.refund_ark_txid === null ? null : String(raw.refund_ark_txid),
  refundOutcome: raw.refund_outcome === null ? null : (String(raw.refund_outcome) as 'pushed' | 'external'),
  refundAttempt: text(raw.refund_attempt),
  paymentBackend: text(raw.payment_backend),
  paymentWallet: text(raw.payment_wallet),
  quotedRoutingFeeSats: numberOrNull(raw.quoted_routing_fee_sats),
  lockupTxid: raw.lockup_txid === null ? null : String(raw.lockup_txid),
  lockupVout: raw.lockup_vout === null ? null : Number(raw.lockup_vout),
  lockupValue: raw.lockup_value === null ? null : Number(raw.lockup_value),
  idempotencyKey: raw.idempotency_key === null ? null : String(raw.idempotency_key),
  payAttemptedAt: raw.pay_attempted_at === null ? null : Number(raw.pay_attempted_at),
  paymentId: raw.payment_id === null ? null : String(raw.payment_id),
  preimage: raw.preimage === null ? null : String(raw.preimage),
  claimArkTxid: raw.claim_ark_txid === null ? null : String(raw.claim_ark_txid),
  claimBatch: text(raw.claim_batch),
  failureReason: raw.failure_reason === null ? null : String(raw.failure_reason),
  paymentEvidence: text(raw.payment_evidence),
  paymentFailureReason: text(raw.payment_failure_reason),
  rfqId: text(raw.rfq_id),
  routingFeePaidSats: numberOrNull(raw.routing_fee_paid_sats),
  unrolledClaim: text(raw.unrolled_claim),
  lockupOutpoints: text(raw.lockup_outpoints),
})

export interface QuoteRecord {
  id: string
  invoice: string
  paymentHash: string
  amountSats: number
  invoiceExpiresAt: number
  quotedRefundDeadline: number
  refundLocktime: number
  senderPubkey: string
  receiverPubkey: string
  serverPubkey: string
  claimDelay: number
  refundDelay: number
  refundWithoutReceiverDelay: number
  pkScript: string
  lockupAddress: string
  refundPkScript?: string
  emulatorPubkey?: string
  clientRefundPubkey?: string
  receiverPkScript?: string
  /** Required: an omitted value persists NULL, rebuilt as eight leaves against a nine-leaf lockup. */
  nonInteractiveParameters: boolean
  quotedRoutingFeeSats?: number
  rfqId?: string
}

/** Identifiers only: a substring match on a number matches too much. Interpolated into SQL, so never request-derived. */
export const SEND_SEARCH_COLUMNS: readonly string[] = [
  'id',
  'payment_hash',
  'invoice',
  'lockup_address',
  'lockup_txid',
  'claim_ark_txid',
  'refund_ark_txid',
  'unrolled_claim',
  'rfq_id',
]

const SHAPE: StoreShape<SendSwapRow, SendSwapState> = {
  table: 'send_swap',
  eventTable: 'send_swap_event',
  noun: 'swap',
  lifecycleLabel: 'swap lifecycle',
  searchColumns: SEND_SEARCH_COLUMNS,
  legalEdges: LnSendMachine.edges,
  transitionColumns: TRANSITION_COLUMNS,
  patchColumns: PATCH_COLUMNS,
  live: NON_TERMINAL,
  exposed: EXPOSED,
  toRow: (raw: RawRow) => toRow(raw as Raw),
}

export interface SendSwapRepository extends SwapRepository<SendSwapRow, SendSwapState> {
  compareAndSwapClaimBatch(id: string, expected: string | null, next: string | null): Promise<boolean>
  insertQuote(quote: QuoteRecord): Promise<SendSwapRow>
  findByLockupTxid(txid: string): Promise<SendSwapRow | null>
  findRefundable(now: number): Promise<SendSwapRow[]>
  findMostRecent(): Promise<SendSwapRow | null>
  noteFundings(id: string, outputs: readonly { txid: string; vout: number; value: number }[]): Promise<void>
}

export class SwapStore extends BaseSwapStore<SendSwapRow, SendSwapState> implements SendSwapRepository {
  protected readonly shape = SHAPE

  async compareAndSwapClaimBatch(id: string, expected: string | null, next: string | null): Promise<boolean> {
    const result = await this.driver.run(swapsSql.compareAndSwapClaimBatch, [next, this.now(), id, expected])
    return result.changes === 1
  }

  static async open(driver: SqlDriver | string, now: () => number = nowSeconds): Promise<SwapStore> {
    const store = new SwapStore(typeof driver === 'string' ? betterSqliteDriver(driver) : driver, now)
    await store.driver.exec(swapsSql.schema)
    await store.migrate()
    return store
  }

  private async migrate(): Promise<void> {
    await addColumns(this.driver, 'send_swap', [
      ['refund_attempt', 'TEXT'],
      ['payment_backend', 'TEXT'],
      ['payment_wallet', 'TEXT'],
      ['refund_pk_script', 'TEXT'],
      ['emulator_pubkey', 'TEXT'],
      ['refund_ark_txid', 'TEXT'],
      ['refund_outcome', 'TEXT'],
      ['rfq_id', 'TEXT'],
      ['client_refund_pubkey', 'TEXT'],
      ['receiver_pk_script', 'TEXT'],
      ['payment_evidence', 'TEXT'],
      ['payment_failure_reason', 'TEXT'],
      ['non_interactive_parameters', 'TEXT'],
      ['quoted_routing_fee_sats', 'INTEGER'],
      // Nothing reads or writes it; kept because dropping a column is a table rebuild.
      ['fee_handle', 'TEXT'],
      // Not TEXT: that affinity would store sats as strings that sort and sum wrongly.
      ['routing_fee_paid_sats', 'INTEGER'],
      ['quoted_refund_deadline', 'INTEGER'],
      ['unrolled_claim', 'TEXT'],
      ['claim_batch', 'TEXT'],
      ['lockup_outpoints', 'TEXT'],
    ])

    // A column-level UNIQUE on payment_hash burns a hash forever; SQLite drops it only by rebuilding.
    if (await this.hasLegacyHashConstraint()) {
      const names = (await this.driver.all<{ name: string }>(swapsSql.tableInfo)).map((c) => c.name).join(', ')
      // FKs off so the transient DROP cannot trip send_swap_event's reference; D1 never has the legacy constraint.
      await this.setForeignKeys(false)
      try {
        await this.driver.transaction(async () => {
          await this.driver.exec(swapsSql.dropRebuildTable)
          await this.driver.exec(swapsSql.createRebuildTable)
          await this.driver.exec(swapsSql.copyIntoRebuildTable(names))
          await this.driver.exec(swapsSql.dropTable)
          await this.driver.exec(swapsSql.renameRebuildTable)
        })
      } finally {
        await this.setForeignKeys(true)
      }
      // Recreate the indexes the dropped table took with it.
      await this.driver.exec(swapsSql.schema)
    }

    // Retired sentinel: 'external' was once stored in refund_ark_txid.
    await this.driver.run(swapsSql.backfillExternalRefundOutcome)
    await this.driver.run(swapsSql.backfillPushedRefundOutcome)
  }

  /** Best-effort: D1 rejects the PRAGMA but already defaults foreign keys off. */
  private async setForeignKeys(on: boolean): Promise<void> {
    try {
      await this.driver.exec(swapsSql.setForeignKeys(on))
    } catch {
      // Driver manages foreign keys itself; nothing to do.
    }
  }

  /** The TEXT PRIMARY KEY has an autoindex too; only one on payment_hash is the legacy UNIQUE. */
  private async hasLegacyHashConstraint(): Promise<boolean> {
    const indexes = await this.driver.all<{ name: string }>(swapsSql.indexList)
    for (const index of indexes) {
      const name = String(index.name)
      if (!name.startsWith('sqlite_autoindex_send_swap')) continue
      const cols = await this.driver.all<{ name: string }>(swapsSql.indexInfo(name))
      if (cols.some((c) => c.name === 'payment_hash')) return true
    }
    return false
  }

  /** One live swap per hash: two lockups against one payment leave the loser claimed with no refund. */
  async insertQuote(quote: QuoteRecord): Promise<SendSwapRow> {
    const at = this.now()
    const inserted = await this.driver.run(swapsSql.insertQuoteUnlessHashLive, [
      quote.id,
      at,
      at,
      quote.invoice,
      quote.paymentHash,
      quote.amountSats,
      quote.invoiceExpiresAt,
      quote.quotedRefundDeadline,
      quote.refundLocktime,
      quote.senderPubkey,
      quote.receiverPubkey,
      quote.serverPubkey,
      quote.claimDelay,
      quote.refundDelay,
      quote.refundWithoutReceiverDelay,
      quote.pkScript,
      quote.lockupAddress,
      quote.refundPkScript ?? null,
      quote.emulatorPubkey ?? null,
      quote.clientRefundPubkey ?? null,
      quote.receiverPkScript ?? null,
      // `false` stores NULL on purpose: `covenantScriptFromRow` treats them identically.
      quote.nonInteractiveParameters ? '1' : null,
      quote.quotedRoutingFeeSats ?? null,
      quote.rfqId ?? null,
      quote.paymentHash,
    ])
    // `WHERE NOT EXISTS`, not an index: a lost race is zero changes, never a driver error.
    if (inserted.changes !== 1) throw new UniqueConstraintError('UNIQUE constraint failed: send_swap.payment_hash')
    await this.recordEvent(quote.id, null, 'quoted', null)
    return this.get(quote.id)
  }

  async findByLockupTxid(txid: string): Promise<SendSwapRow | null> {
    const raw = await this.driver.get<Raw>(swapsSql.selectNewestByLockupTxid, [txid])
    return raw ? toRow(raw) : null
  }

  /** The row that still blocks this hash, including a funded refusal awaiting proof of refund. */
  override async findLiveByPaymentHash(paymentHash: string): Promise<SendSwapRow | null> {
    const raw = await this.driver.get<Raw>(swapsSql.selectBlockingByPaymentHash, [paymentHash])
    return raw ? toRow(raw) : null
  }

  /**
   * `stuck` excluded: we may have paid and the claim leaf never expires. With `client_refund_pubkey`
   * the `nonInteractiveRefund` leaf has no timelock; without it `refund` waits for `refundLocktime`.
   */
  async findRefundable(now: number): Promise<SendSwapRow[]> {
    const rows = await this.driver.all<Raw>(swapsSql.selectRefundable, [now])
    return rows.map(toRow)
  }

  /** rowid breaks ties: `created_at` is whole seconds. */
  async findMostRecent(): Promise<SendSwapRow | null> {
    const raw = await this.driver.get<Raw>(swapsSql.selectMostRecent)
    return raw ? toRow(raw) : null
  }

  async noteFundings(id: string, outputs: readonly { txid: string; vout: number; value: number }[]): Promise<void> {
    if (outputs.length === 0) return
    const [row] = await this.driver.all<Raw>(swapsSql.selectStateById, [id])
    if (!row) return
    const state = String(row.state) as SendSwapState

    const seen = await this.driver.all<Raw>(swapsSql.selectFundingNotes, [id])
    const already = new Set(seen.map((e) => String(e.detail)))

    for (const output of outputs) {
      const detail = `funding ${output.txid}:${output.vout} — ${output.value.toLocaleString('en-US')} sats`
      if (already.has(detail)) continue
      already.add(detail)
      await this.recordEvent(id, state, state, detail)
    }
  }

  /** A refund moves money but is no transition, so it is logged here as a `from === to` note, once for every call site. */
  override async patch(id: string, fields: Record<string, unknown>): Promise<void> {
    const notable = fields.refund_outcome !== undefined
    const [before] = notable ? await this.driver.all<Raw>(this.sql.selectById, [id]) : [null]

    await super.patch(id, fields)

    if (fields.refund_outcome !== undefined && fields.refund_outcome !== null) {
      const txid = fields.refund_ark_txid
      const detail = `refund ${String(fields.refund_outcome)}${typeof txid === 'string' ? ` ${txid}` : ''}`
      if (before) {
        const state = String(before.state) as SendSwapState
        await this.recordEvent(id, state, state, detail)
      }
    }
  }
}
