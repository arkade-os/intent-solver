// `arkade:BTC->onchain:BTC` send leg. Without `refund_locktime` on disk a funded
// lockup cannot be rebuilt, so it is unrefundable.

import { betterSqliteDriver, type SqlDriver } from './driver.js'
import { onchainSwapsSql } from './onchainSwaps.sql.js'
import {
  BaseSwapStore,
  addColumns,
  numberOrNull,
  text,
  txidList,
  type RawRow,
  type StoreShape,
  type SwapRepository,
} from './baseSwapStore.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import { CLIENT_LOCKUP_RELEASE_DELAY_SECONDS } from '@arkade-os/solver-core/core/onchainSend.js'
import { OnchainSendMachine, type OnchainSendSwapState } from '../machines/onchainSend.js'

export type { OnchainSendSwapState }

export const FUND_LEASE_TTL_SECONDS = 10 * 60

const TRANSITION_COLUMNS = new Set([
  'onchain_lockup_txid',
  'onchain_lockup_vout',
  'onchain_lockup_value',
  'funding_txid',
  'funding_vout',
  'preimage',
  'claim_ark_txid',
  'onchain_refund_txid',
  'failure_reason',
  'fund_started_at',
  'lockup_outpoints',
])
// `onchain_refund_txid` is in both sets: the operator override records it in any state, including edge-less ones.
const PATCH_COLUMNS = new Set([
  'onchain_lockup_value',
  'refund_ark_txid',
  'refund_outcome',
  'onchain_refund_txid',
  'onchain_refund_fee_rate',
  'onchain_refund_broadcast_at',
  'onchain_refund_prior_txids',
  'unrolled_claim',
  'claim_ark_txid',
])

export interface OnchainSendSwapRow {
  id: string
  state: OnchainSendSwapState
  createdAt: number
  updatedAt: number
  paymentHash: string
  amountSats: number
  /** `amountSats` minus the fee, fixed at quote time: a locked client's payout is never recomputed. */
  payoutSats: number
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
  /** Null means rebuild the eight-leaf shape exactly as funded, not a refusal. */
  nonInteractiveParameters: boolean | null
  payoutPubkey: string
  htlcPubkey: string
  htlcLocktime: number
  minConfirmations: number
  onchainAddress: string
  onchainPkScript: string
  onchainLockupTxid: string | null
  onchainLockupVout: number | null
  onchainLockupValue: number | null
  fundingTxid: string | null
  /** Never assume 0: the funding may put change at any vout. */
  fundingVout: number | null
  preimage: string | null
  claimArkTxid: string | null
  /** JSON, by outpoint: the last step of each L1 claim of a lockup output the client unrolled. */
  unrolledClaim: string | null
  /** JSON `[{txid, vout, value}]`: the lockup outputs adopted at funding, each to be collected. Null on older rows. */
  lockupOutpoints: string | null
  /** Written BEFORE the broadcast: the refund ATTEMPTED, not one that landed. */
  onchainRefundTxid: string | null
  onchainRefundFeeRate: number | null
  onchainRefundBroadcastAt: number | null
  /** The refund versions {@link onchainRefundTxid} replaced, newest first: until one confirms, ANY of them can be the one that does. */
  onchainRefundPriorTxids: string[]
  refundArkTxid: string | null
  refundOutcome: 'pushed' | 'external' | null
  failureReason: string | null
  rfqId: string | null
  /** Set by the worker that wins the funding lease; never cleared. */
  fundStartedAt: number | null
  /** The signed funding, recorded before it is broadcast: every later pass resends this one. */
  fundingTx: string | null
}

type Raw = Record<string, string | number | null>

