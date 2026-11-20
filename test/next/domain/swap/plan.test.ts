import { describe, expect, it } from 'vitest'
import type { LegStatus, Observation } from '@arkade-os/solver-next/domain/swap/observation.js'
import { legsToRead, plan, type Policies } from '@arkade-os/solver-next/domain/swap/plan.js'
import { Quote } from '@arkade-os/solver-next/domain/swap/quote.js'
import type { Swap } from '@arkade-os/solver-next/domain/swap/swap.js'
import { bothLocked, btc, quoted, ref, SECRET, t, terms, usdt } from '../support.js'

const NOTHING: LegStatus = {
  funding: 'none',
  matured: false,
  spent: { by: 'nobody' },
  refundOpen: false,
  expiresAt: null,
  refundOpensAt: null,
  refundAloneDelay: null,
  lockReference: null,
  lock: 'none',
  claim: 'none',
  refund: 'none',
}

const seen = (override: Partial<Observation> = {}): Observation => ({
  now: t(1_500),
  from: NOTHING,
  to: NOTHING,
  peer: null,
  keyCurrent: true,
  approval: 'not_required',
  ownInvoice: false,
  ...override,
})

const POLICIES: Policies = {
  canFill: () => ({ ok: true }),
  acceptsOverfunding: false,
  onLockFailed: () => 'stuck',
  onLockMissing: () => 'wait',
  canCollect: () => ({ ok: true }),
  onClaimFailed: () => 'retry',
  onRefundFailed: () => 'retry',
  onSpentUnknown: () => 'stuck',
  canRelease: () => true,
}
const policies = (override: Partial<Policies>): Policies => ({ ...POLICIES, ...override })

const funded = (override: Parameters<typeof quoted>[0] = {}): Swap => {
  const swap = quoted(override)
  swap.lock('from', t(1_001), ref('txid-in'))
  return swap
}
const filling = (override: Parameters<typeof quoted>[0] = {}): Swap => {
  const swap = funded(override)
  swap.locking('to', t(1_002))
  return swap
}
const LIGHTNING = { to: { rail: 'lightning', amount: btc(9_990n), contract: 'lightning', version: null } } as const
const claimedBy = { ...NOTHING, spent: { by: 'claim' as const, preimage: SECRET } }

describe('plan: funding', () => {
  it('waits on a quote and refuses it once it expires unfunded', () => {
    expect(plan(quoted(), seen(), POLICIES)).toEqual({ do: 'wait' })
    expect(plan(quoted(), seen({ now: t(2_000) }), POLICIES)).toEqual({
      do: 'fail',
      outcome: 'refused',
      reason: 'quote expired before the client funded',
    })
  })

  it('records the client funding as it confirms', () => {
    const exact = { ...NOTHING, funding: 'exact' as const }
    expect(plan(quoted(), seen({ from: exact }), POLICIES)).toEqual({ do: 'record', side: 'from', state: 'locking' })
    expect(plan(quoted(), seen({ from: { ...exact, matured: true } }), POLICIES)).toEqual({
      do: 'record',
      side: 'from',
      state: 'locked',
    })
    expect(plan(quoted(), seen({ from: { ...NOTHING, funding: 'short' } }), POLICIES)).toEqual({ do: 'wait' })
  })

  it('refuses a lock it cannot use at once, and an overfunded one unless the route takes it', () => {
    const over = seen({ from: { ...NOTHING, funding: 'over', matured: true } })
    expect(plan(quoted(), over, POLICIES)).toMatchObject({
      outcome: 'refused',
      reason: 'the client overfunded the lock',
    })
    expect(plan(quoted(), over, policies({ acceptsOverfunding: true }))).toMatchObject({
      do: 'record',
      state: 'locked',
    })
    expect(plan(quoted(), seen({ from: { ...NOTHING, funding: 'unusable' } }), POLICIES)).toMatchObject({
      outcome: 'refused',
    })
  })
})

