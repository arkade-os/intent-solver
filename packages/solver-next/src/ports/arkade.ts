/** The contract our fill is locked under on Arkade, as it was quoted. Nothing in it changes afterwards. */
export interface LockupContract {
  readonly id: string
  readonly paymentHash: string
  readonly pkScript: string
  readonly lockupAddress: string
  readonly payoutSats: number
  readonly payoutAddress: string
  readonly claimPacket: string | null
  /** Seconds or a block height, in whichever unit the contract was built with. */
  readonly refundLocktime: number
  readonly claimDelay: number
  readonly refundDelay: number
  readonly refundWithoutReceiverDelay: number
  readonly receiverPubkey: string
  readonly receiverPkScript: string | null
  readonly serverPubkey: string
  readonly emulatorPubkey: string | null
  readonly clientRefundPubkey: string | null
  readonly refundPkScript: string | null
  readonly nonInteractiveParameters: boolean | null
}

export interface Outpoint {
  readonly txid: string
  readonly vout: number
}

// An adapter may carry more on these; the leg hands them back to `refund` untouched.
export interface FundedOutput extends Outpoint {
  readonly value: number
}

/** An output the script ever held. `unrolled`: a unilateral exit took it onto Bitcoin. */
export interface LockupOutpoint extends FundedOutput {
  readonly spent: boolean
  readonly unrolled: boolean
}

export interface ArkadeLockups {
  spendable(contract: LockupContract): Promise<FundedOutput[]>
  history(contract: LockupContract): Promise<LockupOutpoint[]>
  /** The preimage a claim of one of these outpoints revealed, on Arkade or on Bitcoin. Null while none is readable. */
  claimPreimage(
    contract: LockupContract,
    outpoints: readonly (Outpoint & { unrolled?: boolean })[],
  ): Promise<Uint8Array | null>
  /** Null only when it is certain nothing left our wallet; any other failure throws. */
  fund(contract: LockupContract): Promise<string | null>
  refund(contract: LockupContract, outputs: readonly FundedOutput[]): Promise<string>
  /** Our own refund that the server accepted before its answer was lost, finished now. Null when there is none. */
  finalizePendingRefund?(contract: LockupContract): Promise<string | null>
  refundOpen(contract: LockupContract): Promise<boolean>
  /** Unix seconds. An estimate when the contract counts blocks. */
  refundOpensAt(contract: LockupContract): Promise<number>
  /** After funding, with no help from the server or the client. */
  secondsToRefundAlone(contract: LockupContract): number
}

export interface LockupContracts {
  contract(swapId: string): Promise<LockupContract>
}
