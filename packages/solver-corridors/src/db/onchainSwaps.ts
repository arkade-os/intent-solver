/**
 * Durable state for the `arkade:BTC->onchain:BTC` send leg.
 *
 * Same rule as `src/db/swaps.ts`: every column exists because a specific
 * crash needs it, `refund_locktime` above all — without it on disk a funded
 * Arkade lockup cannot be reconstructed after a restart, and an
 * unreconstructible script is unrefundable, not merely unclaimable.
 *
 * Lifecycle, forward-only:
 *
 * - `quoted`          params on disk, nothing has moved
 * - `funded`          Arkade lockup seen; nothing funded onchain, so abandoning is safe
 * - `funding_onchain` the solver may be broadcasting/withdrawing to the onchain HTLC — the exposed state
 * - `awaiting_claim`  onchain HTLC funded; waiting for the client to reveal the preimage by claiming it
 * - `claiming`        preimage on disk; claiming the Arkade lockup needs nothing external any more
 * - `claimed`         done
 * - `refunding_onchain` client never claimed past `htlc_locktime`; the solver is broadcasting its own refund spend
 *                        (a late-but-valid claim can still land here — the edge back to `claiming` recovers it)
 * - `refunded`        the solver's onchain refund landed — the swap failed, but no capital is stuck
 * - `refused`         never funded onchain, no exposure
 * - `stuck`           funded onchain but could not claim the Arkade lockup before the refund deadline; needs a human
 */

import { betterSqliteDriver, type SqlDriver } from './driver.js'
import { BaseSwapStore, type RawRow, type StoreShape } from './baseSwapStore.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'

export type OnchainSendSwapState =
  | 'quoted'
  | 'funded'
  | 'funding_onchain'
  | 'awaiting_claim'
  | 'claiming'
  | 'claimed'
  | 'refunding_onchain'
  | 'refunded'
  | 'refused'
  | 'stuck'

export const NON_TERMINAL: readonly OnchainSendSwapState[] = [
  'quoted',
  'funded',
  'funding_onchain',
  'awaiting_claim',
  'claiming',
  'refunding_onchain',
]
export const EXPOSED: readonly OnchainSendSwapState[] = [
  'funding_onchain',
  'awaiting_claim',
  'claiming',
  'refunding_onchain',
]

const LEGAL_EDGES: Record<OnchainSendSwapState, readonly OnchainSendSwapState[]> = {
  quoted: ['funded', 'refused'],
  funded: ['funding_onchain', 'refused'],
  funding_onchain: ['awaiting_claim', 'stuck'],
  awaiting_claim: ['claiming', 'refunding_onchain', 'stuck'],
  claiming: ['claimed', 'stuck'],
  refunding_onchain: ['claiming', 'refunded', 'stuck'],
  claimed: [],
  refunded: [],
  refused: [],
  stuck: [],
}

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
])
/**
 * `onchain_refund_txid` is deliberately in BOTH sets. The automatic refund
 * records it on the `refunding_onchain -> refunded` edge, but the operator
 * override (`OnchainSendSwapService.reclaimOnchainHtlc`) runs against rows in
 * any state, and its main target — `stuck` — has no outgoing edge to move
 * along. Same shape as `refund_ark_txid` above: a fact about money that moved,
 * recorded without rewriting the state machine's verdict.
 */
const PATCH_COLUMNS = new Set(['onchain_lockup_value', 'refund_ark_txid', 'refund_outcome', 'onchain_refund_txid'])

