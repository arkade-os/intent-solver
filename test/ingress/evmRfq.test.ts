/**
 * The EVM RFQ handlers: payload in, quote or refusal out.
 *
 * The schemas are where a client's request stops being arbitrary JSON, so what
 * matters here is what they REFUSE. In particular the token amount is a string
 * — an ERC20 amount is 256-bit and a JSON number is exact only to 2^53, which
 * at 18 decimals is 0.009 tokens — and exact-out is refused at the schema
 * rather than deeper, because inverting a fetched rate is a different problem
 * from applying a fee.
 */

import { describe, it, expect, vi } from 'vitest'
import { respondToRfqRequest } from '@arkade-os/solver-transport/ingress/rfq.js'
import { createCorridorSet } from '@arkade-os/solver-core/core/corridor.js'
import { evmCorridorFor } from '@arkade-os/solver-core/core/corridorPolicy.js'
import type { EvmCorridorPolicy } from '@arkade-os/solver-core/core/evmCorridorConfig.js'
import { evmReceiveCorridor, evmSendCorridor } from '@arkade-os/solver-corridors-evm/corridors/evmCorridors.js'

const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const SEND_PAIR = `arkade:BTC->ethereum:${TOKEN}`
const RECEIVE_PAIR = `ethereum:${TOKEN}->arkade:BTC`
const HEX = (b: string) => b.repeat(32)

/** One served corridor per direction, as the registry would hold it. */
const policy = (direction: 'send' | 'receive'): EvmCorridorPolicy => ({
  corridor: evmCorridorFor(TOKEN, direction),
  token: { symbol: 'USDC', address: TOKEN, decimals: 6 },
  direction,
  limits: { minSats: 1, maxSats: 1_000_000 },
  fee: { bps: 100, flatSats: 0 },
  enabled: true,
})

const row = (over: Record<string, unknown> = {}) => ({
  tokenAddress: TOKEN,
  amountSats: 100_000,
  payoutSats: 99_000,
  evmAmount: '49500000',
  providerPubkey: HEX('aa'),
  refundLocktime: 1_800_090_000,
  validUntil: 1_800_000_060,
  lockupAddress: 'tark1lockup',
  evmTimeout: 20_000_500,
  evmContractAddress: '0x' + 'de'.repeat(20),
  evmChainId: 8453,
  evmClaimAddress: '0x' + '99'.repeat(20),
  minConfirmations: 12,
  minAgeSeconds: 780,
  ...over,
})

const ask = (payload: unknown, quote = vi.fn()) => {
  const corridors = createCorridorSet([
    evmSendCorridor(policy('send'), { quote } as never, {} as never),
    evmReceiveCorridor(policy('receive'), { quote } as never, {} as never),
  ])
  return respondToRfqRequest(corridors, payload)
}

const sendRequest = (over: Record<string, unknown> = {}, profile: Record<string, unknown> = {}) => ({
  v: 1,
  type: 'rfq_request',
  rfq_id: HEX('ab'),
  pair: SEND_PAIR,
  amount_side: 'from',
  amount: 100_000,
  profile: {
    payment_hash: HEX('cd'),
    evm_claim_address: '0x' + '11'.repeat(20),
    refund_address: 'tark1refund',
    client_refund_pubkey: HEX('ef'),
    ...profile,
  },
  ...over,
})

const receiveRequest = (over: Record<string, unknown> = {}, profile: Record<string, unknown> = {}) => ({
  v: 1,
  type: 'rfq_request',
  rfq_id: HEX('ab'),
  pair: RECEIVE_PAIR,
  amount_side: 'from',
  profile: {
    payment_hash: HEX('cd'),
    evm_amount: '50000000',
    evm_timeout_block: 20_000_500,
    evm_refund_address: '0x' + '11'.repeat(20),
    payout_address: 'tark1payout',
    payout_pubkey: HEX('12'),
    ...profile,
  },
  ...over,
})

