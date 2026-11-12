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
import { EvmSwapStore, commonFields, text, type EvmSwapRepository, type Raw } from './evmSwapStore.js'
import { evmSendSwapSql } from './evmSendSwaps.sql.js'

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

export interface EvmSendSwapRepository extends EvmSwapRepository<EvmSendSwapRow, EvmSendSwapState> {
  insertQuote(quote: EvmSendQuoteRecord): Promise<EvmSendSwapRow>
  findRefundable(): Promise<EvmSendSwapRow[]>
  findClosedOverLock(nowSeconds: number): Promise<EvmSendSwapRow[]>
  claimRefundTxid(id: string, txid: string): Promise<boolean>
}

export class EvmSendSwapStore extends EvmSwapStore<EvmSendSwapRow, EvmSendSwapState> implements EvmSendSwapRepository {
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
    await store.driver.exec(evmSendSwapSql.createSchema)
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
    const rows = (await this.driver.all(evmSendSwapSql.selectRefundable)) as Raw[]
    return rows.map(toRow)
  }

  /** Closed rows that reached a lock call, while their refund window is open.
   * `refunded` counts: the word rests on the refund receipt's status alone. */
  async findClosedOverLock(nowSeconds: number): Promise<EvmSendSwapRow[]> {
    const rows = (await this.driver.all(evmSendSwapSql.selectClosedOverLock, [nowSeconds])) as Raw[]
    return rows.map(toRow)
  }

  /** First writer wins, true when that was us: the resend has no state CAS to ride. */
  async claimRefundTxid(id: string, txid: string): Promise<boolean> {
    const result = await this.driver.run(evmSendSwapSql.claimRefundTxid, [this.now(), txid, id])
    return (result?.changes ?? 0) > 0
  }
}