export interface OnchainSendSwapRow {
  id: string
  state: OnchainSendSwapState
  createdAt: number
  updatedAt: number
  paymentHash: string
  /** What the client locks at the Arkade covenant. */
  amountSats: number
  /**
   * What the solver FUNDS the onchain HTLC with: `amountSats` minus this
   * corridor's fee, computed and persisted AT QUOTE TIME. A client who has
   * already locked cannot have their payout recomputed against a fee that
   * changed since — the quoted number has to be a fact on the row. Rows
   * quoted before fees existed carry NULL and read back as `amountSats`,
   * which is exactly what they were quoted at.
   */
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
  /**
   * The client's own refund key, hex x-only pubkey. Required on every row
   * created after the client-unilateral refund leaf shipped — the onchain
   * leg has no legacy family to accommodate an absent one.
   */
  clientRefundPubkey: string
  /**
   * The provider's own Arkade receiving pkScript, hex — where
   * `nonInteractiveClaim` must pay. Same reconstruct-from-the-row rule as
   * every other script parameter here; required, same as `clientRefundPubkey`
   * — this table has no legacy family to accommodate an absent one.
   */
  receiverPkScript: string
  /**
   * Whether this lockup was funded WITH the timelocked non-interactive
   * refund leaf. Unlike `clientRefundPubkey` this genuinely can be null on a
   * row created after the leaf shipped, on any table: null means "rebuild
   * the eight-leaf shape, exactly as funded" and is not a refusal case. See
   * `CovenantScriptRow`'s doc comment on the same field.
   */
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
  /**
   * The vout `fundingTxid` actually pays the onchain HTLC at. A funding
   * transaction may carry a change output, and nothing guarantees the
   * payment output comes first — never assume 0 (confirmed live: a
   * boltz-lnd regtest send put change at vout 0 and the HTLC payment at
   * vout 1). Null until `fundingTxid` is.
   */
  fundingVout: number | null
  preimage: string | null
  claimArkTxid: string | null
  /** Written BEFORE the broadcast (#169): the refund ATTEMPTED, not one that landed. */
  onchainRefundTxid: string | null
  refundArkTxid: string | null
  refundOutcome: 'pushed' | 'external' | null
  failureReason: string | null
  rfqId: string | null
  /**
   * When a worker won the exclusive right to broadcast this swap's onchain
   * HTLC funding. NULL until one does, and never cleared.
   *
   * @see OnchainSendSwapStore.claimFundLease
   */
  fundStartedAt: number | null
}

const SEND_ONCHAIN_SWAP_COLUMNS = `
  id                            TEXT PRIMARY KEY,
  state                         TEXT NOT NULL,
  created_at                    INTEGER NOT NULL,
  updated_at                    INTEGER NOT NULL,
  payment_hash                  TEXT NOT NULL,
  amount_sats                   INTEGER NOT NULL,
  payout_sats                   INTEGER NOT NULL,
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
  non_interactive_parameters TEXT,
  payout_pubkey                 TEXT NOT NULL,
  htlc_pubkey                   TEXT NOT NULL,
  htlc_locktime                 INTEGER NOT NULL,
  min_confirmations             INTEGER NOT NULL,
  onchain_address                TEXT NOT NULL,
  onchain_pk_script              TEXT NOT NULL,
  onchain_lockup_txid           TEXT,
  onchain_lockup_vout           INTEGER,
  onchain_lockup_value          INTEGER,
  funding_txid                  TEXT,
  funding_vout                  INTEGER,
  preimage                      TEXT,
  claim_ark_txid                TEXT,
  onchain_refund_txid           TEXT,
  refund_ark_txid               TEXT,
  refund_outcome                TEXT,
  failure_reason                TEXT,
  rfq_id                        TEXT,
  fund_started_at               INTEGER
`

const SCHEMA = `
CREATE TABLE IF NOT EXISTS send_onchain_swap (${SEND_ONCHAIN_SWAP_COLUMNS});
CREATE INDEX IF NOT EXISTS idx_send_onchain_swap_state ON send_onchain_swap(state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_send_onchain_swap_live_hash
  ON send_onchain_swap(payment_hash) WHERE state != 'refused';
-- Partial for the same reason as send_swap's: findByRfqId runs on every
-- inbound rfq_status_request, which falls through all four corridors' stores.
CREATE INDEX IF NOT EXISTS idx_send_onchain_swap_rfq_id
  ON send_onchain_swap(rfq_id) WHERE rfq_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS send_onchain_swap_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  swap_id    TEXT NOT NULL REFERENCES send_onchain_swap(id),
  at         INTEGER NOT NULL,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_send_onchain_swap_event_swap ON send_onchain_swap_event(swap_id);
`

type Raw = Record<string, string | number | null>

const toRow = (raw: Raw): OnchainSendSwapRow => ({
  id: String(raw.id),
  state: String(raw.state) as OnchainSendSwapState,
  createdAt: Number(raw.created_at),
  updatedAt: Number(raw.updated_at),
  paymentHash: String(raw.payment_hash),
  amountSats: Number(raw.amount_sats),
  // Rows quoted before fees existed have no payout_sats; they charged nothing,
  // so the payout WAS the amount. The fallback is that fact, not a default.
  payoutSats:
    raw.payout_sats === null || raw.payout_sats === undefined ? Number(raw.amount_sats) : Number(raw.payout_sats),
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
  fundingVout: raw.funding_vout === null || raw.funding_vout === undefined ? null : Number(raw.funding_vout),
  preimage: raw.preimage === null ? null : String(raw.preimage),
  claimArkTxid: raw.claim_ark_txid === null ? null : String(raw.claim_ark_txid),
  onchainRefundTxid: raw.onchain_refund_txid === null ? null : String(raw.onchain_refund_txid),
  refundArkTxid: raw.refund_ark_txid === null ? null : String(raw.refund_ark_txid),
  refundOutcome: raw.refund_outcome === null ? null : (String(raw.refund_outcome) as 'pushed' | 'external'),
  failureReason: raw.failure_reason === null ? null : String(raw.failure_reason),
  rfqId: raw.rfq_id === null || raw.rfq_id === undefined ? null : String(raw.rfq_id),
  fundStartedAt: raw.fund_started_at === null || raw.fund_started_at === undefined ? null : Number(raw.fund_started_at),
})

