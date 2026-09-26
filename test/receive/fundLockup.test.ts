import { describe, it, expect } from 'vitest'
import { fundLockup, FundNotSubmittedError } from '@arkade-os/solver-corridors/receive/fundLockup.js'
import { createReservationLedger } from '@arkade-os/solver-arkade/arkade/reservations.js'
import type { ArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'

const ADDRESS = 'tark1lockup'

const coin = (value: number) => ({
  txid: 'a'.repeat(64),
  vout: 0,
  value,
  virtualStatus: { state: 'settled' },
  expiresAt: new Date(Date.now() + 400 * 24 * 3600 * 1000),
})

interface Harness {
  ctx: ArkadeContext
  sendCalls: number
  selectedInputs: number
  reservations: ReturnType<typeof createReservationLedger>
}

const harness = (over: { spendable?: unknown; send?: () => Promise<string> } = {}): Harness => {
  const reservations = createReservationLedger()
  const state = { sendCalls: 0, selectedInputs: 0 }
  const ctx = {
    reservations,
    dustSats: 330n,
    vtxoMinSats: 330n,
    wallet: {
      arkProvider: {
        getInfo: async () => {
          throw new Error('funding must not refetch server info: dust is read at boot')
        },
      },
      getSpendableVtxos: async () => {
        if (typeof over.spendable === 'function') return (over.spendable as () => unknown[])()
        return over.spendable ?? [coin(50_000)]
      },
      send: async (request: { selectedVtxos?: unknown[] }) => {
        state.sendCalls += 1
        state.selectedInputs = request.selectedVtxos?.length ?? 0
        return over.send ? over.send() : 'ark-txid'
      },
    },
  } as unknown as ArkadeContext
  return {
    ctx,
    reservations,
    get sendCalls() {
      return state.sendCalls
    },
    get selectedInputs() {
      return state.selectedInputs
    },
  } as Harness
}

/**
 * The contract the two receive orchestrators' funding leases are decided by:
 * `send()` is the submission boundary, and only failures strictly before it may
 * hand a lease back.
 */
describe('fundLockup — what it proves about submission', () => {
  it('refuses an unfundable selection as provably-unsubmitted, without calling send()', async () => {
    const h = harness({ spendable: [coin(100)] })

    const error = await fundLockup(h.ctx, ADDRESS, 50_000).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(FundNotSubmittedError)
    expect((error as Error).message).toMatch(/refusing to fund lockup of 50000 sats/)
    expect(h.sendCalls).toBe(0)
  })

  it('refuses sub-minimum change before submission', async () => {
    const h = harness({ spendable: [coin(50_111)] })

    const error = await fundLockup(h.ctx, ADDRESS, 50_000).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(FundNotSubmittedError)
    expect((error as Error).message).toContain('minimum_change_unavailable')
    expect(h.sendCalls).toBe(0)
  })

  it('submits an additional input when change needs topping up', async () => {
    const h = harness({ spendable: [coin(50_111), { ...coin(500), vout: 1 }] })

    await expect(fundLockup(h.ctx, ADDRESS, 50_000)).resolves.toBe('ark-txid')

    expect(h.sendCalls).toBe(1)
    expect(h.selectedInputs).toBe(2)
  })

  it('reports a failed pre-submission READ the same way, carrying the cause', async () => {
    const boom = new Error('indexer unreachable')
    const h = harness({
      spendable: () => {
        throw boom
      },
    })

    const error = await fundLockup(h.ctx, ADDRESS, 50_000).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(FundNotSubmittedError)
    expect((error as Error).cause).toBe(boom)
    expect(h.sendCalls).toBe(0)
  })

  it('lets a send() failure through UNWRAPPED — it is ambiguous, and the caller must keep its lease', async () => {
    const h = harness({
      send: () => {
        throw new Error('ark server response lost')
      },
    })

    const error = await fundLockup(h.ctx, ADDRESS, 50_000).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(FundNotSubmittedError)
    expect((error as Error).message).toBe('ark server response lost')
    expect(h.sendCalls).toBe(1)
    // The pin is still released on the ambiguous path.
    expect(h.reservations.reserved().size).toBe(0)
  })

  it('releases the pin on the happy path too', async () => {
    const h = harness()

    await expect(fundLockup(h.ctx, ADDRESS, 50_000)).resolves.toBe('ark-txid')
    expect(h.reservations.reserved().size).toBe(0)
  })
})
