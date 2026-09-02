/**
 * Durable swap state.
 *
 * Every column here exists because a specific crash needs it. The one that
 * matters most is `refund_locktime`: the swap script is derived from it, so
 * without it on disk a funded lockup cannot be reconstructed after a restart —
 * and an unreconstructible script is not merely unclaimable, it is
 * **unrefundable too**. The money is gone, not delayed.
 *
 * The delays are snapshotted for the same reason. They are derived from the Arkade
 * server's reported minimum at startup; if the operator changes it between
 * funding and recovery, re-deriving produces a different script and the funded
 * one becomes unreachable.
 *
 * The rule everywhere below: commit intent BEFORE an irreversible side effect,
 * commit the outcome immediately after, and make every step re-entrant by
 * reading the row first.
 */

import { betterSqliteDriver, type SqlDriver } from './driver.js'
import { BaseSwapStore, type RawRow, type StoreShape } from './baseSwapStore.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'

/**
 * Forward-only lifecycle.
 *
 * - `quoted`   params on disk, nothing has moved
 * - `funded`   lockup seen; nothing paid, so abandoning is safe
 * - `paying`   a Lightning payment may be in flight — the exposed state
 * - `paid`     payment id known, preimage maybe not
 * - `claiming` preimage on disk; the claim needs nothing external any more
 * - `claimed`  done
 * - `refused`  never funded, no exposure
 * - `stuck`    paid but could not claim before the refund deadline; needs a human
 */
export type SendSwapState = 'quoted' | 'funded' | 'paying' | 'paid' | 'claiming' | 'claimed' | 'refused' | 'stuck'

export const NON_TERMINAL: readonly SendSwapState[] = ['quoted', 'funded', 'paying', 'paid', 'claiming']

/** States in which the provider may have paid out and not yet been made whole. */
export const EXPOSED: readonly SendSwapState[] = ['paying', 'paid', 'claiming']

/**
 * The complete edge set of the lifecycle. `transition()` refuses anything else
 * LOUDLY: the forward-only ordering is a money invariant, and enforcing it here
 * — rather than by every caller's discipline — means a future retry tool or
 * admin command cannot silently walk a swap backwards into re-paying.
 */
const LEGAL_EDGES: Record<SendSwapState, readonly SendSwapState[]> = {
  quoted: ['funded', 'refused'],
  // `claiming` from `funded` is the COUPLED path and nothing else: a swap whose
  // hash belongs to our own live receive row can never be paid over Lightning
  // (one node cannot pay its own invoice), so it skips `paying`/`paid` and
  // claims on the preimage the client revealed by claiming our payout. Still
  // forward-only — it skips the two payment states, it never walks back into
  // them — so the invariant this table exists to enforce is untouched, and the
  // exposure set below is unchanged: `claiming` was already exposed.
  funded: ['paying', 'claiming', 'refused'],
  // `refused` from `paying`/`paid` needs PROOF the sats never left, and there
  // are exactly two things that count as proof. Every other terminal failure
  // keeps the old edges.
  //
  // One: the self-payment exception. The invoice is one OUR OWN node minted AND
  // our own node — the payee, the one place the sats could have ended up —
  // says it was never paid (pending or cancelled; armed or settled still goes
  // to `stuck`, because money may still be in play).
  //
  // Two: the route-deadline refusal that never reached `payInvoice`, where the
  // backend's OWN `getSendHtlcState` says it holds nothing for the hash (see
  // `submitPayment`'s `nothingCommitted`). A backend with no such probe has
  // proved nothing and still parks.
  //
  // Either pair of facts dissolves the "trust the backend's failed verdict"
  // objection `findRefundable` documents below, so the lockup goes straight
  // to refund instead of parking in `stuck` for an operator.
  paying: ['paid', 'stuck', 'refused'],
  paid: ['claiming', 'stuck', 'refused'],
  claiming: ['claimed', 'stuck'],
  claimed: [],
  refused: [],
  // `claiming` from `stuck` is the OPERATOR recovery edge, and nothing else.
  // `stuck` means a payment may have gone out and a human must look; when what
  // they find is a preimage for this row's payment hash, that is cryptographic
  // proof the payee revealed and so proof the payment settled. The row rejoins
  // the ordinary claim path on that proof rather than needing a tool that
  // pushes Arkade transactions outside the state machine.
  //
  // It does NOT weaken the invariant this table holds. It is forward-only —
  // `paying` and `paid` remain unreachable from here, so nothing can re-pay —
  // and `stuck` stays out of `NON_TERMINAL`, so no sweep walks a row a human
  // parked. Only a deliberate operator action takes it, and only with the
  // preimage in hand.
  // `refused` from `stuck` is the OTHER operator recovery edge, and the mirror
  // of `claiming` above: claim when the payment settled, refuse when it did
  // not. Taken by `refundNow` only after a refund has actually been pushed —
  // the client is whole, the lockup is spent, and there is nothing left for a
  // human, so the row must leave the queue that `stuck` means.
  //
  // Before this, a refunded row stayed `stuck` forever and the console labelled
  // it "client refunded — parked, nothing outstanding": a label over a row the
  // system still believed was outstanding.
  //
  // It does NOT license refunding a row that should be claimed. That is the
  // double payout `read-payment` exists to prevent, and the guard rails are
  // where they always were — `refund-now` is armed, and marked "not what the
  // read supports" when the verdict disagrees. `refused` is presented as
  // `refunded` and lands in phase `failed`, never `done`, so closing a row can
  // never make a mistaken refund read as success.
  //
  // Forward-only is untouched: `paying` and `paid` stay unreachable from here.
  stuck: ['claiming', 'refused'],
}