describe('plan: paying out', () => {
  it('asks the route before the operator, so a held swap is still refused when it cannot be filled', () => {
    expect(plan(funded(), seen(), POLICIES)).toEqual({ do: 'lock', side: 'to' })
    expect(plan(funded(), seen({ approval: 'pending' }), POLICIES)).toEqual({ do: 'wait' })
    const closed = policies({ canFill: () => ({ ok: false, reason: 'claim window too short' }) })
    expect(plan(funded(), seen({ approval: 'pending' }), closed)).toMatchObject({
      outcome: 'refused',
      reason: 'claim window too short',
    })
  })

  it('leaves quote expiry after funding to the route: some refuse then, some do not', () => {
    expect(plan(funded(), seen({ now: t(2_000) }), POLICIES)).toEqual({ do: 'lock', side: 'to' })
  })

  it('adopts a lock of ours that already landed, before asking anything else', () => {
    const landed = seen({ to: { ...NOTHING, lock: 'landed' }, now: t(2_000) })
    const never = policies({ canFill: () => ({ ok: false, reason: 'too late' }) })
    expect(plan(funded(), landed, never)).toEqual({ do: 'record', side: 'to', state: 'locked' })
    expect(plan(filling(), landed, never)).toEqual({ do: 'record', side: 'to', state: 'locked' })
  })

  it('lets the route decide what a failed lock means', () => {
    const failed = seen({ to: { ...NOTHING, lock: 'failed' } })
    expect(plan(filling(), failed, POLICIES)).toMatchObject({ outcome: 'stuck' })
    expect(plan(filling(), failed, policies({ onLockFailed: () => 'retry' }))).toEqual({ do: 'unlock' })
    expect(plan(filling(LIGHTNING), failed, policies({ onLockFailed: () => 'refuse' }))).toMatchObject({
      do: 'abandon',
    })
    expect(plan(filling(), seen({ to: { ...NOTHING, lock: 'pending' } }), POLICIES)).toEqual({ do: 'wait' })
  })

  it('never undoes a failed lock that has a transaction on record', () => {
    const swap = funded()
    swap.locking('to', t(1_002), ref('txid-out'))
    const failed = seen({ to: { ...NOTHING, lock: 'failed' } })
    expect(plan(swap, failed, policies({ onLockFailed: () => 'retry' }))).toMatchObject({ outcome: 'stuck' })
    expect(plan(swap, seen(), policies({ onLockMissing: () => 'refuse' }))).toEqual({ do: 'wait' })
  })

  it('asks the route about a payout that was recorded but never reached the rail', () => {
    const swap = filling(LIGHTNING)
    expect(plan(swap, seen(), POLICIES)).toEqual({ do: 'wait' })
    expect(plan(swap, seen(), policies({ onLockMissing: () => 'retry' }))).toEqual({ do: 'lock', side: 'to' })
    expect(plan(swap, seen(), policies({ onLockMissing: () => 'refuse' }))).toMatchObject({ do: 'abandon' })
    expect(plan(swap, seen(), policies({ onLockMissing: () => 'stuck' }))).toMatchObject({ outcome: 'stuck' })
    const pending = seen({ to: { ...NOTHING, lock: 'pending' } })
    expect(plan(swap, pending, policies({ onLockMissing: () => 'stuck' }))).toEqual({ do: 'wait' })
  })

  it('sticks on a spend of our lock it does not recognise', () => {
    expect(plan(bothLocked(), seen({ to: { ...NOTHING, spent: { by: 'unknown' } } }), POLICIES)).toMatchObject({
      outcome: 'stuck',
    })
  })

  it('ignores an unrecognised spend once the claim is already recorded', () => {
    const swap = bothLocked()
    swap.claim('to', t(1_004), { preimage: SECRET })
    const odd = seen({ to: { ...NOTHING, spent: { by: 'unknown' } } })
    expect(plan(swap, odd, POLICIES)).toEqual({ do: 'claim', side: 'from' })
  })
})

