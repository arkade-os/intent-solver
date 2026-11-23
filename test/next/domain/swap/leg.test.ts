import { describe, expect, it } from 'vitest'
import { IllegalTransition } from '@arkade-os/solver-next/domain/shared/error.js'
import { ContractKind, LEG_MOVES, Leg, Side, type LegState } from '@arkade-os/solver-next/domain/swap/leg.js'
import { btc, ref, t } from '../support.js'

const STATES = Object.keys(LEG_MOVES) as LegState[]
const FINAL: readonly LegState[] = ['claimed', 'refunded']

/** Every state a leg of this kind can be in, walking only moves it allows. */
const reachable = (leg: { side: Side; contract: ContractKind }, from: LegState = 'pending'): Set<LegState> => {
  const seen = new Set<LegState>([from])
  for (const state of seen) {
    for (const next of STATES) if (Leg.canTransition(leg, state, next)) seen.add(next)
  }
  return seen
}
const KINDS = Object.values(Side).flatMap((side) => Object.values(ContractKind).map((contract) => ({ side, contract })))

describe('leg moves', () => {
  it('are these, and the final states are the ones with no way out', () => {
    expect(LEG_MOVES).toEqual({
      pending: ['locking', 'locked', 'claiming', 'claimed'],
      locking: ['pending', 'locked', 'claiming', 'claimed', 'refunding'],
      locked: ['claiming', 'claimed', 'refunding', 'refunded'],
      claiming: ['claimed', 'refunded'],
      refunding: ['claiming', 'claimed', 'refunded'],
      claimed: [],
      refunded: [],
    })
    expect(STATES.filter((state) => LEG_MOVES[state].length === 0)).toEqual(FINAL)
  })

  it.each(KINDS)('a $side $contract leg can always still finish, from any state it can reach', (leg) => {
    for (const state of reachable(leg)) {
      const ends = [...reachable(leg, state)].filter((end) => FINAL.includes(end))
      expect(ends.length, `${state} is a dead end`).toBeGreaterThan(0)
    }
    expect(reachable(leg).has('claimed')).toBe(true)
  })

  it('never locks or refunds a payment we send, on Lightning or inside an offer', () => {
    for (const contract of [ContractKind.Lightning, ContractKind.Payment]) {
      expect([...reachable({ side: Side.To, contract })].sort()).toEqual(['claimed', 'claiming', 'locking', 'pending'])
    }
    expect(reachable({ side: Side.From, contract: ContractKind.Lightning }).has('refunded')).toBe(true)
  })

  it('never refunds an offer, on either side', () => {
    for (const side of Object.values(Side)) {
      const states = reachable({ side, contract: ContractKind.Offer })
      expect([states.has('refunding'), states.has('refunded'), states.has('locked')]).toEqual([false, false, true])
    }
  })

  it('lets a hashlock contract on any rail reach every state', () => {
    for (const contract of [ContractKind.Vhtlc, ContractKind.OnchainHtlc, ContractKind.EvmHtlc]) {
      for (const side of Object.values(Side)) expect(reachable({ side, contract }).size).toBe(STATES.length)
    }
  })
})

describe('Leg', () => {
  const terms = { rail: 'arkade', amount: btc(1_000n), contract: 'vhtlc', version: null } as const
  const open = (): Leg => Leg.open('from', terms, t(1))

  it('opens pending and refuses an empty amount', () => {
    expect(open().state).toBe('pending')
    expect(() => Leg.open('to', { ...terms, amount: btc(0n) }, t(1))).toThrow('to leg amount must be positive')
  })

  it('moves along its moves without changing the leg it came from', () => {
    const leg = open()
    const locked = leg.moveTo('locked', t(2), { funding: ref('txid') }, t(900))
    expect([leg.state, leg.since, leg.fact('funding')]).toEqual(['pending', 1, null])
    expect([locked.state, locked.since, locked.fact('funding'), locked.expiresAt]).toEqual(['locked', 2, 'txid', 900])
    expect(() => leg.moveTo('refunded', t(2))).toThrow(IllegalTransition)
    expect(() => leg.moveTo('refunded', t(2))).toThrow('from leg cannot go pending -> refunded')
  })

  it('keeps the lock expiry it was shown through later moves', () => {
    const refunding = open().moveTo('locked', t(2), {}, t(900)).moveTo('refunding', t(3))
    expect(refunding.expiresAt).toBe(900)
  })

  it('keeps every version of a reference, the last one current, without repeating it', () => {
    const refunding = open()
      .moveTo('locked', t(2), { funding: ref('txid') })
      .moveTo('refunding', t(3), { refund: ref('refund-1') })
    const bumped = refunding.record({ refund: ref('refund-2') }).record({ refund: ref('refund-2') })
    expect(bumped.facts).toEqual({ funding: ['txid'], claim: [], refund: ['refund-1', 'refund-2'] })
    expect([bumped.fact('refund'), bumped.fact('claim')]).toEqual(['refund-2', null])
    expect([bumped.state, refunding.since, bumped.since]).toEqual(['refunding', 3, 3])
  })

  it('restores what was stored without checking it again', () => {
    const stored = Leg.restore('to', terms, 'refunded', { funding: [ref('a')], claim: [], refund: [ref('b')] }, t(7))
    expect([stored.state, stored.since, stored.expiresAt, stored.fact('refund')]).toEqual(['refunded', 7, null, 'b'])
  })
})
