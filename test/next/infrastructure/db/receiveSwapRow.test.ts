import { describe, expect, it } from 'vitest'
import {
  swapFromReceiveRow,
  type ReceiveSwapRecord,
} from '@arkade-os/solver-next/infrastructure/db/receive_swap_row.js'
import { Hashlock } from '@arkade-os/solver-next/domain/swap/hashlock.js'
import { SECRET } from '../../domain/support.js'

const HASH = Hashlock.ofPreimage(SECRET)

const row = (override: Partial<ReceiveSwapRecord> = {}): ReceiveSwapRecord => ({
  id: 'swap-1',
  state: 'quoted',
  updatedAt: 1_000,
  paymentHash: HASH,
  amountSats: 5_000,
  payoutSats: 4_950,
  invoiceExpiresAt: 2_000,
  htlcExpiresAt: null,
  fundStartedAt: null,
  arkadeLockupTxid: null,
  arkadeLockupVout: null,
  settleAttemptedAt: null,
  preimage: null,
  refundArkTxid: null,
  failureReason: null,
  rfqId: null,
  ...override,
})

const ARMED = { htlcExpiresAt: 9_000 }
const FUNDED = { ...ARMED, arkadeLockupTxid: 'pay', arkadeLockupVout: 2 }
const CLAIMED = { ...FUNDED, preimage: SECRET }

const read = (override: Partial<ReceiveSwapRecord>) => {
  const swap = swapFromReceiveRow(row(override))
  return [swap.state, swap.from.state, swap.to.state]
}

describe('a receive_swap row read as a swap', () => {
  it('gives each state of the row its pair of legs', () => {
    expect(read({ state: 'quoted' })).toEqual(['quoted', 'pending', 'pending'])
    expect(read({ state: 'armed', ...ARMED })).toEqual(['funded', 'locked', 'pending'])
    expect(read({ state: 'armed', ...ARMED, fundStartedAt: 1_100 })).toEqual(['filling', 'locked', 'locking'])
    expect(read({ state: 'funded', ...FUNDED })).toEqual(['awaiting_claim', 'locked', 'locked'])
    expect(read({ state: 'claimed', ...CLAIMED })).toEqual(['filled', 'locked', 'claimed'])
    expect(read({ state: 'claimed', ...CLAIMED, settleAttemptedAt: 1_200 })).toEqual([
      'settling',
      'claiming',
      'claimed',
    ])
    expect(read({ state: 'settled', ...CLAIMED, settleAttemptedAt: 1_200 })).toEqual(['settled', 'claimed', 'claimed'])
    expect(read({ state: 'refunding', ...FUNDED })).toEqual(['refunding', 'locked', 'refunding'])
    expect(read({ state: 'refunded', ...FUNDED, refundArkTxid: 'back' })).toEqual(['refunded', 'locked', 'refunded'])
  })

  it('carries the money, the times and the facts', () => {
    const swap = swapFromReceiveRow(row({ state: 'refunded', ...FUNDED, refundArkTxid: 'back', rfqId: 'rfq-7' }))
    expect([swap.id, swap.rfqId, swap.hashlock, swap.version]).toEqual(['swap-1', 'rfq-7', HASH, 1_000])
    expect([swap.from.amount.units, swap.to.amount.units, swap.quote.pricing.fee.units]).toEqual([5_000n, 4_950n, 50n])
    expect([swap.quote.validUntil, swap.from.expiresAt, swap.to.since]).toEqual([2_000, 9_000, 1_000])
    expect([swap.to.fact('funding'), swap.to.fact('refund')]).toEqual(['pay:2', 'back'])
  })

  it('times a fill in flight from when it was started, not from the last write', () => {
    const swap = swapFromReceiveRow(row({ state: 'armed', ...ARMED, fundStartedAt: 1_100, updatedAt: 1_300 }))
    expect([swap.to.since, swap.from.since]).toEqual([1_100, 1_300])
  })

  it('keeps a lockup recorded without its output index as a bare txid, and guesses nothing', () => {
    const swap = swapFromReceiveRow(row({ state: 'funded', ...ARMED, arkadeLockupTxid: 'pay' }))
    expect(swap.to.fact('funding')).toBe('pay')
  })

  it('reads a failed row as its outcome, on the furthest legs its columns still prove', () => {
    const refused = swapFromReceiveRow(row({ state: 'refused', failureReason: 'too late', ...ARMED }))
    expect([refused.state, refused.outcomeReason, refused.from.state, refused.to.state]).toEqual([
      'refused',
      'too late',
      'locked',
      'pending',
    ])
    const stuckAt = (override: Partial<ReceiveSwapRecord>) => {
      const swap = swapFromReceiveRow(row({ state: 'stuck', failureReason: 'x', ...override }))
      return [swap.state, swap.from.state, swap.to.state]
    }
    expect(stuckAt({})).toEqual(['stuck', 'pending', 'pending'])
    expect(stuckAt({ fundStartedAt: 1_100 })).toEqual(['stuck', 'locked', 'locking'])
    expect(stuckAt(FUNDED)).toEqual(['stuck', 'locked', 'locked'])
    expect(stuckAt(CLAIMED)).toEqual(['stuck', 'locked', 'claimed'])
  })

  it('takes an empty preimage as none', () => {
    const swap = swapFromReceiveRow(row({ state: 'funded', ...FUNDED, preimage: '' }))
    expect([swap.preimage, swap.state]).toEqual([null, 'awaiting_claim'])
    expect(swapFromReceiveRow(row({ state: 'stuck', ...FUNDED, preimage: '' })).to.state).toBe('locked')
  })

  it('never charges a negative fee when the row pays out more than it takes', () => {
    expect(swapFromReceiveRow(row({ payoutSats: 6_000 })).quote.pricing.fee.units).toBe(0n)
  })
})