describe('plan: collecting', () => {
  it('records the client claim with its preimage, then collects', () => {
    const swap = bothLocked()
    expect(plan(swap, seen({ to: claimedBy }), POLICIES)).toEqual({
      do: 'record',
      side: 'to',
      state: 'claimed',
      preimage: SECRET,
    })
    swap.claim('to', t(1_004), { preimage: SECRET })
    expect(plan(swap, seen({ to: claimedBy }), POLICIES)).toEqual({ do: 'claim', side: 'from' })
  })

  it('lets the route decide whether a late collection is still attempted', () => {
    const swap = bothLocked()
    swap.claim('to', t(1_004), { preimage: SECRET })
    const late = seen({ to: claimedBy, from: { ...NOTHING, refundOpen: true } })
    expect(plan(swap, late, POLICIES)).toEqual({ do: 'claim', side: 'from' })
    const strict = policies({ canCollect: () => ({ ok: false, reason: 'refund window closed' }) })
    expect(plan(swap, late, strict)).toMatchObject({ outcome: 'stuck', reason: 'refund window closed' })
  })

  it('claims again when a claim failed or never reached the rail, until the route gives up', () => {
    const swap = bothLocked()
    swap.claim('to', t(1_004), { preimage: SECRET })
    swap.claiming('from', t(1_005))
    const at = (claim: LegStatus['claim']) => seen({ to: claimedBy, from: { ...NOTHING, claim } })
    expect(plan(swap, at('none'), POLICIES)).toEqual({ do: 'claim', side: 'from' })
    expect(plan(swap, at('failed'), POLICIES)).toEqual({ do: 'claim', side: 'from' })
    expect(plan(swap, at('failed'), policies({ onClaimFailed: () => 'stuck' }))).toMatchObject({ outcome: 'stuck' })
    expect(plan(swap, at('none'), policies({ onClaimFailed: () => 'stuck' }))).toMatchObject({ outcome: 'stuck' })
    expect(plan(swap, at('pending'), POLICIES)).toEqual({ do: 'wait' })
    expect(plan(swap, at('landed'), POLICIES)).toEqual({ do: 'record', side: 'from', state: 'claimed' })
  })

  it('never offers a record the aggregate would refuse', () => {
    expect(plan(quoted(), seen({ to: claimedBy }), POLICIES)).toEqual({ do: 'wait' })
  })

  it('sticks on a claim whose preimage it cannot see', () => {
    const blind = { ...NOTHING, spent: { by: 'claim' as const, preimage: null } }
    expect(plan(bothLocked(), seen({ to: blind }), POLICIES)).toMatchObject({ outcome: 'stuck' })
    expect(plan(bothLocked(), seen({ to: blind }), policies({ onSpentUnknown: () => 'wait' }))).toEqual({ do: 'wait' })
  })

  it('keeps watching a stuck swap for a late claim, and reopens it to collect', () => {
    const swap = bothLocked()
    swap.refunding('to', t(1_010))
    swap.fail('stuck', 'refund kept failing', t(1_020))
    expect(plan(swap, seen({ to: { ...NOTHING, refundOpen: true } }), POLICIES)).toEqual({ do: 'wait' })
    expect(plan(swap, seen({ to: claimedBy }), POLICIES)).toEqual({
      do: 'record',
      side: 'to',
      state: 'claimed',
      preimage: SECRET,
      resume: true,
    })
    const blind = { ...NOTHING, spent: { by: 'claim' as const, preimage: null } }
    expect(plan(swap, seen({ to: blind }), POLICIES)).toEqual({ do: 'wait' })
  })

  it('ends a stuck swap as refunded once our refund is seen landed', () => {
    const swap = bothLocked()
    swap.refunding('to', t(1_010))
    swap.fail('stuck', 'refund kept failing', t(1_020))
    const back = seen({ to: { ...NOTHING, spent: { by: 'refund' }, refund: 'landed' } })
    expect(plan(swap, back, POLICIES)).toEqual({ do: 'record', side: 'to', state: 'refunded', resume: true })
    swap.refund('to', t(1_030))
    swap.resume(t(1_030))
    expect(swap.state).toBe('refunded')
  })

  it('keeps the timeout and the reference the rail showed when a lock is recorded', () => {
    const held = {
      ...NOTHING,
      funding: 'exact' as const,
      matured: true,
      expiresAt: t(9_000),
      lockReference: ref('hold'),
    }
    expect(plan(quoted(), seen({ from: held }), POLICIES)).toEqual({
      do: 'record',
      side: 'from',
      state: 'locked',
      funding: ref('hold'),
      expiresAt: t(9_000),
    })
    const paid = { ...NOTHING, lock: 'landed' as const, lockReference: ref('txid-out:0') }
    expect(plan(filling(), seen({ to: paid }), POLICIES)).toMatchObject({ state: 'locked', funding: 'txid-out:0' })
  })

  it('calls it lost when the client takes both sides', () => {
    const swap = bothLocked()
    swap.claim('to', t(1_004), { preimage: SECRET })
    const refunded = { ...NOTHING, spent: { by: 'refund' as const } }
    expect(plan(swap, seen({ to: claimedBy, from: refunded }), POLICIES)).toMatchObject({ outcome: 'lost' })
  })
})

