import { describe, expect, it } from 'vitest'
import type { Erc20SwapLock } from '@arkade-os/solver-core/ports/evm.js'
import {
  finalizedEvmReceiverPreimage,
  planEvmReceiverFunding,
  type EvmReceiverFundingInput,
  type EvmReceiverFundingObservation,
  type EvmReceiverIntentBinding,
} from '@arkade-os/solver-core/core/evmReceiverFunding.js'
import { planEvmSend, type EvmSendPlanRow, type EvmSendObservation } from '@arkade-os/solver-core/core/evmSendPlan.js'
import { paymentHashFromPreimage } from '@arkade-os/solver-core/core/preimage.js'

const bytes = (fill: number, length = 20): Uint8Array => new Uint8Array(length).fill(fill)

const lock = (): Erc20SwapLock => ({
  preimageHash: bytes(0x11, 32),
  amount: 1_000_000n,
  tokenAddress: bytes(0x22),
  claimAddress: bytes(0x33),
  refundAddress: bytes(0x44),
  timelock: 500n,
})

const binding = (): EvmReceiverIntentBinding => ({
  chainId: 31_337n,
  receiverAddress: bytes(0x55),
  receiverRuntimeCodeHash: bytes(0x66, 32),
  swapContract: bytes(0x77),
  activationCutoff: 480n,
  lock: lock(),
})

const observation = (over: Partial<EvmReceiverFundingObservation> = {}): EvmReceiverFundingObservation => {
  const expected = binding()
  return {
    binding: { ...expected, lock: { ...expected.lock } },
    bindingVerified: true,
    observedBlock: 450n,
    currentBlock: 460n,
    balanceReceiverAddress: Uint8Array.from(expected.receiverAddress),
    balanceTokenAddress: Uint8Array.from(expected.lock.tokenAddress),
    tokenBalance: 0n,
    balanceConfirmations: 0,
    balanceAgeSeconds: 0,
    balanceFinalized: false,
    activationState: 'not_started',
    htlcPresent: false,
    htlcConfirmations: 0,
    htlcAgeSeconds: 0,
    htlcFinalized: false,
    ...over,
  }
}

const input = (over: Partial<EvmReceiverFundingInput> = {}): EvmReceiverFundingInput => ({
  binding: binding(),
  receiverDeployment: {
    verified: true,
    observedBinding: { ...binding(), lock: { ...binding().lock } },
    currentBlock: 460n,
  },
  nowSeconds: 1_800_000_000,
  dispatchCutoffSeconds: 1_800_000_100,
  activationCutoffSeconds: 1_800_000_200,
  quoteValidUntil: 1_800_000_090,
  arkadeLockupFunded: true,
  attemptState: 'not_started',
  providerTelemetry: 'unknown',
  observation: null,
  minBalanceConfirmations: 5,
  minBalanceAgeSeconds: 60,
  minHtlcConfirmations: 5,
  minHtlcAgeSeconds: 60,
  ...over,
})

describe('provider dispatch is single-attempt and cutoff bound', () => {
  it('dispatches only after Arkade funding and before both quote and dispatch expiry', () => {
    expect(planEvmReceiverFunding(input())).toEqual({ do: 'dispatch_provider' })
    // A durable prepared row is still pre-submit; callers change it to
    // `submitting` immediately before making the non-idempotent provider call.
    expect(planEvmReceiverFunding(input({ attemptState: 'prepared' }))).toEqual({ do: 'dispatch_provider' })
    expect(planEvmReceiverFunding(input({ arkadeLockupFunded: false }))).toMatchObject({ do: 'wait' })
    expect(planEvmReceiverFunding(input({ nowSeconds: 1_800_000_100 }))).toMatchObject({ do: 'quarantine' })
    expect(planEvmReceiverFunding(input({ nowSeconds: 1_800_000_090 }))).toMatchObject({ do: 'quarantine' })
  })

  it('requires exact receiver code and immutable binding verification before dispatch', () => {
    expect(
      planEvmReceiverFunding(
        input({ receiverDeployment: { verified: false, observedBinding: input().binding, currentBlock: 460n } }),
      ),
    ).toMatchObject({ do: 'quarantine' })
    expect(
      planEvmReceiverFunding(
        input({
          receiverDeployment: {
            verified: true,
            observedBinding: { ...binding(), receiverAddress: bytes(0x99) },
            currentBlock: 460n,
          },
        }),
      ),
    ).toMatchObject({ do: 'quarantine' })
    expect(
      planEvmReceiverFunding(input({ receiverDeployment: { ...input().receiverDeployment, currentBlock: 480n } })),
    ).toMatchObject({ do: 'quarantine' })
  })

  it.each(['unknown', 'failed'] as const)('never retries an ambiguous %s provider submission', (attemptState) => {
    expect(planEvmReceiverFunding(input({ attemptState }))).toMatchObject({ do: 'quarantine' })
    expect(
      planEvmReceiverFunding(
        input({
          attemptState,
          providerTelemetry: 'complete',
          observation: observation({
            tokenBalance: binding().lock.amount,
            balanceConfirmations: 9,
            balanceAgeSeconds: 120,
            balanceFinalized: true,
          }),
        }),
      ),
    ).toMatchObject({ do: 'quarantine' })
  })

  it('treats provider completion as telemetry, never as token delivery', () => {
    expect(planEvmReceiverFunding(input({ attemptState: 'submitted', providerTelemetry: 'complete' }))).toEqual({
      do: 'wait',
      reason: 'provider attempt is submitted; await chain observation',
    })
  })

  it('dispatches from a fresh verified zero-balance receiver observation', () => {
    expect(
      planEvmReceiverFunding(
        input({
          attemptState: 'not_started',
          observation: observation(),
        }),
      ),
    ).toEqual({ do: 'dispatch_provider' })
  })
})

