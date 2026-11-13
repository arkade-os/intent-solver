/** Durable state for the `arkade:BTC->ethereum:<token>` send leg. */

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
  amountSats: number
  /** `amountSats` minus this corridor's fee, fixed AT QUOTE TIME. */
  payoutSats: number
  /** TEXT in base units: ERC20 amounts are 256-bit and a JS number would round a payout. */
  evmAmount: string
  /** Lowercase 0x. */
  tokenAddress: string
  /** Lowercase 0x; the deployment's contract may change between quote and claim. */
  evmContractAddress: string
  evmChainId: number
  /** Block height at which the solver may refund its own lock. */
  evmTimeout: number
  /** Unix seconds; funding first observed past this is refused. */
  validUntil: number
  /** Depth AND age: see `evm/config.ts` on why depth alone is not finality. */
  minConfirmations: number
  minAgeSeconds: number
  evmLockTxid: string | null
  evmRefundTxid: string | null
  evmClaimTxid: string | null
  evmClaimAddress: string
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
  /** @see CovenantScriptRow.nonInteractiveParameters */
  nonInteractiveParameters: boolean | null
  preimage: string | null
  claimArkTxid: string | null
  refundArkTxid: string | null
  /** 'pushed' (our sweep), 'external' (a provable foreign spend), or NULL (unresolved). */
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
  /** Required, unlike the row's: an omitted value persists null and the rebuild throws on claim and refund. */
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

  /** No deadline gate, unlike Lightning's: every EVM row's non-interactive refund leaf is immediate,
   * and a `refused` swap was never paid against, so pushing the refund cannot pay twice. */
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