describe('plan: unwinding', () => {
  it('refunds our leg once its refund opens, retries it, and records it landing', () => {
    const swap = bothLocked()
    expect(plan(swap, seen({ to: { ...NOTHING, refundOpen: true } }), POLICIES)).toEqual({ do: 'refund', side: 'to' })
    swap.refunding('to', t(1_010))
    expect(plan(swap, seen({ to: { ...NOTHING, refund: 'none' } }), POLICIES)).toEqual({ do: 'refund', side: 'to' })
    expect(plan(swap, seen({ to: { ...NOTHING, refund: 'pending' } }), POLICIES)).toEqual({ do: 'wait' })
    expect(plan(swap, seen(), policies({ onRefundFailed: () => 'stuck' }))).toMatchObject({ outcome: 'stuck' })
    expect(plan(swap, seen({ to: { ...NOTHING, refund: 'failed' } }), POLICIES)).toEqual({ do: 'refund', side: 'to' })
    expect(
      plan(swap, seen({ to: { ...NOTHING, refund: 'failed' } }), policies({ onRefundFailed: () => 'stuck' })),
    ).toMatchObject({
      outcome: 'stuck',
    })
    expect(plan(swap, seen({ to: { ...NOTHING, refund: 'landed' } }), POLICIES)).toEqual({
      do: 'record',
      side: 'to',
      state: 'refunded',
    })
  })

  it('does not take a spend that merely looks like a refund as proof', () => {
    const looksRefunded = seen({ to: { ...NOTHING, spent: { by: 'refund' } } })
    expect(plan(bothLocked(), looksRefunded, POLICIES)).toEqual({ do: 'wait' })
  })

  it('still records a late claim while our refund is in flight', () => {
    const swap = bothLocked()
    swap.refunding('to', t(1_010))
    expect(plan(swap, seen({ to: claimedBy }), POLICIES)).toMatchObject({ do: 'record', side: 'to', state: 'claimed' })
  })

  it('hands the client lock back once a swap ended without paying out', () => {
    const refused = funded()
    refused.fail('refused', 'no', t(1_002))
    expect(plan(refused, seen(), POLICIES)).toEqual({ do: 'refund', side: 'from' })
    expect(plan(refused, seen(), policies({ canRelease: () => false }))).toEqual({ do: 'wait' })
    refused.refunding('from', t(1_003))
    expect(plan(refused, seen(), POLICIES)).toEqual({ do: 'refund', side: 'from' })
    expect(plan(refused, seen({ from: { ...NOTHING, refund: 'pending' } }), POLICIES)).toEqual({ do: 'wait' })
    expect(plan(refused, seen({ from: { ...NOTHING, refund: 'landed' } }), POLICIES)).toEqual({
      do: 'record',
      side: 'from',
      state: 'refunded',
    })
    const stuck = bothLocked()
    stuck.fail('stuck', 'unsure', t(1_004))
    expect(plan(stuck, seen({ to: { ...NOTHING, refundOpen: true } }), POLICIES)).toEqual({ do: 'wait' })
  })
})

