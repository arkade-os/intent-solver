/**
 * `refundNow` answered `nothing-at-script` — "already spent, or never funded" —
 * for a lockup still holding the client's sats, because `findLockups` is
 * `spendableOnly`. This pins the operator wiring; the batch primitive is
 * `test/arkade/sweptRefund.test.ts`.
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
// Rebuilding the script from the row needs the row's own keys, which this
// file's fixture does not carry; the rebuild is covered where it lives.
vi.mock('@arkade-os/solver-corridors/send/arkadeOps.js', () => ({
  covenantScriptFromRow: () => ({ pkScript: Uint8Array.from([0x51, 0x20, ...new Uint8Array(32).fill(7)]) }),
}))

const { refundNow, NOTHING_AT_SCRIPT } = await import('@arkade-os/solver-app/ops/refunds.js')

const SWEPT = [{ txid: 'a'.repeat(64), vout: 0, value: 1976 }]

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

describe('refundNow reaches a swept lockup', () => {
  beforeEach(() => {
    findLockups.mockClear()
    findSweptLockups.mockClear()
    refundSweptSwapScript.mockClear()
    refundSwapScript.mockClear()
    findLockups.mockResolvedValue([])
    findSweptLockups.mockResolvedValue([])
  })

  it('pushes the batch refund and records it when only swept outputs remain', async () => {
    findSweptLockups.mockResolvedValue(SWEPT)
    const { services, patch, noteFundings } = servicesWith('refused')

    expect(await refundNow(services as never, 'swap-1')).toEqual({ txid: 'batch-txid' })
    expect(refundSweptSwapScript).toHaveBeenCalledOnce()
    expect(refundSwapScript).not.toHaveBeenCalled()
    expect(noteFundings).toHaveBeenCalledWith('swap-1', SWEPT)
    expect(patch).toHaveBeenCalledWith('swap-1', { refund_outcome: 'pushed', refund_ark_txid: 'batch-txid' })
  })

  it('takes a stuck row out of the operator queue once the batch refund landed', async () => {
    findSweptLockups.mockResolvedValue(SWEPT)
    const { services, transition } = servicesWith('stuck')

    await refundNow(services as never, 'swap-1')
    expect(transition).toHaveBeenCalledWith('swap-1', 'stuck', 'refused')
  })

  it('still answers nothing-at-script when the swept read is empty too', async () => {
    const { services, patch, transition } = servicesWith('stuck')

    expect(await refundNow(services as never, 'swap-1')).toEqual({ skipped: NOTHING_AT_SCRIPT })
    expect(refundSweptSwapScript).not.toHaveBeenCalled()
    expect(patch).not.toHaveBeenCalled()
    expect(transition).not.toHaveBeenCalled()
  })

  it('prefers the ordinary offchain refund whenever the lockup is still spendable', async () => {
    // The batch costs a whole round; the offchain spend does not.
    findLockups.mockResolvedValue(SWEPT)
    findSweptLockups.mockResolvedValue(SWEPT)
    const { services } = servicesWith('refused')

    expect(await refundNow(services as never, 'swap-1')).toEqual({ txid: 'offchain-txid' })
    expect(refundSweptSwapScript).not.toHaveBeenCalled()
  })
})
