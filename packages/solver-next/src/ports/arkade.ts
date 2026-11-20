/** The contract our payout is locked under on Arkade, as it was quoted. Nothing in it changes afterwards. */
export interface LockupContract {
  readonly id: string
  readonly paymentHash: string
  readonly pkScript: string
  readonly lockupAddress: string
  readonly payoutSats: number
  /** Sealed for the client. Null on quotes that carry none. */
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

export interface LockupOutput extends Outpoint {
  readonly value: number
}

/** An output the script ever held. `unrolled`: a unilateral exit took it onto Bitcoin. */
export interface LockupOutpoint extends LockupOutput {
  readonly spent: boolean
  readonly unrolled: boolean
}

/** What the lockup leg needs from Arkade. How coins are chosen and transactions built is behind it. */
export interface ArkadeLockups {
  /** Only what can still be spent at the script. */
  spendable(contract: LockupContract): Promise<LockupOutput[]>
  /** Everything the script ever held, spent or not. */
  history(contract: LockupContract): Promise<LockupOutpoint[]>
  /** The preimage a claim of one of these outpoints revealed, on Arkade or on Bitcoin. Null while none is readable. */
  claimPreimage(
    contract: LockupContract,
    outpoints: readonly (Outpoint & { unrolled?: boolean })[],
  ): Promise<Uint8Array | null>
  /** Pays the lockup. Null only when it is certain nothing left our wallet; any other failure throws. */
  fund(contract: LockupContract): Promise<string | null>
  refund(contract: LockupContract, outputs: readonly LockupOutput[]): Promise<string>
  /** Our own refund that the server accepted before its answer was lost, finished now. Null when there is none. */
  finishLostRefund?(contract: LockupContract): Promise<string | null>
  /** Whether the refund is open, asked in the locktime's own unit. */
  refundOpen(contract: LockupContract): Promise<boolean>
  /** The refund locktime in unix seconds. An estimate when the contract counts blocks. */
  refundOpensAt(contract: LockupContract): Promise<number>
  /** Seconds after funding until we can refund with no help from the server or the client. */
  refundAloneDelaySeconds(contract: LockupContract): number
}

export interface LockupContracts {
  contract(id: string): Promise<LockupContract>
}