/** The lifecycle table, for tests that pin its shape. Not for production use. */
export const LEGAL_EDGES_FOR_TEST: Record<SendSwapState, readonly SendSwapState[]> = LEGAL_EDGES

/**
 * Columns a transition may set alongside its state change, and the only ones
 * patch() may touch at all. Everything else — `state` above all — moves through
 * transition()'s compare-and-swap or not at all. The allowlists also close the
 * column-name interpolation in the UPDATE builders: caller-supplied keys never
 * reach the SQL unless they are in these sets.
 */
const TRANSITION_COLUMNS = new Set([
  'lockup_txid',
  'lockup_vout',
  'lockup_value',
  'idempotency_key',
  'pay_attempted_at',
  'payment_id',
  'preimage',
  'claim_ark_txid',
  'failure_reason',
])
const PATCH_COLUMNS = new Set([
  'lockup_value',
  'payment_id',
  'refund_ark_txid',
  'refund_outcome',
  'payment_evidence',
  'payment_failure_reason',
  'refund_attempt',
  'payment_backend',
  'payment_wallet',
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
  /** Where a covenant refund must pay, hex pkScript. Null on legacy key-refund rows. */
  refundPkScript: string | null
  /** Emulator pubkey the refund covenant was built against, hex. Null on legacy rows. */
  emulatorPubkey: string | null
  /**
   * The client's own refund key, hex x-only pubkey. Present only for rows
   * quoted via the RFQ family after the client-unilateral refund leaf
   * shipped; null for older rows and rows quoted by the CLI's own
   * `quote`/`send` self-test commands (which carry no client key) — both
   * reconstruct the three-leaf script.
   */
  clientRefundPubkey: string | null
  /**
   * The provider's own Arkade receiving pkScript, hex — where
   * `nonInteractiveClaim` must pay. Snapshotted at quote time, same reason as
   * every other script-reconstruction field: rebuilt from the row, never
   * re-fetched live. Null on rows quoted before this leaf shipped.
   */
  receiverPkScript: string | null
  /**
   * Whether this lockup was funded WITH the timelocked non-interactive
   * refund leaf. Null on rows quoted before the leaf shipped — same
   * reconstruct-from-the-row-never-live rule, but null here means "rebuild
   * the eight-leaf shape", not a refusal. See `CovenantScriptRow`'s doc
   * comment on the same field.
   */
  nonInteractiveParameters: boolean | null
  /** Arkade txid of a covenant refund THIS SERVICE pushed. Only ever a txid. */
  refundArkTxid: string | null
  /** How the refund resolved: 'pushed' by us, or 'external' (someone else moved the funds). */
  refundOutcome: 'pushed' | 'external' | null
  /**
   * What the automatic post-failure refund attempt DID — including when it
   * failed, which `refundOutcome` cannot say.
   *
   * Separate from `refundOutcome` on purpose: that one is a one-way door that
   * tells the CLIENT they were refunded, and a failed attempt must never read
   * as one. This tells the OPERATOR what happened, on a row that is on its way
   * to `stuck` where nothing revisits it and they are the retry.
   *
   * `'pushed'` | `'nothing-at-script'` | `'failed: <reason>'` | null (never ran).
   */
  refundAttempt: string | null
  /**
   * Which backend minted {@link SendSwapRow.paymentId}, and which wallet it was
   * pointed at when it did.
   *
   * A payment id means nothing outside the backend that issued it, and nothing
   * even there once the seed changes: the lookup either misses local storage or
   * resolves against a wallet that never made the payment. Recorded WITH the id
   * so a later reader can tell "this provider has lost the record" from "this
   * row belongs to a provider you no longer run" — which otherwise both surface
   * as an undecided verdict and read like a backend fault.
   *
   * The fingerprint is the backend's own public identity (a node or identity
   * pubkey), never a secret: it already appears in the vendor's error messages,
   * and the point is to compare it, not to keep it.
   *
   * Null on rows that never reached a payment, and on rows written before this
   * existed — an absent value is "unknown", never "matches".
   */
  paymentBackend: string | null
  paymentWallet: string | null
  lockupTxid: string | null
  lockupVout: number | null
  lockupValue: number | null
  idempotencyKey: string | null
  payAttemptedAt: number | null
  paymentId: string | null
  preimage: string | null
  claimArkTxid: string | null
  failureReason: string | null
  /**
   * The backend's last word on the outbound payment — `in_flight` vs `wedged`
   * above all, which the status alone cannot tell apart. Diagnostic: it is what
   * an operator and the client read to know whether a fill is progressing, and
   * it decides nothing about whether money moves.
   *
   * Null while nothing has been polled, and for any backend that does not
   * report it. Kept as a plain string because `src/db` is a storage projection
   * and does not otherwise depend on `src/ln`'s vocabulary.
   */
  paymentEvidence: string | null
  /**
   * WHY the backend said a payment failed, in the port's vocabulary —
   * `rejected_by_destination` above all, which is how an invoice a third party
   * already settled comes back. Distinct from `failureReason`, which is our own
   * operator-facing sentence about the swap; this is the backend's verdict about
   * the payment, and the two can disagree.
   */
  paymentFailureReason: string | null
  /**
   * Client-chosen RFQ correlation id (64 hex chars), when the swap arrived as an
   * `rfq_request`. Null for rows quoted by the CLI's own commands. NOT unique
   * across rows: a client retrying after its quote expired legitimately reuses
   * the id, so lookups take the most recent row.
   */
  rfqId: string | null
}

// The unique index on payment_hash is PARTIAL on purpose: one LIVE swap per
// hash, but a 'refused' swap never moved money and never learned a preimage, so
// its still-valid invoice may be quoted again. Every other state blocks the
// hash — including terminal 'claimed'/'stuck', whose preimage the provider may
// KNOW: re-quoting one would invite a lockup the provider could take without
// paying again. (No SQL comments in this string: the D1 driver's exec flattens
// newlines, which would turn a `--` comment into a statement-eater.)
const SEND_SWAP_COLUMNS = `
  id                            TEXT PRIMARY KEY,
  state                         TEXT NOT NULL,
  created_at                    INTEGER NOT NULL,
  updated_at                    INTEGER NOT NULL,
  invoice                       TEXT NOT NULL,
  payment_hash                  TEXT NOT NULL,
  amount_sats                   INTEGER NOT NULL,
  invoice_expires_at            INTEGER NOT NULL,
  refund_locktime               INTEGER NOT NULL,
  sender_pubkey                 TEXT NOT NULL,
  receiver_pubkey               TEXT NOT NULL,
  server_pubkey                 TEXT NOT NULL,
  claim_delay                   INTEGER NOT NULL,
  refund_delay                  INTEGER NOT NULL,
  refund_without_receiver_delay INTEGER NOT NULL,
  pk_script                     TEXT NOT NULL,
  lockup_address                TEXT NOT NULL,
  refund_pk_script              TEXT,
  emulator_pubkey               TEXT,
  client_refund_pubkey          TEXT,
  receiver_pk_script            TEXT,
  non_interactive_parameters TEXT,
  refund_ark_txid               TEXT,
  refund_outcome                TEXT,
  refund_attempt                TEXT,
  payment_backend               TEXT,
  payment_wallet                TEXT,
  lockup_txid                   TEXT,
  lockup_vout                   INTEGER,
  lockup_value                  INTEGER,
  idempotency_key               TEXT,
  pay_attempted_at              INTEGER,
  payment_id                    TEXT,
  preimage                      TEXT,
  claim_ark_txid                TEXT,
  failure_reason                TEXT,
  rfq_id                        TEXT,
  payment_evidence              TEXT,
  payment_failure_reason        TEXT
`

const SCHEMA = `
CREATE TABLE IF NOT EXISTS send_swap (${SEND_SWAP_COLUMNS});
CREATE INDEX IF NOT EXISTS idx_send_swap_state ON send_swap(state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_send_swap_live_hash
  ON send_swap(payment_hash) WHERE state != 'refused';
-- Both partial: the columns are nullable and NULL is never what we look up, so
-- each index carries only the rows a lookup can match. rfq_id is the hot one --
-- findByRfqId runs on EVERY inbound rfq_request and rfq_status_request
-- (src/ingress/rfq.ts), so without it each request scanned the whole table.
-- lockup_txid is the cold one, but it is the only identifier an operator
-- actually has: the swap id is ours and appears in no UI, and a finished swap
-- is terminal so the list command will not show it either.
CREATE INDEX IF NOT EXISTS idx_send_swap_rfq_id
  ON send_swap(rfq_id) WHERE rfq_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_send_swap_lockup_txid
  ON send_swap(lockup_txid) WHERE lockup_txid IS NOT NULL;

CREATE TABLE IF NOT EXISTS send_swap_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  swap_id    TEXT NOT NULL REFERENCES send_swap(id),
  at         INTEGER NOT NULL,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_send_swap_event_swap ON send_swap_event(swap_id);
`

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
  clientRefundPubkey:
    raw.client_refund_pubkey === null || raw.client_refund_pubkey === undefined
      ? null
      : String(raw.client_refund_pubkey),
  receiverPkScript:
    raw.receiver_pk_script === null || raw.receiver_pk_script === undefined ? null : String(raw.receiver_pk_script),
  nonInteractiveParameters:
    raw.non_interactive_parameters === null || raw.non_interactive_parameters === undefined
      ? null
      : raw.non_interactive_parameters === '1',
  refundArkTxid: raw.refund_ark_txid === null ? null : String(raw.refund_ark_txid),
  refundOutcome: raw.refund_outcome === null ? null : (String(raw.refund_outcome) as 'pushed' | 'external'),
  /** What the automatic post-failure refund DID, including when it failed. @see refundAfterTerminalFailure */
  refundAttempt: raw.refund_attempt === null || raw.refund_attempt === undefined ? null : String(raw.refund_attempt),
  paymentBackend:
    raw.payment_backend === null || raw.payment_backend === undefined ? null : String(raw.payment_backend),
  paymentWallet: raw.payment_wallet === null || raw.payment_wallet === undefined ? null : String(raw.payment_wallet),
  lockupTxid: raw.lockup_txid === null ? null : String(raw.lockup_txid),
  lockupVout: raw.lockup_vout === null ? null : Number(raw.lockup_vout),
  lockupValue: raw.lockup_value === null ? null : Number(raw.lockup_value),
  idempotencyKey: raw.idempotency_key === null ? null : String(raw.idempotency_key),
  payAttemptedAt: raw.pay_attempted_at === null ? null : Number(raw.pay_attempted_at),
  paymentId: raw.payment_id === null ? null : String(raw.payment_id),
  preimage: raw.preimage === null ? null : String(raw.preimage),
  claimArkTxid: raw.claim_ark_txid === null ? null : String(raw.claim_ark_txid),
  failureReason: raw.failure_reason === null ? null : String(raw.failure_reason),
  paymentEvidence:
    raw.payment_evidence === null || raw.payment_evidence === undefined ? null : String(raw.payment_evidence),
  paymentFailureReason:
    raw.payment_failure_reason === null || raw.payment_failure_reason === undefined
      ? null
      : String(raw.payment_failure_reason),
  rfqId: raw.rfq_id === null || raw.rfq_id === undefined ? null : String(raw.rfq_id),
})