describe('plan: offers and coupled swaps', () => {
  const offer = (): Swap => {
    const swap = quoted({
      hashlock: null,
      quote: Quote.of(null, { fee: btc(0n), spreadBps: 0 }),
      from: { rail: 'arkade', amount: usdt(5_000n), contract: 'offer', version: null },
      to: { rail: 'arkade', amount: btc(9_990n), contract: 'payment', version: null },
    })
    swap.lock('from', t(1_001), ref('deposit'))
    return swap
  }

  it('adopts a deposit that arrives after the swap was refused, so it can be handed back', () => {
    const swap = quoted()
    swap.fail('refused', 'quote expired before the client funded', t(2_000))
    expect(plan(swap, seen({ now: t(2_001) }), POLICIES)).toEqual({ do: 'wait' })
    const late = { ...NOTHING, funding: 'short' as const }
    expect(plan(swap, seen({ from: late }), POLICIES)).toEqual({ do: 'record', side: 'from', state: 'locking' })
    swap.locking('from', t(2_002))
    expect(plan(swap, seen({ from: late }), POLICIES)).toEqual({ do: 'wait' })
    const confirmed = seen({ from: { ...late, matured: true } })
    expect(plan(swap, confirmed, POLICIES)).toEqual({ do: 'record', side: 'from', state: 'locked' })
    swap.lock('from', t(2_003))
    expect(plan(swap, confirmed, POLICIES)).toEqual({ do: 'refund', side: 'from' })
  })

  it('fills an offer in one decision once its transaction landed', () => {
    const swap = offer()
    expect(plan(swap, seen(), POLICIES)).toEqual({ do: 'lock', side: 'to' })
    swap.locking('to', t(1_002))
    expect(plan(swap, seen({ to: { ...NOTHING, lock: 'pending' } }), POLICIES)).toEqual({ do: 'wait' })
    expect(plan(swap, seen({ to: { ...NOTHING, lock: 'landed' } }), POLICIES)).toEqual({ do: 'fill' })
  })

  it('pays no Lightning when the invoice is our own: the peer swap reveals the preimage', () => {
    const payer = funded({ to: { ...terms.to, rail: 'lightning', contract: 'lightning' } })
    const own = { ownInvoice: true, peer: { state: 'funded' as const, preimage: null } }
    expect(plan(payer, seen(own), POLICIES)).toEqual({ do: 'wait' })
    expect(plan(payer, seen({ ...own, now: t(9_999) }), POLICIES)).toEqual({ do: 'wait' })
    expect(plan(payer, seen({ ...own, peer: { state: 'filled', preimage: SECRET } }), POLICIES)).toEqual({
      do: 'record',
      side: 'to',
      state: 'claimed',
      preimage: SECRET,
    })
  })

  it('settles nothing on the receiving side of a coupled pair: the collateral is the peer lock', () => {
    const receiver = quoted({
      from: { rail: 'lightning', amount: btc(10_000n), contract: 'lightning', version: null },
      to: terms.from,
    })
    const own = { ownInvoice: true, peer: { state: 'funded' as const, preimage: null } }
    expect(plan(receiver, seen(own), POLICIES)).toEqual({ do: 'record', side: 'from', state: 'locked' })
    receiver.lock('from', t(1_001))
    receiver.locking('to', t(1_002))
    receiver.lock('to', t(1_003), ref('lockup'))
    receiver.claim('to', t(1_004), { preimage: SECRET })
    expect(plan(receiver, seen({ ...own, to: claimedBy }), POLICIES)).toEqual({
      do: 'record',
      side: 'from',
      state: 'claimed',
    })
  })
})

describe('plan: which legs to read', () => {
  it('reads only the side that can change the decision', () => {
    expect(legsToRead(quoted())).toEqual({ from: true, to: false })
    expect(legsToRead(funded())).toEqual({ from: true, to: true })
    expect(legsToRead(filling())).toEqual({ from: false, to: true })
    expect(legsToRead(bothLocked())).toEqual({ from: false, to: true })
    const claimed = bothLocked()
    claimed.claim('to', t(1_004), { preimage: SECRET })
    expect(legsToRead(claimed)).toEqual({ from: true, to: false })
    const stuck = bothLocked()
    stuck.fail('stuck', 'unsure', t(1_004))
    expect(legsToRead(stuck)).toEqual({ from: false, to: true })
  })
})
