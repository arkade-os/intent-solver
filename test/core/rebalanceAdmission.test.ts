import { describe, expect, it, vi } from 'vitest'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import type { AdmissionRequest } from '@arkade-os/solver-core/core/admissionStrategy.js'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const request = (): AdmissionRequest => ({
  pair: 'lightning:BTC->arkade:BTC',
  giveSats: 4000,
  capSats: 100000,
  committedSats: async () => 0,
})

const inventory = (sats = 10000): NonNullable<AdmissionRequest['inventory']> => ({
  poolId: 'arkade',
  requiredSats: 4000,
  available: { sats, ageMs: 0 },
  owedSats: async () => 0,
})

describe('rebalance and quote inventory admission', () => {
  it('does not block unrelated admissions while the wallet balance read is pending', async () => {
    const balance = deferred<AdmissionRequest['inventory']>()
    const read = vi.fn(async (req: AdmissionRequest) => (req.pair === request().pair ? balance.promise : undefined))
    const gate = new AdmissionControl(read)
    const pending = gate.admit(request())
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    let admitted = false
    const unrelated = gate.admit({ ...request(), pair: 'arkade:BTC->lightning:BTC' }).then((held) => {
      admitted = held !== null
      held?.release()
    })
    try {
      await vi.waitFor(() => expect(admitted).toBe(true), { timeout: 100 })
    } finally {
      balance.resolve(inventory())
      ;(await pending)?.release()
      await unrelated
    }
  })

  it.each([0, -1, NaN])('rejects invalid size %s before reading the wallet', async (giveSats) => {
    const read = vi.fn(async () => inventory())
    const gate = new AdmissionControl(read)
    await expect(gate.admit({ ...request(), giveSats })).rejects.toThrow(RangeError)
    expect(read).not.toHaveBeenCalled()
    expect(gate.outstandingSats).toBe(0)
  })

  it.each(['wallet', 'committed', 'owed'] as const)(
    'refuses a stale balance when a source hold is spent and released during the %s read',
    async (stage) => {
      const barrier = deferred<void>()
      const reached = deferred<void>()
      const pause = async () => {
        reached.resolve()
        await barrier.promise
      }
      const read = vi.fn(async () => {
        if (stage === 'wallet') await pause()
        return {
          ...inventory(),
          owedSats: async () => {
            if (stage === 'owed') await pause()
            return 0
          },
        }
      })
      const gate = new AdmissionControl(read)
      let source = stage === 'wallet' ? undefined : gate.restoreInventory('arkade', 7000)
      const onRefused = vi.fn()
      const pending = gate.admit({
        ...request(),
        committedSats: async () => {
          if (stage === 'committed') await pause()
          return 0
        },
        onRefused,
      })
      await reached.promise
      if (stage === 'wallet') {
        source = (await gate.reserveInventory('arkade', 7000, 10000, async () => 0)) ?? undefined
        expect(source).toBeDefined()
      }
      source!.release()
      expect(gate.outstandingInventorySats('arkade')).toBe(0)
      barrier.resolve()
      expect(await pending).toBeNull()
      expect(onRefused).toHaveBeenCalledWith('float')
      expect(gate.outstandingSats).toBe(0)
      read.mockImplementation(async () => inventory(3000))
      expect(await gate.admit(request())).toBeNull()
      read.mockImplementation(async () => inventory(8000))
      const fresh = await gate.admit(request())
      expect(fresh).not.toBeNull()
      fresh?.release()
    },
  )

  it('admits overlapping Arkade payouts that both fit the balance read before either was held', async () => {
    const balance = deferred<void>()
    const read = vi.fn(async () => {
      await balance.promise
      return inventory()
    })
    const gate = new AdmissionControl(read)
    const onRefused = vi.fn()
    const pending = [gate.admit({ ...request(), onRefused }), gate.admit({ ...request(), onRefused })]
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    balance.resolve()
    const held = await Promise.all(pending)
    expect(onRefused).not.toHaveBeenCalled()
    expect(gate.outstandingInventorySats('arkade')).toBe(8000)
    held.forEach((reservation) => reservation?.release())
    expect(gate.outstandingInventorySats('arkade')).toBe(0)
  })

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
