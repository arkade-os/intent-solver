/**
 * Durable state for the `lightning:BTC->arkade:BTC` receive leg.
 *
 * Same rule as `src/db/swaps.ts` and `src/db/onchainSwaps.ts`: every column
 * exists because a specific crash needs it. `refund_locktime` is that column
 * here too, for the mirror-image reason of the send legs': this service funds
 * its OWN Arkade lockup, so losing the row after funding loses not a claim but
 * the provider's own recourse to get that capital back.
 *
 * Lifecycle, forward-only:
 *
 * - `quoted`    hold invoice minted on H; nothing armed
 * - `armed`     an incoming HTLC is held against the invoice; `E` known
 * - `funded`    the provider's own Arkade lockup is broadcast — the exposed
 *               state; covclaimd has been (or is being) handed the sealed
 *               claim packet and this watches for its autonomous claim
 * - `claimed`   covclaimd's claim landed on Arkade; `P` extracted and verified
 * - `settled`   the held HTLC was settled with `P` — done, provider paid
 * - `refunding` `refund_locktime` passed with no claim observed; pushing the
 *               provider's own covenant refund back to itself (a late-but-valid
 *               claim can still land here — the edge back to `claimed` recovers it,
 *               mirroring `refunding_onchain` in `src/db/onchainSwaps.ts`)
 * - `refunded`  the provider's own refund landed — the swap failed, but no
 *               capital is stuck
 * - `refused`   never armed, or armed but never funded — no exposure
 * - `stuck`     funded but could not settle before recourse ran out, or the
 *               funded lockup was spent by something ambiguous; needs a human
 */

import { betterSqliteDriver, type SqlDriver } from './driver.js'
import { BaseSwapStore, type RawRow, type StoreShape } from './baseSwapStore.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'

export type ReceiveSwapState =
  'quoted' | 'armed' | 'funded' | 'claimed' | 'settled' | 'refunding' | 'refunded' | 'refused' | 'stuck'

export const NON_TERMINAL: readonly ReceiveSwapState[] = ['quoted', 'armed', 'funded', 'claimed', 'refunding']
/** States in which the provider's OWN Arkade lockup may be funded and not yet made whole. */
export const EXPOSED: readonly ReceiveSwapState[] = ['funded', 'claimed', 'refunding']

const LEGAL_EDGES: Record<ReceiveSwapState, readonly ReceiveSwapState[]> = {
  quoted: ['armed', 'refused'],
  armed: ['funded', 'refused'],
  funded: ['claimed', 'refunding', 'stuck'],
  claimed: ['settled', 'stuck'],
  refunding: ['refunded', 'claimed', 'stuck'],
  settled: [],
  refunded: [],
  refused: [],
  stuck: [],
}

// `refund_locktime` is deliberately absent: it is fixed at insert and the
// covenant's pkScript is derived from it, so no transition may move it. Same
// as the sibling receive corridor's own set (`onchainReceiveSwaps.ts`).
const TRANSITION_COLUMNS = new Set([
  'htlc_expires_at',
  'arkade_lockup_txid',
  'arkade_lockup_vout',
  'arkade_lockup_value',
  'preimage',
  'refund_ark_txid',
  'failure_reason',
])
/**
 * `refund_ark_txid` is deliberately in BOTH sets, and the sibling store's own
 * note said why before this leg needed it: the automatic refund records it on
 * the `refunding -> refunded` edge, but the operator override
 * (`ReceiveSwapService.refundNow`) runs against rows with no outgoing edge —
 * `stuck` above all, which is the reason that override exists — and has to
 * record the audit fact without a transition.
 */
const PATCH_COLUMNS = new Set(['revealed_at', 'settle_attempted_at', 'arkade_lockup_value', 'refund_ark_txid'])

export interface ReceiveSwapRow {
  id: string
  state: ReceiveSwapState
  createdAt: number
  updatedAt: number

  /** `H = sha256(P)`, client-chosen, hex — the natural key. */
  paymentHash: string
  /** What the client pays: the hold invoice's amount. */
  amountSats: number
  /**
   * What the provider FUNDS into the Arkade lockup: `amountSats` minus this
   * corridor's fee, computed and persisted AT QUOTE TIME. A client who has
   * already paid the hold invoice cannot have their payout recomputed against
   * a fee that changed since — the quoted number has to be a fact on the row,
   * the same role the send leg's persisted invoice string plays. Rows quoted
   * before fees existed carry NULL and read back as `amountSats`, which is
   * exactly what they were quoted at.
   */
  payoutSats: number
  /** The hold BOLT11 this provider minted on `H`. */
  invoice: string
  invoiceExpiresAt: number
  /** `E`: the deadline the held HTLC must be settled by. Null until `armed`. */
  htlcExpiresAt: number | null