const toRow = (raw: Raw): OnchainSendSwapRow => ({
  id: String(raw.id),
  state: String(raw.state) as OnchainSendSwapState,
  createdAt: Number(raw.created_at),
  updatedAt: Number(raw.updated_at),
  paymentHash: String(raw.payment_hash),
  amountSats: Number(raw.amount_sats),
  // NULL on pre-fee rows, which charged nothing.
  payoutSats: numberOrNull(raw.payout_sats) ?? Number(raw.amount_sats),
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
  payoutPubkey: String(raw.payout_pubkey),
  htlcPubkey: String(raw.htlc_pubkey),
  htlcLocktime: Number(raw.htlc_locktime),
  minConfirmations: Number(raw.min_confirmations),
  onchainAddress: String(raw.onchain_address),
  onchainPkScript: String(raw.onchain_pk_script),
  onchainLockupTxid: raw.onchain_lockup_txid === null ? null : String(raw.onchain_lockup_txid),
  onchainLockupVout: raw.onchain_lockup_vout === null ? null : Number(raw.onchain_lockup_vout),
  onchainLockupValue: raw.onchain_lockup_value === null ? null : Number(raw.onchain_lockup_value),
  fundingTxid: raw.funding_txid === null ? null : String(raw.funding_txid),
  fundingVout: numberOrNull(raw.funding_vout),
  preimage: raw.preimage === null ? null : String(raw.preimage),
  claimArkTxid: raw.claim_ark_txid === null ? null : String(raw.claim_ark_txid),
  onchainRefundTxid: raw.onchain_refund_txid === null ? null : String(raw.onchain_refund_txid),
  onchainRefundFeeRate: numberOrNull(raw.onchain_refund_fee_rate),
  onchainRefundBroadcastAt: numberOrNull(raw.onchain_refund_broadcast_at),
  onchainRefundPriorTxids: txidList(raw.onchain_refund_prior_txids),
  refundArkTxid: raw.refund_ark_txid === null ? null : String(raw.refund_ark_txid),
  refundOutcome: raw.refund_outcome === null ? null : (String(raw.refund_outcome) as 'pushed' | 'external'),
  failureReason: raw.failure_reason === null ? null : String(raw.failure_reason),
  rfqId: text(raw.rfq_id),
  fundStartedAt: numberOrNull(raw.fund_started_at),
  fundingTx: text(raw.funding_tx),
  unrolledClaim: text(raw.unrolled_claim),
  lockupOutpoints: text(raw.lockup_outpoints),
})

export interface OnchainQuoteRecord {
  id: string
  paymentHash: string
  amountSats: number
  payoutSats: number
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
  /** Required, unlike the row's: a fresh row persisting null would make claim and refund throw. */
  nonInteractiveParameters: boolean
  payoutPubkey: string
  htlcPubkey: string
  htlcLocktime: number
  minConfirmations: number
  onchainAddress: string
  onchainPkScript: string
  rfqId?: string
}

/** Identifiers only; numbers substring-match too much. Interpolated into SQL, so never request-derived. */
export const ONCHAIN_SEND_SEARCH_COLUMNS: readonly string[] = [
  'id',
  'payment_hash',
  'lockup_address',
  'onchain_address',
  'onchain_lockup_txid',
  'funding_txid',
  'claim_ark_txid',
  'onchain_refund_txid',
  'refund_ark_txid',
  'unrolled_claim',
  'rfq_id',
]

const SHAPE: StoreShape<OnchainSendSwapRow, OnchainSendSwapState> = {
  table: 'send_onchain_swap',
  eventTable: 'send_onchain_swap_event',
  noun: 'onchain send swap',
  lifecycleLabel: 'onchain send lifecycle',
  searchColumns: ONCHAIN_SEND_SEARCH_COLUMNS,
  legalEdges: OnchainSendMachine.edges,
  transitionColumns: TRANSITION_COLUMNS,
  patchColumns: PATCH_COLUMNS,
  live: OnchainSendMachine.live,
  exposed: OnchainSendMachine.exposed,
  toRow: (raw: RawRow) => toRow(raw as Raw),
}

export interface OnchainSendSwapRepository extends SwapRepository<OnchainSendSwapRow, OnchainSendSwapState> {
  owedPayoutSats(): Promise<number>
  claimFundLease(id: string, from: OnchainSendSwapState): Promise<boolean>
  refuseUnrecorded(id: string, reason: string): Promise<boolean>
  recordFundingTx(id: string, tx: string): Promise<boolean>
  releaseFundLease(id: string): Promise<void>
  enterFunding(id: string): Promise<boolean>
  insertQuote(quote: OnchainQuoteRecord): Promise<OnchainSendSwapRow>
  findRefundable(now: number): Promise<OnchainSendSwapRow[]>
  findReleasable(now: number): Promise<OnchainSendSwapRow[]>
}

