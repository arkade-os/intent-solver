/**
 * The ordering rules that can lose funds, one describe block each.
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
  evmLockReverted: false,
  evmRefundOutcome: 'pending',
  evmRefundLanded: false,
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

  it('treats an absent lock as not-yet while nothing says otherwise, until the timeout', () => {
    expect(planEvmSend(row({ state: 'locking_evm' }), seen())).toEqual({ do: 'wait' })
    expect(planEvmSend(row({ state: 'locking_evm' }), seen({ evmBlockHeight: EVM_TIMEOUT }))).toEqual({
      do: 'refund_evm',
    })
  })

  it('does not withhold the timeout from a lock that is present but never proven deep', () => {
    const action = planEvmSend(
      row({ state: 'locking_evm' }),
      seen({ evmLockPresent: true, evmLockConfirmations: 0, evmLockAgeSeconds: 0, evmBlockHeight: EVM_TIMEOUT }),
    )
    expect(action).toEqual({ do: 'refund_evm' })
  })
})

describe('rule 6 - a mined revert created no lock', () => {
  const reverted = { do: 'stick', reason: 'the ERC20 lock transaction reverted; no lock was created' }

  it('sticks at once rather than waiting out the timeout', () => {
    expect(planEvmSend(row({ state: 'locking_evm' }), seen({ evmLockReverted: true }))).toEqual(reverted)
  })

  it('does not refund a lock the contract never held', () => {
    const action = planEvmSend(
      row({ state: 'locking_evm' }),
      seen({ evmLockReverted: true, evmBlockHeight: EVM_TIMEOUT }),
    )
    expect(action).toEqual(reverted)
  })

  it('is not consulted while the lock is present', () => {
    const action = planEvmSend(
      row({ state: 'locking_evm' }),
      seen({ evmLockPresent: true, evmLockReverted: true, evmLockConfirmations: 5, evmLockAgeSeconds: 720 }),
    )
    expect(action).toEqual({ do: 'await_claim' })
  })

  it('still yields to a revealed preimage', () => {
    // A preimage cannot exist without a lock, so rule 4 outranks the revert.
    const action = planEvmSend(
      row({ state: 'locking_evm' }),
      seen({ evmLockReverted: true, preimage: 'cd'.repeat(32) }),
    )
    expect(action).toEqual({ do: 'claim_arkade', preimage: 'cd'.repeat(32) })
  })
})

describe('rule 7 - `refunded` means the ERC20 came back', () => {
  const refunding = row({ state: 'refunding_evm' })

  it('waits while the receipt has not arrived', () => {
    expect(planEvmSend(refunding, seen({ evmRefundOutcome: 'pending' }))).toEqual({ do: 'wait' })
  })

  it('records only once the refund is mined', () => {
    expect(planEvmSend(refunding, seen({ evmRefundOutcome: 'success' }))).toEqual({ do: 'record_refund' })
  })

  it('never records a reverted refund as `refunded`', () => {
    // THE FINDING: a reverted refund returned nothing to be terminal about.
    for (const evmLockPresent of [true, false]) {
      const action = planEvmSend(refunding, seen({ evmRefundOutcome: 'reverted', evmLockPresent }))
      expect(action).not.toEqual({ do: 'record_refund' })
    }
  })

  it('sticks when the revert left the lock still funded', () => {
    const action = planEvmSend(refunding, seen({ evmRefundOutcome: 'reverted', evmLockPresent: true }))
    expect(action).toEqual({
      do: 'stick',
      reason: 'the ERC20 refund transaction reverted; the lock is still funded',
    })
  })

  it('does not page when the revert was the client claiming first', () => {
    const action = planEvmSend(refunding, seen({ evmRefundOutcome: 'reverted', evmLockPresent: false }))
    expect(action).toEqual({ do: 'wait' })
  })

  it('yields to the preimage that revert revealed', () => {
    const action = planEvmSend(refunding, seen({ evmRefundOutcome: 'reverted', preimage: 'cd'.repeat(32) }))
    expect(action).toEqual({ do: 'claim_arkade', preimage: 'cd'.repeat(32) })
  })
})

describe('rule 8 - a refund PROVEN landed is `refunded`, whichever txid the row holds', () => {
  const refunding = row({ state: 'refunding_evm' })

  it('records the refund when the row holds the losing txid', () => {
    // THE FINDING (#36). The recorded refund lost, so its outcome is
    // `reverted` or `pending` for ever - and all three exits key on it.
    for (const evmRefundOutcome of ['reverted', 'pending'] as const) {
      expect(planEvmSend(refunding, seen({ evmRefundOutcome, evmRefundLanded: true }))).toEqual({
        do: 'record_refund',
      })
    }
  })

  it('waits while nothing is proven, so a scan that never succeeds spends nothing', () => {
    for (const evmRefundOutcome of ['reverted', 'pending'] as const) {
      expect(planEvmSend(refunding, seen({ evmRefundOutcome }))).toEqual({ do: 'wait' })
    }
  })

  it('does not outrank the preimage', () => {
    const action = planEvmSend(refunding, seen({ evmRefundLanded: true, preimage: 'cd'.repeat(32) }))
    expect(action).toEqual({ do: 'claim_arkade', preimage: 'cd'.repeat(32) })
  })

  it('does not outrank the stick over a lock that is still funded', () => {
    const action = planEvmSend(
      refunding,
      seen({ evmRefundOutcome: 'reverted', evmLockPresent: true, evmRefundLanded: true }),
    )
    expect(action).toEqual({
      do: 'stick',
      reason: 'the ERC20 refund transaction reverted; the lock is still funded',
    })
  })

  it('decides nothing for any state but refunding_evm', () => {
    for (const state of ['locking_evm', 'awaiting_claim'] as EvmSendSwapState[]) {
      expect(planEvmSend(row({ state }), seen({ evmRefundLanded: true }))).toEqual({ do: 'wait' })
    }
  })
})

describe('terminal rows', () => {
  it('decides nothing for a row that is already done', () => {
    for (const state of ['claimed', 'refunded', 'refused', 'stuck'] as EvmSendSwapState[]) {
      expect(planEvmSend(row({ state, preimage: 'ab'.repeat(32) }), seen())).toEqual({ do: 'wait' })
    }
  })
})
