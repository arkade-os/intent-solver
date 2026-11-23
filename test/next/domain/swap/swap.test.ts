import { describe, expect, it } from 'vitest'
import {
  DomainError,
  IllegalTransition,
  InvalidValue,
  RuleViolated,
} from '@arkade-os/solver-next/domain/shared/error.js'
import { SwapId } from '@arkade-os/solver-next/domain/shared/ids.js'
import { Hashlock, Preimage } from '@arkade-os/solver-next/domain/swap/hashlock.js'
import { ContractKind, Leg, type LegState, type LegTerms } from '@arkade-os/solver-next/domain/swap/leg.js'
import { Quote } from '@arkade-os/solver-next/domain/swap/quote.js'
import { Swap, type Command, type NewSwap } from '@arkade-os/solver-next/domain/swap/swap.js'
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

const run = (swap: Swap, ...commands: Command[]): Swap =>
  commands.reduce((current, command, step) => current.apply(command, t(2 + step)).swap, swap)

const FILLED: Command[] = [{ do: 'mark_funded' }, { do: 'start_fill' }, { do: 'mark_filled', preimage: SECRET }]

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

describe('Swap.apply', () => {
  it('walks a swap to settled, one transition per command, leaving the earlier swap as it was', () => {
    const start = quoted()
    const states: string[] = []
    let swap = start
    for (const command of [...FILLED, { do: 'start_settle' }, { do: 'mark_settled' }] as Command[]) {
      const { swap: next, transition } = swap.apply(command, t(5))
      expect([transition?.from, transition?.to, transition?.command]).toEqual([swap.state, next.state, command.do])
      states.push(next.state)
      swap = next
    }
    expect(states).toEqual(['funded', 'filling', 'filled', 'settling', 'settled'])
    expect([start.state, swap.preimage, swap.exposed]).toEqual(['quoted', SECRET, false])
  })

  it('keeps the reference and the expiry a command carries on the leg it moves', () => {
    const swap = run(quoted(), { do: 'mark_funded', reference: ref('lockup:0'), expiresAt: t(900) })
    expect([swap.from.fact('funding'), swap.from.expiresAt, swap.to.fact('funding')]).toEqual(['lockup:0', 900, null])
  })

  it('refuses a move the leg does not allow, and a pair of legs that makes no sense', () => {
    expect(() => quoted().apply({ do: 'mark_refunded' }, t(2))).toThrow(IllegalTransition)
    expect(() => quoted().apply({ do: 'start_fill' }, t(2))).toThrow('legs pending/locking make no sense')
  })

  it('takes only the preimage that opens the hashlock, and collects only once it is known', () => {
    const filling = run(quoted(), { do: 'mark_funded' }, { do: 'start_fill' })
    expect(() => filling.apply({ do: 'mark_filled', preimage: OTHER_SECRET }, t(9))).toThrow(RuleViolated)
    // The legs alone would allow this pair once `to` is claimed; without the preimage there is nothing to claim with.
    const blind = Swap.restore({ ...run(filling, FILLED[2]!).snapshot, preimage: null }, 3)
    expect(() => blind.apply({ do: 'start_settle' }, t(9))).toThrow('before the preimage is known')
  })

  it('records a fact without moving the swap', () => {
    const funded = run(quoted(), { do: 'mark_funded', reference: ref('a') })
    const { swap, transition } = funded.apply({ do: 'record_fact', side: 'from', facts: { funding: ref('b') } }, t(9))
    expect([swap.state, swap.from.fact('funding'), swap.from.since]).toEqual(['funded', 'b', 2])
    expect([transition?.from, transition?.to]).toEqual(['funded', 'funded'])
  })
})