  /** The client's Arkade address — where the funds land once covclaimd claims. */
  payoutAddress: string
  /** `payoutAddress` decoded, hex — the `nonInteractiveClaim` leaf's pinned destination. */
  payoutPkScript: string
  /** The client's own x-only key — the covenant's `receiver` role on this leg (their interactive-claim fallback). */
  payoutPubkey: string
  /** The client's preimage, ECIES-sealed to covclaimd. Opaque here — forwarded verbatim, never decrypted. */
  claimPacket: string

  /**
   * Absolute unix seconds, set at `quoted` (`now + MAX_REFUND_HORIZON`) and
   * IMMUTABLE thereafter — `pkScript` below is derived from it, so a later
   * value would describe a script other than the one actually funded. No
   * transition may set it; `evaluateReceiveFunding` checks it against `E` at
   * the `armed -> funded` edge instead of recomputing it.
   */
  refundLocktime: number
  /** This provider's own key — the covenant's `client` role on this leg (the funder-refund fallback; see `src/arkade/covenant.ts`'s role-inversion note). */
  solverPubkey: string
  serverPubkey: string
  claimDelay: number
  refundDelay: number
  refundWithoutReceiverDelay: number
  emulatorPubkey: string
  /** The derived covenant lockup's pkScript, hex. */
  pkScript: string
  lockupAddress: string
  /** Where the provider's OWN refund must pay — the covenant's `refund`/`refundCollaborative`/`refundWithoutServer` leaves' destination. */
  solverRefundPkScript: string
  /**
   * Whether this lockup was funded WITH the timelocked non-interactive
   * refund leaf. Null means "rebuild the eight-leaf shape, exactly as
   * funded" — not a refusal case. See `CovenantScriptRow`'s doc comment on
   * the same field.
   */
  nonInteractiveParameters: boolean | null

  arkadeLockupTxid: string | null
  arkadeLockupVout: number | null
  arkadeLockupValue: number | null
  /** Set once `covclaimd.reveal()` has succeeded — a data fact, not a state, so a failed attempt retries without re-funding. */
  revealedAt: number | null
  /**
   * When `settleHold` was CALLED — pre-committed, BEFORE the call, so a
   * resumed process can tell "not yet attempted" apart from "already
   * succeeded". Mirrors {@link revealedAt}, and exists for the same reason:
   * the side effect is not reversible and the row is the only memory of it.
   *
   * @see ReceiveSwapService.whenClaimed
   */
  settleAttemptedAt: number | null

  /** `P`, hex — set only once extracted from the claim witness AND verified against `paymentHash`. */
  preimage: string | null
  /** Arkade txid of a covenant refund THIS SERVICE pushed for its own lockup. */
  refundArkTxid: string | null

  failureReason: string | null
  /**
   * Client-chosen RFQ correlation id (64 hex chars). NOT unique across rows —
   * same reasoning as `SendSwapRow.rfqId`.
   */
  rfqId: string | null
}

// The unique index on payment_hash is PARTIAL for the identical reason
// `send_swap`'s is: one LIVE swap per hash, but a `refused` swap never funded
// anything and never learned a preimage, so its hash may be re-quoted.
const RECEIVE_SWAP_COLUMNS = `
  id                            TEXT PRIMARY KEY,
  state                         TEXT NOT NULL,
  created_at                    INTEGER NOT NULL,
  updated_at                    INTEGER NOT NULL,
  payment_hash                  TEXT NOT NULL,
  amount_sats                   INTEGER NOT NULL,
  payout_sats                   INTEGER NOT NULL,
  invoice                       TEXT NOT NULL,
  invoice_expires_at            INTEGER NOT NULL,
  htlc_expires_at                INTEGER,
  payout_address                TEXT NOT NULL,
  payout_pk_script               TEXT NOT NULL,
  payout_pubkey                  TEXT NOT NULL,
  claim_packet                  TEXT NOT NULL,
  refund_locktime               INTEGER NOT NULL,
  solver_pubkey                  TEXT NOT NULL,
  server_pubkey                  TEXT NOT NULL,
  claim_delay                    INTEGER NOT NULL,
  refund_delay                   INTEGER NOT NULL,
  refund_without_receiver_delay  INTEGER NOT NULL,
  emulator_pubkey                TEXT NOT NULL,
  pk_script                     TEXT NOT NULL,
  lockup_address                 TEXT NOT NULL,
  solver_refund_pk_script         TEXT NOT NULL,
  non_interactive_parameters TEXT,
  arkade_lockup_txid             TEXT,
  arkade_lockup_vout             INTEGER,
  arkade_lockup_value            INTEGER,
  revealed_at                    INTEGER,
  settle_attempted_at            INTEGER,
  preimage                      TEXT,
  refund_ark_txid                TEXT,
  failure_reason                TEXT,
  rfq_id                        TEXT
`