export interface QuoteRecord {
  id: string
  invoice: string
  paymentHash: string
  amountSats: number
  invoiceExpiresAt: number
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
  /**
   * @see SendSwapRow.nonInteractiveParameters
   *
   * REQUIRED, unlike the row's own field. The legacy-family argument for a
   * nullable ROW does not extend to an optional INSERT: old rows genuinely
   * predate the column, but nothing justifies letting a NEW quote forget it.
   * Optional here would let a future send_swap call site omit it, persist
   * NULL, and have `covenantScriptFromRow`'s `?? false` rebuild eight leaves
   * against a lockup funded with nine — `assertScriptMatchesRow` then throws
   * on both claim and refund, on the corridor with the most traffic. Same
   * reasoning as the other three QuoteRecord types; this one was left
   * optional by mistake, not by a reason that held up.
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
export const SEND_SEARCH_COLUMNS: readonly string[] = [
  'id',
  'payment_hash',
  'invoice',
  'lockup_address',
  'lockup_txid',
  'claim_ark_txid',
  'refund_ark_txid',
  'rfq_id',
]

const SHAPE: StoreShape<SendSwapRow, SendSwapState> = {
  table: 'send_swap',
  eventTable: 'send_swap_event',
  noun: 'swap',
  lifecycleLabel: 'swap lifecycle',
  searchColumns: SEND_SEARCH_COLUMNS,
  legalEdges: LEGAL_EDGES,
  transitionColumns: TRANSITION_COLUMNS,
  patchColumns: PATCH_COLUMNS,
  live: NON_TERMINAL,
  exposed: EXPOSED,
  // `stuck` rather than a generic failure when money is already exposed: those
  // need a human, and flattening them into "failed" hides that.
  failStates: { exposed: 'stuck', clean: 'refused' },
  toRow: (raw: RawRow) => toRow(raw as Raw),
}

export class SwapStore extends BaseSwapStore<SendSwapRow, SendSwapState> {
  protected readonly shape = SHAPE

  /**
   * Open a store over a driver — or a SQLite file path, the Node convenience —
   * and bring the schema up to date BEFORE handing the store out. Nothing can
   * read or write a row until the columns that reconstruct its script exist.
   * (Durability pragmas live in the Node driver, not here: they are a
   * file-on-disk concern, and D1 manages its own.)
   */
  static async open(driver: SqlDriver | string, now: () => number = nowSeconds): Promise<SwapStore> {
    const store = new SwapStore(typeof driver === 'string' ? betterSqliteDriver(driver) : driver, now)
    await store.driver.exec(SCHEMA)
    await store.migrate()
    return store
  }

