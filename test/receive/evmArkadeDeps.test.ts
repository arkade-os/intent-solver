/**
 * The Arkade adapter behind `ethereum:<token>->arkade:BTC`.
 *
 * The solver is the FUNDER on this leg, which makes two things money-critical
 * that are merely tidy on the send leg: paying the NET amount, and deciding
 * "already funded?" from a read that still sees a SPENT lockup. Getting the
 * second wrong pays the client twice out of the solver's own float.
 */

import { describe, it, expect, vi } from 'vitest'
import { hex } from '@scure/base'
import { evmReceiveArkadeDeps } from '@arkade-os/solver-corridors-evm/receive/evmArkadeDeps.js'
import type { ReceiveArkadeOps } from '@arkade-os/solver-corridors/receive/arkadeOps.js'
import type { EvmReceiveSwapRow } from '@arkade-os/solver-corridors-evm/db/evmReceiveSwaps.js'

const row = {
  id: 'swap-1',
  pkScript: '5120' + 'ab'.repeat(32),
  lockupAddress: 'tark1lockup',
  paymentHash: 'aa'.repeat(32),
  amountSats: 100_000,
  payoutSats: 99_000,
} as unknown as EvmReceiveSwapRow

const opsWith = (over: Partial<ReceiveArkadeOps> = {}): ReceiveArkadeOps =>
  ({
    fund: vi.fn().mockResolvedValue('ark-fund-txid'),
    refund: vi.fn().mockResolvedValue('ark-refund-txid'),
    findLockups: vi.fn().mockResolvedValue([]),
    findLockupOutpoints: vi.fn().mockResolvedValue([]),
    findClaimPreimage: vi.fn().mockResolvedValue(null),
    ...over,
  }) as unknown as ReceiveArkadeOps

describe('fundArkade', () => {
  it('pays payoutSats, NOT amountSats - the fee came off at quote time', async () => {
    // Paying the gross would hand the client the fee back on every swap, and the
    // row carries both numbers so the mistake is one character wide.
    const ops = opsWith()
    expect(await evmReceiveArkadeDeps(ops).fundArkade(row)).toBe('ark-fund-txid')
    expect(ops.fund).toHaveBeenCalledWith('tark1lockup', 99_000)
  })

  it('pays the address off the ROW rather than re-deriving one', async () => {
    const ops = opsWith()
    await evmReceiveArkadeDeps(ops).fundArkade({ ...row, lockupAddress: 'tark1other' } as EvmReceiveSwapRow)
    expect(ops.fund).toHaveBeenCalledWith('tark1other', 99_000)
  })
})

describe('arkadeLockupFunded - the double-spend guard', () => {
  it('still reads FUNDED after the client has claimed and the outpoint is spent', async () => {
    // THE test on this leg. `findLockups` is spendableOnly, so a claimed lockup
    // vanishes from it. If this predicate used that read, the sequence
    //   fund -> client claims -> crash before the txid is patched -> re-read
    // would fund a second time out of the solver's own float.
    const ops = opsWith({
      findLockups: vi.fn().mockResolvedValue([]),
      findLockupOutpoints: vi.fn().mockResolvedValue([{ txid: 'a', vout: 0, value: 99_000, spent: true }]),
    })
    expect(await evmReceiveArkadeDeps(ops).arkadeLockupFunded(row)).toBe(true)
    expect(ops.findLockups).not.toHaveBeenCalled()
  })

  it('is false when the script has never held anything', async () => {
    const ops = opsWith({ findLockupOutpoints: vi.fn().mockResolvedValue([]) })
    expect(await evmReceiveArkadeDeps(ops).arkadeLockupFunded(row)).toBe(false)
  })

  it('is false on a short fund, so a partial payment is topped up rather than accepted', async () => {
    const ops = opsWith({
      findLockupOutpoints: vi.fn().mockResolvedValue([{ txid: 'a', vout: 0, value: 98_999, spent: false }]),
    })
    expect(await evmReceiveArkadeDeps(ops).arkadeLockupFunded(row)).toBe(false)
  })

  it('measures against payoutSats - what the solver actually locks', async () => {
    // Measuring against amountSats (the gross) would call the solver's own
    // correct funding short and fund it again.
    const ops = opsWith({
      findLockupOutpoints: vi.fn().mockResolvedValue([{ txid: 'a', vout: 0, value: 99_000, spent: false }]),
    })
    expect(await evmReceiveArkadeDeps(ops).arkadeLockupFunded(row)).toBe(true)
  })
})

