import type { Erc20SwapLock } from '../ports/evm.js'
import { preimageMatchesHash } from './preimage.js'

export interface EvmReceiverIntentBinding {
  chainId: bigint
  receiverAddress: Uint8Array
  receiverRuntimeCodeHash: Uint8Array
  swapContract: Uint8Array
  activationCutoff: bigint
  lock: Erc20SwapLock
}

export interface EvmReceiverObservedBinding {
  chainId: bigint
  receiverAddress: Uint8Array
  receiverRuntimeCodeHash: Uint8Array
  swapContract: Uint8Array
  activationCutoff: bigint
  lock: Erc20SwapLock
}

export type EvmProviderAttemptState =
  'not_started' | 'prepared' | 'submitting' | 'submitted' | 'unknown' | 'failed' | 'complete'

export type EvmProviderTelemetry = 'unknown' | 'pending' | 'complete' | 'failed'

export type EvmReceiverActivationState = 'not_started' | 'submitting' | 'submitted' | 'unknown' | 'failed'

export interface EvmReceiverFundingObservation {
  binding: EvmReceiverObservedBinding
  bindingVerified: boolean
  observedBlock: bigint
  currentBlock: bigint
  balanceReceiverAddress: Uint8Array
  balanceTokenAddress: Uint8Array
  tokenBalance: bigint
  balanceConfirmations: number
  balanceAgeSeconds: number
  balanceFinalized: boolean
  activationState: EvmReceiverActivationState
  htlcPresent: boolean
  htlcConfirmations: number
  htlcAgeSeconds: number
  htlcFinalized: boolean
}

export interface EvmReceiverFundingInput {
  binding: EvmReceiverIntentBinding
  receiverDeployment: {
    verified: boolean
    observedBinding: EvmReceiverObservedBinding | null
    currentBlock: bigint
  }
  nowSeconds: number
  dispatchCutoffSeconds: number
  activationCutoffSeconds: number
  quoteValidUntil: number
  arkadeLockupFunded: boolean
  attemptState: EvmProviderAttemptState
  providerTelemetry: EvmProviderTelemetry
  observation: EvmReceiverFundingObservation | null
  minBalanceConfirmations: number
  minBalanceAgeSeconds: number
  minHtlcConfirmations: number
  minHtlcAgeSeconds: number
}

export type EvmReceiverFundingDecision =
  | { do: 'wait'; reason: string }
  | { do: 'dispatch_provider' }
  | { do: 'activate_receiver'; excessAmount: bigint }
  | { do: 'recover_late_delivery'; amount: bigint; reason: string }
  | { do: 'quarantine'; reason: string }
  | { do: 'ready_for_existing_send_planner' }

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index])

const lockEqual = (a: Erc20SwapLock, b: Erc20SwapLock): boolean =>
  a.amount === b.amount &&
  a.timelock === b.timelock &&
  bytesEqual(a.preimageHash, b.preimageHash) &&
  bytesEqual(a.tokenAddress, b.tokenAddress) &&
  bytesEqual(a.claimAddress, b.claimAddress) &&
  bytesEqual(a.refundAddress, b.refundAddress)

const bindingEqual = (a: EvmReceiverIntentBinding, b: EvmReceiverObservedBinding): boolean =>
  a.chainId === b.chainId &&
  a.activationCutoff === b.activationCutoff &&
  bytesEqual(a.receiverAddress, b.receiverAddress) &&
  bytesEqual(a.receiverRuntimeCodeHash, b.receiverRuntimeCodeHash) &&
  bytesEqual(a.swapContract, b.swapContract) &&
  lockEqual(a.lock, b.lock)