describe('abort_fill', () => {
  it('lets a Lightning payment be tried again', () => {
    const retried = run(
      quoted(),
      { do: 'mark_funded' },
      { do: 'start_fill', reference: ref('pay-1') },
      { do: 'abort_fill' },
    )
    expect([retried.state, retried.to.state]).toEqual(['funded', 'pending'])
  })

  it('is refused once a transaction that may still land is on record', () => {
    const onchain = quoted({ to: leg('onchain-htlc') })
    const unsent = run(onchain, { do: 'mark_funded' }, { do: 'start_fill' })
    const sent = run(onchain, { do: 'mark_funded' }, { do: 'start_fill', reference: ref('txid') })
    expect([unsent.canAbortFill, sent.canAbortFill]).toEqual([true, false])
    expect(() => sent.apply({ do: 'abort_fill' }, t(9))).toThrow('may still land')
    expect(() => quoted().apply({ do: 'abort_fill' }, t(9))).toThrow(IllegalTransition)
  })
})

describe('an offer', () => {
  it('ends both legs in its one transaction, and has no preimage', () => {
    const filling = run(offer(), { do: 'mark_funded' }, { do: 'start_fill' })
    expect(() => filling.apply({ do: 'mark_filled', preimage: SECRET }, t(9))).toThrow('an offer has no preimage')
    const filled = run(filling, { do: 'mark_offer_filled', reference: ref('fill') })
    expect([filled.state, filled.from.fact('claim'), filled.to.fact('claim')]).toEqual(['settled', 'fill', 'fill'])
  })

  it('is the only swap filled that way, and only while filling', () => {
    expect(() =>
      run(quoted(), { do: 'mark_funded' }, { do: 'start_fill' }).apply({ do: 'mark_offer_filled' }, t(9)),
    ).toThrow(RuleViolated)
    expect(() => offer().apply({ do: 'mark_offer_filled' }, t(9))).toThrow(IllegalTransition)
  })
})

describe('a failed swap', () => {
  const funded = (): Swap => run(quoted(), { do: 'mark_funded' })
  const filling = (): Swap => run(funded(), { do: 'start_fill' })

  it('takes its outcome as its state, and the reason with it', () => {
    const { swap, transition } = funded().apply({ do: 'refuse', reason: 'quote_expired' }, t(9))
    expect([swap.state, swap.outcome, swap.outcomeReason, transition?.reason]).toEqual([
      'refused',
      'refused',
      'quote_expired',
      'quote_expired',
    ])
  })

  it('cannot be refused while our payout is out', () => {
    expect(() => filling().apply({ do: 'refuse', reason: 'x' }, t(9))).toThrow('our payout may be out')
    expect(filling().apply({ do: 'stick', reason: 'x' }, t(9)).swap.state).toBe('stuck')
  })

  it('changes nothing when told its outcome again', () => {
    const refused = run(funded(), { do: 'refuse', reason: 'first' })
    const again = refused.apply({ do: 'refuse', reason: 'second' }, t(9))
    expect([again.swap, again.transition, again.swap.outcomeReason]).toEqual([refused, null, 'first'])
  })

  it('may be judged again only while stuck', () => {
    const stuck = run(filling(), { do: 'stick', reason: 'x' })
    expect(run(stuck, { do: 'mark_lost', reason: 'y' }).state).toBe('lost')
    expect(() => run(stuck, { do: 'mark_lost', reason: 'y' }).apply({ do: 'stick', reason: 'z' }, t(9))).toThrow(
      'already lost',
    )
    expect(() => run(funded(), { do: 'refuse', reason: 'x' }).apply({ do: 'stick', reason: 'z' }, t(9))).toThrow(
      'already refused',
    )
    expect(() =>
      run(quoted(), ...FILLED, { do: 'start_settle' }, { do: 'mark_settled' }).apply(
        { do: 'stick', reason: 'z' },
        t(9),
      ),
    ).toThrow('already settled')
  })

  it('still records what the rails do, so the client lock of a refused swap can go back', () => {
    const released = run(
      funded(),
      { do: 'refuse', reason: 'x' },
      { do: 'start_client_refund' },
      { do: 'mark_client_refunded' },
    )
    expect([released.state, released.from.state]).toEqual(['refused', 'refunded'])
  })

  it('is rearmed once the preimage is known or our payout is back, never before', () => {
    const stuck = run(filling(), { do: 'stick', reason: 'x' })
    expect(() => stuck.apply({ do: 'rearm' }, t(9))).toThrow('no preimage is known')
    expect(() => filling().apply({ do: 'rearm' }, t(9))).toThrow(IllegalTransition)
    const rearmed = run(stuck, { do: 'mark_filled', preimage: SECRET }, { do: 'rearm' })
    expect([rearmed.state, rearmed.outcome, rearmed.outcomeReason]).toEqual(['filled', null, null])
  })
})

