import { beforeEach, describe, expect, it } from 'vitest'
import { DriveSwap } from '@arkade-os/solver-core/application/drive_swap.js'
import type { Side } from '@arkade-os/solver-core/domain/swap/leg.js'
import type { LegStatus } from '@arkade-os/solver-core/domain/swap/observation.js'
import type { Policies } from '@arkade-os/solver-core/domain/swap/plan.js'
import type { Swap } from '@arkade-os/solver-core/domain/swap/swap.js'
import type { RailService, RailWatcher, SendResult } from '@arkade-os/solver-core/ports/rail.js'
import { betterSqliteDriver } from '@arkade-os/solver-db/driver.js'
import { SwapEvents } from '@arkade-os/solver-db/swapEvents.js'
import { quoted, ref, SECRET, t, terms } from '../domain/support.js'

class Crash extends Error {}

/** Fake rails for one swap. The client has already funded and claims our payout as soon as it is sent. */
class World {
  payouts = 0
  collected = 0
  /** Every write and rail call is counted. Call number `crashAt` throws, before or after it takes effect. */
  calls = 0
  crashAt = 0
  crashAfterEffect = false

  effect<T>(run: () => T): T {
    this.calls += 1
    const dying = this.calls === this.crashAt
    if (dying && !this.crashAfterEffect) throw new Crash()
    const result = run()
    if (dying) throw new Crash()
    return result
  }

  seen(side: Side): LegStatus {
    const paid = this.payouts > 0
    const base = { matured: true, refundOpen: false, expiresAt: null, refundOpensAt: null, refund: 'none' } as const
    return side === 'from'
      ? {
          ...base,
          funding: 'exact',
          spent: { by: 'nobody' },
          lock: 'none',
          claim: this.collected > 0 ? 'landed' : 'none',
        }
      : {
          ...base,
          funding: 'none',
          spent: paid ? { by: 'claim', preimage: SECRET } : { by: 'nobody' },
          lock: paid ? 'landed' : 'none',
          claim: 'none',
        }
  }
}

const POLICIES: Policies = {
  canFill: () => ({ ok: true }),
  acceptsOverfunding: false,
  onLockFailed: () => 'stuck',
  onLockMissing: () => 'retry',
  canCollect: () => ({ ok: true }),
  onClaimFailed: () => 'retry',
  onRefundFailed: () => 'retry',
  canRelease: () => true,
}

let world: World
let swaps: SwapEvents

const worker = (): DriveSwap => {
  const watcher: RailWatcher = { observe: async (_swap: Swap, side: Side) => world.seen(side) }
  const sent = (reference: string): SendResult => ({ status: 'sent', reference: ref(reference) })
  const service: RailService = {
    lock: async () => world.effect(() => ((world.payouts += 1), sent('payout'))),
    claim: async () => world.effect(() => ((world.collected += 1), sent('collect'))),
    refund: async () => world.effect(() => sent('refund')),
  }
  const stored: Pick<SwapEvents, 'get' | 'update'> = {
    get: (id) => swaps.get(id),
    update: async (id, change) => {
      const before = world.calls
      // Count the write once, even though the callback runs inside it.
      const result = await swaps.update(id, async (swap) => {
        await change(swap)
        if (world.calls === before) world.effect(() => undefined)
      })
      return result
    },
  }
  return new DriveSwap({
    swaps: stored,
    policies: POLICIES,
    watchers: { from: watcher, to: watcher },
    services: { from: service, to: service },
    context: async () => ({ peer: null, keyCurrent: true, approval: 'not_required', ownInvoice: false }),
    now: () => t(1_500),
  })
}

beforeEach(async () => {
  world = new World()
  swaps = await SwapEvents.open(betterSqliteDriver(':memory:'))
  await swaps.add(quoted())
})

describe('driving a swap', () => {
  it('drives a funded swap to settled with one payout and one collection', async () => {
    expect(await worker().drive(terms.id)).toBe('wait')
    const swap = await swaps.get(terms.id)
    expect(swap?.state).toBe('settled')
    expect([world.payouts, world.collected]).toEqual([1, 1])
    expect([swap?.to.reference('funding'), swap?.from.reference('claim')]).toEqual(['payout', 'collect'])
  })

  it('still settles with one payout after a crash before or after any write or rail call', async () => {
    await worker().drive(terms.id)
    const total = world.calls
    expect(total).toBeGreaterThan(6)

    for (const crashAfterEffect of [false, true]) {
      for (let crashAt = 1; crashAt <= total; crashAt++) {
        world = Object.assign(new World(), { crashAt, crashAfterEffect })
        swaps = await SwapEvents.open(betterSqliteDriver(':memory:'))
        await swaps.add(quoted())
        await expect(worker().drive(terms.id), `crash ${crashAt}`).rejects.toThrow(Crash)

        expect(await worker().drive(terms.id)).toBe('wait')
        const label = `crash ${crashAfterEffect ? 'after' : 'before'} call ${crashAt}`
        expect((await swaps.get(terms.id))?.state, label).toBe('settled')
        expect(world.payouts, label).toBe(1)
      }
    }
  })

  it('lets only one of two workers act on the same swap version', async () => {
    const steps = await Promise.all([worker().step(terms.id), worker().step(terms.id)])
    expect(steps.sort()).toEqual(['record', 'skipped'])
    const racing = await Promise.all([worker().step(terms.id), worker().step(terms.id)])
    expect(racing.sort()).toEqual(['lock', 'skipped'])
    expect(world.payouts).toBe(1)
  })
})