describe('the send handler', () => {
  it('quotes, and answers in the pair that was asked for', async () => {
    const quote = vi.fn().mockResolvedValue({ accepted: true, swap: row() })
    const outcome = await ask(sendRequest(), quote)
    expect(outcome.kind).toBe('quote')
    const payload = outcome.payload as Record<string, unknown>
    expect(payload.pair).toBe(SEND_PAIR)
    // Different assets on the two sides, so the token figure stays a string.
    expect(payload.from_amount).toBe(100_000)
    expect(payload.to_amount).toBe('49500000')
  })

  it('reads the token from the PAIR, not from the profile', async () => {
    // One source. A profile field naming a second token could disagree with the
    // pair the market key is derived from.
    const quote = vi.fn().mockResolvedValue({ accepted: true, swap: row() })
    await ask(sendRequest(), quote)
    expect(quote.mock.calls[0]![0].tokenAddress).toBe(TOKEN)
  })

  it.each([
    // The wire has a CLOSED set of eight reasons and maps internal ones onto
    // it; anything unmapped degrades to `unsupported_payload`. So an EVM reason
    // that is not in the table reaches the client as "your payload was wrong",
    // which for a token we do not serve or a feed that is down is a lie.
    ['unsupported_token', 'unsupported_pair'],
    ['price_unavailable', 'pricing_unavailable'],
    ['provider_at_capacity', 'exposure_cap'],
    ['amount_out_of_range', 'amount_out_of_range'],
    ['duplicate_swap', 'quote_conflict'],
    ['fee_consumes_swap', 'pricing_unavailable'],
    ['deadlines_cannot_be_ordered', 'pricing_unavailable'],
  ])('maps the internal refusal %s onto the wire reason %s', async (internal, wire) => {
    const quote = vi.fn().mockResolvedValue({ accepted: false, reason: internal })
    const outcome = await ask(sendRequest(), quote)
    expect(outcome.kind).toBe('refused')
    expect((outcome.payload as Record<string, unknown>).reason).toBe(wire)
  })

  it('refuses exact-out AT THE SCHEMA, before anything is built', async () => {
    // The `to` leg is a different asset, so exact-out means inverting a fetched,
    // rounded, directional rate. The client should hear that immediately.
    const quote = vi.fn()
    const outcome = await ask(sendRequest({ amount_side: 'to' }), quote)
    expect(JSON.stringify(outcome.payload)).toMatch(/unsupported_payload/)
    expect(quote).not.toHaveBeenCalled()
  })

  it.each([
    ['an unknown profile field', { extra: 1 }],
    ['a non-hex payment hash', { payment_hash: 'zz'.repeat(32) }],
    ['a malformed claim address', { evm_claim_address: '0xnothex' }],
  ])('refuses %s', async (_why, profile) => {
    const quote = vi.fn()
    const outcome = await ask(sendRequest({}, profile), quote)
    expect(JSON.stringify(outcome.payload)).toMatch(/unsupported_payload/)
    expect(quote).not.toHaveBeenCalled()
  })
})

describe('the receive handler', () => {
  it('quotes, with the token on the FROM side', async () => {
    const quote = vi.fn().mockResolvedValue({ accepted: true, swap: row() })
    const outcome = await ask(receiveRequest(), quote)
    expect(outcome.kind).toBe('quote')
    const payload = outcome.payload as Record<string, unknown>
    expect(payload.pair).toBe(RECEIVE_PAIR)
    expect(payload.from_amount).toBe('49500000')
    expect(payload.to_amount).toBe(99_000)
  })

  it('carries the client’s own evm_timeout_block through to the quote', async () => {
    // The client chooses it on this leg; the solver validates rather than
    // substitutes.
    const quote = vi.fn().mockResolvedValue({ accepted: true, swap: row() })
    await ask(receiveRequest(), quote)
    expect(quote.mock.calls[0]![0].evmTimeout).toBe(20_000_500)
  })

  it.each([
    ['a JSON number, which cannot hold a 256-bit amount', 50_000_000],
    ['a fraction', '1.5'],
    ['exponent form', '1e18'],
    ['a leading zero', '0100'],
    ['a negative', '-1'],
  ])('refuses %s as evm_amount', async (_why, evm_amount) => {
    const quote = vi.fn()
    const outcome = await ask(receiveRequest({}, { evm_amount }), quote)
    expect(JSON.stringify(outcome.payload)).toMatch(/unsupported_payload/)
    expect(quote).not.toHaveBeenCalled()
  })

  it('refuses an envelope amount, which would be in the wrong asset', async () => {
    // The receive leg's amount lives in the profile because it is the TOKEN's.
    // A sats `amount` alongside it is a client that has misread the corridor.
    const quote = vi.fn()
    const outcome = await ask(receiveRequest({ amount: 100_000 }), quote)
    expect(JSON.stringify(outcome.payload)).toMatch(/unsupported_payload/)
    expect(quote).not.toHaveBeenCalled()
  })
})
