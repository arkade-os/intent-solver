/**
 * Durable state for the `onchain:BTC->arkade:BTC` receive leg — the mirror
 * of `src/db/onchainSwaps.ts` (send).
 *
 * Same rule as every store in this repo: every column exists because a
 * specific crash needs it, and every irreversible side effect is committed
 * as intent BEFORE it happens and as outcome immediately after.
 *
 * Lifecycle, forward-only:
 *
 * - `quoted`                params on disk, nothing has moved
 * - `awaiting_confirmations` the CLIENT's onchain HTLC funding output has been
 *                            seen (or not yet); nothing of the solver's own is
 *                            at risk, so abandoning here is safe
 * - `funding_arkade`        the solver may be broadcasting its own funding of
 *                            the Arkade lockup — the exposed state
 * - `awaiting_claim`        Arkade lockup funded; covclaimd has been asked to
 *                           push the claim, waiting for `P` to become public
 * - `claimed`                covclaimd's claim landed; `P` is on disk — claiming
 *                           the onchain HTLC needs nothing external any more
 * - `settled`                done: the onchain HTLC has been claimed
 * - `refunding_arkade`      covclaimd never got the claim in before the
 *                           solver's own Arkade refund deadline; reclaiming the
 *                           Arkade lockup back to the solver
 *                           (a late-but-valid claim can still land here — the
 *                           edge back to `claimed` recovers it)
 * - `refunded`               the solver's Arkade refund landed — the swap
 *                            failed, but the solver's capital is not stuck
 * - `refused`                never funded on the Arkade side, no exposure
 * - `stuck`                  funded the Arkade side but could not resolve
 *                            before its own refund deadline; needs a human
 */

import { betterSqliteDriver, type SqlDriver } from './driver.js'
import { BaseSwapStore, type RawRow, type StoreShape } from './baseSwapStore.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'

export type OnchainReceiveSwapState =
  | 'quoted'
  | 'awaiting_confirmations'
  | 'funding_arkade'
  | 'awaiting_claim'
  | 'claimed'
  | 'settled'
  | 'refunding_arkade'
  | 'refunded'
  | 'refused'
  | 'stuck'

export const NON_TERMINAL: readonly OnchainReceiveSwapState[] = [
  'quoted',
  'awaiting_confirmations',
  'funding_arkade',
  'awaiting_claim',
  'claimed',
  'refunding_arkade',
]
export const EXPOSED: readonly OnchainReceiveSwapState[] = [
  'funding_arkade',
  'awaiting_claim',
  'claimed',
  'refunding_arkade',
]