  /**
   * Additive migration for databases created before a column existed.
   * `CREATE TABLE IF NOT EXISTS` never alters an existing table, so columns
   * added to the schema must also be added here. The column check goes through
   * the driver's prepared `all` because that form works on both runtimes —
   * D1 serves `PRAGMA table_info` via prepare().all() like any query.
   */
  private async migrate(): Promise<void> {
    const columns = await this.driver.all<{ name: string }>(`PRAGMA table_info(send_swap)`)
    const existing = new Set(columns.map((c) => c.name))
    for (const column of [
      'refund_attempt',
      'payment_backend',
      'payment_wallet',
      'refund_pk_script',
      'emulator_pubkey',
      'refund_ark_txid',
      'refund_outcome',
      'rfq_id',
      'client_refund_pubkey',
      'receiver_pk_script',
      'payment_evidence',
      'payment_failure_reason',
      'non_interactive_parameters',
    ]) {
      if (!existing.has(column)) await this.driver.exec(`ALTER TABLE send_swap ADD COLUMN ${column} TEXT`)
    }

    // Databases created when payment_hash carried a column-level UNIQUE burn a
    // hash forever once any swap — even a refused one that never moved money —
    // exists for it. SQLite cannot drop a column constraint in place, so the
    // table is rebuilt once. Detection must be precise: the TEXT PRIMARY KEY
    // also creates an autoindex, so only an autoindex whose indexed column is
    // payment_hash marks the legacy constraint.
    if (await this.hasLegacyHashConstraint()) {
      const names = (await this.driver.all<{ name: string }>(`PRAGMA table_info(send_swap)`))
        .map((c) => c.name)
        .join(', ')
      // The SQLite-recommended table rebuild (sqlite.org/lang_altertable.html):
      // build the replacement, copy, drop the original, rename into place. The
      // drop is what removes the column-level UNIQUE the whole rebuild exists to
      // shed. Two safeguards, because this moves a money table:
      //  - FK enforcement is toggled OFF around the swap. send_swap_event holds a
      //    foreign key into send_swap(id); the ids are preserved so the reference
      //    stays valid, but the transient DROP would otherwise trip it. Restored
      //    in `finally`, so an error never leaves the connection with FKs off.
      //  - the DDL runs through `driver.transaction`, so on Node a crash rolls
      //    back to the intact legacy table rather than stranding rows in a
      //    half-renamed one. `IF EXISTS` also recovers from a prior crash.
      // The transaction and PRAGMA are driver-aware: better-sqlite3 gets real
      // atomicity and honours the FK toggle, D1 runs best-effort (a fresh D1
      // database never carries the legacy constraint, so this path is Node-only
      // in practice; D1 also defaults foreign_keys OFF, so the drop needs no
      // toggle there). The PRAGMA is best-effort precisely so a driver that
      // rejects it degrades to "leave the constraint" rather than bricking.
      await this.setForeignKeys(false)
      try {
        await this.driver.transaction(async () => {
          await this.driver.exec(`DROP TABLE IF EXISTS send_swap_next`)
          await this.driver.exec(`CREATE TABLE send_swap_next (${SEND_SWAP_COLUMNS})`)
          await this.driver.exec(`INSERT INTO send_swap_next (${names}) SELECT ${names} FROM send_swap`)
          await this.driver.exec(`DROP TABLE send_swap`)
          await this.driver.exec(`ALTER TABLE send_swap_next RENAME TO send_swap`)
        })
      } finally {
        await this.setForeignKeys(true)
      }
      // Recreate the indexes the dropped table took with it.
      await this.driver.exec(SCHEMA)
    }

    // Backfill the outcome discriminator from the retired 'external' sentinel,
    // which used to be smuggled through the txid column (and leaked to clients
    // as if it were a txid).
    await this.driver.run(
      `UPDATE send_swap SET refund_outcome = 'external', refund_ark_txid = NULL
       WHERE refund_ark_txid = 'external' AND refund_outcome IS NULL`,
    )
    await this.driver.run(
      `UPDATE send_swap SET refund_outcome = 'pushed'
       WHERE refund_ark_txid IS NOT NULL AND refund_outcome IS NULL`,
    )
  }

