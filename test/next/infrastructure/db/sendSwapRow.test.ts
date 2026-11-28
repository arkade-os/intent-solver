import { describe, expect, it } from 'vitest'
import { swapFromSendRow, type SendSwapRecord } from '@arkade-os/solver-next/infrastructure/db/send_swap_row.js'
import { Hashlock } from '@arkade-os/solver-next/domain/swap/hashlock.js'
import { SECRET } from '../../domain/support.js'

const HASH = Hashlock.ofPreimage(SECRET)

const row = (override: Partial<SendSwapRecord> = {}): SendSwapRecord => ({
  id: 'swap-1',
  state: 'quoted',
  updatedAt: 1_000,
  paymentHash: HASH,
  amountSats: 10_030,
  invoiceSats: 10_000,
  invoiceExpiresAt: 2_000,
  quotedRefundDeadline: 90_000,
  lockupTxid: null,
  lockupVout: null,
  payAttemptedAt: null,
  paymentId: null,
  preimage: null,
  claimArkTxid: null,
  refundArkTxid: null,
  failureReason: null,
  rfqId: null,
  ...override,
})

const FUNDED = { lockupTxid: 'lock', lockupVout: 1 }
const SENT = { ...FUNDED, payAttemptedAt: 1_100, paymentId: 'pay-1' }
const PAID = { ...SENT, preimage: SECRET }

const read = (override: Partial<SendSwapRecord>) => {
  const swap = swapFromSendRow(row(override))
  return [swap.state, swap.from.state, swap.to.state]
}

describe('a send row read as a swap', () => {
  it('gives each state of the row its pair of legs', () => {
    expect(read({ state: 'quoted' })).toEqual(['quoted', 'pending', 'pending'])
    expect(read({ state: 'funded', ...FUNDED })).toEqual(['funded', 'locked', 'pending'])
    expect(read({ state: 'paying', ...SENT })).toEqual(['filling', 'locked', 'locking'])
    expect(read({ state: 'paid', ...PAID })).toEqual(['filled', 'locked', 'claimed'])
    expect(read({ state: 'claiming', ...PAID })).toEqual(['settling', 'claiming', 'claimed'])
    expect(read({ state: 'claimed', ...PAID, claimArkTxid: 'claim' })).toEqual(['settled', 'claimed', 'claimed'])
  })

  it('keeps a payment the node calls paid in flight until its preimage is read', () => {
    expect(read({ state: 'paid', ...SENT })).toEqual(['filling', 'locked', 'locking'])
  })

  it('carries the amounts, the fee, the references and the times', () => {
    const swap = swapFromSendRow(row({ state: 'claimed', ...PAID, claimArkTxid: 'claim', rfqId: 'rfq-9' }))
    expect([swap.from.amount.units, swap.to.amount.units, swap.quote.pricing.fee.units]).toEqual([
      10_030n,
      10_000n,
      30n,
    ])
    expect([swap.from.fact('funding'), swap.from.fact('claim'), swap.to.fact('funding')]).toEqual([
      'lock:1',
      'claim',
      'pay-1',
    ])
    expect([swap.hashlock, swap.preimage, swap.rfqId, swap.version]).toEqual([HASH, SECRET, 'rfq-9', 1_000])
    expect(swap.from.expiresAt).toBe(90_000)
    expect(swapFromSendRow(row({ state: 'paying', ...SENT })).to.since).toBe(1_100)
  })

  it('keeps a lockup recorded without its output index as a bare txid', () => {
    expect(swapFromSendRow(row({ state: 'funded', lockupTxid: 'lock' })).from.fact('funding')).toBe('lock')
  })

  it('reads a failed row at the furthest state its columns still prove', () => {
    const failed = (override: Partial<SendSwapRecord>) => {
      const swap = swapFromSendRow(row({ state: 'stuck', failureReason: 'why', ...override }))
      return [swap.state, swap.outcomeReason, swap.from.state, swap.to.state]
    }
    expect(failed({})).toEqual(['stuck', 'why', 'pending', 'pending'])
    expect(failed(FUNDED)).toEqual(['stuck', 'why', 'locked', 'pending'])
    expect(failed(SENT)).toEqual(['stuck', 'why', 'locked', 'locking'])
    expect(failed({ ...FUNDED, payAttemptedAt: 1_100 })).toEqual(['stuck', 'why', 'locked', 'locking'])
    expect(failed({ ...FUNDED, paymentId: 'pay-1' })).toEqual(['stuck', 'why', 'locked', 'locking'])
    expect(failed(PAID)).toEqual(['stuck', 'why', 'locked', 'claimed'])
    expect(swapFromSendRow(row({ state: 'refused', failureReason: 'late' })).state).toBe('refused')
  })

  it('takes an empty preimage as none, and never charges a negative fee', () => {
    expect(swapFromSendRow(row({ state: 'paid', ...SENT, preimage: '' })).preimage).toBeNull()
    expect(swapFromSendRow(row({ invoiceSats: 10_031 })).quote.pricing.fee.units).toBe(0n)
  })
})
