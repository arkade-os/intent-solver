import { describe, expect, it } from 'vitest'
import { Exposure } from '@arkade-os/solver-core/domain/liquidity/exposure.js'
import { Inventory } from '@arkade-os/solver-core/domain/liquidity/inventory.js'
import { RebalancePolicy, type RebalanceLimits } from '@arkade-os/solver-core/domain/liquidity/rebalance_policy.js'
import { Transfer, transferId } from '@arkade-os/solver-core/domain/liquidity/transfer.js'
import { Withdrawal, withdrawalId } from '@arkade-os/solver-core/domain/liquidity/withdrawal.js'
import { ARKADE, btc, LIGHTNING, ONCHAIN, t, usdt } from '../support.js'

describe('exposure', () => {
  it('admits up to the cap, counting stored swaps and quotes in flight', () => {
    const first = Exposure.NONE.reserve(400n, 500n, 1_000n)
    expect(first?.reserved).toBe(400n)
    expect(first?.reserve(101n, 500n, 1_000n)).toBeNull()
    expect(first?.reserve(100n, 500n, 1_000n)?.reserved).toBe(500n)
    expect(first?.release(400n)).toEqual(Exposure.NONE)
    expect(() => first?.release(401n)).toThrow('negative')
    expect(() => Exposure.NONE.reserve(1n, -1n, 1_000n)).toThrow('cannot be negative')
  })

  it('refuses float it cannot read, rather than treating it as zero or as plenty', () => {
    expect(Exposure.NONE.reserveFloat(10n, 0n, null)).toBeNull()
    expect(Exposure.NONE.reserveFloat(10n, 95n, 100n)).toBeNull()
    expect(Exposure.NONE.reserveFloat(5n, 95n, 100n)?.reservedFloat).toBe(5n)
    expect(() => Exposure.NONE.releaseFloat(1n)).toThrow('negative')
    expect(() => Exposure.NONE.reserveFloat(5n, 0n, -1n)).toThrow('cannot be negative')
  })

  it('tracks inventory per pool', () => {
    const held = Exposure.NONE.reserveInventory('arkade', 70n, 0n, 100n)
    expect(held?.inventory('arkade')).toBe(70n)
    expect(held?.reserveInventory('arkade', 31n, 0n, 100n)).toBeNull()
    expect(held?.releaseInventory('arkade', 70n).inventory('arkade')).toBe(0n)
    expect(() => Exposure.NONE.releaseInventory('arkade', 1n)).toThrow('negative')
  })

  it('puts back a hold that outlived a restart without asking again', () => {
    expect(Exposure.NONE.reserveInventory('arkade', 70n, 50n, 100n)).toBeNull()
    expect(Exposure.NONE.restoreInventory('arkade', 70n).inventory('arkade')).toBe(70n)
  })
})

describe('rebalancing', () => {
  const limits: RebalanceLimits = {
    enabled: true,
    reserve: 0n,
    maxDebit: 500_000n,
    dailyDebit: 1_000_000n,
    maxFee: 1_000n,
    maxFeeBps: 50,
    minTransfer: 10_000n,
    cooldownSeconds: 600,
  }
  const policy = RebalancePolicy.of(limits)
  const target = { minimum: 100_000n, target: 300_000n }
  const low = Inventory.of(ARKADE, btc(40_000n), target)
  const lower = Inventory.of(LIGHTNING, btc(10_000n), target)
  const fine = Inventory.of(ONCHAIN, btc(100_000n), target)
  const blind = Inventory.of(ONCHAIN, null, target)

  it('refills the most depleted inventory up to its target, minus what is on its way', () => {
    expect(policy.select([low, lower, fine, blind], new Map(), t(1_000), null)).toEqual({
      inventory: lower,
      net: 290_000n,
    })
    const pending = new Map([[LIGHTNING.key, 285_000n]])
    expect(policy.select([low, lower], pending, t(1_000), null)).toEqual({ inventory: low, net: 260_000n })
  })

  it('does nothing while cooling down, when disabled, or when nothing is low', () => {
    expect(policy.select([low], new Map(), t(1_000), t(500))).toBeNull()
    expect(policy.select([low], new Map(), t(1_100), t(500))).not.toBeNull()
    expect(policy.select([fine, blind], new Map(), t(1_000), null)).toBeNull()
    expect(RebalancePolicy.of({ ...limits, enabled: false }).select([low], new Map(), t(1_000), null)).toBeNull()
  })

  it('caps a transfer per move and by what the day has left, down to the least worth moving', () => {
    expect(policy.amountFor(290_000n, 0n)).toBe(290_000n)
    expect(policy.amountFor(900_000n, 0n)).toBe(500_000n)
    expect(policy.amountFor(290_000n, 900_000n)).toBe(100_000n)
    expect(policy.amountFor(290_000n, 990_001n)).toBeNull()
    expect(policy.amountFor(290_000n, 1_000_000n)).toBeNull()
  })

  it('caps the debit, which is the credit plus its fees', () => {
    expect(policy.debitAllowed(500_000n, 0n)).toBe(true)
    expect(policy.debitAllowed(500_001n, 0n)).toBe(false)
    expect(policy.debitAllowed(400_000n, 600_001n)).toBe(false)
  })

  it('takes a zero minimum as an inventory that is never refilled', () => {
    const never = Inventory.of(ARKADE, btc(0n), { minimum: 0n, target: 300_000n })
    expect(policy.select([never], new Map(), t(1_000), null)).toBeNull()
  })

  it('bounds fees both flat and as a share of the credit', () => {
    expect(policy.feesAllowed(100_000n, 100_500n)).toBe(true)
    expect(policy.feesAllowed(100_000n, 100_501n)).toBe(false)
    expect(policy.feesAllowed(1_000_000n, 1_001_001n)).toBe(false)
    expect(() => policy.feesAllowed(100n, 99n)).toThrow('must cover')
  })

  it('refuses an enabled policy that could move nothing', () => {
    expect(() => RebalancePolicy.of({ ...limits, maxDebit: 0n })).toThrow('positive maxDebit')
    expect(() => RebalancePolicy.of({ ...limits, reserve: -1n })).toThrow('negative')
    expect(() => RebalancePolicy.of({ ...limits, enabled: false, maxDebit: -1n })).toThrow('negative')
    expect(() => RebalancePolicy.of({ ...limits, cooldownSeconds: 1.5 })).toThrow('whole number')
    expect(() => Inventory.of(ARKADE, usdt(1n), null)).toThrow('cannot hold')
  })
})

