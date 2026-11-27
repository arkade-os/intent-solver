import { describe, expect, it } from 'vitest'
import {
  DomainError,
  IllegalTransition,
  InvalidValue,
  RuleViolated,
} from '@arkade-os/solver-next/domain/shared/error.js'
import { SwapId } from '@arkade-os/solver-next/domain/shared/ids.js'
import { Hashlock, Preimage } from '@arkade-os/solver-next/domain/swap/hashlock.js'
import { ContractKind, Leg, type LegState, type LegTerms, type Side } from '@arkade-os/solver-next/domain/swap/leg.js'
import { Quote } from '@arkade-os/solver-next/domain/swap/quote.js'
import { Swap, type NewSwap } from '@arkade-os/solver-next/domain/swap/swap.js'
import { SwapState } from '@arkade-os/solver-next/domain/swap/swap_state.js'
import { btc, ref, t } from '../support.js'

const SECRET = Preimage.of('11'.repeat(32))
const OTHER_SECRET = Preimage.of('22'.repeat(32))
const HASH = Hashlock.ofPreimage(SECRET)
const QUOTE = Quote.of(t(100), { fee: btc(10n), spreadBps: 5 })

const leg = (contract: ContractKind): LegTerms => ({
  rail: contract === 'lightning' ? 'lightning' : 'arkade',
  amount: btc(1_000n),
  contract,
  version: null,
})

const quoted = (over: Partial<NewSwap> = {}): Swap =>
  Swap.quote({
    id: SwapId.of('swap-1'),
    rfqId: null,
    quote: QUOTE,
    hashlock: HASH,
    from: leg('vhtlc'),
    to: leg('lightning'),
    at: t(1),
    ...over,
  })

const offer = (): Swap => quoted({ hashlock: null, from: leg('offer'), to: leg('payment') })

type Step = (swap: Swap) => Swap

const run = (swap: Swap, ...steps: Step[]): Swap => steps.reduce((current, step) => step(current), swap)

const funded: Step = (swap) => swap.markFunded(t(2))
const filling: Step = (swap) => swap.startFill(t(3))
const filled: Step = (swap) => swap.markFilled(t(4), SECRET)
const toLocked: Step = (swap) => swap.markToLocked(t(3))
const stuck: Step = (swap) => swap.stick('x')
const onArkade = (): Swap => quoted({ to: leg('vhtlc') })

describe('Swap.quote', () => {
  it('starts quoted, with both legs pending and nothing stored yet', () => {
    const swap = quoted()
    expect([swap.state, swap.from.state, swap.to.state, swap.version, swap.preimage]).toEqual([
      'quoted',
      'pending',
      'pending',
      0,
      null,
    ])
  })

  it('needs a hashlock exactly when the swap is not an offer', () => {
    expect(() => quoted({ hashlock: null })).toThrow(InvalidValue)
    expect(() => quoted({ from: leg('offer'), to: leg('payment') })).toThrow(InvalidValue)
    expect(offer().isOffer).toBe(true)
  })

  it('refuses a quote that is already expired', () => {
    expect(() => quoted({ at: t(100) })).toThrow(RuleViolated)
  })
})

