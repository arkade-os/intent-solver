import { describe, expect, it } from 'vitest'
import { Hashlock } from '@arkade-os/solver-next/domain/swap/hashlock.js'
import { Quote } from '@arkade-os/solver-next/domain/swap/quote.js'
import { Swap } from '@arkade-os/solver-next/domain/swap/swap.js'
import { ContractVersion } from '@arkade-os/solver-next/domain/swap/leg.js'
import { SwapState } from '@arkade-os/solver-next/domain/swap/swap_state.js'
import { bothLocked, btc, quoted, ref, SECRET, t, terms, usdt, WRONG_SECRET } from '../support.js'

const offer = (): Swap =>
  quoted({
    hashlock: null,
    rfqId: null,
    quote: Quote.of(null, { fee: btc(0n), spreadBps: 0 }),
    from: { rail: 'arkade', amount: usdt(5_000n), contract: 'offer', version: ContractVersion.of('offer-v2') },
    to: { rail: 'arkade', amount: btc(9_990n), contract: 'payment', version: null },
  })

const lightningSend = (): Swap => {
  const swap = quoted({ to: { rail: 'lightning', amount: btc(9_990n), contract: 'lightning', version: null } })
  swap.lock('from', t(1_001), ref('txid-in'))
  swap.locking('to', t(1_002))
  return swap
}

describe('swap state', () => {
  it.each([
    ['pending', 'pending', 'quoted', false],
    ['locking', 'pending', 'quoted', false],
    ['locked', 'pending', 'funded', false],
    ['locked', 'locking', 'filling', true],
    ['locked', 'locked', 'awaiting_claim', true],
    ['locked', 'claiming', 'awaiting_claim', true],
    ['locked', 'claimed', 'filled', true],
    ['claiming', 'claimed', 'settling', true],
    ['claimed', 'claimed', 'settled', false],
    ['locked', 'refunding', 'refunding', true],
    ['refunded', 'locked', 'refunding', true],
    ['refunded', 'refunding', 'refunding', true],
    ['locked', 'refunded', 'refunded', false],
    ['refunded', 'refunded', 'refunded', false],
  ] as const)('%s + %s is %s', (from, to, state, exposed) => {
    expect(SwapState.derive(from, to)).toBe(state)
    expect(SwapState.isExposed(state)).toBe(exposed)
  })

  it('has no state for a pair outside the table', () => {
    expect(SwapState.derive('pending', 'claimed')).toBeNull()
    expect(SwapState.derive('refunded', 'claimed')).toBeNull()
    expect(SwapState.derive('claimed', 'refunded')).toBeNull()
    expect(SwapState.derive('claiming', 'refunded')).toBeNull()
    expect(SwapState.derive('claimed', 'locking')).toBeNull()
  })

  it('ends on settled, refunded and every outcome', () => {
    for (const state of ['settled', 'refunded', 'refused', 'lost', 'stuck'] as const) {
      expect(SwapState.isTerminal(state)).toBe(true)
      expect(SwapState.isExposed(state)).toBe(false)
    }
    expect(SwapState.isTerminal('filled')).toBe(false)
  })
})

describe('quoting a swap', () => {
  it.each([
    [{ hashlock: null }, 'a hashlock is required'],
    [{ to: { ...terms.to, contract: 'offer' } } as const, 'a hashlock is required'],
    [{ from: { ...terms.from, amount: btc(0n) } }, 'must be positive'],
    [{ at: t(2_000) }, 'quote expired'],
  ] as const)('refuses %o', (override, message) => {
    expect(() => quoted(override)).toThrow(message)
  })

  it('holds a standing offer: no hashlock, no request, no expiry', () => {
    const standing = offer()
    expect(standing.state).toBe('quoted')
    expect(standing.snapshot.rfqId).toBeNull()
    expect(standing.quote.expiredAt(t(9_999_999))).toBe(false)
  })

  it('expires a quote from its validUntil second on', () => {
    const quote = Quote.of(t(2_000), { fee: btc(0n), spreadBps: 0 })
    expect(quote.expiredAt(t(1_999))).toBe(false)
    expect(quote.expiredAt(t(2_000))).toBe(true)
    expect(() => Quote.of(t(2_000), { fee: btc(0n), spreadBps: 10_000 })).toThrow('0..9999 bps')
  })
})