describe('receiver activation requires the exact finalized binding and amount', () => {
  it('waits for the exact token amount and its configured finality', () => {
    const funded = observation({ tokenBalance: binding().lock.amount })
    expect(planEvmReceiverFunding(input({ attemptState: 'submitted', observation: funded }))).toMatchObject({
      do: 'wait',
    })
    expect(
      planEvmReceiverFunding(
        input({
          attemptState: 'submitted',
          observation: observation({
            tokenBalance: binding().lock.amount,
            balanceFinalized: true,
            balanceConfirmations: 5,
          }),
        }),
      ),
    ).toMatchObject({ do: 'wait' })
    expect(
      planEvmReceiverFunding(
        input({
          attemptState: 'submitted',
          observation: observation({
            tokenBalance: binding().lock.amount,
            balanceFinalized: true,
            balanceConfirmations: 5,
            balanceAgeSeconds: 60,
          }),
        }),
      ),
    ).toEqual({ do: 'activate_receiver', excessAmount: 0n })
  })

  it('rejects wrong immutable receiver, token, recipient, or lock terms', () => {
    const wrongLock = { ...lock(), amount: 2_000_000n }
    const cases: EvmReceiverFundingObservation[] = [
      observation({ bindingVerified: false }),
      observation({ binding: { ...binding(), receiverAddress: bytes(0x88) } }),
      observation({ balanceTokenAddress: bytes(0x99) }),
      observation({ balanceReceiverAddress: bytes(0x99) }),
      observation({ binding: { ...binding(), lock: wrongLock } }),
    ]
    for (const seen of cases) {
      expect(
        planEvmReceiverFunding(
          input({
            attemptState: 'submitted',
            observation: observation({
              ...seen,
              tokenBalance: binding().lock.amount,
              balanceFinalized: true,
              balanceConfirmations: 8,
              balanceAgeSeconds: 120,
            }),
          }),
        ),
      ).toMatchObject({ do: 'quarantine' })
    }
  })

  it('waits for a partial balance and exposes excess for separate recovery accounting', () => {
    expect(
      planEvmReceiverFunding(
        input({
          attemptState: 'submitted',
          observation: observation({
            tokenBalance: binding().lock.amount - 1n,
            balanceFinalized: true,
            balanceConfirmations: 9,
            balanceAgeSeconds: 120,
          }),
        }),
      ),
    ).toMatchObject({ do: 'wait' })

    expect(
      planEvmReceiverFunding(
        input({
          attemptState: 'submitted',
          observation: observation({
            tokenBalance: binding().lock.amount + 123n,
            balanceFinalized: true,
            balanceConfirmations: 9,
            balanceAgeSeconds: 120,
          }),
        }),
      ),
    ).toEqual({ do: 'activate_receiver', excessAmount: 123n })
  })

  it('waits for an activation in flight and quarantines unknown or failed activation', () => {
    const exactFinalBalance = observation({
      tokenBalance: binding().lock.amount,
      balanceFinalized: true,
      balanceConfirmations: 9,
      balanceAgeSeconds: 120,
    })
    for (const activationState of ['submitting', 'submitted'] as const) {
      expect(
        planEvmReceiverFunding(
          input({ attemptState: 'submitted', observation: observation({ ...exactFinalBalance, activationState }) }),
        ),
      ).toMatchObject({ do: 'wait' })
    }
    for (const activationState of ['unknown', 'failed'] as const) {
      expect(
        planEvmReceiverFunding(
          input({ attemptState: 'submitted', observation: observation({ ...exactFinalBalance, activationState }) }),
        ),
      ).toMatchObject({ do: 'quarantine' })
    }
  })
})