describe('a swap', () => {
  it('walks to settled one step at a time, leaving each earlier swap as it was', () => {
    const start = quoted()
    const steps: Step[] = [funded, filling, filled, (swap) => swap.startSettle(t(5)), (swap) => swap.markSettled(t(6))]
    const states: string[] = []
    const end = steps.reduce((swap, step) => {
      const next = step(swap)
      states.push(`${swap.state}>${next.state}`)
      return next
    }, start)
    expect(states).toEqual(['quoted>funded', 'funded>filling', 'filling>filled', 'filled>settling', 'settling>settled'])
    expect([start.state, end.preimage, end.exposed]).toEqual(['quoted', SECRET, false])
  })

  it('moves the leg each step names and files the reference under the right fact', () => {
    const seen = quoted().markFundingSeen(t(2), ref('deposit'))
    expect([seen.state, seen.from.state, seen.from.fact('funding')]).toEqual(['quoted', 'locking', 'deposit'])

    const locked = onArkade().markFunded(t(2), ref('in'), t(900)).markToLocked(t(3), ref('out'), t(800))
    expect([locked.from.state, locked.to.state, locked.state]).toEqual(['locked', 'locked', 'awaiting_claim'])
    expect([locked.from.fact('funding'), locked.from.expiresAt]).toEqual(['in', 900])
    expect([locked.to.fact('funding'), locked.to.expiresAt]).toEqual(['out', 800])

    const refunding = locked.startRefund(t(4), ref('back'))
    expect([refunding.from.state, refunding.to.state]).toEqual(['locked', 'refunding'])
    expect([refunding.to.fact('refund'), refunding.to.fact('funding')]).toEqual(['back', 'out'])

    const refunded = refunding.markRefunded(t(5))
    expect([refunded.from.state, refunded.to.state, refunded.state]).toEqual(['locked', 'refunded', 'refunded'])

    const claimed = locked.markFilled(t(4), SECRET, ref('claim'))
    expect([claimed.to.fact('claim'), claimed.startSettle(t(5), ref('collect')).from.fact('claim')]).toEqual([
      'claim',
      'collect',
    ])
  })

  it('refuses a move the leg does not allow, and a pair of legs that makes no sense', () => {
    expect(() => quoted().markRefunded(t(2))).toThrow(IllegalTransition)
    expect(() => quoted().startFill(t(2))).toThrow('legs pending/locking make no sense')
    expect([
      quoted().allows('to', 'refunded'),
      quoted().allows('to', 'locking'),
      quoted().allows('from', 'locked'),
    ]).toEqual([false, false, true])
  })

  it('takes only the preimage that opens the hashlock, and collects only once it is known', () => {
    const paying = run(quoted(), funded, filling)
    expect(() => paying.markFilled(t(9), OTHER_SECRET)).toThrow('does not open the hashlock')
    // The legs alone would allow this pair once `to` is claimed; without the preimage there is nothing to claim with.
    const blind = Swap.restore({ ...filled(paying).snapshot, preimage: null }, 3)
    expect(() => blind.startSettle(t(9))).toThrow('before the preimage is known')
    expect(() => stuck(quoted()).markSettled(t(9))).toThrow('before the preimage is known')
  })

  it('records a fact without moving, and is the same swap when the fact is already on record', () => {
    const start = quoted().markFunded(t(2), ref('a'))
    const bumped = start.recordFact('from', { funding: ref('b') })
    expect([bumped.state, bumped.from.fact('funding'), bumped.from.since]).toEqual(['funded', 'b', 2])
    expect(start.recordFact('from', { funding: ref('a') })).toBe(start)
  })

  it('keeps the reference of every step that ends or unwinds a leg', () => {
    const settled = run(quoted(), funded, filling, filled).startSettle(t(5)).markSettled(t(6), ref('collected'))
    expect(settled.from.fact('claim')).toBe('collected')
    const back = run(onArkade(), funded, toLocked).startRefund(t(4)).markRefunded(t(5), ref('ours-back'))
    expect(back.to.fact('refund')).toBe('ours-back')
    const released = funded(quoted()).refuse('x').startClientRefund(t(5), ref('sent'))
    expect([
      released.from.fact('refund'),
      released.markClientRefunded(t(6), ref('landed')).from.fact('refund'),
    ]).toEqual(['sent', 'landed'])
  })

  it('says the leg cannot move before it looks at the preimage', () => {
    const claimed = run(quoted(), funded, filling, filled)
    expect(() => claimed.markFilled(t(9), OTHER_SECRET)).toThrow(IllegalTransition)
  })

  it('keeps the version it was loaded with', () => {
    expect(funded(Swap.restore(quoted().snapshot, 7)).version).toBe(7)
  })
})