const SCHEMA = `
CREATE TABLE IF NOT EXISTS receive_swap (${RECEIVE_SWAP_COLUMNS});
CREATE INDEX IF NOT EXISTS idx_receive_swap_state ON receive_swap(state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_receive_swap_live_hash
  ON receive_swap(payment_hash) WHERE state != 'refused';
-- Partial for the same reason as send_swap's: findByRfqId runs on every
-- inbound rfq_status_request, which falls through all four corridors' stores.
CREATE INDEX IF NOT EXISTS idx_receive_swap_rfq_id
  ON receive_swap(rfq_id) WHERE rfq_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS receive_swap_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  swap_id    TEXT NOT NULL REFERENCES receive_swap(id),
  at         INTEGER NOT NULL,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_receive_swap_event_swap ON receive_swap_event(swap_id);
`

type Raw = Record<string, string | number | null>

const toRow = (raw: Raw): ReceiveSwapRow => ({
  id: String(raw.id),
  state: String(raw.state) as ReceiveSwapState,
  createdAt: Number(raw.created_at),
  updatedAt: Number(raw.updated_at),
  paymentHash: String(raw.payment_hash),
  amountSats: Number(raw.amount_sats),
  // Rows quoted before fees existed have no payout_sats; they charged nothing,
  // so the payout WAS the amount. The fallback is that fact, not a default.
  payoutSats:
    raw.payout_sats === null || raw.payout_sats === undefined ? Number(raw.amount_sats) : Number(raw.payout_sats),
  invoice: String(raw.invoice),
  invoiceExpiresAt: Number(raw.invoice_expires_at),
  htlcExpiresAt: raw.htlc_expires_at === null || raw.htlc_expires_at === undefined ? null : Number(raw.htlc_expires_at),
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
  nonInteractiveParameters:
    raw.non_interactive_parameters === null || raw.non_interactive_parameters === undefined
      ? null
      : raw.non_interactive_parameters === '1',
  arkadeLockupTxid:
    raw.arkade_lockup_txid === null || raw.arkade_lockup_txid === undefined ? null : String(raw.arkade_lockup_txid),
  arkadeLockupVout:
    raw.arkade_lockup_vout === null || raw.arkade_lockup_vout === undefined ? null : Number(raw.arkade_lockup_vout),
  arkadeLockupValue:
    raw.arkade_lockup_value === null || raw.arkade_lockup_value === undefined ? null : Number(raw.arkade_lockup_value),
  revealedAt: raw.revealed_at === null || raw.revealed_at === undefined ? null : Number(raw.revealed_at),
  settleAttemptedAt:
    raw.settle_attempted_at === null || raw.settle_attempted_at === undefined ? null : Number(raw.settle_attempted_at),
  preimage: raw.preimage === null || raw.preimage === undefined ? null : String(raw.preimage),
  refundArkTxid: raw.refund_ark_txid === null || raw.refund_ark_txid === undefined ? null : String(raw.refund_ark_txid),
  failureReason: raw.failure_reason === null || raw.failure_reason === undefined ? null : String(raw.failure_reason),
  rfqId: raw.rfq_id === null || raw.rfq_id === undefined ? null : String(raw.rfq_id),
})

export interface ReceiveQuoteRecord {
  id: string
  paymentHash: string
  amountSats: number
  /** See {@link ReceiveSwapRow.payoutSats} — required, never derived here. */
  payoutSats: number
  invoice: string
  invoiceExpiresAt: number
  payoutAddress: string
  payoutPkScript: string
  payoutPubkey: string
  claimPacket: string
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
  /**
   * @see ReceiveSwapRow.nonInteractiveParameters
   *
   * REQUIRED, unlike the row's own field: this table has no legacy family,
   * so nothing justifies letting a caller forget it. See
   * OnchainSendSwapRow's identical note for what forgetting it costs.
   */
  nonInteractiveParameters: boolean
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
export const RECEIVE_SEARCH_COLUMNS: readonly string[] = [
  'id',
  'payment_hash',
  'invoice',
  'lockup_address',
  'payout_address',
  'arkade_lockup_txid',
  'refund_ark_txid',
  'rfq_id',
]

const SHAPE: StoreShape<ReceiveSwapRow, ReceiveSwapState> = {
  table: 'receive_swap',
  eventTable: 'receive_swap_event',
  noun: 'receive swap',
  lifecycleLabel: 'receive swap lifecycle',
  searchColumns: RECEIVE_SEARCH_COLUMNS,
  legalEdges: LEGAL_EDGES,
  transitionColumns: TRANSITION_COLUMNS,
  patchColumns: PATCH_COLUMNS,
  live: NON_TERMINAL,
  exposed: EXPOSED,
  // `stuck` rather than a generic failure when the provider's own money is
  // already out — same "stuck-over-silence" rule every other leg applies.
  failStates: { exposed: 'stuck', clean: 'refused' },
  toRow: (raw: RawRow) => toRow(raw as Raw),
}

export class ReceiveSwapStore extends BaseSwapStore<ReceiveSwapRow, ReceiveSwapState> {
  protected readonly shape = SHAPE

