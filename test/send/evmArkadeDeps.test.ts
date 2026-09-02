/**
 * The Arkade adapter behind `arkade:BTC->ethereum:<token>`.
 *
 * Two money properties: the funded check must measure against what the CLIENT
 * owes, and a claim must never invent a txid off an empty read - the
 * orchestrator stores that txid as proof the sats arrived.
 */

import { describe, it, expect, vi } from 'vitest'
import { evmSendArkadeDeps } from '@arkade-os/solver-corridors-evm/send/evmArkadeDeps.js'
import type { ArkadeOps } from '@arkade-os/solver-corridors/send/orchestrator.js'
import type { EvmSendSwapRow } from '@arkade-os/solver-corridors-evm/db/evmSendSwaps.js'

const row = { id: 'swap-1', pkScript: '5120' + 'ab'.repeat(32), amountSats: 100_000 } as unknown as EvmSendSwapRow

const opsWith = (over: Partial<ArkadeOps> = {}): ArkadeOps =>
  ({
    findLockups: vi.fn().mockResolvedValue([]),
    claim: vi.fn().mockResolvedValue('ark-claim-txid'),
    ...over,
  }) as unknown as ArkadeOps

describe('arkadeLockupFunded', () => {
  it('is false while the client has locked less than it owes', async () => {
    const ops = opsWith({ findLockups: vi.fn().mockResolvedValue([{ value: 99_999 }]) })
    expect(await evmSendArkadeDeps(ops).arkadeLockupFunded(row)).toBe(false)
  })

  it('is true at exactly the quoted amount', async () => {
    const ops = opsWith({ findLockups: vi.fn().mockResolvedValue([{ value: 100_000 }]) })
    expect(await evmSendArkadeDeps(ops).arkadeLockupFunded(row)).toBe(true)
  })

  it('sums MULTIPLE outputs rather than reading only the first', async () => {
    // A lockup can be funded by more than one payment. Reading outputs[0] would
    // leave a fully funded swap stuck at quoted forever.
    const ops = opsWith({ findLockups: vi.fn().mockResolvedValue([{ value: 60_000 }, { value: 40_000 }]) })
    expect(await evmSendArkadeDeps(ops).arkadeLockupFunded(row)).toBe(true)
  })

  it('accepts an overpayment, since the quote already fixed what is owed', async () => {
    const ops = opsWith({ findLockups: vi.fn().mockResolvedValue([{ value: 250_000 }]) })
    expect(await evmSendArkadeDeps(ops).arkadeLockupFunded(row)).toBe(true)
  })

  it('measures against amountSats - what the CLIENT locks, not the payout', async () => {
    // payoutSats is smaller (the fee came off). Measuring against it would call
    // an underfunded lockup funded and lock ERC20 against sats that never came.
    const underfunded = { ...row, payoutSats: 90_000 } as unknown as EvmSendSwapRow
    const ops = opsWith({ findLockups: vi.fn().mockResolvedValue([{ value: 95_000 }]) })
    expect(await evmSendArkadeDeps(ops).arkadeLockupFunded(underfunded)).toBe(false)
  })
})

describe('claimArkade', () => {
  it('THROWS on an empty read rather than returning a txid for a claim that never happened', async () => {
    // The orchestrator records this txid as evidence the sats arrived. Resolving
    // to anything here would mark a swap complete having moved no money.
    const ops = opsWith({ findLockups: vi.fn().mockResolvedValue([]) })
    await expect(evmSendArkadeDeps(ops).claimArkade(row, 'ff'.repeat(32))).rejects.toThrow(/nothing to claim/)
    expect(ops.claim).not.toHaveBeenCalled()
  })

  it('claims against the covenant row rebuilt from the swap row, with the solver as receiver', async () => {
    const outputs = [{ txid: 'aa'.repeat(32), vout: 0, value: 100_000 }]
    const ops = opsWith({ findLockups: vi.fn().mockResolvedValue(outputs) })
    const preimage = 'ff'.repeat(32)
    expect(await evmSendArkadeDeps(ops).claimArkade(row, preimage)).toBe('ark-claim-txid')
    const [covenantRow, passedOutputs, passedPreimage] = vi.mocked(ops.claim).mock.calls[0]!
    expect(covenantRow.id).toBe('swap-1')
    expect(passedOutputs).toEqual(outputs)
    expect(passedPreimage).toBe(preimage)
  })
})