describe('refundArkade', () => {
  it('THROWS on an empty read rather than reporting a refund that never happened', async () => {
    const ops = opsWith({ findLockups: vi.fn().mockResolvedValue([]) })
    await expect(evmReceiveArkadeDeps(ops).refundArkade(row)).rejects.toThrow(/nothing to refund/)
    expect(ops.refund).not.toHaveBeenCalled()
  })

  it('refunds against the covenant row rebuilt from the swap row', async () => {
    const outputs = [{ txid: 'aa'.repeat(32), vout: 0, value: 99_000 }]
    const ops = opsWith({ findLockups: vi.fn().mockResolvedValue(outputs) })
    expect(await evmReceiveArkadeDeps(ops).refundArkade(row)).toBe('ark-refund-txid')
    const [covenantRow, passedOutputs] = vi.mocked(ops.refund).mock.calls[0]!
    expect(covenantRow.id).toBe('swap-1')
    expect(passedOutputs).toEqual(outputs)
  })

  it('uses the SPENDABLE read, since a spent lockup has nothing left to refund', async () => {
    // The opposite choice from arkadeLockupFunded above, deliberately: pushing a
    // refund against an already-claimed outpoint can only be rejected.
    const ops = opsWith({ findLockups: vi.fn().mockResolvedValue([]) })
    await expect(evmReceiveArkadeDeps(ops).refundArkade(row)).rejects.toThrow()
    expect(ops.findLockupOutpoints).not.toHaveBeenCalled()
  })
})

describe('arkadePreimage', () => {
  it('returns the secret as hex, which is the shape the row column holds', async () => {
    const preimage = new Uint8Array(32).fill(7)
    const ops = opsWith({
      findLockupOutpoints: vi.fn().mockResolvedValue([{ txid: 'a', vout: 0, value: 99_000, spent: true }]),
      findClaimPreimage: vi.fn().mockResolvedValue(preimage),
    })
    expect(await evmReceiveArkadeDeps(ops).arkadePreimage(row)).toBe(hex.encode(preimage))
  })

  it('verifies against the row payment hash, not some other swap', async () => {
    const ops = opsWith({
      findLockupOutpoints: vi.fn().mockResolvedValue([{ txid: 'a', vout: 0, value: 99_000, spent: true }]),
      findClaimPreimage: vi.fn().mockResolvedValue(new Uint8Array(32).fill(7)),
    })
    await evmReceiveArkadeDeps(ops).arkadePreimage(row)
    expect(vi.mocked(ops.findClaimPreimage).mock.calls[0]![1]).toBe('aa'.repeat(32))
  })

  it('is null while nothing has claimed yet', async () => {
    const ops = opsWith({
      findLockupOutpoints: vi.fn().mockResolvedValue([{ txid: 'a', vout: 0, value: 99_000, spent: false }]),
      findClaimPreimage: vi.fn().mockResolvedValue(null),
    })
    expect(await evmReceiveArkadeDeps(ops).arkadePreimage(row)).toBeNull()
  })

  it('does not ask for a preimage when the script has never held anything', async () => {
    const ops = opsWith({ findLockupOutpoints: vi.fn().mockResolvedValue([]) })
    expect(await evmReceiveArkadeDeps(ops).arkadePreimage(row)).toBeNull()
    expect(ops.findClaimPreimage).not.toHaveBeenCalled()
  })
})
