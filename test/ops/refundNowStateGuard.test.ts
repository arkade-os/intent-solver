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
const { EXPOSED, SwapStore } = await import('@arkade-os/solver-corridors/db/swaps.js')

const SPENDABLE = [{ txid: 'a'.repeat(64), vout: 0, value: 1976 }]

/** No htlc committed against the hash: `never-submitted`, the safe verdict. */
const UNPAID_LN = { getSendHtlcState: async () => null }
const PAID_LN = { getSendHtlcState: async () => ({ status: 'settled', preimage: 'cc'.repeat(32) }) }

const servicesWith = (state: string, ln: unknown = UNPAID_LN) => {
  const patch = vi.fn(async () => {})
  let currentState = state
  const transition = vi.fn(async (_id: string, from: string, to: string) => {
    if (currentState !== from) return false
    currentState = to
    return true
  })
  const noteFundings = vi.fn(async () => {})
  const services = {
    arkade: {},
    ln,
    config: { emulatorUrl: 'http://emulator', lnBackend: 'lnd' },
    store: {
      get: async () => ({
        id: 'swap-1',
        state: currentState,
        paymentHash: 'ab'.repeat(32),
        paymentId: null,
        paymentBackend: null,
        paymentWallet: null,
        refundPkScript: hex.encode(Uint8Array.from([0x51, 0x20, ...new Uint8Array(32).fill(5)])),
        emulatorPubkey: 'ff'.repeat(33),
      }),
      noteFundings,
      patch,
      transition,
    },
  }
  return { services, patch, transition, noteFundings, stateNow: () => currentState }
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

  it('still refunds a stuck row the backend never paid — the override exists for exactly this', async () => {
    const { services } = servicesWith('stuck')
    expect(await refundNow(services as never, 'swap-1')).toEqual({ txid: 'offchain-txid' })
    expect(refundSwapScript).toHaveBeenCalledOnce()
  })

  // `stuck` conflates paid and unpaid (a returned commitment lands here too), so
  // the row state alone cannot gate the refund — the payment itself must.
  it('refuses a stuck row the backend says was actually paid', async () => {
    const { services, patch, transition } = servicesWith('stuck', PAID_LN)
    await expect(refundNow(services as never, 'swap-1')).rejects.toThrow(/verdict|twice|do not refund/i)
    expect(refundSwapScript).not.toHaveBeenCalled()
    expect(refundSweptSwapScript).not.toHaveBeenCalled()
    expect(patch).not.toHaveBeenCalled()
    expect(transition).not.toHaveBeenCalled()
  })

  for (const state of ['quoted', 'funded', 'stuck']) {
    it(`claims a ${state} row before sending its refund`, async () => {
      const { services, transition, stateNow } = servicesWith(state)
      refundSwapScript.mockImplementationOnce(async () => {
        expect(stateNow()).toBe('refused')
        return 'offchain-txid'
      })

      expect(await refundNow(services as never, 'swap-1')).toEqual({ txid: 'offchain-txid' })
      expect(transition).toHaveBeenCalledWith('swap-1', state, 'refused', { lockup_value: 1976 })
      expect(stateNow()).toBe('refused')
    })
  }

  it('aborts the refund if a payment wins the funded state race', async () => {
    const { services, transition, patch } = servicesWith('funded')
    transition.mockResolvedValueOnce(false)

    await expect(refundNow(services as never, 'swap-1')).rejects.toThrow(/state changed|retry/i)
    expect(refundSwapScript).not.toHaveBeenCalled()
    expect(refundSweptSwapScript).not.toHaveBeenCalled()
    expect(patch).not.toHaveBeenCalled()
  })

  it('leaves a failed refund send in refused for a safe manual retry', async () => {
    const { services, transition, patch, stateNow } = servicesWith('funded')
    refundSwapScript.mockRejectedValueOnce(new Error('arkd unavailable'))

    await expect(refundNow(services as never, 'swap-1')).rejects.toThrow('arkd unavailable')
    expect(stateNow()).toBe('refused')
    expect(patch).not.toHaveBeenCalled()

    expect(await refundNow(services as never, 'swap-1')).toEqual({ txid: 'offchain-txid' })
    expect(transition).toHaveBeenCalledTimes(1)
    expect(patch).toHaveBeenCalledWith('swap-1', { refund_outcome: 'pushed', refund_ark_txid: 'offchain-txid' })
  })

  it('persists the refund claim before spending, blocking a later payment transition', async () => {
    const store = await SwapStore.open(':memory:', () => 1_000_000)
    try {
      await store.insertQuote({
        id: 'swap-db',
        invoice: 'lnbc5u1p...',
        paymentHash: 'ab'.repeat(32),
        amountSats: 1976,
        invoiceExpiresAt: 1_003_600,
        quotedRefundDeadline: 1_007_200,
        refundLocktime: 1_007_200,
        senderPubkey: '01'.repeat(32),
        receiverPubkey: '02'.repeat(32),
        serverPubkey: '03'.repeat(32),
        claimDelay: 605184,
        refundDelay: 605696,
        refundWithoutReceiverDelay: 606208,
        pkScript: '5120' + 'ab'.repeat(32),
        lockupAddress: 'ark1qexample',
        refundPkScript: hex.encode(Uint8Array.from([0x51, 0x20, ...new Uint8Array(32).fill(5)])),
        emulatorPubkey: 'ff'.repeat(33),
        nonInteractiveParameters: true,
      })
      await store.transition('swap-db', 'quoted', 'funded')
      const services = {
        arkade: {},
        ln: UNPAID_LN,
        config: { emulatorUrl: 'http://emulator', lnBackend: 'lnd' },
        store,
      }
      refundSwapScript.mockRejectedValueOnce(new Error('arkd unavailable'))
      await expect(refundNow(services as never, 'swap-db')).rejects.toThrow('arkd unavailable')
      const pending = await store.get('swap-db')
      expect(pending.state).toBe('refused')
      expect(pending.lockupValue).toBe(1976)
      expect(pending.refundOutcome).toBeNull()
      expect((await store.findRefundable(1_007_300)).map((row) => row.id)).toContain('swap-db')

      refundSwapScript.mockImplementationOnce(async () => {
        expect((await store.get('swap-db')).state).toBe('refused')
        return 'offchain-txid'
      })

      expect(await refundNow(services as never, 'swap-db')).toEqual({ txid: 'offchain-txid' })
      expect((await store.get('swap-db')).refundOutcome).toBe('pushed')
      expect(await store.transition('swap-db', 'funded', 'paying')).toBe(false)
    } finally {
      await store.close()
    }
  })
})
