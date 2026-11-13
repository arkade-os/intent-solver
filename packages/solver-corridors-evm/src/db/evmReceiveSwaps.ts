/** Durable state for the `ethereum:<token>->arkade:BTC` receive leg: the client locks the ERC20, the solver funds sats. */

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
  amountSats: number
  /** `amountSats` after this corridor's fee, fixed AT QUOTE TIME. */
  payoutSats: number
  /** What the client locks, in base units. TEXT: 256-bit. */
  evmAmount: string
  tokenAddress: string
  evmContractAddress: string
  evmChainId: number
  /** Block height after which the client may take their ERC20 back. */
  evmTimeout: number
  /** Unix seconds; a client lock first observed past this is refused. */
  validUntil: number
  minConfirmations: number
  minAgeSeconds: number
  /** Observed, not broadcast: it can reorg away after the solver has funded against it. */
  evmLockTxid: string | null
  evmClaimTxid: string | null
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
  /** @see CovenantScriptRow.nonInteractiveParameters */
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
  /** Required: @see EvmSendQuoteRecord.nonInteractiveParameters */
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