describe('a restored swap whose legs disagree', () => {
  const stored = (from: LegState, to: LegState): Swap => {
    const { snapshot } = quoted()
    const at = (side: 'from' | 'to', state: LegState): Leg =>
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
    expect(swap.apply({ do: 'stick', reason: 'operator' }, t(9)).swap.outcomeReason).toBe('operator')
  })

  it('is not refused while its payout may be out, and its fill is not aborted into another contradiction', () => {
    expect(() => stored('pending', 'locked').apply({ do: 'refuse', reason: 'x' }, t(9))).toThrow('may be out')
    expect(() => stored('refunded', 'locking').apply({ do: 'abort_fill' }, t(9))).toThrow('make no sense')
  })
})

describe('each command', () => {
  const awaitingClaim = (): Swap => run(quoted({ to: leg('vhtlc') }), { do: 'mark_funded' }, { do: 'mark_to_locked' })

  it('moves the leg it names and files its reference under the right fact', () => {
    const locked = run(
      quoted({ to: leg('vhtlc') }),
      { do: 'mark_funded' },
      { do: 'mark_to_locked', reference: ref('out') },
    )
    expect([locked.from.state, locked.to.state, locked.to.fact('funding')]).toEqual(['locked', 'locked', 'out'])

    const refunding = run(locked, { do: 'start_refund', reference: ref('back') })
    expect([refunding.from.state, refunding.to.state]).toEqual(['locked', 'refunding'])
    expect([refunding.to.fact('refund'), refunding.to.fact('funding')]).toEqual(['back', 'out'])

    const refunded = run(refunding, { do: 'mark_refunded' })
    expect([refunded.from.state, refunded.to.state, refunded.state]).toEqual(['locked', 'refunded', 'refunded'])

    const filled = run(locked, { do: 'mark_filled', preimage: SECRET, reference: ref('claim') })
    expect(filled.to.fact('claim')).toBe('claim')
  })

  it('keeps the version it was loaded with', () => {
    const stored = Swap.restore(quoted().snapshot, 7)
    expect(run(stored, { do: 'mark_funded' }).version).toBe(7)
  })

  it('reports nothing when a fact is already on record', () => {
    const funded = run(quoted(), { do: 'mark_funded', reference: ref('a') })
    const again = funded.apply({ do: 'record_fact', side: 'from', facts: { funding: ref('a') } }, t(9))
    expect([again.swap, again.transition]).toEqual([funded, null])
  })

  it('is rearmed once our payout is back', () => {
    const back = run(awaitingClaim(), { do: 'stick', reason: 'x' }, { do: 'mark_refunded' }, { do: 'rearm' })
    expect([back.state, back.outcome]).toEqual(['refunded', null])
  })

  it('does not count a failed swap as exposed, nor fill its offer', () => {
    expect(run(awaitingClaim(), { do: 'stick', reason: 'x' }).exposed).toBe(false)
    const stuckOffer = run(offer(), { do: 'mark_funded' }, { do: 'start_fill' }, { do: 'stick', reason: 'x' })
    expect(() => stuckOffer.apply({ do: 'mark_offer_filled' }, t(9))).toThrow(IllegalTransition)
  })
})

