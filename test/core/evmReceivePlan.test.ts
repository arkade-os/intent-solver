/**
 * The receive leg's money rules. The risk runs the OTHER WAY from the send leg:
 * the solver commits SATS against a token lock it neither controls nor created.
 */

import { describe, it, expect } from 'vitest'
import {
  EVM_RECEIVE_CLAIM_MARGIN_BLOCKS,
  planEvmReceive,
  type EvmReceiveObservation,
} from '@arkade-os/solver-core/core/evmReceivePlan.js'
import type { EvmReceiveSwapRow } from '@arkade-os/solver-corridors-evm/db/evmReceiveSwaps.js'
import type { EvmReceiveSwapState } from '@arkade-os/solver-core/core/evmSwapState.js'

const NOW = 1_800_000_000
const REFUND_LOCKTIME = NOW + 86_400
const EVM_TIMEOUT = 21_000_000
const SAFE_HEIGHT = EVM_TIMEOUT - EVM_RECEIVE_CLAIM_MARGIN_BLOCKS - 1

const row = (over: Partial<EvmReceiveSwapRow> = {}): EvmReceiveSwapRow =>
  ({
    id: 'swap-1',
    state: 'awaiting_lock' as EvmReceiveSwapState,
    refundLocktime: REFUND_LOCKTIME,
    evmTimeout: EVM_TIMEOUT,
    validUntil: NOW + 60,
    minConfirmations: 5,
    minAgeSeconds: 720,
    preimage: null,
    ...over,
  }) as EvmReceiveSwapRow

const seen = (over: Partial<EvmReceiveObservation> = {}): EvmReceiveObservation => ({
  evmLockPresent: true,
  evmLockConfirmations: 5,
  evmLockAgeSeconds: 720,
  arkadeLockupFunded: false,
  preimage: null,
  nowSeconds: NOW,
  evmBlockHeight: SAFE_HEIGHT,
  ...over,
})

describe('rule 1 - depth AND age before the solver commits sats', () => {
  it('funds once both are met', () => {
    expect(planEvmReceive(row(), seen())).toEqual({ do: 'fund_arkade' })
  })

  it('waits on depth alone', () => {
    // On a rollup a lock can be deep and still vanish. @see evm/config.ts
    expect(planEvmReceive(row(), seen({ evmLockAgeSeconds: 0 }))).toEqual({ do: 'wait' })
  })

  it('waits on age alone', () => {
    expect(planEvmReceive(row(), seen({ evmLockConfirmations: 0 }))).toEqual({ do: 'wait' })
  })

  it('refuses rather than failing when the client never locked', () => {
    // The backstop behind rule 5: a quote that somehow outlives the refund
    // locktime still terminates there. Unreachable for live rows - the quote
    // window is minutes, the locktime hours.
    const action = planEvmReceive(
      row({ validUntil: REFUND_LOCKTIME + 60 }),
      seen({ evmLockPresent: false, nowSeconds: REFUND_LOCKTIME }),
    )
    expect(action).toEqual({ do: 'refuse', reason: 'client never locked the ERC20' })
  })
})

describe('rule 5 - a quote binds only until valid_until', () => {
  it('refuses an unlocked quote at its own deadline, not the refund locktime', () => {
    const action = planEvmReceive(row(), seen({ evmLockPresent: false, nowSeconds: NOW + 60 }))
    expect(action).toEqual({ do: 'refuse', reason: 'quote expired before the client locked' })
  })

  it('refuses an ERC20 lock first observed after the quote died', () => {
    // Funding here would lock the solver's sats at a rate that stopped binding
    // when the window closed.
    const action = planEvmReceive(row(), seen({ nowSeconds: NOW + 60 }))
    expect(action).toEqual({ do: 'refuse', reason: 'ERC20 lock observed after the quote expired' })
  })

  it('still funds a lock observed inside the window', () => {
    const action = planEvmReceive(row(), seen({ nowSeconds: NOW + 59 }))
    expect(action).toEqual({ do: 'fund_arkade' })
  })
})

describe('rule 2 - do not fund into a nearly-expired client lock', () => {
  it('refuses when too little of the timeout remains to claim in', () => {
    // The solver would pay sats for tokens the client can take straight back.
    const action = planEvmReceive(row(), seen({ evmBlockHeight: EVM_TIMEOUT - 1 }))
    expect(action).toEqual({ do: 'refuse', reason: 'client ERC20 timeout too close to fund against' })
  })

  it('funds when the margin is exactly satisfied', () => {
    const action = planEvmReceive(row(), seen({ evmBlockHeight: EVM_TIMEOUT - EVM_RECEIVE_CLAIM_MARGIN_BLOCKS - 1 }))
    expect(action).toEqual({ do: 'fund_arkade' })
  })
})

describe('rule 3 - a preimage means claim the ERC20, and it outranks everything', () => {
  it('claims as soon as the preimage is revealed', () => {
    const action = planEvmReceive(row({ state: 'awaiting_claim' }), seen({ preimage: 'ab'.repeat(32) }))
    expect(action).toEqual({ do: 'claim_evm', preimage: 'ab'.repeat(32) })
  })

  it('claims even past the ARKADE refund window', () => {
    // THE ORDERING TEST. The sats have already gone out, so the Arkade window is
    // no longer relevant to the solver's position - claiming the ERC20 is the
    // only way it gets paid. Checking the refund window first would send this to
    // refund_arkade, abandoning the tokens the solver had already bought.
    const action = planEvmReceive(
      row({ state: 'awaiting_claim' }),
      seen({ preimage: 'cd'.repeat(32), nowSeconds: REFUND_LOCKTIME + 1 }),
    )
    expect(action).toEqual({ do: 'claim_evm', preimage: 'cd'.repeat(32) })
  })

  it('uses a preimage already on the row after a crash', () => {
    const action = planEvmReceive(row({ state: 'claiming', preimage: 'ef'.repeat(32) }), seen())
    expect(action).toEqual({ do: 'claim_evm', preimage: 'ef'.repeat(32) })
  })
})

describe('rule 4 - past the client timeout with a preimage, the money is gone', () => {
  it('sticks rather than pretending a claim can still land', () => {
    const action = planEvmReceive(
      row({ state: 'awaiting_claim' }),
      seen({ preimage: 'ab'.repeat(32), evmBlockHeight: EVM_TIMEOUT }),
    )
    expect(action).toEqual({
      do: 'stick',
      reason: 'preimage revealed but the client ERC20 timeout has passed',
    })
  })
})

describe('the unclaimed path', () => {
  it('refunds the solver own sats once the Arkade window closes with no preimage', () => {
    const action = planEvmReceive(row({ state: 'awaiting_claim' }), seen({ nowSeconds: REFUND_LOCKTIME }))
    expect(action).toEqual({ do: 'refund_arkade' })
  })

  it('waits while the window is still open', () => {
    expect(planEvmReceive(row({ state: 'awaiting_claim' }), seen())).toEqual({ do: 'wait' })
  })

  it('advances once the funded lockup is visible', () => {
    const action = planEvmReceive(row({ state: 'funding_arkade' }), seen({ arkadeLockupFunded: true }))
    expect(action).toEqual({ do: 'await_claim' })
  })
})