export interface OnchainQuoteRecord {
  id: string
  paymentHash: string
  amountSats: number
  /** See {@link OnchainSendSwapRow.payoutSats} — required, never derived here. */
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
  /**
   * The client's own refund key, hex x-only pubkey. Required on every row
   * created after the client-unilateral refund leaf shipped — the onchain
   * leg has no legacy family to accommodate an absent one.
   */
  clientRefundPubkey: string
  receiverPkScript: string
  /**
   * @see OnchainSendSwapRow.nonInteractiveParameters
   *
   * REQUIRED, unlike the row's own field (which stays nullable so an old row
   * still reads back its true history): this table has no legacy family, so
   * there is no honest reason a caller inserting a row should be allowed to
   * forget it. Optional here would let a future call site omit it, persist
   * null, and have the rebuild throw on both claim and refund the moment
   * anyone tries to spend it — the same failure this rework exists to
   * prevent, just on a fresh row instead of an old one.
   */
  nonInteractiveParameters: boolean
  payoutPubkey: string
  htlcPubkey: string
  htlcLocktime: number
  minConfirmations: number
  onchainAddress: string
  onchainPkScript: string
  rfqId?: string
}

/**
 * Columns an operator search matches against, for this corridor.
 *
 * Identifiers only — every one is something a user can hand you: the swap
 * id, the payment hash, the invoice, an address, a txid, the rfq id. Amounts
 * and timestamps are deliberately absent; they are filters, not identifiers,
 * and a substring match on a number matches far too much to be a search.
 *
 * Interpolated into SQL, so it lives here beside the schema rather than
 * anywhere a request can reach.
 */
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
  'rfq_id',
]

const SHAPE: StoreShape<OnchainSendSwapRow, OnchainSendSwapState> = {
  table: 'send_onchain_swap',
  eventTable: 'send_onchain_swap_event',
  noun: 'onchain send swap',
  lifecycleLabel: 'onchain send lifecycle',
  searchColumns: ONCHAIN_SEND_SEARCH_COLUMNS,
  legalEdges: LEGAL_EDGES,
  transitionColumns: TRANSITION_COLUMNS,
  patchColumns: PATCH_COLUMNS,
  live: NON_TERMINAL,
  exposed: EXPOSED,
  failStates: { exposed: 'stuck', clean: 'refused' },
  toRow: (raw: RawRow) => toRow(raw as Raw),
}

export class OnchainSendSwapStore extends BaseSwapStore<OnchainSendSwapRow, OnchainSendSwapState> {
  protected readonly shape = SHAPE

  static async open(driver: SqlDriver | string, now: () => number = nowSeconds): Promise<OnchainSendSwapStore> {
    const store = new OnchainSendSwapStore(typeof driver === 'string' ? betterSqliteDriver(driver) : driver, now)
    await store.driver.exec(SCHEMA)
    await store.migrate()
    return store
  }

  /**
   * Additive migration for databases created before a column existed — same
   * rule and same technique `SwapStore.migrate()` (src/db/swaps.ts) uses:
   * `CREATE TABLE IF NOT EXISTS` never alters an existing table.
   *
   * `client_refund_pubkey`/`receiver_pk_script` are `NOT NULL` in the current
   * schema, but a bare `ALTER TABLE ADD COLUMN ... NOT NULL` fails outright
   * against a non-empty table with no default to backfill — and there is no
   * honest default: a row quoted before these columns existed was quoted
   * under a script shape that no longer matches what this code reconstructs
   * from a row, on a corridor with no legacy family to fall back to. Adding
   * them nullable at the SQL level (like `swaps.ts` already does for these
   * same two columns) is the safe choice: existing rows read back with
   * `null` here rather than a fabricated value or a crash on startup. Such a
   * row is only ever `quoted` — the client-refund-pubkey requirement was
   * added before `funding_vout`/`onchain_refund_txid`, so nothing predating
   * this migration could have reached a state where real capital moved.
   */
  private async migrate(): Promise<void> {
    const columns = await this.driver.all<{ name: string }>(`PRAGMA table_info(send_onchain_swap)`)
    const existing = new Set(columns.map((c) => c.name))
    for (const column of [
      'funding_vout',
      'onchain_refund_txid',
      'client_refund_pubkey',
      'receiver_pk_script',
      'payout_sats',
      'fund_started_at',
      'non_interactive_parameters',
    ]) {
      if (!existing.has(column)) {
        const type =
          column === 'funding_vout' || column === 'payout_sats' || column === 'fund_started_at' ? 'INTEGER' : 'TEXT'
        await this.driver.exec(`ALTER TABLE send_onchain_swap ADD COLUMN ${column} ${type}`)
      }
    }
  }