describe('transfer', () => {
  const quote = (): Transfer =>
    Transfer.quote({
      id: transferId('tr-1'),
      origin: 'automatic',
      requestKey: 'req-1',
      from: ONCHAIN,
      to: ARKADE,
      net: btc(100_000n),
      debit: btc(100_400n),
    })

  it('charges on submit and completes once the credit covers the net', () => {
    const transfer = quote()
    expect(transfer.fee).toEqual(btc(400n))
    transfer.submit(t(1_000))
    expect(transfer.charged).toBe(true)
    expect(() => transfer.accepted('')).toThrow('needs its funding transaction')
    transfer.accepted('funding-txid')
    expect(() => transfer.complete(btc(99_999n))).toThrow('short of')
    transfer.complete(btc(100_050n))
    expect(transfer.state).toBe('completed')
    expect(transfer.snapshot).toMatchObject({ fundingTxid: 'funding-txid', credited: btc(100_050n), chargedAt: 1_000 })
  })

  it('cannot be cancelled once a debit may have left', () => {
    const transfer = quote()
    transfer.submit(t(1_000))
    expect(() => transfer.cancel()).toThrow('submitting -> cancelled')
    transfer.lostTrack()
    transfer.accepted('funding-txid')
    transfer.refund()
    expect(transfer.state).toBe('refunded')
  })

  it('can be found finished while it is being reconciled', () => {
    const [completed, refunded] = [quote(), quote()]
    for (const transfer of [completed, refunded]) {
      transfer.submit(t(1_000))
      transfer.lostTrack()
    }
    completed.complete(btc(100_000n))
    refunded.refund()
    expect([completed.state, refunded.state]).toEqual(['completed', 'refunded'])
  })

  it('needs a debit that covers a positive credit', () => {
    const terms = { id: transferId('tr-2'), origin: 'manual', requestKey: null, from: ONCHAIN, to: ARKADE } as const
    expect(() => Transfer.quote({ ...terms, net: btc(100n), debit: btc(99n) })).toThrow('must cover')
    expect(() => Transfer.quote({ ...terms, to: ONCHAIN, net: btc(1n), debit: btc(1n) })).toThrow('are the same')
  })
})

describe('withdrawal', () => {
  const prepare = (): Withdrawal =>
    Withdrawal.prepare(withdrawalId('wd-1'), 'arkade', ONCHAIN, 'bc1qaddress', btc(50_000n))

  it('knows its debit from the moment it is sending, and is sent with a reference', () => {
    const withdrawal = prepare()
    expect(withdrawal.debit).toBeNull()
    withdrawal.send(btc(300n))
    expect(withdrawal.debit).toEqual(btc(50_300n))
    expect(() => withdrawal.sent('')).toThrow('fee and reference')
    withdrawal.sent('txid')
    expect(withdrawal.snapshot).toMatchObject({ state: 'sent', reference: 'txid' })
  })

  it('cannot simply fail after it was submitted, and keeps the reference of an uncertain send', () => {
    const withdrawal = prepare()
    withdrawal.send(btc(300n))
    expect(() => withdrawal.fail()).toThrow('sending -> failed')
    withdrawal.uncertain('maybe-txid')
    expect(withdrawal.snapshot.reference).toBe('maybe-txid')
    withdrawal.fail()
    expect(withdrawal.state).toBe('failed')
  })

  it('cannot be sent straight from an uncertain preparation, which has no fee', () => {
    const withdrawal = prepare()
    withdrawal.uncertain()
    expect(() => withdrawal.sent('txid')).toThrow('fee and reference')
  })
})