describe('finalized lock and Claim event are independent of provider status', () => {
  it('hands off only the exact, sufficiently finalized HTLC', () => {
    const observed = observation({ htlcPresent: true, htlcConfirmations: 5, htlcAgeSeconds: 60, htlcFinalized: true })
    expect(
      planEvmReceiverFunding(input({ attemptState: 'submitted', providerTelemetry: 'failed', observation: observed })),
    ).toEqual({ do: 'ready_for_existing_send_planner' })
    expect(
      planEvmReceiverFunding(
        input({
          attemptState: 'submitted',
          observation: observation({ ...observed, htlcFinalized: false }),
        }),
      ),
    ).toMatchObject({ do: 'wait' })
  })

  it('does not let dust prevent the first dispatch or bypass uncertain activation', () => {
    const seen = observation({ tokenBalance: 1n })
    expect(planEvmReceiverFunding(input({ observation: seen }))).toEqual({ do: 'dispatch_provider' })
    expect(planEvmReceiverFunding(input({ observation: { ...seen, activationState: 'unknown' } }))).toMatchObject({
      do: 'quarantine',
    })
    expect(planEvmReceiverFunding(input({ observation: { ...seen, activationState: 'submitted' } }))).toMatchObject({
      do: 'wait',
    })
  })

  it('does not let residual dust or a passed dispatch cutoff hide an already-final HTLC', () => {
    const decision = planEvmReceiverFunding(
      input({
        attemptState: 'submitted',
        nowSeconds: 1_800_000_100,
        observation: observation({
          tokenBalance: 1n,
          htlcPresent: true,
          htlcConfirmations: 9,
          htlcAgeSeconds: 120,
          htlcFinalized: true,
        }),
      }),
    )
    expect(decision).toEqual({ do: 'ready_for_existing_send_planner' })
  })

  it('requires an exact finalized Claim event and a preimage opening the quoted payment hash', () => {
    const preimage = 'ab'.repeat(32)
    const paymentHash = paymentHashFromPreimage(Uint8Array.from(Buffer.from(preimage, 'hex')))
    const evidence = {
      preimage,
      exactLockEvent: true,
      successfulReceipt: true,
      confirmations: 5,
      ageSeconds: 60,
      finalized: true,
    }
    expect(finalizedEvmReceiverPreimage(paymentHash, evidence, 5, 60)).toBe(preimage)
    expect(finalizedEvmReceiverPreimage(paymentHash, { ...evidence, preimage: 'cd'.repeat(32) }, 5, 60)).toBeNull()
    expect(finalizedEvmReceiverPreimage(paymentHash, { ...evidence, exactLockEvent: false }, 5, 60)).toBeNull()
    expect(finalizedEvmReceiverPreimage(paymentHash, { ...evidence, successfulReceipt: false }, 5, 60)).toBeNull()
    expect(finalizedEvmReceiverPreimage(paymentHash, { ...evidence, finalized: false }, 5, 60)).toBeNull()
    expect(finalizedEvmReceiverPreimage(paymentHash, null, 5, 60)).toBeNull()
  })

  it('only the hash-verified Claim event gives the existing send planner a claimable preimage', () => {
    const preimage = 'ab'.repeat(32)
    const paymentHash = paymentHashFromPreimage(Uint8Array.from(Buffer.from(preimage, 'hex')))
    const row: EvmSendPlanRow = {
      state: 'awaiting_claim',
      refundLocktime: 1_800_100_000,
      evmTimeout: 500,
      validUntil: 1_800_000_090,
      minConfirmations: 5,
      minAgeSeconds: 60,
      preimage: null,
      evmRefundTxid: null,
    }
    const observation: EvmSendObservation = {
      arkadeLockupFunded: true,
      evmLockPresent: true,
      evmLockReverted: false,
      evmRefundOutcome: 'pending',
      evmRefundLanded: false,
      evmLockConfirmations: 5,
      evmLockAgeSeconds: 60,
      preimage: null,
      nowSeconds: 1_800_000_001,
      evmBlockHeight: 450,
    }
    expect(planEvmSend(row, observation)).toEqual({ do: 'wait' })
    const verified = finalizedEvmReceiverPreimage(
      paymentHash,
      { preimage, exactLockEvent: true, successfulReceipt: true, confirmations: 5, ageSeconds: 60, finalized: true },
      5,
      60,
    )
    expect(planEvmSend(row, { ...observation, preimage: verified })).toEqual({ do: 'claim_arkade', preimage })
  })
})

describe('late receiver funds require recovery and never late activation', () => {
  it('stops new submissions at dispatch cutoff but permits in-flight funds before receiver cutoff', () => {
    expect(
      planEvmReceiverFunding(
        input({
          nowSeconds: 1_800_000_100,
          observation: null,
        }),
      ),
    ).toMatchObject({ do: 'quarantine' })
    expect(
      planEvmReceiverFunding(
        input({
          attemptState: 'submitted',
          nowSeconds: 1_800_000_100,
          observation: observation({
            tokenBalance: binding().lock.amount,
            balanceFinalized: true,
            balanceConfirmations: 9,
            balanceAgeSeconds: 120,
          }),
        }),
      ),
    ).toEqual({ do: 'activate_receiver', excessAmount: 0n })
  })

  it('routes funds arriving after the receiver block cutoff to recovery', () => {
    expect(
      planEvmReceiverFunding(
        input({
          attemptState: 'submitted',
          observation: observation({ tokenBalance: 100n, currentBlock: 480n }),
        }),
      ),
    ).toMatchObject({ do: 'recover_late_delivery', amount: 100n })
  })
})
