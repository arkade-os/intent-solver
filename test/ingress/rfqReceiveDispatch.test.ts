/**
 * Which corridor an `rfq_request` reaches, for the two RECEIVE pairs.
 *
 * Dispatch only — the corridors' own quote logic is tested against their
 * orchestrators. What is easy to get wrong here is routing: before this, both
 * receive pairs fell through to the Lightning-SEND handler and were refused
 * `unsupported_pair`, which looks identical from outside to a solver that
 * simply does not serve them.
 */
import { describe, expect, it, vi } from 'vitest'
import { respondToRfqRequest } from '@arkade-os/solver-transport/ingress/rfq.js'
import { setFrom, type RfqServices } from '../support/corridorSet.js'
import { RFQ_PAIR_RECEIVE } from '@arkade-os/solver-corridors/wire/lightningReceivePayloads.js'
import { RFQ_PAIR_ONCHAIN_RECEIVE } from '@arkade-os/solver-corridors/wire/onchainReceivePayloads.js'

const HEX32 = 'a'.repeat(64)
const XONLY = 'b'.repeat(64)
/** rfq_id is 64 lowercase hex, same shape as every other id on the wire. */
const RFQ_ID = 'd'.repeat(64)

const stores = { store: {} as never, onchainStore: {} as never }

const sendServices = { send: {} as never, onchainSend: {} as never }

const lightningReceivePayload = (over: Record<string, unknown> = {}) => ({
  v: 1,
  type: 'rfq_request',
  rfq_id: RFQ_ID,
  pair: RFQ_PAIR_RECEIVE,
  amount_side: 'to',
  amount: 5000,
  profile: {
    payment_hash: HEX32,
    payout_address: 'tark1qexampleaddress',
    payout_pubkey: XONLY,
    claim_packet: 'sealed-packet',
  },
  ...over,
})

const onchainReceivePayload = () => ({
  v: 1,
  type: 'rfq_request',
  rfq_id: RFQ_ID,
  pair: RFQ_PAIR_ONCHAIN_RECEIVE,
  amount_side: 'to',
  amount: 5000,
  profile: {
    payment_hash: HEX32,
    claim_packet: 'sealed-packet',
    refund_pubkey: XONLY,
    payout_address: 'tark1qexampleaddress',
    payout_pubkey: XONLY,
  },
})

const dispatch = (services: RfqServices, payload: unknown) => respondToRfqRequest(setFrom(services, stores), payload)

describe('rfq dispatch — receive pairs', () => {
  it('routes lightning:BTC->arkade:BTC to the receive service', async () => {
    const quote = vi.fn().mockResolvedValue({ accepted: false, reason: 'provider_at_capacity' })
    const outcome = await dispatch({ ...sendServices, receive: { quote } as never }, lightningReceivePayload())

    expect(quote).toHaveBeenCalledTimes(1)
    expect(quote.mock.calls[0]?.[0]).toMatchObject({
      paymentHash: HEX32,
      amountSats: 5000,
      amountSide: 'to', // the wire's amount_side reaches the corridor verbatim
      payoutPubkey: XONLY,
      claimPacket: 'sealed-packet',
    })
    expect(outcome.kind).toBe('refused')
  })

  it('routes onchain:BTC->arkade:BTC to the onchain receive service', async () => {
    const quote = vi.fn().mockResolvedValue({ accepted: false, reason: 'provider_at_capacity' })
    const outcome = await dispatch({ ...sendServices, onchainReceive: { quote } as never }, onchainReceivePayload())

    expect(quote).toHaveBeenCalledTimes(1)
    expect(quote.mock.calls[0]?.[0]).toMatchObject({ paymentHash: HEX32, refundPubkey: XONLY })
    expect(outcome.kind).toBe('refused')
  })

  /**
   * The reason the absent case is handled by name rather than left to fall
   * through: a solver that does not serve a corridor should say so, and the
   * send handler would otherwise answer for a pair it knows nothing about.
   */
  it('refuses a receive pair by name when that corridor is not served', async () => {
    const outcome = await dispatch(sendServices, lightningReceivePayload())
    expect(outcome.kind).toBe('invalid')
    expect(outcome.payload).toMatchObject({ reason: 'unsupported_pair' })
  })

  it('refuses the onchain receive pair the same way', async () => {
    const outcome = await dispatch(sendServices, onchainReceivePayload())
    expect(outcome.kind).toBe('invalid')
    expect(outcome.payload).toMatchObject({ reason: 'unsupported_pair' })
  })

  it('never reaches the corridor with a payload its schema rejects', async () => {
    const quote = vi.fn()
    const outcome = await dispatch(
      { ...sendServices, receive: { quote } as never },
      lightningReceivePayload({ profile: { payment_hash: 'not-hex' } }),
    )
    expect(quote).not.toHaveBeenCalled()
    expect(outcome.payload).toMatchObject({ reason: 'unsupported_payload' })
  })

  it('passes an accepted quote back as a quote', async () => {
    const quote = vi.fn().mockResolvedValue({
      accepted: true,
      validUntil: 1_800_000_000,
      swap: {
        amountSats: 5000,
        payoutSats: 5000,
        solverPubkey: XONLY,
        refundLocktime: 1_800_003_600,
        paymentHash: HEX32,
        invoice: 'lnbcrt50u1p',
        lockupAddress: 'tark1qlockup',
        solverRefundPkScript: '5120' + 'c'.repeat(64),
      },
    })
    const outcome = await dispatch({ ...sendServices, receive: { quote } as never }, lightningReceivePayload())
    expect(outcome.kind).toBe('quote')
    expect(outcome.payload).toMatchObject({ pair: RFQ_PAIR_RECEIVE, to_amount: 5000 })
  })
})
