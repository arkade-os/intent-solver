/**
 * Durable state for the `arkade:BTC->ethereum:<token>` send leg.
 *
 * Same rule as every other store here: a column exists because a specific crash
 * needs it. `refund_locktime` above all - without it on disk a funded Arkade
 * lockup cannot be reconstructed after a restart, and an unreconstructible
 * script is unrefundable, not merely unclaimable.
 *
 * What this table carries that the onchain one does not is the EVM side's
 * identity, and it is three separate facts rather than one:
 *
 * - `token_address` - WHICH ERC20. The corridor names it, so a row without it
 *   cannot be matched back to the policy that quoted it.
 * - `evm_contract_address` - WHICH `ERC20Swap`. A deployment can be pointed at
 *   a different contract between quote and claim, and the lock lives in the one
 *   that was current when it was created.
 * - `evm_chain_id` - WHICH CHAIN. The same swap key can exist on two chains;
 *   the id is what stops a claim being attempted against the wrong one.
 *
 * `evm_amount` is TEXT, not INTEGER. ERC20 amounts are 256-bit and routinely
 * exceed what a JS number holds exactly - persisting one as a float would
 * silently round a payout.
 *
 * Lifecycle, forward-only:
 *
 * - `quoted`         params on disk, nothing has moved
 * - `funded`         Arkade lockup seen; nothing locked on the EVM side, so abandoning is safe
 * - `locking_evm`    the ERC20 lock call is in flight - the exposed state, because a revert
 *                    is not observable until it is mined
 * - `awaiting_claim` the lock is confirmed; waiting for the client to reveal the preimage
 * - `claiming`       preimage on disk; claiming the Arkade lockup needs nothing external
 * - `claimed`        done
 * - `refunding_evm`  client never claimed past `evm_timeout`; the solver's refund is broadcast
 *                    and awaiting its receipt, so the tokens are still exposed
 * - `refunded`       the solver's EVM refund landed - the swap failed, no capital stuck
 * - `refused`        never locked on the EVM side, no exposure
 * - `stuck`          locked on the EVM side but could not claim the Arkade lockup before the
 *                    refund deadline; needs a human
 */

import { betterSqliteDriver, type SqlDriver } from '@arkade-os/solver-db/driver.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import { EVM_SEND_NON_TERMINAL, type EvmSendSwapState } from '@arkade-os/solver-core/core/evmSwapState.js'
import { EvmSwapStore, commonFields, text, type Raw } from './evmSwapStore.js'

export interface EvmSendSwapRow {
  id: string
  state: EvmSendSwapState
  createdAt: number
  updatedAt: number
  paymentHash: string
  /** What the client locks at the Arkade covenant. */
  amountSats: number
  /** `amountSats` minus this corridor's fee, fixed AT QUOTE TIME. */
  payoutSats: number
  /** The ERC20 the solver locks, in the token's own base units. TEXT - see above. */
  evmAmount: string
  /** Lowercase 0x - the ERC20 this corridor serves. */
  tokenAddress: string
  /** Lowercase 0x - the `ERC20Swap` the lock lives in. */
  evmContractAddress: string
  evmChainId: number
  /** Block height at which the solver may refund its own lock. */
  evmTimeout: number
  /**
   * The quote stops binding here: unix seconds. Funding first observed past
   * this is refused, never filled at stale terms, and an unfunded quote is
   * refused outright so the row stops holding capacity.
   */
  validUntil: number
  /** Depth AND age, both required - see `evm/config.ts` on why depth alone is not finality. */
  minConfirmations: number
  minAgeSeconds: number
  evmLockTxid: string | null
  evmRefundTxid: string | null
  evmClaimTxid: string | null
  /** Where the client claims the ERC20 to. */
  evmClaimAddress: string
  /** Where the solver refunds its own lock to. */
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
  /**
   * Whether this lockup was funded WITH the timelocked non-interactive
   * refund leaf. Unlike `clientRefundPubkey` this genuinely can be null on a
   * row created after the leaf shipped, on any table: null means "rebuild
   * the eight-leaf shape, exactly as funded" and is not a refusal case. See
   * `CovenantScriptRow`'s doc comment on the same field.
   */
  nonInteractiveParameters: boolean | null
  preimage: string | null
  claimArkTxid: string | null
  refundArkTxid: string | null
  /**
   * How the Arkade lockup left the script: 'pushed' (our sweep spent the
   * non-interactive refund leaf), 'external' (someone else spent it — recorded
   * on the strength of a provable spend, not one empty read), or NULL (still
   * to resolve). Mirrors `send_swap.refund_outcome`.
   */
  refundOutcome: string | null
  rfqId: string | null
  failureReason: string | null
}