const LEGAL_EDGES: Record<OnchainReceiveSwapState, readonly OnchainReceiveSwapState[]> = {
  quoted: ['awaiting_confirmations', 'refused'],
  awaiting_confirmations: ['funding_arkade', 'refused'],
  funding_arkade: ['awaiting_claim', 'stuck'],
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
 * `arkade_refund_txid` is deliberately in BOTH sets — same reason
 * `onchain_refund_txid` is on the send leg's onchain store: the automatic
 * refund records it on the `refunding_arkade -> refunded` edge, but a future
 * operator override running against a `stuck` row (which has no outgoing
 * edge) needs to record it without a transition.
 */
/**
 * `onchain_claim_txid` is in both sets for the same reason as
 * `arkade_refund_txid` above, and for a caller that now exists: the automatic
 * claim records it on the `claimed -> settled` edge, while
 * `OnchainReceiveSwapService.claimNow` — the operator's fee-dust retry, TLA+
 * finding F4 — runs against a `stuck` row with no outgoing edge and must record
 * the txid without a transition.
 */
const PATCH_COLUMNS = new Set(['refund_outcome', 'arkade_refund_txid', 'onchain_claim_txid'])

export interface OnchainReceiveSwapRow {
  id: string
  state: OnchainReceiveSwapState
  createdAt: number
  updatedAt: number
  paymentHash: string
  /** What the client funds the onchain HTLC with. */
  amountSats: number
  /**
   * What the solver FUNDS into the Arkade lockup: `amountSats` minus this
   * corridor's fee, computed and persisted AT QUOTE TIME. A client who has
   * already funded their HTLC cannot have their payout recomputed against a
   * fee that changed since — the quoted number has to be a fact on the row.
   * Rows quoted before fees existed carry NULL and read back as `amountSats`,
   * which is exactly what they were quoted at.
   */
  payoutSats: number
  /** The onchain HTLC's own CLTV deadline — the CLIENT's refund path on this leg. */
  htlcLocktime: number
  /** The Arkade lockup's refund deadline — the SOLVER's own refund path on this leg. */
  refundLocktime: number
  minConfirmations: number
  /**
   * The solver's own Arkade settlement key, hex x-only. Fills the covenant's
   * `client` (VHTLC "sender") role — the party who funded the lockup and so
   * needs its own refund recourse — exactly as `solverPubkey` does on the
   * Lightning receive leg. Also reused as the solver's onchain HTLC claim key
   * (`htlcPubkey`), the same "one key, two roles" simplification
   * `onchainOrchestrator.ts` (send) applies.
   *
   * It used to fill `receiver` as well. That is now
   * {@link clientPayoutPubkey}'s job — see its doc comment for why the
   * corridors must agree.
   */
  providerPubkey: string
  /**
   * The CLIENT's own Arkade x-only key — the covenant's `receiver` role, and
   * the reason the client can claim the lockup itself.
   *
   * Both receive corridors are the SAME swap on the Arkade side (the solver
   * funds, the client is the beneficiary, the client generated `P`), so they
   * carry the SAME covenant; only the other leg differs. This field is what
   * makes that true — it mirrors the Lightning leg's `payoutPubkey`.
   *
   * It is not redundant with {@link clientPayoutPkScript}: that is the
   * `nonInteractiveClaim` PAYOUT PIN (where a claim must pay), this is a
   * SIGNING KEY (who may spend the collaborative `claim` leaf, which is
   * `preimage + receiver + server`). Without it the client holds no key in
   * this covenant at all and its only route to the funds is covclaimd — which
   * is exactly the single point of failure this corridor cannot afford, since
   * covclaimd accepts a reveal and then silently declines to claim against
   * this covenant shape (observed against `covclaimd:v0.0.1-rc.1`).
   */
  clientPayoutPubkey: string
  serverPubkey: string
  claimDelay: number
  refundDelay: number
  refundWithoutReceiverDelay: number
  emulatorPubkey: string
  pkScript: string
  lockupAddress: string
  /** The SOLVER's own Arkade destination — where `nonInteractiveRefund` pays if covclaimd never claims in time. Reuses the service's own receiving pkScript, same value `ArkadeOps.receiverPkScript` already is on the send leg, just filling the covenant's `refundPkScript` slot instead of `receiverPkScript` this time. */
  refundPkScript: string
  /** The CLIENT's own Arkade payout destination, per-swap — the ONE place client identity enters this covenant. Pinned into `nonInteractiveClaim` via `enforcePayTo`, so covclaimd's autonomous claim can only ever pay here. */
  clientPayoutPkScript: string
  /**
   * Whether this lockup was funded WITH the timelocked non-interactive
   * refund leaf. Null means "rebuild the eight-leaf shape, exactly as
   * funded" — not a refusal case. See `CovenantScriptRow`'s doc comment on
   * the same field.
   */
  nonInteractiveParameters: boolean | null
  /** The solver's onchain HTLC claim pubkey — reuses `providerPubkey`, same "one key, two roles" simplification. */
  htlcPubkey: string
  /** The client's onchain HTLC refund pubkey, supplied in the request. */
  clientOnchainRefundPubkey: string
  onchainAddress: string
  onchainPkScript: string
  /** `P` ECIES-sealed to covclaimd, base64, exactly as the client supplied it — carried blindly, never decrypted here. */
  claimPacket: string
  fundingTxid: string | null
  /** The vout `fundingTxid` actually pays the onchain HTLC at — never assume 0, same reasoning as the send leg's identical field. */
  fundingVout: number | null
  /** Audit fact: the txid the solver's own Arkade-funding broadcast produced. */
  arkadeFundTxid: string | null
  /** `P`, hex, once covclaimd's claim reveals it. */
  preimage: string | null
  /** Audit fact: the checkpoint/Ark txid where `P` was actually observed. */
  arkadeClaimTxid: string | null
  /**
   * The solver's own onchain claim txid.
   *
   * NULL ON A `settled` ROW MEANS THE RECOVERY PATH, not a missing write. When
   * `whenClaimed` finds the HTLC already spent and recognises the solver's own
   * preimage in the witness, it settles the row on that evidence — and
   * `findSpendWitness` returns the witness stack, never the spending txid, so
   * there is nothing truthful to record. An operator tracing such a row finds
   * the transaction by looking up the spend of `funding_txid`:`funding_vout`,
   * not by this column. Inventing a txid to fill it would be worse than the
   * gap. @see receive/onchainOrchestrator.ts `whenClaimed`
   */
  onchainClaimTxid: string | null
  arkadeRefundTxid: string | null
  refundOutcome: 'pushed' | 'external' | null
  failureReason: string | null
  rfqId: string | null
  /**
   * When a worker won the exclusive right to pay this swap's Arkade lockup.
   *
   * NULL until one does, and never cleared. It is a one-shot claim rather than
   * a timed lease: see {@link OnchainReceiveSwapStore.claimFundLease} for why
   * an expiry would reinstate the double-fund it exists to prevent.
   */
  fundStartedAt: number | null
}

const RECEIVE_ONCHAIN_SWAP_COLUMNS = `
  id                            TEXT PRIMARY KEY,
  state                         TEXT NOT NULL,
  created_at                    INTEGER NOT NULL,
  updated_at                    INTEGER NOT NULL,
  payment_hash                  TEXT NOT NULL,
  amount_sats                   INTEGER NOT NULL,
  payout_sats                   INTEGER NOT NULL,
  htlc_locktime                 INTEGER NOT NULL,
  refund_locktime               INTEGER NOT NULL,
  min_confirmations             INTEGER NOT NULL,
  provider_pubkey               TEXT NOT NULL,
  client_payout_pubkey          TEXT NOT NULL,
  server_pubkey                 TEXT NOT NULL,
  claim_delay                   INTEGER NOT NULL,
  refund_delay                  INTEGER NOT NULL,
  refund_without_receiver_delay INTEGER NOT NULL,
  emulator_pubkey                TEXT NOT NULL,
  pk_script                      TEXT NOT NULL,
  lockup_address                 TEXT NOT NULL,
  refund_pk_script                TEXT NOT NULL,
  client_payout_pk_script         TEXT NOT NULL,
  non_interactive_parameters TEXT,
  htlc_pubkey                     TEXT NOT NULL,
  client_onchain_refund_pubkey    TEXT NOT NULL,
  onchain_address                 TEXT NOT NULL,
  onchain_pk_script                TEXT NOT NULL,
  claim_packet                     TEXT NOT NULL,
  funding_txid                     TEXT,
  funding_vout                     INTEGER,
  arkade_fund_txid                 TEXT,
  preimage                         TEXT,
  arkade_claim_txid                TEXT,
  onchain_claim_txid               TEXT,
  arkade_refund_txid               TEXT,
  refund_outcome                   TEXT,
  failure_reason                   TEXT,
  rfq_id                           TEXT,
  fund_started_at                  INTEGER
`

const SCHEMA = `
CREATE TABLE IF NOT EXISTS receive_onchain_swap (${RECEIVE_ONCHAIN_SWAP_COLUMNS});
CREATE INDEX IF NOT EXISTS idx_receive_onchain_swap_state ON receive_onchain_swap(state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_receive_onchain_swap_live_hash
  ON receive_onchain_swap(payment_hash) WHERE state != 'refused';
-- Partial for the same reason as send_swap's: findByRfqId runs on every
-- inbound rfq_status_request, which falls through all four corridors' stores.
CREATE INDEX IF NOT EXISTS idx_receive_onchain_swap_rfq_id
  ON receive_onchain_swap(rfq_id) WHERE rfq_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS receive_onchain_swap_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  swap_id    TEXT NOT NULL REFERENCES receive_onchain_swap(id),
  at         INTEGER NOT NULL,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_receive_onchain_swap_event_swap ON receive_onchain_swap_event(swap_id);
`

type Raw = Record<string, string | number | null>

const toRow = (raw: Raw): OnchainReceiveSwapRow => ({
  id: String(raw.id),
  state: String(raw.state) as OnchainReceiveSwapState,
  createdAt: Number(raw.created_at),
  updatedAt: Number(raw.updated_at),
  paymentHash: String(raw.payment_hash),
  amountSats: Number(raw.amount_sats),
  // Rows quoted before fees existed have no payout_sats; they charged nothing,
  // so the payout WAS the amount. The fallback is that fact, not a default.
  payoutSats:
    raw.payout_sats === null || raw.payout_sats === undefined ? Number(raw.amount_sats) : Number(raw.payout_sats),
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
  refundOutcome: raw.refund_outcome === null ? null : (String(raw.refund_outcome) as 'pushed' | 'external'),
  failureReason: raw.failure_reason === null ? null : String(raw.failure_reason),
  rfqId: raw.rfq_id === null || raw.rfq_id === undefined ? null : String(raw.rfq_id),
  fundStartedAt: raw.fund_started_at === null || raw.fund_started_at === undefined ? null : Number(raw.fund_started_at),
})

export interface OnchainReceiveQuoteRecord {
  id: string
  paymentHash: string
  amountSats: number
  /** See {@link OnchainReceiveSwapRow.payoutSats} — required, never derived here. */
  payoutSats: number
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
  /**
   * @see OnchainReceiveSwapRow.nonInteractiveParameters
   *
   * REQUIRED, unlike the row's own field: this table has no legacy family,
   * so nothing justifies letting a caller forget it. See
   * OnchainSendSwapRow's identical note for what forgetting it costs.
   */
  nonInteractiveParameters: boolean
  htlcPubkey: string
  clientOnchainRefundPubkey: string
  onchainAddress: string
  onchainPkScript: string
  claimPacket: string
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
export const ONCHAIN_RECEIVE_SEARCH_COLUMNS: readonly string[] = [
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

const SHAPE: StoreShape<OnchainReceiveSwapRow, OnchainReceiveSwapState> = {
  table: 'receive_onchain_swap',
  eventTable: 'receive_onchain_swap_event',
  noun: 'onchain receive swap',
  lifecycleLabel: 'onchain receive lifecycle',
  searchColumns: ONCHAIN_RECEIVE_SEARCH_COLUMNS,
  legalEdges: LEGAL_EDGES,
  transitionColumns: TRANSITION_COLUMNS,
  patchColumns: PATCH_COLUMNS,
  live: NON_TERMINAL,
  exposed: EXPOSED,
  failStates: { exposed: 'stuck', clean: 'refused' },
  toRow: (raw: RawRow) => toRow(raw as Raw),
}

export class OnchainReceiveSwapStore extends BaseSwapStore<OnchainReceiveSwapRow, OnchainReceiveSwapState> {
  protected readonly shape = SHAPE

  static async open(driver: SqlDriver | string, now: () => number = nowSeconds): Promise<OnchainReceiveSwapStore> {
    const store = new OnchainReceiveSwapStore(typeof driver === 'string' ? betterSqliteDriver(driver) : driver, now)
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
    const columns = await this.driver.all<{ name: string }>(`PRAGMA table_info(receive_onchain_swap)`)
    const existing = new Set(columns.map((c) => c.name))
    if (!existing.has('payout_sats')) {
      await this.driver.exec(`ALTER TABLE receive_onchain_swap ADD COLUMN payout_sats INTEGER`)
    }
    if (!existing.has('fund_started_at')) {
      await this.driver.exec(`ALTER TABLE receive_onchain_swap ADD COLUMN fund_started_at INTEGER`)
    }
    if (!existing.has('non_interactive_parameters')) {
      await this.driver.exec(`ALTER TABLE receive_onchain_swap ADD COLUMN non_interactive_parameters TEXT`)
    }
  }

  /**
   * Claim the exclusive right to pay this swap's Arkade lockup.
   *
   * Returns true to exactly ONE caller. The compare-and-swap is on
   * `fund_started_at IS NULL`, so a second worker reaching the same row loses
   * here — before it spends, which is the only place losing is free.
   *
   * ## Why the chain read is not enough
   *
   * `whenFundingArkade` already asks `findLockups` whether this swap's script
   * is funded, and adopts it if so. That closes the CRASH case: a restart sees
   * what landed. It does not close the CONCURRENT case, and its comment saying
   * a persisted flag is unnecessary is true only of the former. Two workers in
   * the same window both read an empty script — the first one's payment has not
   * landed yet, which is precisely why the second is still running — and both
   * pay. Coin selection is per-process, so they select DIFFERENT vtxos and both
   * succeed, leaving two lockup outputs where the swap needs one. The
   * compare-and-swap on `state` that follows the payment gates RECORDING, not
   * spending.
   *
   * ## What it does not close
   *
   * A crash between winning the lease and the payment landing. The row then
   * holds a lease with no `arkade_fund_txid`, and this service cannot tell from
   * its own state whether the transaction is in flight or was never sent. That
   * is deliberately left STUCK and visible rather than retried: retrying is the
   * double-fund this exists to prevent, and `findLockups` will adopt the lockup
   * on the next tick if the payment did land. Closing it properly needs
   * idempotency at the wallet, which `sendBitcoin` does not offer.
   *
   * No TTL, for the same reason. A lease that expires is a lease that lets a
   * second worker pay while the first may still be in flight, which reinstates
   * the bug on a timer.
   */
  async claimFundLease(id: string, from: OnchainReceiveSwapState): Promise<boolean> {
    const result = await this.driver.run(
      `UPDATE receive_onchain_swap SET fund_started_at = ?, updated_at = ?
       WHERE id = ? AND state = ? AND fund_started_at IS NULL`,
      [this.now(), this.now(), id, from],
    )
    return result.changes === 1
  }

  /**
   * Give the lease back when the payment provably did not happen.
   *
   * Called only when `fund()` THREW. Without it a failure that moved no money
   * strands the row for every worker, not just the one that failed.
   *
   * Not "the lease expired": a throw is not proof nothing was sent, so this
   * re-opens the ambiguity the adoption check above already owns and resolves
   * by reading the script. What the lease adds is narrower and is the actual
   * defect — two workers cannot both be inside `fund()` at once.
   */
  async releaseFundLease(id: string): Promise<void> {
    await this.driver.run(`UPDATE receive_onchain_swap SET fund_started_at = NULL WHERE id = ?`, [id])
  }

  /**
   * Record a quote before anything is funded. Rejects (UNIQUE violation) if
   * a non-refused row already exists for this payment hash — same
   * idempotency rule as every other store here (rfq-protocol.md §4.5).
   */
  async insertQuote(quote: OnchainReceiveQuoteRecord): Promise<OnchainReceiveSwapRow> {
    const at = this.now()
    await this.driver.run(
      `INSERT INTO receive_onchain_swap (
        id, state, created_at, updated_at, payment_hash, amount_sats, payout_sats,
        htlc_locktime, refund_locktime, min_confirmations,
        provider_pubkey, client_payout_pubkey, server_pubkey, claim_delay, refund_delay, refund_without_receiver_delay, emulator_pubkey,
        pk_script, lockup_address, refund_pk_script, client_payout_pk_script,
        non_interactive_parameters,
        htlc_pubkey, client_onchain_refund_pubkey,
        onchain_address, onchain_pk_script, claim_packet, rfq_id
      ) VALUES (?, 'quoted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        quote.id,
        at,
        at,
        quote.paymentHash,
        quote.amountSats,
        quote.payoutSats,
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
        quote.nonInteractiveParameters === undefined ? null : quote.nonInteractiveParameters ? '1' : null,
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

  async findLiveByPaymentHash(paymentHash: string): Promise<OnchainReceiveSwapRow | null> {
    const raw = await this.driver.get<Raw>(
      `SELECT * FROM receive_onchain_swap WHERE payment_hash = ? AND state != 'refused' LIMIT 1`,
      [paymentHash],
    )
    return raw ? toRow(raw) : null
  }
}
