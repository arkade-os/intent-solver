export interface EvmPayoutFundingBinding {
  readonly adapterId: string
  readonly intentId: string
  readonly chainId: number
  readonly contractAddress: string
  readonly paymentHash: string
  readonly tokenAddress: string
  readonly amount: string
  readonly arkadeAmountSats: string
  readonly payoutSats: string
  readonly quoteValidUntil: number
  readonly claimAddress: string
  readonly refundAddress: string
  readonly evmTimeout: string
  readonly arkadeRefundLocktime: number
  readonly minConfirmations: number
  readonly minAgeSeconds: number
}

export interface EvmPayoutFundingContext {
  readonly binding: EvmPayoutFundingBinding
  readonly nowSeconds: number
  readonly blockHeight: number
}

export interface EvmPayoutFundingQuoteContext extends EvmPayoutFundingContext {
  readonly tokenDecimals: number
  readonly orderMarginSeconds: number
  readonly quoteValiditySeconds: number
}

export type EvmPayoutFundingMode = 'start' | 'reconcile' | 'recover'

export interface EvmPayoutFundingResult {
  /** Evidence to correlate a transaction, never proof that the HTLC exists. */
  activationTxid?: string
}

export interface EvmPayoutFundingAdapter {
  readonly identity: string
  prepareQuote?(context: EvmPayoutFundingQuoteContext): Promise<{ validUntil: number } | void>
  abandonQuote?(binding: EvmPayoutFundingBinding): Promise<void>
  /**
   * Persist binding, receiver, cutoff, reservations and attempt before dispatch;
   * use a durable cross-process CAS. Reconcile must quarantine unknown sends,
   * including a missing ledger, rather than create another provider transfer.
   * Fixed quote deficits and top-ups are the solver's liability.
   */
  ensure(context: EvmPayoutFundingContext, mode: EvmPayoutFundingMode): Promise<EvmPayoutFundingResult>
  /** Recover provider/receiver money even after the customer row is terminal. */
  sweepRecovery(): Promise<void>
}
