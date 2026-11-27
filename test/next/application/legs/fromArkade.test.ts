import { describe, expect, it } from 'vitest'
import { SendSwapService } from '@arkade-os/solver-corridors/send/orchestrator.js'
import { FromArkade } from '@arkade-os/solver-next/application/legs/from_arkade.js'
import type { ClientLockupContract, ClientLockupOutput, ClientLockups } from '@arkade-os/solver-next/ports/arkade.js'
import { quoted, t } from '../../domain/support.js'

const NOW = 1_800_000_000
const REFUND_OPENS_AT = t(NOW + 100_000)
const SWAP = quoted()

const CONTRACT: ClientLockupContract = {
  id: SWAP.id,
  pkScript: 'pk',
  amountSats: 10_000,
  lockedSats: null,
  adopted: null,
  refundLocktime: REFUND_OPENS_AT,
  refundWithoutReceiverDelay: 4_096,
}
const output = (txid: string, value: number, more: Partial<ClientLockupOutput> = {}): ClientLockupOutput => ({
  txid,
  vout: 0,
  value,
  ...more,
})

const legOn = (outputs: ClientLockupOutput[], contract = CONTRACT, claimsOutlastTheBatch = false) => {
  const arkade: ClientLockups = {
    available: async () => outputs,
    claimsOutlastTheBatch: () => claimsOutlastTheBatch,
    refundOpensAt: async () => REFUND_OPENS_AT,
    secondsToRefundAlone: () => 4_096,
  }
  return new FromArkade({ contract: async () => contract }, arkade, () => t(NOW))
}
const adopted = (...outputs: ClientLockupOutput[]): ClientLockupContract => ({
  ...CONTRACT,
  lockedSats: 10_000,
  adopted: outputs.map(({ txid, vout, value }) => ({ txid, vout, value })),
})

describe('a client lockup on Arkade', () => {
  it('reports everything held, and separately what a claim can spend', async () => {
    const plain = output('a', 6_000)
    const leg = legOn([plain, output('b', 4_000, { assets: [{}] })])
    expect(await leg.state(SWAP)).toEqual({ heldSats: 10_000, spendableSats: [6_000], spendable: [plain] })
  })

  it('reports an empty address as holding nothing', async () => {
    expect(await legOn([]).state(SWAP)).toEqual({ heldSats: 0, spendableSats: [], spendable: [] })
  })
})

describe('the moment a payment against the lockup must be over by', () => {
  const whole = output('a', 10_000)

  it('is the client refund when nothing expires sooner', async () => {
    expect(await legOn([whole], adopted(whole)).payDeadline(SWAP, REFUND_OPENS_AT)).toBe(REFUND_OPENS_AT)
  })

  it('is the batch expiry of the outputs that cover the amount, where that comes first', async () => {
    const soon = output('a', 10_000, { expiresAt: NOW + 5_000 })
    expect(await legOn([soon], adopted(soon)).payDeadline(SWAP, REFUND_OPENS_AT)).toBe(NOW + 5_000)
    const later = output('b', 10_000, { expiresAt: NOW + 9_000 })
    expect(await legOn([soon, later], { ...CONTRACT, lockedSats: 10_000 }).payDeadline(SWAP, REFUND_OPENS_AT)).toBe(
      NOW + 9_000,
    )
  })

  it('ignores the batch expiry where a claim still works after it', async () => {
    const soon = output('a', 10_000, { expiresAt: NOW + 5_000 })
    expect(await legOn([soon], adopted(soon), true).payDeadline(SWAP, REFUND_OPENS_AT)).toBe(REFUND_OPENS_AT)
  })

  it.each([
    ['an adopted output is gone', [], adopted(whole)],
    ['an adopted output changed value', [output('a', 9_999)], adopted(whole)],
    ['an adopted output now carries assets', [output('a', 10_000, { assets: [{}] })], adopted(whole)],
    ['what was locked is not the amount', [whole], { ...adopted(whole), lockedSats: 9_999 }],
    ['nothing was adopted and nothing is there', [], CONTRACT],
  ])('is now, so that nothing is paid, when %s', async (_what, outputs, contract) => {
    expect(await legOn(outputs, contract).payDeadline(SWAP, REFUND_OPENS_AT)).toBe(NOW)
  })
})

describe('the pay deadline against production', () => {
  const random = (seed: number) => () => {
    seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296
    return seed / 4_294_967_296
  }
  // Today's rule is a private method of the send service. It is called on a stand-in holding only what it reads.
  const today = SendSwapService.prototype as unknown as {
    payDeadline(this: unknown, row: unknown, refundDeadline: number): Promise<number>
    availableLockups: unknown
  }

  it('agrees on 20,000 random lockups', async () => {
    const next = random(20261127)
    const pick = <T>(of: readonly T[]): T => of[Math.floor(next() * of.length)]!
    const reached = new Set<string>()

    for (let i = 0; i < 20_000; i++) {
      const outputs = Array.from({ length: pick([0, 1, 1, 2, 3]) }, (_, n) =>
        output(`tx${n}`, pick([10_000, 10_000, 6_000, 4_000, 9_999]), {
          ...(next() < 0.1 ? { assets: [{}] } : {}),
          ...(next() < 0.6 ? { expiresAt: NOW + pick([1_000, 5_000, 200_000]) } : {}),
        }),
      )
      const taken = next() < 0.6 ? outputs.filter(() => next() < 0.8) : null
      const lockupOutpoints =
        taken === null || taken.length === 0
          ? null
          : taken.map(({ txid, vout, value }) => ({ txid, vout, value: next() < 0.95 ? value : value + 1 }))
      const lockedSats = pick([null, 10_000, 10_000, 10_000, 9_999])
      const batchReady = next() < 0.4
      const swept = next() < 0.3 ? [output('tx0', 10_000), output('swept', pick([10_000, 4_000]))] : []
      const network = pick(['regtest', 'mutinynet', 'bitcoin'])

      const row = {
        pkScript: 'pk',
        amountSats: 10_000,
        lockupValue: lockedSats,
        lockupOutpoints: lockupOutpoints && JSON.stringify(lockupOutpoints),
      }
      const service = {
        deps: { arkade: { findLockups: async () => outputs, findSweptLockups: async () => swept }, network },
        now: () => NOW,
        batchClaimReady: () => batchReady,
        availableLockups: today.availableLockups,
      }
      const expected = await today.payDeadline.call(service, row, REFUND_OPENS_AT)

      const contract = { ...CONTRACT, lockedSats, adopted: lockupOutpoints }
      const claimsOutlastTheBatch = network === 'regtest' || (batchReady && lockupOutpoints !== null)
      const reachable =
        batchReady && lockupOutpoints !== null
          ? [...outputs, ...swept.filter((late) => !outputs.some((seen) => seen.txid === late.txid))]
          : outputs
      const ours = await legOn(reachable, contract, claimsOutlastTheBatch).payDeadline(SWAP, REFUND_OPENS_AT)
      if (ours !== expected)
        throw new Error(
          `lockup ${i}: ours ${ours}, today ${expected}: ${JSON.stringify({ row, outputs, batchReady, network })}`,
        )
      reached.add(ours === NOW ? 'now' : ours === REFUND_OPENS_AT ? 'refund' : 'batch')
    }
    expect([...reached].sort()).toEqual(['batch', 'now', 'refund'])
  })
})