// SCHEMA HISTORY. `valid_until` and `refund_outcome` were added after these
// tables first shipped on the feat/evm-corridors branch. CREATE TABLE IF NOT
// EXISTS does not extend an already-created table, so an environment whose
// database predates those two columns needs, once, before this code
// deploys against it:
//
//   ALTER TABLE send_evm_swap ADD COLUMN valid_until INTEGER NOT NULL DEFAULT 0;
//   ALTER TABLE send_evm_swap ADD COLUMN refund_outcome TEXT;
//
// Without them the failure modes are: pre-existing rows read valid_until as
// NaN and never expire (fail-safe, but silent), and any insert or refund-sweep
// patch throws "no such column". Fresh databases get both columns from the
// CREATE below — no runtime migration on purpose: the gap can only exist on a
// staging box that ran unreleased corridor code, and it should be fixed
// deliberately, not self-healed invisibly.
//
// EXPECT PENDING QUOTES TO TERMINATE. `DEFAULT 0` dates existing rows to 1970,
// so the first tick after the ALTER refuses every `quoted` row as expired.
// Correct — the alternative is filling at a pre-restart rate — but an operator
// not told will read the refusals as breakage. Only `quoted` rows are affected;
// anything funded has already passed that check.
const COLUMNS = `
  id                            TEXT PRIMARY KEY,
  state                         TEXT NOT NULL,
  created_at                    INTEGER NOT NULL,
  updated_at                    INTEGER NOT NULL,
  payment_hash                  TEXT NOT NULL,
  amount_sats                   INTEGER NOT NULL,
  payout_sats                   INTEGER,
  evm_amount                    TEXT NOT NULL,
  token_address                 TEXT NOT NULL,
  evm_contract_address          TEXT NOT NULL,
  evm_chain_id                   INTEGER NOT NULL,
  evm_timeout                    INTEGER NOT NULL,
  valid_until                    INTEGER NOT NULL,
  min_confirmations              INTEGER NOT NULL,
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
  non_interactive_parameters TEXT,
  preimage                      TEXT,
  claim_ark_txid                TEXT,
  refund_ark_txid               TEXT,
  refund_outcome                TEXT,
  rfq_id                        TEXT,
  failure_reason                TEXT
`

const SCHEMA = `
CREATE TABLE IF NOT EXISTS send_evm_swap (${COLUMNS});
CREATE INDEX IF NOT EXISTS idx_send_evm_swap_state ON send_evm_swap(state);
-- One LIVE row per payment hash, as in every other corridor: two lockups
-- against one hash means whichever client loses the race is claimed with no
-- refund.
CREATE UNIQUE INDEX IF NOT EXISTS idx_send_evm_swap_live_hash
  ON send_evm_swap(payment_hash) WHERE state != 'refused';
-- Partial for the reason the other corridors give: findByRfqId runs on every
-- inbound rfq_status_request and falls through every store.
CREATE INDEX IF NOT EXISTS idx_send_evm_swap_rfq_id
  ON send_evm_swap(rfq_id) WHERE rfq_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS send_evm_swap_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  swap_id    TEXT NOT NULL REFERENCES send_evm_swap(id),
  at         INTEGER NOT NULL,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_send_evm_swap_event_swap ON send_evm_swap_event(swap_id);
`