export class OnchainSendSwapStore
  extends BaseSwapStore<OnchainSendSwapRow, OnchainSendSwapState>
  implements OnchainSendSwapRepository
{
  protected readonly shape = SHAPE

  static async open(driver: SqlDriver | string, now: () => number = nowSeconds): Promise<OnchainSendSwapStore> {
    const store = new OnchainSendSwapStore(typeof driver === 'string' ? betterSqliteDriver(driver) : driver, now)
    await store.driver.exec(onchainSwapsSql.schema)
    await store.migrate()
    return store
  }

  /**
   * The NOT NULL columns are added nullable: `ADD COLUMN ... NOT NULL` fails on a non-empty table,
   * and pre-column rows (only ever `quoted`) have no honest default.
   */
  private async migrate(): Promise<void> {
    await addColumns(this.driver, 'send_onchain_swap', [
      ['funding_vout', 'INTEGER'],
      ['onchain_refund_txid', 'TEXT'],
      ['client_refund_pubkey', 'TEXT'],
      ['receiver_pk_script', 'TEXT'],
      ['payout_sats', 'INTEGER'],
      ['fund_started_at', 'INTEGER'],
      ['non_interactive_parameters', 'TEXT'],
      ['onchain_refund_fee_rate', 'REAL'],
      ['onchain_refund_broadcast_at', 'INTEGER'],
      ['onchain_refund_prior_txids', 'TEXT'],
      ['unrolled_claim', 'TEXT'],
      ['lockup_outpoints', 'TEXT'],
      ['funding_tx', 'TEXT'],
    ])
  }

  /** Not `committedSats`, which sums the client's lockups. COALESCE mirrors `toRow`. */
  async owedPayoutSats(): Promise<number> {
    const owes = OnchainSendMachine.where('owesPayout')
    const row = await this.driver.get<{ total: number }>(onchainSwapsSql.sumOwedPayoutInStates(owes.length), [...owes])
    return Number(row?.total ?? 0)
  }

  /** Expires: a row taken over after a crash only resends the `funding_tx` it recorded. */
  override async claimFundLease(id: string, from: OnchainSendSwapState): Promise<boolean> {
    return super.claimFundLease(id, from, this.now() - FUND_LEASE_TTL_SECONDS)
  }

  /** Never over a recorded funding: a worker past an expired lease may be broadcasting it. */
  async refuseUnrecorded(id: string, reason: string): Promise<boolean> {
    return this.transitionWhere(
      id,
      'funding_onchain',
      'refused',
      { failure_reason: reason },
      onchainSwapsSql.fundingTxUnrecorded,
    )
  }

  /** Single-winner, so a worker that loses it never broadcasts the funding it signed. */
  async recordFundingTx(id: string, tx: string): Promise<boolean> {
    const result = await this.driver.run(onchainSwapsSql.recordFundingTx, [tx, this.now(), id])
    return result.changes === 1
  }

  override async releaseFundLease(id: string): Promise<void> {
    await super.releaseFundLease(id)
  }

  /** Entry and lease in one write, so no recovery pass leases the row in between. */
  async enterFunding(id: string): Promise<boolean> {
    return this.transition(id, 'funded', 'funding_onchain', { fund_started_at: this.now() })
  }

  async insertQuote(quote: OnchainQuoteRecord): Promise<OnchainSendSwapRow> {
    const at = this.now()
    await this.driver.run(onchainSwapsSql.insertQuote, [
      quote.id,
      at,
      at,
      quote.paymentHash,
      quote.amountSats,
      quote.payoutSats,
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
      quote.payoutPubkey,
      quote.htlcPubkey,
      quote.htlcLocktime,
      quote.minConfirmations,
      quote.onchainAddress,
      quote.onchainPkScript,
      quote.rfqId ?? null,
    ])
    await this.recordEvent(quote.id, null, 'quoted', null)
    return this.get(quote.id)
  }

  /** `refused` only (never exposed); `client_refund_pubkey` means an untimelocked refund leaf. */
  async findRefundable(now: number): Promise<OnchainSendSwapRow[]> {
    const rows = await this.driver.all<Raw>(onchainSwapsSql.selectRefundable, [now])
    return rows.map(toRow)
  }

  async findReleasable(now: number): Promise<OnchainSendSwapRow[]> {
    const rows = await this.driver.all<Raw>(onchainSwapsSql.selectReleasable, [
      now - CLIENT_LOCKUP_RELEASE_DELAY_SECONDS,
    ])
    return rows.map(toRow)
  }
}
