import { describe, expect, it } from 'vitest'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'

describe('rebalance and quote inventory admission', () => {
  it('failed obligation reads release every acquired reservation', async () => {
    const gate = new AdmissionControl()
    const base = { pair: 'lightning:BTC->arkade:BTC', giveSats: 4000, capSats: 100000, committedSats: async () => 0 }
    await expect(
      gate.admit({
        ...base,
        inventory: {
          poolId: 'arkade',
          requiredSats: 4000,
          available: { sats: 10000, ageMs: 0 },
          owedSats: async () => {
            throw new Error('database unavailable')
          },
        },
      }),
    ).rejects.toThrow(/database/)
    expect(gate.outstandingSats).toBe(0)
    await expect(
      gate.admit({
        ...base,
        inventory: {
          poolId: 'arkade',
          requiredSats: 4000,
          available: { sats: 10000, ageMs: 0 },
          owedSats: async () => 0,
        },
        float: {
          requiredSats: 1,
          available: { sats: 10000, ageMs: 0 },
          owedSats: async () => {
            throw new Error('float unavailable')
          },
        },
      }),
    ).rejects.toThrow(/float/)
    expect(gate.outstandingSats).toBe(0)
    expect(gate.outstandingInventorySats('arkade')).toBe(0)
  })
  it('serializes source debits against customer Arkade payouts without mixing onchain pools', async () => {
    const gate = new AdmissionControl()
    const transfer = await gate.reserveInventory('arkade', 6000, 10000, async () => 1000)
    expect(transfer).not.toBeNull()
    expect(
      await gate.admit({
        pair: 'lightning:BTC->arkade:BTC',
        giveSats: 4000,
        capSats: 100000,
        committedSats: async () => 0,
        inventory: {
          poolId: 'arkade',
          requiredSats: 4000,
          available: { sats: 10000, ageMs: 0 },
          owedSats: async () => 1000,
        },
      }),
    ).toBeNull()
    const unrelated = await gate.reserveInventory('onchain', 9000, 10000, async () => 0)
    expect(unrelated).not.toBeNull()
    transfer!.release()
    expect(gate.outstandingInventorySats('arkade')).toBe(0)
    unrelated!.release()
  })

  it('restores uncertain debits before admitting new funding and releases once', async () => {
    const gate = new AdmissionControl()
    const held = gate.restoreInventory('arkade', 10000)
    expect(await gate.reserveInventory('arkade', 1, 10000, async () => 0)).toBeNull()
    held.release()
    held.release()
    expect(gate.outstandingInventorySats('arkade')).toBe(0)
  })
})
