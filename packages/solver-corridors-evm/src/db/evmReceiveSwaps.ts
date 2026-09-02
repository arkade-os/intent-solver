/**
 * Durable state for the `ethereum:<token>->arkade:BTC` receive leg.
 *
 * The mirror of `db/evmSendSwaps.ts`, and the inversion is the whole point: here the
 * CLIENT locks the ERC20 and the SOLVER locks sats. So the risk runs the other
 * way, and two columns exist that the send table has no use for.
 *
 * `evm_lock_txid` is the CLIENT's lock, observed rather than broadcast. The
 * solver never created it, so it can vanish in a reorg after the solver has
 * already funded sats against it - which is why `min_confirmations` and
 * `min_age_seconds` matter more on this side than on the other.
 *
 * `evm_claim_txid` is the SOLVER's claim, and it is how the solver gets paid at
 * all. On the send leg a missed claim costs the client; here it costs the
 * solver, because the sats have already gone out.
 *
 * Lifecycle, forward-only:
 *
 * - `quoted`           params on disk, nothing has moved
 * - `awaiting_lock`    waiting for the client's ERC20 lock to appear
 * - `locked`           the lock is there and has met depth AND age
 * - `funding_arkade`   the solver is funding the Arkade lockup - the exposed state
 * - `awaiting_claim`   Arkade lockup funded; waiting for the client to claim and reveal
 * - `claiming`         preimage on disk; the solver is claiming the client's ERC20
 * - `claimed`          done, and the solver has been paid
 * - `refunding_arkade` the client never claimed; the solver takes its own sats back
 * - `refunded`         the swap failed and no capital is stuck
 * - `refused`          never funded, no exposure
 * - `stuck`            sats are out and the ERC20 could not be claimed; needs a human
 */

import { betterSqliteDriver, type SqlDriver } from '@arkade-os/solver-db/driver.js'
import { pageQuery, takePage, type PageOptions, type PageRawFields } from '@arkade-os/solver-core/core/page.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import { EVM_RECEIVE_NON_TERMINAL, type EvmReceiveSwapState } from '@arkade-os/solver-core/core/evmSwapState.js'

export interface EvmReceiveSwapRow {
  id: string
  state: EvmReceiveSwapState
  createdAt: number
  updatedAt: number
  paymentHash: string
  /** What the solver locks at the Arkade covenant for the client. */
  amountSats: number
  /** `amountSats` after this corridor's fee, fixed AT QUOTE TIME. */
  payoutSats: number
  /** What the CLIENT locks, in the token's own base units. TEXT - 256-bit. */
  evmAmount: string
  tokenAddress: string
  evmContractAddress: string
  evmChainId: number
  /** Block height after which the CLIENT may take their ERC20 back. */
  evmTimeout: number
  /**
   * The quote stops binding here: unix seconds. A client's ERC20 lock first
   * observed past this is refused, never funded against at stale terms, and an
   * unlocked quote is refused outright so the row stops holding capacity.
   */
  validUntil: number
  minConfirmations: number
  minAgeSeconds: number
  /** The client's lock, OBSERVED - the solver did not create it. */
  evmLockTxid: string | null
  /** The solver's claim of that lock. This is how the solver gets paid. */
  evmClaimTxid: string | null
  /** Where the solver claims the ERC20 to. */
  evmClaimAddress: string
  /** Where the client's own refund would go, for reconstructing the lock. */
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
  payoutPubkey: string
  preimage: string | null
  fundArkTxid: string | null
  refundArkTxid: string | null
  rfqId: string | null
  failureReason: string | null
}

// SCHEMA HISTORY. `valid_until` was added after this table first shipped on
// the feat/evm-corridors branch; see the twin comment on send_evm_swap for the
// why and the failure modes. For a database created by the pre-#228 schema:
//
//   ALTER TABLE receive_evm_swap ADD COLUMN valid_until INTEGER NOT NULL DEFAULT 0;
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
  payout_pubkey                 TEXT NOT NULL,
  preimage                      TEXT,
  fund_ark_txid                 TEXT,
  refund_ark_txid               TEXT,
  rfq_id                        TEXT,
  failure_reason                TEXT
