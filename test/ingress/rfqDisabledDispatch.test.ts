/**
 * A corridor whose service was never constructed (its `<CORRIDOR>_ENABLED`
 * knob is off — see config.ts's `corridorEnabled`) must refuse its pair BY
 * NAME: `unsupported_pair` is what a solver that does not serve a corridor
 * should say, on all four pairs symmetrically. Before the send legs were made
 * optional, an absent send service fell through to a `TypeError` — over HTTP
 * a 500, over the relay silence with no reply at all.
 */
import { describe, expect, it, vi } from 'vitest'
import { respondToRfqRequest } from '@arkade-os/solver-transport/ingress/rfq.js'
import { setFrom, type RfqServices } from '../support/corridorSet.js'
import { RFQ_PAIR_SEND } from '@arkade-os/solver-corridors/wire/payloads.js'
import { RFQ_PAIR_RECEIVE } from '@arkade-os/solver-corridors/wire/lightningReceivePayloads.js'
import { RFQ_PAIR_ONCHAIN_SEND } from '@arkade-os/solver-corridors/wire/onchainPayloads.js'
import { RFQ_PAIR_ONCHAIN_RECEIVE } from '@arkade-os/solver-corridors/wire/onchainReceivePayloads.js'

const RFQ_ID = 'd'.repeat(64)
const HEX32 = 'a'.repeat(64)
const XONLY = 'b'.repeat(64)

const stores = { store: {} as never, onchainStore: { findByRfqId: async () => null } as never }

const payloadFor = (pair: string) => {
  const base = { v: 1, type: 'rfq_request', rfq_id: RFQ_ID, pair, amount_side: 'to', amount: 5000 }
  if (pair === RFQ_PAIR_SEND) {
    return { ...base, profile: { invoice: 'lnbcrt...', refund_address: 'tark1...', client_refund_pubkey: XONLY } }
  }
  if (pair === RFQ_PAIR_ONCHAIN_SEND) {
    return {
      ...base,
      profile: { payment_hash: HEX32, payout_pubkey: XONLY, refund_address: 'tark1...', client_refund_pubkey: XONLY },
    }
  }
  if (pair === RFQ_PAIR_RECEIVE) {
    return {
      ...base,
      profile: { payment_hash: HEX32, payout_address: 'tark1...', payout_pubkey: XONLY, claim_packet: 'sealed' },
    }
  }
  return {
    ...base,
    profile: {
      payment_hash: HEX32,
      claim_packet: 'sealed',
      refund_pubkey: XONLY,
      payout_address: 'tark1...',
      payout_pubkey: XONLY,
    },
  }
}

describe('rfq dispatch — a corridor with no service refuses by name', () => {
  it.each([RFQ_PAIR_SEND, RFQ_PAIR_ONCHAIN_SEND, RFQ_PAIR_RECEIVE, RFQ_PAIR_ONCHAIN_RECEIVE])(
    'refuses %s as unsupported_pair when its service is absent',
    async (pair) => {
      const outcome = await respondToRfqRequest(setFrom({}, stores), payloadFor(pair))
      expect(outcome.kind).toBe('invalid')
      expect(outcome.payload).toMatchObject({ type: 'rfq_refusal', rfq_id: RFQ_ID, reason: 'unsupported_pair' })
    },
  )

  it('still serves the corridors that ARE present', async () => {
    const quote = vi.fn().mockResolvedValue({ accepted: false, reason: 'provider_at_capacity' })
    const services: RfqServices = { onchainSend: { quote } as never }
    const outcome = await respondToRfqRequest(setFrom(services, stores), payloadFor(RFQ_PAIR_ONCHAIN_SEND))
    expect(quote).toHaveBeenCalledTimes(1)
    expect(outcome.kind).toBe('refused')
    expect(outcome.payload).toMatchObject({ reason: 'exposure_cap' })
  })
})
