import type { Erc20SwapLock } from '@arkade-os/solver-core/ports/evm.js'
import type { EvmSendSwapRow, EvmSendQuoteRecord } from '../db/evmSendSwaps.js'

import type { EvmPayoutFundingBinding, EvmPayoutFundingResult } from '@arkade-os/solver-core/ports/evmPayoutFunding.js'
export type {
  EvmPayoutFundingAdapter,
  EvmPayoutFundingBinding,
  EvmPayoutFundingContext,
  EvmPayoutFundingMode,
  EvmPayoutFundingQuoteContext,
  EvmPayoutFundingResult,
} from '@arkade-os/solver-core/ports/evmPayoutFunding.js'

const bytesHex = (bytes: Uint8Array, length: number): string => {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new Error('invalid payout funding bytes')
  return Buffer.from(bytes).toString('hex')
}

const normalizedHex = (value: string, length: number): string => {
  const normalized = value.replace(/^0x/, '').toLowerCase()
  if (!new RegExp(`^[0-9a-f]{${length * 2}}$`).test(normalized)) throw new Error('invalid payout funding hex')
  return normalized
}

const validInteger = (value: number, positive = false): boolean =>
  Number.isSafeInteger(value) && value >= (positive ? 1 : 0)

export const payoutFundingBinding = (
  adapterId: string,
  row: EvmSendSwapRow | EvmSendQuoteRecord,
  lock: Erc20SwapLock,
): EvmPayoutFundingBinding => {
  if (!adapterId.trim() || !row.id || !/^[1-9][0-9]*$/.test(row.evmAmount)) {
    throw new Error('invalid payout funding identity or amount')
  }
  if (
    !validInteger(row.amountSats, true) ||
    !validInteger(row.payoutSats, true) ||
    !validInteger(row.validUntil, true) ||
    !validInteger(row.evmChainId, true) ||
    !validInteger(row.evmTimeout, true) ||
    !validInteger(row.refundLocktime, true) ||
    !validInteger(row.minConfirmations) ||
    !validInteger(row.minAgeSeconds)
  ) {
    throw new Error('invalid payout funding deadline or chain')
  }
  if (BigInt(row.evmAmount) >= 1n << 256n) throw new Error('payout funding amount exceeds uint256')
  const paymentHash = normalizedHex(row.paymentHash, 32)
  const token = normalizedHex(row.tokenAddress, 20)
  const claim = normalizedHex(row.evmClaimAddress, 20)
  const refund = normalizedHex(row.evmRefundAddress, 20)
  if (
    bytesHex(lock.preimageHash, 32) !== paymentHash ||
    bytesHex(lock.tokenAddress, 20) !== token ||
    bytesHex(lock.claimAddress, 20) !== claim ||
    bytesHex(lock.refundAddress, 20) !== refund ||
    lock.amount !== BigInt(row.evmAmount) ||
    lock.timelock !== BigInt(row.evmTimeout)
  ) {
    throw new Error('payout funding lock does not match persisted quote')
  }
  return Object.freeze({
    adapterId,
    intentId: row.id,
    chainId: row.evmChainId,
    contractAddress: `0x${normalizedHex(row.evmContractAddress, 20)}`,
    paymentHash,
    tokenAddress: `0x${token}`,
    amount: row.evmAmount,
    arkadeAmountSats: row.amountSats.toString(),
    payoutSats: row.payoutSats.toString(),
    quoteValidUntil: row.validUntil,
    claimAddress: `0x${claim}`,
    refundAddress: `0x${refund}`,
    evmTimeout: row.evmTimeout.toString(),
    arkadeRefundLocktime: row.refundLocktime,
    minConfirmations: row.minConfirmations,
    minAgeSeconds: row.minAgeSeconds,
  })
}

export const checkedActivationTxid = (result: EvmPayoutFundingResult): string | undefined => {
  if (result.activationTxid !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(result.activationTxid)) {
    throw new Error('invalid payout funding activation transaction hash')
  }
  return result.activationTxid?.toLowerCase()
}
