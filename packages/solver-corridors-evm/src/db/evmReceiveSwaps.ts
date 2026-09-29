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
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import { EVM_RECEIVE_NON_TERMINAL, type EvmReceiveSwapState } from '@arkade-os/solver-core/core/evmSwapState.js'
import { EvmSwapStore, commonFields, text, type Raw } from './evmSwapStore.js'

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
// why and the failure modes. For a database predating that column:
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

const toRow = (raw: Raw): EvmReceiveSwapRow => ({
  ...commonFields(raw),
  state: String(raw.state) as EvmReceiveSwapState,
  payoutPubkey: String(raw.payout_pubkey),
  fundArkTxid: text(raw.fund_ark_txid),
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

export class EvmReceiveSwapStore extends EvmSwapStore<EvmReceiveSwapRow, EvmReceiveSwapState> {
  private constructor(driver: SqlDriver, now: () => number) {
    super(driver, now, {
      table: 'receive_evm_swap',
      noun: 'receive',
      toRow,
      nonTerminal: EVM_RECEIVE_NON_TERMINAL,
      transitionColumns: new Set([
        'evm_lock_txid',
        'evm_claim_txid',
        'preimage',
        'fund_ark_txid',
        'refund_ark_txid',
        'failure_reason',
      ]),
    })
  }

  static async open(driver: SqlDriver | string, now: () => number = nowSeconds): Promise<EvmReceiveSwapStore> {
    const store = new EvmReceiveSwapStore(typeof driver === 'string' ? betterSqliteDriver(driver) : driver, now)
    await store.driver.exec(SCHEMA)
    return store
  }

  async insertQuote(quote: EvmReceiveQuoteRecord): Promise<EvmReceiveSwapRow> {
    return this.insert(quote, { payout_pubkey: quote.payoutPubkey })
  }
}
