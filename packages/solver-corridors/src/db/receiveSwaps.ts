/** This service funds its OWN Arkade lockup: losing `refund_locktime` loses the provider's recourse to that capital. */

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
import { LnReceiveMachine, type LnReceiveSwapState } from '../machines/lnReceive.js'
import { receiveSwapsSql } from './receiveSwaps.sql.js'

export type ReceiveSwapState = LnReceiveSwapState

export const NON_TERMINAL: readonly ReceiveSwapState[] = LnReceiveMachine.live
export const EXPOSED: readonly ReceiveSwapState[] = LnReceiveMachine.exposed

// No `refund_locktime`: the pkScript is derived from it.
const TRANSITION_COLUMNS = new Set([
  'htlc_expires_at',
  'arkade_lockup_txid',
  'arkade_lockup_vout',
  'arkade_lockup_value',
  'preimage',
  'refund_ark_txid',
  'failure_reason',
  'fund_started_at',
])
/** `refund_ark_txid` is in both sets: `refundNow` records it on `stuck`, which has no outgoing edge. */
const PATCH_COLUMNS = new Set([
  'revealed_at',
  'stamped_at',
  'settle_attempted_at',
  'arkade_lockup_value',
  'refund_ark_txid',
  'unrolled_refund',
])

export interface ReceiveSwapRow {
  id: string
  state: ReceiveSwapState
  createdAt: number
  updatedAt: number

  paymentHash: string
  amountSats: number
  /** Fixed at quote time: a client who already paid cannot have the payout recomputed against a changed fee. */
  payoutSats: number
  invoice: string
  invoiceWalletFingerprint: string | null
  invoiceBackendName: string | null
  invoiceExpiresAt: number
  htlcExpiresAt: number | null

  payoutAddress: string
  payoutPkScript: string
  /** The covenant's `receiver` role on this leg. */
  payoutPubkey: string
  /** Sealed to covclaimd; forwarded verbatim, never decrypted. */
  claimPacket: string | null

  /** Immutable: `pkScript` is derived from it. */
  refundLocktime: number
  /** The covenant's `client` role on this leg (see the role-inversion note in `src/arkade/covenant.ts`). */
  solverPubkey: string
  serverPubkey: string
  claimDelay: number
  refundDelay: number
  refundWithoutReceiverDelay: number
  emulatorPubkey: string
  pkScript: string
  lockupAddress: string
  solverRefundPkScript: string
  /** Null means "rebuild the eight-leaf shape", not a refusal. */
  nonInteractiveParameters: boolean | null

  fundStartedAt: number | null

  arkadeLockupTxid: string | null
  arkadeLockupVout: number | null
  arkadeLockupValue: number | null
  /** A data fact, not a state, so a failed reveal retries without re-funding. */
  revealedAt: number | null
  /** `claim_packet` says what a funding WOULD carry; only this says what an adopted one did. */
  stampedAt: number | null
  /** Written BEFORE `settleHold` is called, so a resumed process can tell "not attempted" from "succeeded". */
  settleAttemptedAt: number | null

  /** Set only once verified against `paymentHash`. */
  preimage: string | null
  refundArkTxid: string | null
  /** JSON `UnrolledSpendRecord`: the L1 refund of a lockup the client unrolled. */
  unrolledRefund: string | null

  failureReason: string | null
  rfqId: string | null
}

type Raw = Record<string, string | number | null>

const toRow = (raw: Raw): ReceiveSwapRow => ({
  id: String(raw.id),
  state: String(raw.state) as ReceiveSwapState,
  createdAt: Number(raw.created_at),
  updatedAt: Number(raw.updated_at),
  paymentHash: String(raw.payment_hash),
  amountSats: Number(raw.amount_sats),
  // Pre-fee rows charged nothing, so the payout WAS the amount.
  payoutSats: numberOrNull(raw.payout_sats) ?? Number(raw.amount_sats),
  invoice: String(raw.invoice),
  invoiceWalletFingerprint: text(raw.invoice_wallet_fingerprint),
  invoiceBackendName: text(raw.invoice_backend_name),
  invoiceExpiresAt: Number(raw.invoice_expires_at),
  htlcExpiresAt: numberOrNull(raw.htlc_expires_at),
  payoutAddress: String(raw.payout_address),
  payoutPkScript: String(raw.payout_pk_script),
  payoutPubkey: String(raw.payout_pubkey),
  // Absence is '' because the column is NOT NULL in deployed databases; the wire schema refuses an empty packet.
  claimPacket: raw.claim_packet === '' ? null : text(raw.claim_packet),
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
  nonInteractiveParameters:
    raw.non_interactive_parameters === null || raw.non_interactive_parameters === undefined
      ? null
      : raw.non_interactive_parameters === '1',
  fundStartedAt: numberOrNull(raw.fund_started_at),
  arkadeLockupTxid: text(raw.arkade_lockup_txid),
  arkadeLockupVout: numberOrNull(raw.arkade_lockup_vout),
  arkadeLockupValue: numberOrNull(raw.arkade_lockup_value),
  revealedAt: numberOrNull(raw.revealed_at),
  stampedAt: numberOrNull(raw.stamped_at),
  settleAttemptedAt: numberOrNull(raw.settle_attempted_at),
  preimage: text(raw.preimage),
  refundArkTxid: text(raw.refund_ark_txid),
  unrolledRefund: text(raw.unrolled_refund),
  failureReason: text(raw.failure_reason),
  rfqId: text(raw.rfq_id),
})

