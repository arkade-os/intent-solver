/**
 * `refundNow` bypasses the deadline sweep's gate, which never refunds an exposed
 * row because that pays a client we already paid over Lightning twice. So the
 * manual override has to carry that guard itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { hex } from '@scure/base'

const { findLockups, findSweptLockups, refundSweptSwapScript, refundSwapScript } = vi.hoisted(() => ({
  findLockups: vi.fn(async () => [] as { txid: string; vout: number; value: number }[]),
  findSweptLockups: vi.fn(async () => [] as { txid: string; vout: number; value: number }[]),
  refundSweptSwapScript: vi.fn(async () => 'batch-txid'),
  refundSwapScript: vi.fn(async () => 'offchain-txid'),
}))

vi.mock('@arkade-os/solver-arkade/arkade/wallet.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@arkade-os/solver-arkade/arkade/wallet.js')>()),
  findLockups,
  findSweptLockups,
  refundSwapScript,
}))
vi.mock('@arkade-os/solver-arkade/arkade/sweptRefund.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@arkade-os/solver-arkade/arkade/sweptRefund.js')>()),
  refundSweptSwapScript,
}))
vi.mock('@arkade-os/solver-corridors/send/arkadeOps.js', () => ({
  covenantScriptFromRow: () => ({ pkScript: Uint8Array.from([0x51, 0x20, ...new Uint8Array(32).fill(7)]) }),
}))

const { refundNow } = await import('@arkade-os/solver-app/ops/refunds.js')
const { EXPOSED } = await import('@arkade-os/solver-corridors/db/swaps.js')

const SPENDABLE = [{ txid: 'a'.repeat(64), vout: 0, value: 1976 }]

const servicesWith = (state: string) => {
  const patch = vi.fn(async () => {})
  const transition = vi.fn(async () => true)
  const noteFundings = vi.fn(async () => {})
  const services = {
    arkade: {},
    config: { emulatorUrl: 'http://emulator' },
    store: {
      get: async () => ({
        id: 'swap-1',
        state,
        refundPkScript: hex.encode(Uint8Array.from([0x51, 0x20, ...new Uint8Array(32).fill(5)])),
        emulatorPubkey: 'ff'.repeat(33),
      }),
      noteFundings,
      patch,
      transition,
    },
  }
  return { services, patch, transition, noteFundings }
}

describe('refundNow refuses a swap the solver may already have paid out', () => {
  beforeEach(() => {
    findLockups.mockClear()
    findSweptLockups.mockClear()
    refundSwapScript.mockClear()
    refundSweptSwapScript.mockClear()
    // The lockup IS still there — so nothing but the guard can stop the refund.
    findLockups.mockResolvedValue(SPENDABLE)
    findSweptLockups.mockResolvedValue(SPENDABLE)
  })

  for (const state of [...EXPOSED, 'claimed']) {
    it(`throws on a ${state} row and pushes no refund`, async () => {
      const { services, patch, transition } = servicesWith(state)
      await expect(refundNow(services as never, 'swap-1')).rejects.toThrow(/in flight|twice/i)
      expect(refundSwapScript).not.toHaveBeenCalled()
      expect(refundSweptSwapScript).not.toHaveBeenCalled()
      expect(patch).not.toHaveBeenCalled()
      expect(transition).not.toHaveBeenCalled()
    })
  }

  it('still refunds a stuck row — the override exists for exactly this', async () => {
    const { services } = servicesWith('stuck')
    expect(await refundNow(services as never, 'swap-1')).toEqual({ txid: 'offchain-txid' })
    expect(refundSwapScript).toHaveBeenCalledOnce()
  })
})