  /**
   * Claim the exclusive right to broadcast this swap's onchain HTLC funding.
   *
   * Returns true to exactly ONE caller — the mirror of the receive leg's lease,
   * and the same defect (#103). Two workers reaching `submitFunding` together
   * would both broadcast an L1 payment to the client's HTLC address, from
   * different UTXOs, because coin selection is per-process. The compare-and-swap
   * on `state` afterwards gates RECORDING, not spending.
   *
   * `tick()`'s `inFlight` set hides this within one process, and is exactly what
   * a second worker, a restart, or the Go rewrite removes.
   *
   * One-shot rather than timed. A lease that expires lets a second worker
   * broadcast while the first may still be in flight, which reinstates the bug
   * on a timer. A crash between winning the lease and broadcasting leaves the
   * row stuck and visible, which is the honest outcome: this service cannot
   * tell from its own state whether that transaction exists, and retrying is
   * the double-spend the lease exists to prevent.
   */
  async claimFundLease(id: string, from: OnchainSendSwapState): Promise<boolean> {
    const result = await this.driver.run(
      `UPDATE send_onchain_swap SET fund_started_at = ?, updated_at = ?
       WHERE id = ? AND state = ? AND fund_started_at IS NULL`,
      [this.now(), this.now(), id, from],
    )
    return result.changes === 1
  }

  /**
   * Give the lease back when the broadcast provably did not happen.
   *
   * Called only when `fund()` THREW. Without it the lease outlives a failure
   * that moved no money and the row can never be funded by anyone — which an
   * existing test catches directly: it strands a row by making `fund()` throw,
   * then requires recovery to fund it afterwards.
   *
   * This is deliberately NOT "the lease expired". A throw is not proof that
   * nothing was sent — a timeout can throw after the transaction is already
   * out — so releasing here re-opens the same ambiguity the surrounding
   * recovery already owns and already resolves by looking for an output at the
   * address for exactly the right amount. What the lease adds is narrower and
   * is the actual defect: two workers in the same window cannot both be inside
   * `fund()` at once.
   */
  async releaseFundLease(id: string): Promise<void> {
    await this.driver.run(`UPDATE send_onchain_swap SET fund_started_at = NULL WHERE id = ?`, [id])
  }

  async insertQuote(quote: OnchainQuoteRecord): Promise<OnchainSendSwapRow> {
    const at = this.now()
    await this.driver.run(
      `INSERT INTO send_onchain_swap (
        id, state, created_at, updated_at, payment_hash, amount_sats, payout_sats, refund_locktime,
        provider_pubkey, server_pubkey, claim_delay, refund_delay, refund_without_receiver_delay,
        pk_script, lockup_address, refund_pk_script, emulator_pubkey, client_refund_pubkey, receiver_pk_script,
        non_interactive_parameters,
        payout_pubkey, htlc_pubkey, htlc_locktime, min_confirmations,
        onchain_address, onchain_pk_script, rfq_id
      ) VALUES (?, 'quoted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
        quote.nonInteractiveParameters === undefined ? null : quote.nonInteractiveParameters ? '1' : null,
        quote.payoutPubkey,
        quote.htlcPubkey,
        quote.htlcLocktime,
        quote.minConfirmations,
        quote.onchainAddress,
        quote.onchainPkScript,
        quote.rfqId ?? null,
      ],
    )
    await this.recordEvent(quote.id, null, 'quoted', null)
    return this.get(quote.id)
  }

  async findLiveByPaymentHash(paymentHash: string): Promise<OnchainSendSwapRow | null> {
    const raw = await this.driver.get<Raw>(
      `SELECT * FROM send_onchain_swap WHERE payment_hash = ? AND state != 'refused' LIMIT 1`,
      [paymentHash],
    )
    return raw ? toRow(raw) : null
  }

  async findRefundable(now: number): Promise<OnchainSendSwapRow[]> {
    const rows = await this.driver.all<Raw>(
      `SELECT * FROM send_onchain_swap
       WHERE state = 'refused' AND refund_outcome IS NULL AND refund_locktime <= ?
       ORDER BY created_at`,
      [now],
    )
    return rows.map(toRow)
  }
}
