/**
 * The four ordering rules that can lose funds, one describe block each.
 *
 * Pure inputs, no fixtures: that is the whole reason the decision was split out
 * of the service. Every case below is a scenario that costs real money if the
 * branch order changes.
 */

import { describe, it, expect } from 'vitest'
import { planEvmSend, type EvmSendObservation } from '@arkade-os/solver-core/core/evmSendPlan.js'
import type { EvmSendSwapRow } from '@arkade-os/solver-corridors-evm/db/evmSendSwaps.js'
import type { EvmSendSwapState } from '@arkade-os/solver-core/core/evmSwapState.js'

const NOW = 1_800_000_000
const REFUND_LOCKTIME = NOW + 86_400
const EVM_TIMEOUT = 21_000_000

const row = (over: Partial<EvmSendSwapRow> = {}): EvmSendSwapRow =>
  ({
    id: 'swap-1',
    state: 'quoted' as EvmSendSwapState,
    refundLocktime: REFUND_LOCKTIME,
    evmTimeout: EVM_TIMEOUT,
    validUntil: NOW + 60,
    minConfirmations: 5,
    minAgeSeconds: 720,
    preimage: null,
    ...over,
  }) as EvmSendSwapRow

const seen = (over: Partial<EvmSendObservation> = {}): EvmSendObservation => ({
  arkadeLockupFunded: false,
  evmLockPresent: false,
  evmLockConfirmations: 0,
  evmLockAgeSeconds: 0,
  preimage: null,
  nowSeconds: NOW,
  evmBlockHeight: EVM_TIMEOUT - 1,
  ...over,
})

describe('rule 1 - never lock the ERC20 before the Arkade lockup is funded', () => {
  it('waits on an unfunded lockup rather than committing tokens', () => {
    // The solver's tokens would be locked against nothing.
    expect(planEvmSend(row(), seen())).toEqual({ do: 'wait' })
  })

  it('locks once the lockup is funded', () => {
    expect(planEvmSend(row(), seen({ arkadeLockupFunded: true }))).toEqual({ do: 'lock_evm' })
  })

  it('refuses rather than failing when the client never turned up', () => {
    // The backstop behind rule 5: a row whose quote outlives the refund locktime
    // still terminates at the locktime. Unreachable for live rows (the quote
    // window is minutes, the locktime hours) but kept as the floor.
    const action = planEvmSend(row({ validUntil: REFUND_LOCKTIME + 60 }), seen({ nowSeconds: REFUND_LOCKTIME }))
    expect(action).toEqual({ do: 'refuse', reason: 'client never funded the Arkade lockup' })
  })
})

describe('rule 5 - a quote binds only until valid_until', () => {
  it('refuses an unfunded quote at its own deadline, not the refund locktime', () => {
    // Until it dies the row counts against the house cap - dying must happen
    // at the quote's deadline, hours before the locktime matures.
    const action = planEvmSend(row(), seen({ nowSeconds: NOW + 60 }))
    expect(action).toEqual({ do: 'refuse', reason: 'quote expired before the client funded' })
  })

  it('refuses a lockup that funds after the quote died, never fills at a stale rate', () => {
    const action = planEvmSend(row(), seen({ arkadeLockupFunded: true, nowSeconds: NOW + 60 }))
    expect(action).toEqual({ do: 'refuse', reason: 'lockup funded after the quote expired' })
  })

  it('still locks for a lockup that funds inside the window', () => {
    const action = planEvmSend(row(), seen({ arkadeLockupFunded: true, nowSeconds: NOW + 59 }))
    expect(action).toEqual({ do: 'lock_evm' })
  })
})