describe('refuse', () => {
  const stuck = (...before: Command[]): Swap =>
    run(quoted({ to: leg('vhtlc') }), ...before, { do: 'stick', reason: 'x' })
  const refuse: Command = { do: 'refuse', reason: 'y' }

  it('is turned down on a stuck swap whose payout went out after it stuck', () => {
    const sequences: Command[][] = [
      [{ do: 'start_fill' }],
      [{ do: 'mark_to_locked' }],
      [{ do: 'mark_filled', preimage: SECRET }],
    ]
    for (const after of sequences) expect(() => run(stuck(), ...after).apply(refuse, t(9))).toThrow('may be out')
    const paidAndClientRefunded = run(stuck({ do: 'mark_funded' }, { do: 'start_fill' }), {
      do: 'mark_client_refunded',
    })
    expect(() => paidAndClientRefunded.apply(refuse, t(9))).toThrow('may be out')
  })

  it('is allowed on a stuck swap once nothing of ours is out', () => {
    expect(run(stuck({ do: 'mark_funded' }), refuse).state).toBe('refused')
    const back = run(stuck({ do: 'mark_funded' }, { do: 'mark_to_locked' }), { do: 'mark_refunded' }, refuse)
    expect(back.state).toBe('refused')
  })
})

// Seeded so a failure can be replayed.
const random = (seed: number) => (): number => {
  seed = (seed + 0x6d2b79f5) | 0
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296
}

const COMMANDS: Command[] = [
  { do: 'mark_funding_seen' },
  { do: 'mark_funded', reference: ref('lock') },
  { do: 'start_fill' },
  { do: 'start_fill', reference: ref('pay') },
  { do: 'abort_fill' },
  { do: 'mark_to_locked' },
  { do: 'mark_filled', preimage: SECRET },
  { do: 'mark_filled', preimage: OTHER_SECRET },
  { do: 'start_settle' },
  { do: 'mark_settled' },
  { do: 'start_refund' },
  { do: 'mark_refunded' },
  { do: 'start_client_refund' },
  { do: 'mark_client_refunded' },
  { do: 'mark_offer_filled' },
  { do: 'refuse', reason: 'r' },
  { do: 'mark_lost', reason: 'l' },
  { do: 'stick', reason: 's' },
  { do: 'rearm' },
  { do: 'record_fact', side: 'to', facts: { refund: ref('bump') } },
]

const STARTS: (() => Swap)[] = [
  quoted,
  offer,
  () => quoted({ to: leg('vhtlc'), from: leg('lightning') }),
  () => quoted({ to: leg('onchain-htlc') }),
  () => quoted({ to: leg('evm-htlc') }),
]

describe('any sequence of commands', () => {
  it('keeps every swap in a state that makes sense', () => {
    const next = random(20261123)
    for (let trial = 0; trial < 4_000; trial++) {
      let swap = STARTS[Math.floor(next() * STARTS.length)]!()
      for (let step = 0; step < 25; step++) {
        const command = COMMANDS[Math.floor(next() * COMMANDS.length)]!
        const before = swap
        const snapshot = before.snapshot
        const accepted = before.accepts(command)
        let applied: ReturnType<Swap['apply']> | null = null
        try {
          applied = before.apply(command, t(10 + step))
        } catch (error) {
          expect(error).toBeInstanceOf(DomainError)
        }
        expect(applied !== null, `accepts disagrees with apply on ${command.do}`).toBe(accepted)
        expect(before.snapshot).toBe(snapshot)
        if (applied === null) continue
        swap = applied.swap

        const legs = SwapState.derive(swap.from.state, swap.to.state)
        if (swap.outcome === null)
          expect(legs, `live swap with legs ${swap.from.state}/${swap.to.state}`).not.toBeNull()
        if (swap.preimage !== null) expect(Preimage.opens(swap.preimage, swap.hashlock!)).toBe(true)
        if (before.preimage !== null) expect(swap.preimage).toBe(before.preimage)
        if (swap.to.state === 'claimed' && !swap.isOffer) expect(swap.preimage).not.toBeNull()
        if (swap.from.state === 'claimed' && swap.outcome === null) expect(swap.to.state).toBe('claimed')
        if (before.outcome === 'refused' || before.outcome === 'lost') expect(swap.outcome).toBe(before.outcome)
        if (command.do === 'refuse' && applied.transition !== null)
          expect(['pending', 'refunded']).toContain(before.to.state)
        if (applied.transition !== null) {
          expect([applied.transition.from, applied.transition.to]).toEqual([before.state, swap.state])
        }
      }
    }
  })
})