describe('swap aggregate', () => {
  it('walks the happy path and keeps the preimage the client revealed', () => {
    const swap = bothLocked()
    expect(swap.state).toBe('awaiting_claim')
    expect(swap.exposed).toBe(true)
    swap.claim('to', t(1_004), { claim: ref('txid-claim'), preimage: SECRET })
    expect(swap.state).toBe('filled')
    expect(swap.preimage).toBe(SECRET)
    swap.claiming('from', t(1_005))
    swap.claim('from', t(1_006), { claim: ref('txid-collect') })
    expect(swap.state).toBe('settled')
    expect(swap.to.references).toEqual({ funding: ['txid-out'], claim: ['txid-claim'], refund: [] })
  })

  it('needs the right preimage to claim the to leg, and it before collecting the from leg', () => {
    const swap = bothLocked()
    expect(() => swap.claim('to', t(1_004))).toThrow('needs the preimage')
    expect(() => swap.claim('to', t(1_004), { preimage: WRONG_SECRET })).toThrow('needs the preimage')
    expect(() => swap.claiming('from', t(1_004))).toThrow('before the preimage is known')
    expect(() => swap.lock('from', t(1_004))).toThrow('cannot go locked -> locked')
  })

  it('rejects an edge the leg does not have and a pair the table does not know', () => {
    const swap = quoted()
    expect(() => swap.refund('from', t(1_001))).toThrow('from leg cannot go pending -> refunded')
    expect(() => swap.lock('to', t(1_001))).toThrow('legs pending/locked make no sense')
    expect(swap.accepts('to', 'locked')).toBe(false)
    expect(swap.accepts('from', 'locked')).toBe(true)
    expect(swap.changes).toHaveLength(1)
  })

  it('attaches a reference learned after the intent, and its replacements', () => {
    const swap = lightningSend()
    expect(swap.owesPayout).toBe(true)
    swap.reference('to', { funding: ref('payment-id') }, t(1_003))
    expect(swap.to.state).toBe('locking')
    expect(swap.to.reference('funding')).toBe('payment-id')
    expect(swap.owesPayout).toBe(false)
  })

  it('still owes an on-chain payout until it is locked, reference or not', () => {
    const swap = quoted()
    swap.lock('from', t(1_001))
    swap.locking('to', t(1_002), ref('signed-tx'))
    expect(swap.owesPayout).toBe(true)
    swap.lock('to', t(1_003))
    expect(swap.owesPayout).toBe(false)
  })

  it('takes back a failed Lightning payment, but never a transaction that may still land', () => {
    const paying = lightningSend()
    paying.reference('to', { funding: ref('payment-id') }, t(1_003))
    paying.lockFailed('to', t(1_004))
    expect(paying.state).toBe('funded')

    const funding = quoted()
    funding.lock('from', t(1_001))
    funding.locking('to', t(1_002))
    funding.reference('to', { funding: ref('signed-tx') }, t(1_003))
    expect(() => funding.lockFailed('to', t(1_004))).toThrow('may still land')
  })

  it('fills an offer in one step, both legs at once', () => {
    const swap = offer()
    swap.lock('from', t(1_001), ref('deposit'))
    expect(() => swap.fillOffer(t(1_002))).toThrow('cannot fill while funded')
    swap.locking('to', t(1_002))
    swap.fillOffer(t(1_003), ref('fill-txid'))
    expect(swap.state).toBe('settled')
    expect(swap.from.reference('claim')).toBe('fill-txid')
    expect(swap.to.reference('claim')).toBe('fill-txid')
    expect(() => bothLocked().fillOffer(t(1_004))).toThrow('only an offer')
  })

  it('refunds our leg when the client never claims', () => {
    const swap = bothLocked()
    swap.refunding('to', t(1_010), ref('refund-1'))
    swap.reference('to', { refund: ref('refund-2') }, t(1_011))
    expect(swap.state).toBe('refunding')
    swap.refund('to', t(1_012), ref('refund-2'))
    expect(swap.state).toBe('refunded')
    expect(swap.to.references.refund).toEqual(['refund-1', 'refund-2'])
  })

  it('unwinds when the client side fails back while our lock is still open', () => {
    const swap = bothLocked()
    swap.refund('from', t(1_010))
    expect(swap.state).toBe('refunding')
    expect(swap.exposed).toBe(true)
  })

  it('refuses only a swap with nothing of ours out', () => {
    const swap = bothLocked()
    expect(() => swap.fail('refused', 'no', t(1_004))).toThrow('our payout is out')
    expect(swap.fail('stuck', 'claim failed', t(1_004))).not.toBeNull()
    expect(swap.exposed).toBe(false)
    expect(swap.capitalOut).toBe(true)
  })

  it('fails once, re-judges only a stuck swap, and still records what the rails do', () => {
    const swap = quoted()
    swap.lock('from', t(1_001), ref('txid-in'))
    swap.fail('stuck', 'unsure', t(1_002))
    expect(swap.fail('stuck', 'again', t(1_003))).toBeNull()
    expect(swap.fail('refused', 'quote_expired', t(1_003))).not.toBeNull()
    expect(() => swap.fail('lost', 'no', t(1_004))).toThrow('already refused')
    expect(swap.snapshot.outcomeReason).toBe('quote_expired')
    swap.refund('from', t(1_005), ref('client-refund'))
    expect(swap.from.state).toBe('refunded')
    expect(swap.state).toBe('refused')
  })

  it('records a claim we lost to the other side', () => {
    const swap = bothLocked()
    swap.claim('to', t(1_004), { preimage: SECRET })
    swap.claiming('from', t(1_005))
    swap.fail('lost', 'client refunded first', t(1_006))
    swap.refund('from', t(1_007))
    expect(swap.from.state).toBe('refunded')
    expect(swap.capitalOut).toBe(false)
  })

  it('cannot fail a swap that already settled', () => {
    const swap = bothLocked()
    swap.claim('to', t(1_004), { preimage: SECRET })
    swap.claim('from', t(1_005))
    expect(() => swap.fail('stuck', 'late', t(1_006))).toThrow('already settled')
  })

  it('resumes a stuck swap only with the preimage in hand or the payout back', () => {
    const swap = bothLocked()
    expect(() => swap.resume(t(1_004))).toThrow('only a stuck swap resumes')
    swap.fail('stuck', 'claim failed', t(1_004))
    expect(() => swap.resume(t(1_005))).toThrow('no preimage is known and our payout is not back')
    swap.claim('to', t(1_005), { preimage: SECRET })
    swap.resume(t(1_006))
    expect(swap.state).toBe('filled')
    expect(swap.snapshot.outcomeReason).toBeNull()
  })

  it('rebuilds from its events and counts them as its version', () => {
    const swap = bothLocked()
    swap.claim('to', t(1_004), { claim: ref('txid-claim'), preimage: SECRET })
    expect(swap.version).toBe(0)
    const loaded = Swap.fromEvents(swap.changes)
    expect(loaded.version).toBe(5)
    expect(loaded.snapshot).toEqual(swap.snapshot)
    expect(() => Swap.fromEvents([])).toThrow('must start with SwapQuoted')
    expect(() => Swap.fromEvents([swap.changes[0]!, swap.changes[0]!])).toThrow('quoted twice')
  })

  it('loads from a snapshot with only new changes as events', () => {
    const loaded = Swap.fromSnapshot(bothLocked().snapshot, 7)
    expect(loaded.version).toBe(7)
    expect(loaded.changes).toEqual([])
    loaded.refunding('to', t(1_010))
    expect(loaded.changes.map((e) => e.type)).toEqual(['LegAdvanced'])
  })

  it('only takes 32 bytes of lowercase hex as a hashlock', () => {
    expect(() => Hashlock.of('AB'.repeat(32))).toThrow('lowercase hex')
    expect(() => Hashlock.of('ab'.repeat(31))).toThrow('lowercase hex')
  })

  it('says why a stored swap with contradicting legs reads as stuck', () => {
    const { snapshot } = bothLocked()
    const odd = Swap.fromSnapshot({ ...snapshot, from: snapshot.from.moveTo('claimed', t(2_000)) }, 1)
    expect(odd.state).toBe('stuck')
    expect(odd.outcomeReason).toBe('legs claimed/locked contradict each other')
    expect(bothLocked().outcomeReason).toBeNull()
  })
})