export const planEvmReceiverFunding = (input: EvmReceiverFundingInput): EvmReceiverFundingDecision => {
  const { binding, observation } = input
  if (
    !input.receiverDeployment.verified ||
    input.receiverDeployment.observedBinding === null ||
    !bindingEqual(binding, input.receiverDeployment.observedBinding)
  ) {
    return {
      do: 'quarantine',
      reason: 'receiver deployment code and immutable binding must verify before provider dispatch',
    }
  }
  if (input.attemptState === 'submitting' || input.attemptState === 'submitted' || input.attemptState === 'complete') {
    // A provider's terminal success is not evidence that the receiver got paid.
    if (observation === null) {
      return { do: 'wait', reason: `provider attempt is ${input.attemptState}; await chain observation` }
    }
  }

  if (!input.arkadeLockupFunded) return { do: 'wait', reason: 'Arkade lockup is not funded' }

  if (observation === null) {
    if (input.attemptState !== 'not_started' && input.attemptState !== 'prepared') {
      return { do: 'quarantine', reason: 'provider submission outcome lacks a receiver chain observation' }
    }
    if (input.nowSeconds >= input.quoteValidUntil) {
      return { do: 'quarantine', reason: 'quote expired before provider dispatch' }
    }
    if (input.nowSeconds >= input.dispatchCutoffSeconds) {
      return { do: 'quarantine', reason: 'provider dispatch cutoff passed' }
    }
    if (input.receiverDeployment.currentBlock >= binding.activationCutoff) {
      return { do: 'quarantine', reason: 'receiver activation block cutoff passed' }
    }
    return { do: 'dispatch_provider' }
  }

  if (!observation.bindingVerified || !bindingEqual(binding, observation.binding)) {
    return { do: 'quarantine', reason: 'receiver code or immutable HTLC binding does not match the quote snapshot' }
  }
  if (
    observation.observedBlock > observation.currentBlock ||
    !bytesEqual(observation.balanceReceiverAddress, binding.receiverAddress) ||
    !bytesEqual(observation.balanceTokenAddress, binding.lock.tokenAddress)
  ) {
    return { do: 'quarantine', reason: 'receiver balance observation is for the wrong chain view, receiver, or token' }
  }

  // Check the actual lock before considering unactivated receiver funds. A
  // tiny dust balance can remain after successful activation, so it must not
  // hide an already-funded, finalized HTLC or route its proceeds to recovery.
  if (observation.htlcPresent) {
    if (!lockEqual(binding.lock, observation.binding.lock)) {
      return { do: 'quarantine', reason: 'observed HTLC does not match the immutable quoted lock' }
    }
    if (
      observation.htlcFinalized &&
      observation.htlcConfirmations >= input.minHtlcConfirmations &&
      observation.htlcAgeSeconds >= input.minHtlcAgeSeconds
    ) {
      return { do: 'ready_for_existing_send_planner' }
    }
    return { do: 'wait', reason: 'exact HTLC exists but has not met configured finality' }
  }

  // Receiver-held funds remain recoverable after its on-chain cutoff.
  if (observation.tokenBalance > 0n && observation.currentBlock >= binding.activationCutoff) {
    return {
      do: 'recover_late_delivery',
      amount: observation.tokenBalance,
      reason: 'receiver activation cutoff passed; recover the late delivery',
    }
  }

  if (input.attemptState === 'unknown' || input.attemptState === 'failed') {
    return {
      do: 'quarantine',
      reason: `provider submission is ${input.attemptState}; reconcile manually, do not retry or activate`,
    }
  }

  if (observation.activationState === 'unknown' || observation.activationState === 'failed') {
    return {
      do: 'quarantine',
      reason: `receiver activation is ${observation.activationState}; reconcile exact lock before recovery`,
    }
  }
  if (observation.activationState === 'submitting' || observation.activationState === 'submitted') {
    return { do: 'wait', reason: 'receiver activation may have been submitted; do not submit it again' }
  }

  if (
    observation.tokenBalance < binding.lock.amount &&
    (input.attemptState === 'not_started' || input.attemptState === 'prepared')
  ) {
    if (input.nowSeconds >= input.quoteValidUntil || input.nowSeconds >= input.dispatchCutoffSeconds) {
      return { do: 'quarantine', reason: 'provider dispatch cutoff passed' }
    }
    if (observation.currentBlock >= binding.activationCutoff) {
      return { do: 'quarantine', reason: 'receiver activation block cutoff passed' }
    }
    return { do: 'dispatch_provider' }
  }

  if (observation.currentBlock >= binding.activationCutoff) {
    return observation.tokenBalance > 0n
      ? {
          do: 'recover_late_delivery',
          amount: observation.tokenBalance,
          reason: 'receiver activation cutoff passed; recover the late delivery',
        }
      : { do: 'quarantine', reason: 'receiver activation cutoff passed with no finalized HTLC' }
  }
  if (input.nowSeconds >= input.activationCutoffSeconds) {
    return { do: 'wait', reason: 'activation safety cutoff passed; wait for on-chain recovery window' }
  }
  if (observation.tokenBalance < binding.lock.amount) {
    return { do: 'wait', reason: 'receiver has not received the full quoted token amount' }
  }
  if (
    !observation.balanceFinalized ||
    observation.balanceConfirmations < input.minBalanceConfirmations ||
    observation.balanceAgeSeconds < input.minBalanceAgeSeconds
  ) {
    return { do: 'wait', reason: 'receiver token balance has not met configured finality' }
  }
  // The receiver activates the exact quoted lock amount and has a separate
  // recovery path for any amount above it. Expose the excess for accounting.
  return { do: 'activate_receiver', excessAmount: observation.tokenBalance - binding.lock.amount }
}

export interface EvmReceiverClaimEvidence {
  preimage: string
  exactLockEvent: boolean
  successfulReceipt: boolean
  confirmations: number
  ageSeconds: number
  finalized: boolean
}

export const finalizedEvmReceiverPreimage = (
  paymentHash: string,
  evidence: EvmReceiverClaimEvidence | null,
  minConfirmations: number,
  minAgeSeconds: number,
): string | null => {
  if (evidence === null) return null
  if (!evidence.exactLockEvent || !evidence.successfulReceipt || !evidence.finalized) return null
  if (evidence.confirmations < minConfirmations || evidence.ageSeconds < minAgeSeconds) return null
  return preimageMatchesHash(evidence.preimage, paymentHash) ? evidence.preimage.toLowerCase() : null
}