  static async open(driver: SqlDriver | string, now: () => number = nowSeconds): Promise<ReceiveSwapStore> {
    const store = new ReceiveSwapStore(typeof driver === 'string' ? betterSqliteDriver(driver) : driver, now)
    await store.driver.exec(SCHEMA)
    await store.migrate()
    return store
  }

  /**
   * Additive migration for databases created before a column existed — same
   * rule and same technique `SwapStore.migrate()` (src/db/swaps.ts) uses:
   * `CREATE TABLE IF NOT EXISTS` never alters an existing table. Added
   * nullable at the SQL level even though the schema says NOT NULL, for the
   * reason `OnchainSendSwapStore.migrate()` documents: a bare
   * `ALTER TABLE ADD COLUMN ... NOT NULL` fails against a non-empty table,
   * and a pre-fees row's honest payout is read back from `amount_sats` by
   * `toRow`, not fabricated here.
   */
  private async migrate(): Promise<void> {
    const columns = await this.driver.all<{ name: string }>(`PRAGMA table_info(receive_swap)`)
    const existing = new Set(columns.map((c) => c.name))
    if (!existing.has('payout_sats')) {
      await this.driver.exec(`ALTER TABLE receive_swap ADD COLUMN payout_sats INTEGER`)
    }
    if (!existing.has('settle_attempted_at')) {
      await this.driver.exec(`ALTER TABLE receive_swap ADD COLUMN settle_attempted_at INTEGER`)
    }
    if (!existing.has('non_interactive_parameters')) {
      await this.driver.exec(`ALTER TABLE receive_swap ADD COLUMN non_interactive_parameters TEXT`)
    }
  }

  /**
   * Record a quote before anything is armed.
   *
   * Rejects if a non-terminal swap already exists for this payment hash —
   * same reasoning as `SwapStore.insertQuote`: two live swaps sharing a hash
   * mean a race whichever side loses cannot recover from.
   */
  async insertQuote(quote: ReceiveQuoteRecord): Promise<ReceiveSwapRow> {
    const at = this.now()
    await this.driver.run(
      `INSERT INTO receive_swap (
        id, state, created_at, updated_at, payment_hash, amount_sats, payout_sats, invoice, invoice_expires_at,
        payout_address, payout_pk_script, payout_pubkey, claim_packet,
        refund_locktime, solver_pubkey, server_pubkey, claim_delay, refund_delay, refund_without_receiver_delay,
        emulator_pubkey, pk_script, lockup_address, solver_refund_pk_script,
        non_interactive_parameters, rfq_id
      ) VALUES (?, 'quoted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
        quote.claimPacket,
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
        quote.nonInteractiveParameters === undefined ? null : quote.nonInteractiveParameters ? '1' : null,
        quote.rfqId ?? null,
      ],
    )
    await this.recordEvent(quote.id, null, 'quoted', null)
    return this.get(quote.id)
  }

  async findByPaymentHash(paymentHash: string): Promise<ReceiveSwapRow | null> {
    const raw = await this.driver.get<Raw>(
      'SELECT * FROM receive_swap WHERE payment_hash = ? ORDER BY created_at DESC LIMIT 1',
      [paymentHash],
    )
    return raw ? toRow(raw) : null
  }

  /** The swap that BLOCKS a new quote for this hash, if any — mirrors the partial unique index. */
  async findLiveByPaymentHash(paymentHash: string): Promise<ReceiveSwapRow | null> {
    const raw = await this.driver.get<Raw>(
      `SELECT * FROM receive_swap WHERE payment_hash = ? AND state != 'refused' LIMIT 1`,
      [paymentHash],
    )
    return raw ? toRow(raw) : null
  }
}