describe('markFundedBy', () => {
  const output = (outpoint: string, units: bigint) => ({ outpoint: ref(outpoint), amount: btc(units) })
  const amount = quoted().from.amount.units

  it('locks the from leg in the outputs it was funded by, and names the first as the funding', () => {
    const funded = quoted().markFundedBy(t(2), [output('a:0', amount - 1n), output('b:1', 1n)], t(900))
    expect([funded.state, funded.from.fact('funding'), funded.from.expiresAt]).toEqual(['funded', 'a:0', 900])
    expect(funded.from.outputs.map((held) => held.outpoint)).toEqual(['a:0', 'b:1'])
    expect(funded.startFill(t(3)).from.outputs).toEqual(funded.from.outputs)
  })

  it('takes on exactly the amount of the leg, never more and never less', () => {
    expect(() => quoted().markFundedBy(t(2), [output('a:0', amount + 1n)])).toThrow(RuleViolated)
    expect(() => quoted().markFundedBy(t(2), [output('a:0', amount - 1n)])).toThrow(RuleViolated)
    expect(() => quoted().markFundedBy(t(2), [])).toThrow(RuleViolated)
  })

  it('is refused where markFunded is', () => {
    const funded = quoted().markFunded(t(2))
    expect(() => funded.startFill(t(3)).markFundedBy(t(4), [output('a:0', amount)])).toThrow(IllegalTransition)
  })
})

describe('abortFill', () => {
  it('lets a Lightning payment be tried again', () => {
    const retried = funded(quoted()).startFill(t(3), ref('pay-1')).abortFill(t(4))
    expect([retried.state, retried.to.state]).toEqual(['funded', 'pending'])
  })

  it('is refused once a transaction that may still land is on record', () => {
    const onchain = funded(quoted({ to: leg('onchain-htlc') }))
    const unsent = onchain.startFill(t(3))
    const sent = onchain.startFill(t(3), ref('txid'))
    expect([unsent.canAbortFill, sent.canAbortFill, onchain.canAbortFill]).toEqual([true, false, false])
    expect(() => sent.abortFill(t(9))).toThrow('may still land')
    expect(() => quoted().abortFill(t(9))).toThrow(IllegalTransition)
  })
})

describe('an offer', () => {
  it('ends both legs in its one transaction, and has no preimage', () => {
    const paying = run(offer(), funded, filling)
    expect(() => paying.markFilled(t(9), SECRET)).toThrow('an offer has no preimage')
    const done = paying.markOfferFilled(t(9), ref('fill'))
    expect([done.state, done.from.fact('claim'), done.to.fact('claim')]).toEqual(['settled', 'fill', 'fill'])
  })

  it('is the only swap filled that way, only while filling, and not once it failed', () => {
    expect(() => run(quoted(), funded, filling).markOfferFilled(t(9))).toThrow(RuleViolated)
    expect(() => offer().markOfferFilled(t(9))).toThrow(IllegalTransition)
    expect(() => run(offer(), funded, filling, stuck).markOfferFilled(t(9))).toThrow(IllegalTransition)
  })
})

describe('a failed swap', () => {
  it('takes its outcome as its state, the reason with it, and is not counted as exposed', () => {
    const refused = funded(quoted()).refuse('quote_expired')
    expect([refused.state, refused.outcome, refused.outcomeReason]).toEqual(['refused', 'refused', 'quote_expired'])
    const out = run(onArkade(), funded, toLocked)
    expect([out.exposed, stuck(out).exposed]).toEqual([true, false])
  })

  it('is the same swap when told its outcome again', () => {
    const refused = funded(quoted()).refuse('first')
    expect(refused.refuse('second')).toBe(refused)
  })

  it('may be judged again only while stuck', () => {
    const lost = run(quoted(), funded, filling, stuck).markLost('y')
    expect(lost.state).toBe('lost')
    expect(() => lost.stick('z')).toThrow('already lost')
    expect(() => funded(quoted()).refuse('x').stick('z')).toThrow('already refused')
    const settled = run(quoted(), funded, filling, filled).startSettle(t(5)).markSettled(t(6))
    expect(() => settled.stick('z')).toThrow('already settled')
  })

  it('still records what the rails do, so the client lock of a refused swap can go back', () => {
    const released = funded(quoted()).refuse('x').startClientRefund(t(5)).markClientRefunded(t(6))
    expect([released.state, released.from.state]).toEqual(['refused', 'refunded'])
  })

  it('is rearmed once the preimage is known or our payout is back, never before', () => {
    const waiting = run(quoted(), funded, filling, stuck)
    expect([waiting.canRearm, filled(waiting).canRearm]).toEqual([false, true])
    expect(() => waiting.rearm()).toThrow('no preimage is known')
    expect(() => run(quoted(), funded, filling).rearm()).toThrow(IllegalTransition)
    const collectable = filled(waiting).rearm()
    expect([collectable.state, collectable.outcome, collectable.snapshot.outcomeReason]).toEqual(['filled', null, null])
    const back = run(onArkade(), funded, toLocked, stuck).markRefunded(t(5)).rearm()
    expect([back.state, back.outcome]).toEqual(['refunded', null])
  })
})

