/**
 * That an EVM pair never reaches the Lightning handler.
 *
 * The ingress dispatches on pair CONSTANTS for the four BTC corridors, with the
 * Lightning send handler as the fall-through. An EVM pair cannot be a constant —
 * it carries the token address — so without an arm of its own it lands in that
 * fall-through, and the client asking for `arkade:BTC->ethereum:0x…` is answered
 * by the Lightning corridor complaining about an invoice it never sent.
 *
 * That is a wrong answer rather than a missing feature, which is why it is worth
 * closing before the quote handlers exist.
 */

import { describe, it, expect, vi } from 'vitest'
import { evmDirectionOf } from '@arkade-os/solver-core/core/corridorPolicy.js'
import { respondToRfqRequest } from '@arkade-os/solver-transport/ingress/rfq.js'
import { createCorridorSet, type Corridor } from '@arkade-os/solver-core/core/corridor.js'
import { RFQ_PAIR_SEND, rfqRefusalPayload } from '@arkade-os/solver-corridors/wire/payloads.js'

const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

describe('evmDirectionOf', () => {
  it('names the send direction', () => {
    expect(evmDirectionOf(`arkade:BTC->ethereum:${TOKEN}`)).toBe('send')
  })

  it('names the receive direction', () => {
    expect(evmDirectionOf(`ethereum:${TOKEN}->arkade:BTC`)).toBe('receive')
  })

  it.each([
    ['a lightning pair', 'arkade:BTC->lightning:BTC'],
    ['an onchain pair', 'onchain:BTC->arkade:BTC'],
    ['an arkade asset pair', 'arkade:BTC->arkade:USDT'],
    ['an empty string', ''],
    ['nonsense', 'not-a-pair'],
  ])('is null for %s', (_why, pair) => {
    expect(evmDirectionOf(pair)).toBeNull()
  })

  it.each([
    ['an uppercase address, which is not the canonical spelling', `arkade:BTC->ethereum:${TOKEN.toUpperCase()}`],
    ['a short address', 'arkade:BTC->ethereum:0xdead'],
    ['no 0x prefix', `arkade:BTC->ethereum:${TOKEN.slice(2)}`],
    ['a token on the wrong side', `arkade:${TOKEN}->ethereum:BTC`],
  ])('refuses %s rather than matching loosely', (_why, pair) => {
    // A loose match here is worse than no match: it would route a malformed
    // pair into a corridor that then quotes against a token id it cannot serve.
    expect(evmDirectionOf(pair)).toBeNull()
  })
})

describe('the ingress', () => {
  const sendQuote = vi.fn()
  // A stand-in Lightning-send corridor, registered so the fall-through arm can
  // be proven against it: an EVM pair must be refused WITHOUT the dispatcher
  // ever reaching this corridor's quote.
  const lightningSend = {
    descriptor: {
      pair: RFQ_PAIR_SEND,
      envStem: 'LN_SEND',
      payoutRail: 'lightning',
      states: { live: ['quoted'], exposed: [], delivered: ['claimed'] },
    },
    statusFor: async () => null,
    findRecoverable: async () => [],
    committedSats: async () => 0,
    page: async () => ({ swaps: [], nextCursor: null }),
    detail: async () => null,
    close: async () => {},
    quote: sendQuote,
    tick: async () => {},
    tickAll: async () => 0,
  } as unknown as Corridor
  const corridors = createCorridorSet([lightningSend])

  const ask = (pair: string) =>
    respondToRfqRequest(corridors, {
      v: 1,
      type: 'rfq_request',
      rfq_id: 'a'.repeat(64),
      pair,
      amount_side: 'from',
      amount: 50_000,
      profile: {},
    })

  it.each([
    ['send', `arkade:BTC->ethereum:${TOKEN}`],
    ['receive', `ethereum:${TOKEN}->arkade:BTC`],
  ])('refuses an EVM %s pair by name instead of handing it to Lightning', async (_dir, pair) => {
    sendQuote.mockReset()
    const outcome = await ask(pair)
    expect(outcome.kind).toBe('invalid')
    expect(JSON.stringify(outcome)).toMatch(/unsupported_pair/)
    // THE POINT: the Lightning corridor was never consulted. An unregistered
    // pair answers by name without touching any other corridor.
    expect(sendQuote).not.toHaveBeenCalled()
  })

  it('still lets a Lightning pair through to its own handler', async () => {
    // Asserted on the REFUSAL REASON rather than on `quote` being called: this
    // minimal payload has no send profile, so the Lightning handler rejects it
    // as `unsupported_payload` before it ever reaches a quote. That reason is
    // itself the evidence — only that handler can produce it.
    sendQuote.mockReset()
    sendQuote.mockResolvedValue({ kind: 'invalid', payload: rfqRefusalPayload(undefined, 'unsupported_payload') })
    const outcome = await ask('arkade:BTC->lightning:BTC')
    expect(JSON.stringify(outcome)).toMatch(/unsupported_payload/)
    expect(JSON.stringify(outcome)).not.toMatch(/unsupported_pair/)
  })
})