export interface ReceiveQuoteRecord {
  id: string
  paymentHash: string
  amountSats: number
  payoutSats: number
  invoice: string
  invoiceWalletFingerprint?: string | null
  invoiceBackendName?: string | null
  invoiceExpiresAt: number
  payoutAddress: string
  payoutPkScript: string
  payoutPubkey: string
  claimPacket: string | null
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
  /** Required: an omitted value persists NULL, rebuilt as eight leaves against a nine-leaf lockup. */
  nonInteractiveParameters: boolean
  rfqId?: string
}

/** Identifiers only: a substring match on a number matches too much. Interpolated into SQL, so never request-derived. */
export const RECEIVE_SEARCH_COLUMNS: readonly string[] = [
  'id',
  'payment_hash',
  'invoice',
  'lockup_address',
  'payout_address',
  'arkade_lockup_txid',
  'refund_ark_txid',
  'unrolled_refund',
  'rfq_id',
]

const SHAPE: StoreShape<ReceiveSwapRow, ReceiveSwapState> = {
  table: 'receive_swap',
  eventTable: 'receive_swap_event',
  noun: 'receive swap',
  lifecycleLabel: 'receive swap lifecycle',
  searchColumns: RECEIVE_SEARCH_COLUMNS,
  legalEdges: LnReceiveMachine.edges,
  transitionColumns: TRANSITION_COLUMNS,
  patchColumns: PATCH_COLUMNS,
  live: NON_TERMINAL,
  exposed: EXPOSED,
  toRow: (raw: RawRow) => toRow(raw as Raw),
}

export interface ReceiveSwapRepository extends SwapRepository<ReceiveSwapRow, ReceiveSwapState> {
  claimFundLease(id: string, from: ReceiveSwapState): Promise<boolean>
  releaseFundLease(id: string): Promise<void>
  insertQuote(quote: ReceiveQuoteRecord): Promise<ReceiveSwapRow>
  noteCltvHeadroom(id: string, headroomSeconds: number, spareSeconds: number): Promise<void>
}

export class ReceiveSwapStore extends BaseSwapStore<ReceiveSwapRow, ReceiveSwapState> implements ReceiveSwapRepository {
  protected readonly shape = SHAPE

  static async open(driver: SqlDriver | string, now: () => number = nowSeconds): Promise<ReceiveSwapStore> {
    const store = new ReceiveSwapStore(typeof driver === 'string' ? betterSqliteDriver(driver) : driver, now)
    await store.driver.exec(receiveSwapsSql.schema)
    await store.migrate()
    return store
  }

  /** Nullable despite the schema: `ADD COLUMN ... NOT NULL` fails on a non-empty table. */
  private async migrate(): Promise<void> {
    await addColumns(this.driver, 'receive_swap', [
      ['payout_sats', 'INTEGER'],
      ['stamped_at', 'INTEGER'],
      ['settle_attempted_at', 'INTEGER'],
      ['non_interactive_parameters', 'TEXT'],
      ['fund_started_at', 'INTEGER'],
      ['invoice_wallet_fingerprint', 'TEXT'],
      ['invoice_backend_name', 'TEXT'],
      ['unrolled_refund', 'TEXT'],
    ])
  }

  override async claimFundLease(id: string, from: ReceiveSwapState): Promise<boolean> {
    return super.claimFundLease(id, from)
  }

  override async releaseFundLease(id: string): Promise<void> {
    await super.releaseFundLease(id)
  }

  async insertQuote(quote: ReceiveQuoteRecord): Promise<ReceiveSwapRow> {
    const at = this.now()
    await this.driver.run(receiveSwapsSql.insertQuote, [
      quote.id,
      at,
      at,
      quote.paymentHash,
      quote.amountSats,
      quote.payoutSats,
      quote.invoice,
      quote.invoiceExpiresAt,
      quote.payoutAddress,
      quote.payoutPkScript,
      quote.payoutPubkey,
      quote.claimPacket ?? '',
      quote.refundLocktime,
      quote.solverPubkey,
      quote.serverPubkey,
      quote.claimDelay,
      quote.refundDelay,
      quote.refundWithoutReceiverDelay,
      quote.emulatorPubkey,
      quote.pkScript,
      quote.lockupAddress,
      quote.solverRefundPkScript,
      quote.nonInteractiveParameters ? '1' : null,
      quote.rfqId ?? null,
      quote.invoiceWalletFingerprint ?? null,
      quote.invoiceBackendName ?? null,
    ])
    await this.recordEvent(quote.id, null, 'quoted', null)
    return this.get(quote.id)
  }

  /** A `from === to` note: nothing moved. */
  async noteCltvHeadroom(id: string, headroomSeconds: number, spareSeconds: number): Promise<void> {
    await this.recordEvent(id, 'armed', 'armed', `cltv headroom ${headroomSeconds}s — ${spareSeconds}s spare`)
  }
}
