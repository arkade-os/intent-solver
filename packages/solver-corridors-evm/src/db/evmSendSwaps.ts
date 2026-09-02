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
 * - `refunding_evm`  client never claimed past `evm_timeout`; the solver refunds its own lock
 * - `refunded`       the solver's EVM refund landed - the swap failed, no capital stuck
 * - `refused`        never locked on the EVM side, no exposure
 * - `stuck`          locked on the EVM side but could not claim the Arkade lockup before the
 *                    refund deadline; needs a human
 */

import { betterSqliteDriver, type SqlDriver } from '@arkade-os/solver-db/driver.js'
import { pageQuery, takePage, type PageOptions, type PageRawFields } from '@arkade-os/solver-core/core/page.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import { EVM_SEND_NON_TERMINAL, type EvmSendSwapState } from '@arkade-os/solver-core/core/evmSwapState.js'

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
// database was created by the pre-#228 schema needs, once, before this code
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

type Raw = Record<string, string | number | null>

// `| undefined` because `noUncheckedIndexedAccess` makes every raw column
// lookup possibly-absent, and a column this store does not know about is
// absent rather than null.
const text = (value: string | number | null | undefined): string | null =>
  value === null || value === undefined ? null : String(value)

const toRow = (raw: Raw): EvmSendSwapRow => ({
  id: String(raw.id),
  state: String(raw.state) as EvmSendSwapState,
  createdAt: Number(raw.created_at),
  updatedAt: Number(raw.updated_at),
  paymentHash: String(raw.payment_hash),
  amountSats: Number(raw.amount_sats),
  // Rows quoted before a fee existed carry NULL and read back as the full
  // amount, which is exactly what they were quoted at.
  payoutSats: raw.payout_sats === null ? Number(raw.amount_sats) : Number(raw.payout_sats),
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

/** Columns `transition()` may set, so a typo cannot silently write nothing. */
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

export class EvmSendSwapStore {
  private constructor(
    private readonly driver: SqlDriver,
    private readonly now: () => number,
  ) {}

  static async open(driver: SqlDriver | string, now: () => number = nowSeconds): Promise<EvmSendSwapStore> {
    const store = new EvmSendSwapStore(typeof driver === 'string' ? betterSqliteDriver(driver) : driver, now)
    await store.driver.exec(SCHEMA)
    return store
  }

  async close(): Promise<void> {
    await this.driver.close?.()
  }

  async insertQuote(quote: EvmSendQuoteRecord): Promise<EvmSendSwapRow> {
    const at = this.now()
    await this.driver.run(
      `INSERT INTO send_evm_swap (
         id, state, created_at, updated_at, payment_hash, amount_sats, payout_sats, evm_amount,
         token_address, evm_contract_address, evm_chain_id, evm_timeout, valid_until, min_confirmations,
         min_age_seconds, evm_claim_address, evm_refund_address, refund_locktime, provider_pubkey,
         server_pubkey, claim_delay, refund_delay, refund_without_receiver_delay, pk_script,
         lockup_address, refund_pk_script, emulator_pubkey, client_refund_pubkey, receiver_pk_script,
         non_interactive_parameters, rfq_id
       ) VALUES (?, 'quoted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        quote.id,
        at,
        at,
        quote.paymentHash,
        quote.amountSats,
        quote.payoutSats,
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
        quote.nonInteractiveParameters === undefined ? null : quote.nonInteractiveParameters ? '1' : null,
        quote.rfqId,
      ],
    )
    await this.driver.run(
      `INSERT INTO send_evm_swap_event (swap_id, at, from_state, to_state) VALUES (?, ?, NULL, 'quoted')`,
      [quote.id, at],
    )
    return this.get(quote.id)
  }

  async get(id: string): Promise<EvmSendSwapRow> {
    const rows = (await this.driver.all(`SELECT * FROM send_evm_swap WHERE id = ?`, [id])) as Raw[]
    const raw = rows[0]
    if (!raw) throw new Error('no evm send swap ' + id)
    return toRow(raw)
  }

  async findByRfqId(rfqId: string): Promise<EvmSendSwapRow | null> {
    const rows = (await this.driver.all(`SELECT * FROM send_evm_swap WHERE rfq_id = ?`, [rfqId])) as Raw[]
    return rows[0] ? toRow(rows[0]) : null
  }

  async findLiveByPaymentHash(paymentHash: string): Promise<EvmSendSwapRow | null> {
    const rows = (await this.driver.all(
      `SELECT * FROM send_evm_swap WHERE payment_hash = ? AND state != 'refused'  `.trim(),
      [paymentHash],
    )) as Raw[]
    return rows[0] ? toRow(rows[0]) : null
  }

  /**
   * Total sats COMMITTED across every non-terminal swap — this corridor's
   * contribution to the house cap.
   *
   * NON_TERMINAL, not money-committed-only: a swap the provider has QUOTED is
   * capacity it may have to honour. The quote is binding until `valid_until`
   * and the client can fund any time inside that window at the quoted rate, so
   * an unfunded row is a claim on the float, not free capacity. Counting only
   * the exposed states would let unlimited concurrent quotes slip past the cap
   * and all be paid at once — the invariant `src/db/swaps.ts` states on its
   * own committedSats, and the one the #38 TLA+ admission guard asserts.
   */
  async committedSats(): Promise<number> {
    const placeholders = EVM_SEND_NON_TERMINAL.map(() => '?').join(', ')
    const rows = (await this.driver.all(
      'SELECT COALESCE(SUM(amount_sats), 0) AS total FROM send_evm_swap WHERE state IN (' + placeholders + ')',
      [...EVM_SEND_NON_TERMINAL],
    )) as Raw[]
    return Number(rows[0]?.total ?? 0)
  }

  async findByStates(states: readonly EvmSendSwapState[]): Promise<EvmSendSwapRow[]> {
    if (states.length === 0) return []
    const placeholders = states.map(() => '?').join(', ')
    const rows = (await this.driver.all(
      'SELECT * FROM send_evm_swap WHERE state IN (' + placeholders + ') ORDER BY created_at ASC',
      [...states],
    )) as Raw[]
    return rows.map(toRow)
  }

  /** Every row that has not reached a terminal state. */
  async findLive(): Promise<EvmSendSwapRow[]> {
    return this.findByStates(EVM_SEND_NON_TERMINAL)
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

  async history(swapId: string): Promise<{ at: number; from: string | null; to: string; detail: string | null }[]> {
    const rows = (await this.driver.all(
      'SELECT at, from_state, to_state, detail FROM send_evm_swap_event WHERE swap_id = ? ORDER BY id ASC',
      [swapId],
    )) as Raw[]
    return rows.map((raw) => ({
      at: Number(raw.at),
      from: text(raw.from_state),
      to: String(raw.to_state),
      detail: text(raw.detail),
    }))
  }

  async page(options: PageOptions = {}): Promise<{ rows: EvmSendSwapRow[]; nextCursor: string | null }> {
    const { sql, params, limit } = pageQuery('send_evm_swap', options)
    const raw = await this.driver.all<Raw & PageRawFields>(sql, params)
    const { page, nextCursor } = takePage(raw, limit)
    return { rows: page.map(toRow), nextCursor }
  }

  /**
   * Move a row forward, GUARDED on the state it is moving from.
   *
   * The guard is what makes a concurrent tick safe: two ticks that both read
   * `funded` cannot both advance it, because the second one's UPDATE matches no
   * row and it is told so rather than silently doing nothing.
   */
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
      'UPDATE send_evm_swap SET state = ?, updated_at = ?' +
        (assignments ? ', ' + assignments : '') +
        ' WHERE id = ? AND state = ?',
      [to, at, ...columns.map((column) => fields[column] as string | number | null), id, from],
    )
    if ((result?.changes ?? 0) === 0) {
      throw new Error('evm send swap ' + id + ' is not in state ' + from)
    }
    await this.driver.run('INSERT INTO send_evm_swap_event (swap_id, at, from_state, to_state) VALUES (?, ?, ?, ?)', [
      id,
      at,
      from,
      to,
    ])
  }

  /**
   * Set fields WITHOUT moving the row.
   *
   * Separate from `transition` because recording a txid is not a state change,
   * and routing it through `transition` would write a self-transition into the
   * event log - making the history claim the row moved when it did not.
   */
  async patch(id: string, fields: Record<string, unknown>): Promise<void> {
    const columns = Object.keys(fields)
    if (columns.length === 0) return
    assertColumns(columns, TRANSITION_COLUMNS, 'patch()')
    const assignments = columns.map((column) => column + ' = ?').join(', ')
    await this.driver.run('UPDATE send_evm_swap SET updated_at = ?, ' + assignments + ' WHERE id = ?', [
      this.now(),
      ...columns.map((column) => fields[column] as string | number | null),
      id,
    ])
  }

  /** Terminal failure, with the reason on the row so an operator need not guess. */
  async fail(id: string, from: EvmSendSwapState, reason: string): Promise<void> {
    await this.transition(id, from, 'stuck', { failure_reason: reason })
  }
}
