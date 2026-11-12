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
import { EvmSwapStore, commonFields, text, type EvmSwapRepository, type Raw } from './evmSwapStore.js'
import { evmReceiveSwapSql } from './evmReceiveSwaps.sql.js'

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

export interface EvmReceiveSwapRepository extends EvmSwapRepository<EvmReceiveSwapRow, EvmReceiveSwapState> {
  insertQuote(quote: EvmReceiveQuoteRecord): Promise<EvmReceiveSwapRow>
}

export class EvmReceiveSwapStore
  extends EvmSwapStore<EvmReceiveSwapRow, EvmReceiveSwapState>
  implements EvmReceiveSwapRepository
{
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
    await store.driver.exec(evmReceiveSwapSql.createSchema)
    return store
  }

  async insertQuote(quote: EvmReceiveQuoteRecord): Promise<EvmReceiveSwapRow> {
    return this.insert(quote, { payout_pubkey: quote.payoutPubkey })
  }
}