`

const SCHEMA = `
CREATE TABLE IF NOT EXISTS receive_evm_swap (${COLUMNS});
CREATE INDEX IF NOT EXISTS idx_receive_evm_swap_state ON receive_evm_swap(state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_receive_evm_swap_live_hash
  ON receive_evm_swap(payment_hash) WHERE state != 'refused';
CREATE INDEX IF NOT EXISTS idx_receive_evm_swap_rfq_id
  ON receive_evm_swap(rfq_id) WHERE rfq_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS receive_evm_swap_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  swap_id    TEXT NOT NULL REFERENCES receive_evm_swap(id),
  at         INTEGER NOT NULL,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_receive_evm_swap_event_swap ON receive_evm_swap_event(swap_id);
`

type Raw = Record<string, string | number | null>

const text = (value: string | number | null | undefined): string | null =>
  value === null || value === undefined ? null : String(value)

const toRow = (raw: Raw): EvmReceiveSwapRow => ({
  id: String(raw.id),
  state: String(raw.state) as EvmReceiveSwapState,
  createdAt: Number(raw.created_at),
  updatedAt: Number(raw.updated_at),
  paymentHash: String(raw.payment_hash),
  amountSats: Number(raw.amount_sats),
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
  payoutPubkey: String(raw.payout_pubkey),
  preimage: text(raw.preimage),
  fundArkTxid: text(raw.fund_ark_txid),
  refundArkTxid: text(raw.refund_ark_txid),
  rfqId: text(raw.rfq_id),
  failureReason: text(raw.failure_reason),
})

export type EvmReceiveQuoteRecord = Omit<
  EvmReceiveSwapRow,
  | 'state'
  | 'createdAt'
  | 'updatedAt'
  | 'evmLockTxid'
  | 'evmClaimTxid'
  | 'preimage'
  | 'fundArkTxid'
  | 'refundArkTxid'
  | 'failureReason'
  | 'nonInteractiveParameters'
> & {
  /**
   * @see EvmReceiveSwapRow.nonInteractiveParameters
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

const TRANSITION_COLUMNS: ReadonlySet<string> = new Set([
  'evm_lock_txid',
  'evm_claim_txid',
  'preimage',
  'fund_ark_txid',
  'refund_ark_txid',
  'failure_reason',
])

const assertColumns = (columns: readonly string[], allowed: ReadonlySet<string>, where: string): void => {
  for (const column of columns) {
    if (!allowed.has(column)) throw new Error(where + ': unknown column ' + column)
  }
}

export class EvmReceiveSwapStore {
  private constructor(
    private readonly driver: SqlDriver,
    private readonly now: () => number,
  ) {}

  static async open(driver: SqlDriver | string, now: () => number = nowSeconds): Promise<EvmReceiveSwapStore> {
    const store = new EvmReceiveSwapStore(typeof driver === 'string' ? betterSqliteDriver(driver) : driver, now)
    await store.driver.exec(SCHEMA)
    return store
  }

  async close(): Promise<void> {
    await this.driver.close?.()
  }

  async insertQuote(quote: EvmReceiveQuoteRecord): Promise<EvmReceiveSwapRow> {
    const at = this.now()
    await this.driver.run(
      `INSERT INTO receive_evm_swap (
         id, state, created_at, updated_at, payment_hash, amount_sats, payout_sats, evm_amount,
         token_address, evm_contract_address, evm_chain_id, evm_timeout, valid_until, min_confirmations,
         min_age_seconds, evm_claim_address, evm_refund_address, refund_locktime, provider_pubkey,
         server_pubkey, claim_delay, refund_delay, refund_without_receiver_delay, pk_script,
         lockup_address, refund_pk_script, emulator_pubkey, client_refund_pubkey, receiver_pk_script,
         non_interactive_parameters, payout_pubkey, rfq_id
       ) VALUES (?, 'quoted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        quote.payoutPubkey,
        quote.rfqId,
      ],
    )
    await this.driver.run(
      `INSERT INTO receive_evm_swap_event (swap_id, at, from_state, to_state) VALUES (?, ?, NULL, 'quoted')`,
      [quote.id, at],
    )
    return this.get(quote.id)
  }

  async get(id: string): Promise<EvmReceiveSwapRow> {
    const rows = (await this.driver.all('SELECT * FROM receive_evm_swap WHERE id = ?', [id])) as Raw[]
    const raw = rows[0]
    if (!raw) throw new Error('no evm receive swap ' + id)
    return toRow(raw)
  }

  async findByRfqId(rfqId: string): Promise<EvmReceiveSwapRow | null> {
    const rows = (await this.driver.all('SELECT * FROM receive_evm_swap WHERE rfq_id = ?', [rfqId])) as Raw[]
    return rows[0] ? toRow(rows[0]) : null
  }

  async findLiveByPaymentHash(paymentHash: string): Promise<EvmReceiveSwapRow | null> {
    const rows = (await this.driver.all(
      "SELECT * FROM receive_evm_swap WHERE payment_hash = ? AND state != 'refused'",
      [paymentHash],
    )) as Raw[]
    return rows[0] ? toRow(rows[0]) : null
  }

  /**
   * Sats committed across every non-terminal swap — this corridor's
   * contribution to the house cap.
   *
   * NON_TERMINAL, not money-committed-only. On this side that widens the count
   * beyond where the solver's sats are literally at risk, and deliberately: the
   * quote is binding until `valid_until`, and a client whose ERC20 lock is
   * inside that window is owed a funded lockup — so a live `quoted` or
   * `awaiting_lock` or `locked` row is capacity the solver may have to honour
   * at the quoted rate. Reserving only the exposed states would let unlimited
   * concurrent quotes slip past the cap and all expect funding at once. Once
   * the row is terminal the claim is gone either way.
   */
  async committedSats(): Promise<number> {
    const placeholders = EVM_RECEIVE_NON_TERMINAL.map(() => '?').join(', ')
    const rows = (await this.driver.all(
      'SELECT COALESCE(SUM(amount_sats), 0) AS total FROM receive_evm_swap WHERE state IN (' + placeholders + ')',
      [...EVM_RECEIVE_NON_TERMINAL],
    )) as Raw[]
    return Number(rows[0]?.total ?? 0)
  }

  async findByStates(states: readonly EvmReceiveSwapState[]): Promise<EvmReceiveSwapRow[]> {
    if (states.length === 0) return []
    const placeholders = states.map(() => '?').join(', ')
    const rows = (await this.driver.all(
      'SELECT * FROM receive_evm_swap WHERE state IN (' + placeholders + ') ORDER BY created_at ASC',
      [...states],
    )) as Raw[]
    return rows.map(toRow)
  }

  async findLive(): Promise<EvmReceiveSwapRow[]> {
    return this.findByStates(EVM_RECEIVE_NON_TERMINAL)
  }

  async history(swapId: string): Promise<{ at: number; from: string | null; to: string; detail: string | null }[]> {
    const rows = (await this.driver.all(
      'SELECT at, from_state, to_state, detail FROM receive_evm_swap_event WHERE swap_id = ? ORDER BY id ASC',
      [swapId],
    )) as Raw[]
    return rows.map((raw) => ({
      at: Number(raw.at),
      from: text(raw.from_state),
      to: String(raw.to_state),
      detail: text(raw.detail),
    }))
  }

  async page(options: PageOptions = {}): Promise<{ rows: EvmReceiveSwapRow[]; nextCursor: string | null }> {
    const { sql, params, limit } = pageQuery('receive_evm_swap', options)
    const raw = await this.driver.all<Raw & PageRawFields>(sql, params)
    const { page, nextCursor } = takePage(raw, limit)
    return { rows: page.map(toRow), nextCursor }
  }

  async transition(
    id: string,
    from: EvmReceiveSwapState,
    to: EvmReceiveSwapState,
    fields: Record<string, unknown> = {},
  ): Promise<void> {
    const columns = Object.keys(fields)
    assertColumns(columns, TRANSITION_COLUMNS, 'transition()')
    const at = this.now()
    const assignments = columns.map((column) => column + ' = ?').join(', ')
    const result = await this.driver.run(
      'UPDATE receive_evm_swap SET state = ?, updated_at = ?' +
        (assignments ? ', ' + assignments : '') +
        ' WHERE id = ? AND state = ?',
      [to, at, ...columns.map((column) => fields[column] as string | number | null), id, from],
    )
    if ((result?.changes ?? 0) === 0) {
      throw new Error('evm receive swap ' + id + ' is not in state ' + from)
    }
    await this.driver.run(
      'INSERT INTO receive_evm_swap_event (swap_id, at, from_state, to_state) VALUES (?, ?, ?, ?)',
      [id, at, from, to],
    )
  }

  /** Set fields without moving the row - see the send store on why this is separate. */
  async patch(id: string, fields: Record<string, unknown>): Promise<void> {
    const columns = Object.keys(fields)
    if (columns.length === 0) return
    assertColumns(columns, TRANSITION_COLUMNS, 'patch()')
    const assignments = columns.map((column) => column + ' = ?').join(', ')
    await this.driver.run('UPDATE receive_evm_swap SET updated_at = ?, ' + assignments + ' WHERE id = ?', [
      this.now(),
      ...columns.map((column) => fields[column] as string | number | null),
      id,
    ])
  }

  async fail(id: string, from: EvmReceiveSwapState, reason: string): Promise<void> {
    await this.transition(id, from, 'stuck', { failure_reason: reason })
  }
}