const toRow = (raw: Raw): EvmSendSwapRow => ({
  ...commonFields(raw),
  state: String(raw.state) as EvmSendSwapState,
  evmRefundTxid: text(raw.evm_refund_txid),
  claimArkTxid: text(raw.claim_ark_txid),
  refundOutcome: text(raw.refund_outcome),
})

export type EvmSendQuoteRecord = Omit<
  EvmSendSwapRow,
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
> & {
  /**
   * @see EvmSendSwapRow.nonInteractiveParameters
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
}

export class EvmSendSwapStore extends EvmSwapStore<EvmSendSwapRow, EvmSendSwapState> {
  private constructor(driver: SqlDriver, now: () => number) {
    super(driver, now, {
      table: 'send_evm_swap',
      noun: 'send',
      toRow,
      nonTerminal: EVM_SEND_NON_TERMINAL,
      transitionColumns: new Set([
        'evm_lock_txid',
        'evm_refund_txid',
        'evm_claim_txid',
        'preimage',
        'claim_ark_txid',
        'refund_ark_txid',
        'refund_outcome',
        'failure_reason',
      ]),
    })
  }

  static async open(driver: SqlDriver | string, now: () => number = nowSeconds): Promise<EvmSendSwapStore> {
    const store = new EvmSendSwapStore(typeof driver === 'string' ? betterSqliteDriver(driver) : driver, now)
    await store.driver.exec(SCHEMA)
    return store
  }

  async insertQuote(quote: EvmSendQuoteRecord): Promise<EvmSendSwapRow> {
    return this.insert(quote)
  }

  /**
   * `refused` rows whose Arkade lockup has not been refunded yet — the refund
   * sweep's input.
   *
   * No deadline gate, unlike the Lightning corridor's `findRefundable`: every
   * EVM row is quoted through the RFQ family, so every one carries a client
   * refund key and the eight-leaf script whose non-interactive refund leaf is
   * IMMEDIATE — there is no timelock to wait out. And `refused` is by
   * definition a swap the solver never paid against (the planner only refuses
   * before locking), so pushing the refund cannot pay twice.
   */
  async findRefundable(): Promise<EvmSendSwapRow[]> {
    const rows = (await this.driver.all(
      `SELECT * FROM send_evm_swap
       WHERE state = 'refused' AND refund_outcome IS NULL
       ORDER BY created_at`,
    )) as Raw[]
    return rows.map(toRow)
  }

  /** Closed rows that reached a lock call, while their refund window is open.
   * `refunded` counts: the word rests on the refund receipt's status alone. */
  async findClosedOverLock(nowSeconds: number): Promise<EvmSendSwapRow[]> {
    // Keyed on the ENTRY into `locking_evm`, never on `evm_lock_txid`: that is
    // patched after the broadcast, so a crash leaves it null over the very lock
    // still in the mempool this must not skip.
    const rows = (await this.driver.all(
      `SELECT * FROM send_evm_swap AS s
       WHERE s.state IN ('stuck', 'refunded') AND s.refund_locktime > ?
         AND EXISTS (SELECT 1 FROM send_evm_swap_event AS e
                     WHERE e.swap_id = s.id AND e.to_state = 'locking_evm')
       ORDER BY s.created_at`,
      [nowSeconds],
    )) as Raw[]
    return rows.map(toRow)
  }

  /** First writer wins, true when that was us: the resend has no state CAS to ride. */
  async claimRefundTxid(id: string, txid: string): Promise<boolean> {
    const result = await this.driver.run(
      'UPDATE send_evm_swap SET updated_at = ?, evm_refund_txid = ? WHERE id = ? AND evm_refund_txid IS NULL',
      [this.now(), txid, id],
    )
    return (result?.changes ?? 0) > 0
  }
}