  /**
   * Toggle FK enforcement, best-effort. better-sqlite3 honours it (needed so the
   * rebuild's transient DROP does not trip send_swap_event's foreign key); D1
   * rejects the PRAGMA but also defaults it off, so ignoring the failure there is
   * correct rather than fatal.
   */
  private async setForeignKeys(on: boolean): Promise<void> {
    try {
      await this.driver.exec(`PRAGMA foreign_keys = ${on ? 'ON' : 'OFF'}`)
    } catch {
      // Driver manages foreign keys itself; nothing to do.
    }
  }

  /** True when payment_hash still carries the legacy column-level UNIQUE. */
  private async hasLegacyHashConstraint(): Promise<boolean> {
    const indexes = await this.driver.all<{ name: string }>(`PRAGMA index_list(send_swap)`)
    for (const index of indexes) {
      const name = String(index.name)
      if (!name.startsWith('sqlite_autoindex_send_swap')) continue
      const cols = await this.driver.all<{ name: string }>(`PRAGMA index_info(${name})`)
      if (cols.some((c) => c.name === 'payment_hash')) return true
    }
    return false
  }

  /**
   * Record a quote before anything is funded.
   *
   * Rejects if a non-terminal swap already exists for this payment hash. That
   * uniqueness is load-bearing: two swaps sharing a payment hash mean two
   * lockups and one payment, and whichever client loses the race has their
   * lockup claimed with a valid preimage and no refund.
   */
  async insertQuote(quote: QuoteRecord): Promise<SendSwapRow> {
    const at = this.now()
    await this.driver.run(
      `INSERT INTO send_swap (
        id, state, created_at, updated_at, invoice, payment_hash, amount_sats, invoice_expires_at,
        refund_locktime, sender_pubkey, receiver_pubkey, server_pubkey,
        claim_delay, refund_delay, refund_without_receiver_delay, pk_script, lockup_address,
        refund_pk_script, emulator_pubkey, client_refund_pubkey, receiver_pk_script,
        non_interactive_parameters, rfq_id
      ) VALUES (?, 'quoted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        quote.id,
        at,
        at,
        quote.invoice,
        quote.paymentHash,
        quote.amountSats,
        quote.invoiceExpiresAt,
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
        // `false` collapses to NULL — the same value a row quoted before the leaf shipped
        // carries — and so does not round-trip back as `false`. Deliberate: the only reader
        // that matters (`covenantScriptFromRow`) treats NULL and `false` identically and
        // rebuilds the eight-leaf shape for both, so this is not a distinction the row needs
        // to carry. Only `true` changes what gets derived.
        quote.nonInteractiveParameters === undefined ? null : quote.nonInteractiveParameters ? '1' : null,
        quote.rfqId ?? null,
      ],
    )
    await this.recordEvent(quote.id, null, 'quoted', null)
    return this.get(quote.id)
  }

  /** Most recent swap for a hash, any state — the status lookup's view. */
  async findByPaymentHash(paymentHash: string): Promise<SendSwapRow | null> {
    const raw = await this.driver.get<Raw>(
      'SELECT * FROM send_swap WHERE payment_hash = ? ORDER BY created_at DESC LIMIT 1',
      [paymentHash],
    )
    return raw ? toRow(raw) : null
  }

  /**
   * The swap funded by this Arkade transaction.
   *
   * The lockup txid is the one identifier an operator actually HAS: it is what
   * a block explorer shows and what a maker can read off their own wallet. The
   * swap id is ours and appears in no UI, so without this a completed swap —
   * terminal, so absent from `list` — is unreachable from the outside.
   */
  async findByLockupTxid(txid: string): Promise<SendSwapRow | null> {
    const raw = await this.driver.get<Raw>(
      'SELECT * FROM send_swap WHERE lockup_txid = ? ORDER BY created_at DESC LIMIT 1',
      [txid],
    )
    return raw ? toRow(raw) : null
  }

  /**
   * The swap that BLOCKS a new quote for this hash, if any: every state except
   * `refused`. Mirrors the partial unique index — `refused` swaps never moved
   * money and never learned a preimage, so their invoice may be quoted again;
   * anything else (live, claimed, stuck) holds the hash.
   */
  async findLiveByPaymentHash(paymentHash: string): Promise<SendSwapRow | null> {
    const raw = await this.driver.get<Raw>(
      `SELECT * FROM send_swap WHERE payment_hash = ? AND state != 'refused' LIMIT 1`,
      [paymentHash],
    )
    return raw ? toRow(raw) : null
  }

  /**
   * Total sats COMMITTED across every non-terminal swap — the number an
   * aggregate cap must compare against. It sums all states that could still
   * result in a payout (`quoted` and `funded` included, not just the exposed
   * ones), because a swap the provider has quoted is capacity it may have to
   * honour: a client can fund any of them and be paid. Counting only the
   * already-exposed states would let unlimited concurrent quotes slip past the
   * cap and all be paid at once. Per-swap limits bound one bug's cost; this
   * bounds all concurrent ones.
   */
  /**
   * Swaps whose lockup should be auto-refunded: `refused` only — the failure
   * state the provider reaches WITHOUT ever paying (never funded, or funded but
   * refused before paying). Past the deadline, covenant-capable, not already
   * refunded.
   *
   * `stuck` is deliberately EXCLUDED. A stuck swap is one the provider may have
   * paid — a claim blocked by an Arkade-server outage, a mismatched preimage, a
   * claim failing past the deadline. Auto-pushing its refund would hand the
   * client back the lockup on a swap the provider could still claim (the claim
   * leaf never expires), turning a recoverable outage into a certain double
   * loss. Stuck swaps go to a human, who decides claim-retry vs. refund.
   *
   * One stuck sub-case is provably unpaid — a terminal Lightning failure from
   * `paying`, where the sats did not leave — and could in principle be
   * auto-refunded. It is still excluded on purpose: telling it apart means
   * trusting the backend's "failed" verdict, and the client can recover it
   * anyway (the covenant refund pays only their address, so anyone can push it
   * past the deadline). The conservative rule keeps auto-refund to swaps that
   * were never exposed at all.
   *
   * The two narrow exceptions live in the orchestrator, not here. Both move
   * `paying -> refused` directly and are then refundable by this query,
   * immediately for the covenant's non-interactive leaf rather than only past
   * the deadline; both replace trust in the payer-side verdict with a record
   * that is ours or the backend's own:
   *
   *   - a terminal failure on a SELF-payment, where the invoice is one our own
   *     node minted and our own node says it was never paid — the payee's
   *     record is ours to read (`refundProvenSelfPayment`);
   *   - a route-deadline refusal that never reached `payInvoice`, where the
   *     backend's own `getSendHtlcState` says it holds nothing for the hash
   *     (`submitPayment`'s `nothingCommitted`). Eight mainnet rows holding
   *     377,366 sats waited on an operator before this one existed, because
   *     `store.fail` sees only that the row sat in `paying`.
   *
   * Both are in `src/send/orchestrator.ts`.
   *
   * THE DEADLINE IS A PROPERTY OF THE SCRIPT, NOT OF THE STATE. Which refund
   * leaf `arkade.refund` can push is decided by `client_refund_pubkey`:
   *
   *   present — the RFQ family's extended VHTLC, whose `nonInteractiveRefund`
   *             leaf (server + receiver + emulator) carries NO timelock. There
   *             is nothing to wait for, so waiting only parks the client's sats
   *             for `refundLocktime` — days, and about a week on mainnet.
   *   absent  — the base three-leaf program, whose `refund` leaf IS gated on
   *             `refundLocktime`. An early push there is simply invalid.
   *
   * Every swap quoted through the RFQ family carries the key, so in practice
   * this is every client swap; the CLI's own self-test quotes are the legacy
   * shape. Loosening it costs nothing in safety: `refused` is by definition a
   * swap the provider never paid against, the covenant refund pays ONLY the
   * client's own address, and `stuck` — the state that means we may have paid —
   * is excluded from this query entirely.
   */
  async findRefundable(now: number): Promise<SendSwapRow[]> {
    const rows = await this.driver.all<Raw>(
      `SELECT * FROM send_swap
       WHERE state = 'refused'
         AND refund_outcome IS NULL
         AND refund_pk_script IS NOT NULL
         AND (client_refund_pubkey IS NOT NULL OR refund_locktime <= ?)
       ORDER BY created_at`,
      [now],
    )
    return rows.map(toRow)
  }

  /**
   * The most recently QUOTED swap, whatever state it is in now — what a
   * read-only operator command shows when no id is named.
   *
   * Ordered by `created_at` and tie-broken by rowid, because `created_at` is
   * unix seconds: two quotes minted in the same second are indistinguishable by
   * time alone, and insertion order is then the only remaining truth about
   * which came last.
   */
  async findMostRecent(): Promise<SendSwapRow | null> {
    const raw = await this.driver.get<Raw>('SELECT * FROM send_swap ORDER BY created_at DESC, rowid DESC LIMIT 1')
    return raw ? toRow(raw) : null
  }

  async noteFundings(id: string, outputs: readonly { txid: string; vout: number; value: number }[]): Promise<void> {
    if (outputs.length === 0) return
    const [row] = await this.driver.all<Raw>('SELECT state FROM send_swap WHERE id = ?', [id])
    if (!row) return
    const state = String(row.state) as SendSwapState

    const seen = await this.driver.all<Raw>(
      "SELECT detail FROM send_swap_event WHERE swap_id = ? AND detail LIKE 'funding %'",
      [id],
    )
    const already = new Set(seen.map((e) => String(e.detail)))

    for (const output of outputs) {
      const detail = `funding ${output.txid}:${output.vout} — ${output.value.toLocaleString('en-US')} sats`
      if (already.has(detail)) continue
      already.add(detail)
      await this.recordEvent(id, state, state, detail)
    }
  }

  /**
   * A refund is the one thing a patch does that MOVES MONEY, and until this
   * existed it left no trace in the swap's own history: the timeline records
   * transitions, and a refund is not one. An operator reading
   * `paying -> paid -> stuck` alongside a refund transaction had no way to see
   * where the refund came from, or when.
   *
   * Recorded HERE rather than at the eight call sites that push one, because a
   * history with a gap in it is exactly what a ninth call site would
   * reintroduce. `from === to` says plainly that nothing moved in the
   * lifecycle — this is a note about the swap, not a step through it.
   *
   * The read stays BEFORE the write, and happens only when a noted column is in
   * play, so every other patch is still a single statement. This is the ONLY
   * store that overrides `patch`; the other three inherit it unchanged.
   */
  override async patch(id: string, fields: Record<string, unknown>): Promise<void> {
    const notable = fields.refund_outcome !== undefined
    const [before] = notable ? await this.driver.all<Raw>('SELECT * FROM send_swap WHERE id = ?', [id]) : [null]

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