describe('refuse', () => {
  it('is turned down while our payout is out', () => {
    expect(() => run(quoted(), funded, filling).refuse('x')).toThrow('our payout may be out')
  })

  it('is turned down on a stuck swap whose payout went out after it stuck', () => {
    const after: Step[] = [filling, toLocked, filled]
    for (const step of after) expect(() => run(onArkade(), stuck, step).refuse('y')).toThrow('may be out')
    const paidAndClientRefunded = run(onArkade(), funded, filling, stuck).markClientRefunded(t(5))
    expect(() => paidAndClientRefunded.refuse('y')).toThrow('may be out')
  })

  it('is the same swap when already refused, whatever the rails did since', () => {
    const refused = funded(onArkade()).refuse('x').startFill(t(5))
    expect(refused.refuse('again')).toBe(refused)
  })

  it('says a final swap is final before it looks at the payout', () => {
    const lost = run(onArkade(), funded, filling).markLost('x')
    expect(() => lost.refuse('y')).toThrow('already lost')
  })

  it('is allowed on a stuck swap once nothing of ours is out', () => {
    expect(run(onArkade(), funded, stuck).refuse('y').state).toBe('refused')
    expect(run(onArkade(), funded, toLocked, stuck).markRefunded(t(5)).refuse('y').state).toBe('refused')
  })
})

describe('a restored swap whose legs disagree', () => {
  const stored = (from: LegState, to: LegState): Swap => {
    const { snapshot } = quoted()
    const at = (side: Side, state: LegState): Leg =>
      Leg.restore(side, snapshot[side].terms, state, snapshot[side].facts, t(1))
    return Swap.restore({ ...snapshot, from: at('from', from), to: at('to', to) }, 4)
  }

  it('reads as stuck and says why, and can still be given an outcome', () => {
    const swap = stored('claimed', 'pending')
    expect([swap.state, swap.outcome, swap.outcomeReason, swap.version]).toEqual([
      'stuck',
      null,
      'legs claimed/pending contradict each other',
      4,
    ])
    expect(swap.stick('operator').outcomeReason).toBe('operator')
  })

  it('is not refused while its payout may be out, and its fill is not aborted into another contradiction', () => {
    expect(() => stored('pending', 'locked').refuse('x')).toThrow('may be out')
    expect(() => stored('refunded', 'locking').abortFill(t(9))).toThrow('make no sense')
  })
})

// Seeded so a failure can be replayed.
const random = (seed: number) => (): number => {
  seed = (seed + 0x6d2b79f5) | 0
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296
}

interface Move {
  readonly name: string
  readonly step: Step
  readonly leg?: readonly [Side, LegState]
}

