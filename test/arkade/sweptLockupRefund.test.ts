import { describe, it, expect, vi } from 'vitest'
import {
  refundSweptLockupFor,
  type SweptRefundDecision,
  type SweptRefundRecord,
} from '@arkade-os/solver-arkade/arkade/sweptLockupRefund.js'
import type { FundedOutput } from '@arkade-os/solver-arkade/arkade/wallet.js'

const SCRIPT = 'ab'.repeat(17)
const SWEPT: FundedOutput[] = [
  { txid: 'a'.repeat(64), vout: 0, value: 1505 },
  { txid: 'b'.repeat(64), vout: 0, value: 471 },
]

interface Row {
  id: string
  state: string
  lockupValue?: number | null
  refundOutcome?: string | null
}

const harness = (
  row: Row | null,
  options: {
    swept?: readonly FundedOutput[]
    decide?: (row: Row) => Promise<SweptRefundDecision>
    closableStates?: readonly string[]
  } = {},
) => {
  const refund = vi.fn(async () => 'refund-txid')
  const record = vi.fn(async (_row: Row, _fields: SweptRefundRecord) => {})
  const close = vi.fn(async (_row: Row, _reason: string) => {})
  const run = () =>
    refundSweptLockupFor<Row>(SCRIPT, {
      find: async () => row,
      swept: async () => options.swept ?? SWEPT,
      refund,
      record,
      ...(options.decide ? { decide: options.decide } : {}),
      close,
      closableStates: options.closableStates ?? ['paying', 'paid', 'stuck'],
    })
  return { run, refund, record, close }
}

describe('the swept-lockup refund policy', () => {
  it('refunds a refused row and records both blanks it finds', async () => {
    const { run, refund, record } = harness({ id: 'swap-1', state: 'refused', lockupValue: null, refundOutcome: null })

    await expect(run()).resolves.toEqual({ swapId: 'swap-1', txid: 'refund-txid', recorded: true })
    expect(refund).toHaveBeenCalledOnce()
    // The incident's shape: a refused row whose lockup_value was never written,
    // which every deadline-gated sweep skips. The value comes from what is
    // actually at the script.
    expect(record.mock.calls[0]?.[1]).toEqual({
      lockup_value: 1976,
      refund_outcome: 'pushed',
      refund_ark_txid: 'refund-txid',
    })
  })

  it('leaves an already-recorded outcome alone but still reports the txid', async () => {
    const { run, record } = harness({ id: 'swap-2', state: 'refused', lockupValue: 1976, refundOutcome: 'external' })

    await expect(run()).resolves.toEqual({ swapId: 'swap-2', txid: 'refund-txid', recorded: false })
    expect(record).not.toHaveBeenCalled()
  })

  it('does nothing when no row of ours sits at the script', async () => {
    const { run, refund } = harness(null)
    await expect(run()).resolves.toBeNull()
    expect(refund).not.toHaveBeenCalled()
  })

  it('does nothing when the script holds nothing swept, whatever state the row is in', async () => {
    const { run, refund } = harness({ id: 'swap-3', state: 'stuck' }, { swept: [] })
    await expect(run()).resolves.toBeNull()
    expect(refund).not.toHaveBeenCalled()
  })

  it('names an exposed row rather than refunding it when no verdict is supplied', async () => {
    const { run, refund } = harness({ id: 'swap-4', state: 'stuck' })
    await expect(run()).resolves.toEqual({ swapId: 'swap-4', heldInState: 'stuck' })
    expect(refund).not.toHaveBeenCalled()
  })

  it('refunds and closes an exposed row the verdict clears', async () => {
    const decide = async (): Promise<SweptRefundDecision> => ({ refund: true, reason: 'payment never landed' })
    const { run, refund, record, close } = harness({ id: 'swap-5', state: 'paid', refundOutcome: null }, { decide })

    await expect(run()).resolves.toEqual({
      swapId: 'swap-5',
      txid: 'refund-txid',
      recorded: true,
      closedFrom: 'paid',
    })
    expect(refund).toHaveBeenCalledOnce()
    expect(close.mock.calls[0]?.[1]).toBe('payment never landed')
    // Recorded BEFORE the close, so a crash between them leaves the txid on disk.
    expect(record.mock.invocationCallOrder[0]!).toBeLessThan(close.mock.invocationCallOrder[0]!)
  })

  it('holds an exposed row the verdict will not clear, carrying its evidence', async () => {
    const decide = async (): Promise<SweptRefundDecision> => ({ refund: false, why: 'paid-do-not-refund' })
    const { run, refund } = harness({ id: 'swap-6', state: 'stuck' }, { decide })

    await expect(run()).resolves.toEqual({ swapId: 'swap-6', heldInState: 'stuck', why: 'paid-do-not-refund' })
    expect(refund).not.toHaveBeenCalled()
  })

  it('never asks the verdict about a state with no edge to refused', async () => {
    const decide = vi.fn(async (): Promise<SweptRefundDecision> => ({ refund: true, reason: 'should never be asked' }))
    const { run, refund } = harness({ id: 'swap-7', state: 'claiming' }, { decide })

    await expect(run()).resolves.toEqual({ swapId: 'swap-7', heldInState: 'claiming' })
    expect(decide).not.toHaveBeenCalled()
    expect(refund).not.toHaveBeenCalled()
  })
})