describe('rule 2 - never claim the Arkade lockup past the refund locktime', () => {
  it('claims while the window is open', () => {
    const action = planEvmSend(row({ state: 'awaiting_claim' }), seen({ preimage: 'ab'.repeat(32) }))
    expect(action).toEqual({ do: 'claim_arkade', preimage: 'ab'.repeat(32) })
  })

  it('sticks rather than racing the client refund once the window has closed', () => {
    // Past the locktime the client's own refund path is live. A claim races it,
    // and the loser has paid for nothing - only a human can settle who won.
    const action = planEvmSend(
      row({ state: 'awaiting_claim' }),
      seen({ preimage: 'ab'.repeat(32), nowSeconds: REFUND_LOCKTIME }),
    )
    expect(action).toEqual({
      do: 'stick',
      reason: 'preimage revealed but the Arkade refund window has closed',
    })
  })
})

describe('rule 3 - refund the ERC20 only at or after evm_timeout', () => {
  it('waits below the timeout, because the contract would reject it', () => {
    const action = planEvmSend(row({ state: 'awaiting_claim' }), seen({ evmBlockHeight: EVM_TIMEOUT - 1 }))
    expect(action).toEqual({ do: 'wait' })
  })

  it('refunds at the timeout exactly, not one block later', () => {
    const action = planEvmSend(row({ state: 'awaiting_claim' }), seen({ evmBlockHeight: EVM_TIMEOUT }))
    expect(action).toEqual({ do: 'refund_evm' })
  })
})

describe('rule 4 - a revealed preimage outranks everything', () => {
  it('claims even when the EVM lock has timed out', () => {
    // THE ORDERING TEST. If the timeout were checked first this would refund,
    // abandoning a claimable preimage and paying the client twice - once in
    // tokens they claimed, once in the sats refund they would then take.
    const action = planEvmSend(
      row({ state: 'awaiting_claim' }),
      seen({ preimage: 'cd'.repeat(32), evmBlockHeight: EVM_TIMEOUT + 100 }),
    )
    expect(action).toEqual({ do: 'claim_arkade', preimage: 'cd'.repeat(32) })
  })

  it('uses a preimage already persisted on the row', () => {
    // A crash between observing the preimage and claiming must not lose it.
    const action = planEvmSend(row({ state: 'claiming', preimage: 'ef'.repeat(32) }), seen())
    expect(action).toEqual({ do: 'claim_arkade', preimage: 'ef'.repeat(32) })
  })
})

describe('the confirmation policy is depth AND age', () => {
  it('does not advance on depth alone', () => {
    // On a rollup a lock can be many confirmations deep and still vanish,
    // because safety comes from the L1 posting finalising. @see evm/config.ts
    const action = planEvmSend(
      row({ state: 'locking_evm' }),
      seen({ evmLockPresent: true, evmLockConfirmations: 50, evmLockAgeSeconds: 0 }),
    )
    expect(action).toEqual({ do: 'wait' })
  })

  it('does not advance on age alone', () => {
    const action = planEvmSend(
      row({ state: 'locking_evm' }),
      seen({ evmLockPresent: true, evmLockConfirmations: 0, evmLockAgeSeconds: 9_999 }),
    )
    expect(action).toEqual({ do: 'wait' })
  })

  it('advances when both are met', () => {
    const action = planEvmSend(
      row({ state: 'locking_evm' }),
      seen({ evmLockPresent: true, evmLockConfirmations: 5, evmLockAgeSeconds: 720 }),
    )
    expect(action).toEqual({ do: 'await_claim' })
  })

  it('treats an absent lock as not-yet rather than reverted, until the timeout', () => {
    // A revert and a pending call are indistinguishable from here. Both mean
    // keep waiting; only the timeout turns it into a refund.
    expect(planEvmSend(row({ state: 'locking_evm' }), seen())).toEqual({ do: 'wait' })
    expect(planEvmSend(row({ state: 'locking_evm' }), seen({ evmBlockHeight: EVM_TIMEOUT }))).toEqual({
      do: 'refund_evm',
    })
  })
})

describe('terminal rows', () => {
  it('decides nothing for a row that is already done', () => {
    for (const state of ['claimed', 'refunded', 'refused', 'stuck'] as EvmSendSwapState[]) {
      expect(planEvmSend(row({ state, preimage: 'ab'.repeat(32) }), seen())).toEqual({ do: 'wait' })
    }
  })
})
