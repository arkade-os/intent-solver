/**
 * Rails, once the payout rail became an open id.
 *
 * Two properties carry money-adjacent meaning and both predate this file — they
 * lived as prose in `diagnostics.ts` and as a closed `Record<PayoutRail, …>`
 * that made one of them true by construction:
 *
 *  - ONE read per rail, never one per corridor. Two corridors pay out on Arkade.
 *  - UNKNOWN is not zero. A rail that cannot be read must not make the solver
 *    look broke.
 */
import { describe, it, expect, vi } from 'vitest'
import { balanceOfRail, readRails, type Rail } from '@arkade-os/solver-core/core/rail.js'

const rail = (id: string, value: number | null, calls?: string[]): Rail => ({
  id,
  balance: async () => {
    calls?.push(id)
    return { value, error: value === null ? 'unreachable' : null }
  },
})

describe('readRails', () => {
  it('reads every rail exactly once', async () => {
    const calls: string[] = []
    await readRails([rail('lightning', 1, calls), rail('arkade', 2, calls), rail('onchain', 3, calls)])
    expect(calls.sort()).toEqual(['arkade', 'lightning', 'onchain'])
  })

  /**
   * The property the closed `Record` used to give for free. Two corridors pay
   * out on Arkade; asking that wallet twice can return two different numbers
   * and report the pair inconsistently — one corridor able to honour its max
   * beside another that is not, off the same balance.
   */
  it('takes ONE snapshot that many corridors then index', async () => {
    const balance = vi.fn().mockResolvedValue({ value: 5_000, error: null })
    const balances = await readRails([{ id: 'arkade', balance }])
    // Two corridors both funded by Arkade read the same snapshot.
    expect(balanceOfRail(balances, 'arkade').value).toBe(5_000)
    expect(balanceOfRail(balances, 'arkade').value).toBe(5_000)
    expect(balance).toHaveBeenCalledTimes(1)
  })

  it('reports a rail that could not be read as unknown, not zero', async () => {
    const balances = await readRails([rail('lightning', null)])
    expect(balanceOfRail(balances, 'lightning')).toEqual({ value: null, error: 'unreachable' })
  })

  /**
   * A rail is contracted not to throw, but a plugged-in one is third-party
   * code. One misbehaving rail must not take the whole diagnostics page down —
   * the page an operator opens BECAUSE something is already broken.
   */
  it('survives a rail that throws despite the contract', async () => {
    const boom: Rail = {
      id: 'rogue',
      balance: async () => {
        throw new Error('backend exploded')
      },
    }
    const balances = await readRails([boom, rail('arkade', 7)])
    expect(balanceOfRail(balances, 'rogue')).toEqual({ value: null, error: 'backend exploded' })
    expect(balanceOfRail(balances, 'arkade').value).toBe(7)
  })
})

describe('balanceOfRail', () => {
  /**
   * The plugged-in case. A corridor may name a rail this build has no probe
   * for; that must read as unknown — the same answer a dead rail gives — and
   * never as zero, which would report the solver as broke rather than blind.
   */
  it('answers unknown for a rail nobody registered, naming it', async () => {
    const balances = await readRails([rail('arkade', 1)])
    const unknown = balanceOfRail(balances, 'fake-chain')
    expect(unknown.value).toBeNull()
    expect(unknown.error).toContain('fake-chain')
  })
})
