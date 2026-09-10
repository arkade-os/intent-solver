import { describe, it, expect } from 'vitest'
import { outcomeOfTransition, percentChange, formatSats } from '@arkade-os/solver-core/core/businessEvent.js'

// The real shipped vocabularies, not invented ones.
const LN_SEND = {
  live: ['quoted', 'funded', 'paying', 'paid', 'claiming'],
  exposed: ['paying', 'paid', 'claiming'],
  delivered: ['claimed'],
}
const LN_RECEIVE = {
  live: ['quoted', 'armed', 'funded', 'claimed', 'refunding'],
  exposed: ['funded', 'claimed', 'refunding'],
  delivered: ['settled'],
}

describe('outcomeOfTransition', () => {
  it('says nothing about a transition that is still in flight', () => {
    expect(outcomeOfTransition(LN_SEND, 'quoted', 'funded')).toBeNull()
    expect(outcomeOfTransition(LN_SEND, 'funded', 'paying')).toBeNull()
  })

  it('reports fulfilled on the corridor-declared delivered state', () => {
    expect(outcomeOfTransition(LN_SEND, 'claiming', 'claimed')).toBe('fulfilled')
  })

  it('reports failed on every other terminal state', () => {
    expect(outcomeOfTransition(LN_SEND, 'funded', 'refused')).toBe('failed')
    expect(outcomeOfTransition(LN_SEND, 'paying', 'stuck')).toBe('failed')
  })

  // `claimed` is DELIVERED on the send leg and merely LIVE on the receive one.
  it('reads the same word differently per corridor, as declared', () => {
    expect(outcomeOfTransition(LN_SEND, 'claiming', 'claimed')).toBe('fulfilled')
    expect(outcomeOfTransition(LN_RECEIVE, 'funded', 'claimed')).toBeNull()
    expect(outcomeOfTransition(LN_RECEIVE, 'claimed', 'settled')).toBe('fulfilled')
  })

  // A refund ended safely but did not deliver.
  it('reports a refund as failed, matching phaseOfStates', () => {
    expect(outcomeOfTransition(LN_RECEIVE, 'refunding', 'refunded')).toBe('failed')
  })

  it('treats a state it has never heard of as failed, never as fulfilled', () => {
    expect(outcomeOfTransition(LN_SEND, 'funded', 'invented')).toBe('failed')
  })
})

describe('percentChange', () => {
  it('is n/a with no previous reading — the first event after a deploy', () => {
    expect(percentChange(null, 1_000)).toBe('n/a')
  })

  // The divide-by-zero: "+Infinity%" is worse than saying nothing.
  it('is n/a when the previous reading was zero', () => {
    expect(percentChange(0, 1_000)).toBe('n/a')
  })

  it('signs an increase and a decrease', () => {
    expect(percentChange(1_000, 1_100)).toBe('+10.00%')
    expect(percentChange(1_000, 900)).toBe('-10.00%')
  })

  it('reports no movement as +0.00% rather than n/a', () => {
    expect(percentChange(1_000, 1_000)).toBe('+0.00%')
  })

  it('handles a fall to zero', () => {
    expect(percentChange(1_000, 0)).toBe('-100.00%')
  })

  it('rounds to two places rather than printing a float', () => {
    expect(percentChange(3, 4)).toBe('+33.33%')
  })
})

describe('formatSats', () => {
  it('groups digits so a big number is readable at a glance', () => {
    expect(formatSats(1_234_567)).toBe('1,234,567')
    expect(formatSats(0)).toBe('0')
  })
})