const MOVES: Move[] = [
  { name: 'markFundingSeen', step: (s) => s.markFundingSeen(t(9)), leg: ['from', 'locking'] },
  { name: 'markFunded', step: (s) => s.markFunded(t(9), ref('lock')), leg: ['from', 'locked'] },
  { name: 'startFill', step: (s) => s.startFill(t(9)), leg: ['to', 'locking'] },
  { name: 'startFill sent', step: (s) => s.startFill(t(9), ref('pay')), leg: ['to', 'locking'] },
  { name: 'abortFill', step: (s) => s.abortFill(t(9)) },
  { name: 'markToLocked', step: (s) => s.markToLocked(t(9)), leg: ['to', 'locked'] },
  { name: 'markFilled', step: (s) => s.markFilled(t(9), SECRET) },
  { name: 'markFilled wrong', step: (s) => s.markFilled(t(9), OTHER_SECRET) },
  { name: 'startSettle', step: (s) => s.startSettle(t(9)), leg: ['from', 'claiming'] },
  { name: 'markSettled', step: (s) => s.markSettled(t(9)), leg: ['from', 'claimed'] },
  { name: 'startRefund', step: (s) => s.startRefund(t(9)), leg: ['to', 'refunding'] },
  { name: 'markRefunded', step: (s) => s.markRefunded(t(9)), leg: ['to', 'refunded'] },
  { name: 'startClientRefund', step: (s) => s.startClientRefund(t(9)), leg: ['from', 'refunding'] },
  { name: 'markClientRefunded', step: (s) => s.markClientRefunded(t(9)), leg: ['from', 'refunded'] },
  { name: 'markOfferFilled', step: (s) => s.markOfferFilled(t(9)) },
  { name: 'refuse', step: (s) => s.refuse('r') },
  { name: 'markLost', step: (s) => s.markLost('l') },
  { name: 'stick', step: (s) => s.stick('s') },
  { name: 'rearm', step: (s) => s.rearm() },
  { name: 'recordFact', step: (s) => s.recordFact('to', { refund: ref('bump') }) },
]

const STARTS: (() => Swap)[] = [
  quoted,
  offer,
  onArkade,
  () => quoted({ to: leg('vhtlc'), from: leg('lightning') }),
  () => quoted({ to: leg('onchain-htlc') }),
  () => quoted({ to: leg('evm-htlc') }),
]

describe('any sequence of steps', () => {
  it('keeps every swap in a state that makes sense', () => {
    const next = random(20261123)
    const reached = new Set<string>()
    for (let trial = 0; trial < 4_000; trial++) {
      let swap = STARTS[Math.floor(next() * STARTS.length)]!()
      for (let turn = 0; turn < 25; turn++) {
        const move = MOVES[Math.floor(next() * MOVES.length)]!
        const before = swap
        const snapshot = before.snapshot
        let after: Swap | null = null
        try {
          after = move.step(before)
        } catch (error) {
          expect(error).toBeInstanceOf(DomainError)
        }
        if (move.leg) expect(before.allows(...move.leg), `allows disagrees with ${move.name}`).toBe(after !== null)
        if (move.name === 'rearm') expect(before.canRearm).toBe(after !== null)
        if (move.name === 'abortFill' && after !== null) expect(before.canAbortFill).toBe(true)
        expect(before.snapshot).toBe(snapshot)
        if (after === null) continue
        swap = after
        reached.add(swap.state)

        const legs = SwapState.derive(swap.from.state, swap.to.state)
        if (swap.outcome === null)
          expect(legs, `live swap with legs ${swap.from.state}/${swap.to.state}`).not.toBeNull()
        if (swap.preimage !== null) expect(Preimage.opens(swap.preimage, swap.hashlock!)).toBe(true)
        if (before.preimage !== null) expect(swap.preimage).toBe(before.preimage)
        if (swap.to.state === 'claimed' && !swap.isOffer) expect(swap.preimage).not.toBeNull()
        if (swap.from.state === 'claimed' && swap.outcome === null) expect(swap.to.state).toBe('claimed')
        if (before.outcome === 'refused' || before.outcome === 'lost') expect(swap.outcome).toBe(before.outcome)
        if (move.name === 'refuse' && after !== before) expect(['pending', 'refunded']).toContain(before.to.state)
        expect(swap.version).toBe(before.version)
      }
    }
    expect([...reached].sort()).toEqual([
      'awaiting_claim',
      'filled',
      'filling',
      'funded',
      'lost',
      'quoted',
      'refunded',
      'refunding',
      'refused',
      'settled',
      'settling',
      'stuck',
    ])
  })
})
