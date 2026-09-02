/**
 * A switched-off corridor refuses its pair BY NAME and quotes nothing.
 *
 * The dispatch tests next door prove routing when a corridor is present. This
 * proves the other half: absent means refused, for all four pairs rather than
 * only the two that happened to be optional first.
 *
 * The assertion that matters is `quote` never being called. A refusal payload
 * alone would not prove much — the send handler also answers `unsupported_pair`
 * for a pair it does not recognise, so a disabled corridor that still reached
 * its service and failed later would look identical from the payload alone.
 */

import { describe, expect, it, vi } from 'vitest'
import { respondToRfqRequest } from '@arkade-os/solver-transport/ingress/rfq.js'
import { setFrom, type RfqServices } from '../support/corridorSet.js'
import { RFQ_PAIR_RECEIVE } from '@arkade-os/solver-corridors/wire/lightningReceivePayloads.js'
import { RFQ_PAIR_ONCHAIN_RECEIVE } from '@arkade-os/solver-corridors/wire/onchainReceivePayloads.js'
import { RFQ_PAIR_ONCHAIN_SEND } from '@arkade-os/solver-corridors/wire/onchainPayloads.js'
import { RFQ_PAIR_SEND } from '@arkade-os/solver-corridors/wire/payloads.js'

const HEX32 = 'a'.repeat(64)
const XONLY = 'b'.repeat(64)
const RFQ_ID = 'd'.repeat(64)
const stores = { store: {} as never, onchainStore: {} as never }

/** A payload per pair, each shaped well enough that only the toggle can refuse it. */
const payloadFor = (pair: string) => ({
  v: 1,
  type: 'rfq_request',
  rfq_id: RFQ_ID,
  pair,
  amount_side: 'to',
  amount: 5000,
  profile: {
    payment_hash: HEX32,
    payout_address: 'tark1qexampleaddress',
    payout_pubkey: XONLY,
    claim_packet: 'sealed-packet',
    refund_pubkey: XONLY,
    invoice: 'lnbcrt1',
    refund_address: 'tark1qexampleaddress',
    client_refund_pubkey: XONLY,
  },
})

const dispatch = (services: RfqServices, payload: unknown) => respondToRfqRequest(setFrom(services, stores), payload)

/** Every corridor, by the key it occupies in `RfqServices` and the pair it serves. */
const CORRIDORS = [
  ['send', RFQ_PAIR_SEND],
  ['onchainSend', RFQ_PAIR_ONCHAIN_SEND],
  ['receive', RFQ_PAIR_RECEIVE],
  ['onchainReceive', RFQ_PAIR_ONCHAIN_RECEIVE],
] as const

describe('rfq dispatch — a disabled corridor', () => {
  it.each(CORRIDORS)('refuses %s by name and never reaches a service', async (_key, pair) => {
    // Every OTHER corridor is present, so a refusal cannot come from the
    // dispatch falling through to a missing neighbour.
    const quote = vi.fn()
    const services = Object.fromEntries(
      CORRIDORS.filter(([k]) => k !== _key).map(([k]) => [k, { quote } as never]),
    ) as RfqServices

    const outcome = await dispatch(services, payloadFor(pair))

    expect(outcome.kind).toBe('invalid')
    expect(outcome.payload).toMatchObject({ type: 'rfq_refusal', reason: 'unsupported_pair', rfq_id: RFQ_ID })
    expect(quote).not.toHaveBeenCalled()
  })

  it('answers nothing at all when every corridor is off', async () => {
    const outcome = await dispatch({}, payloadFor(RFQ_PAIR_SEND))
    expect(outcome.kind).toBe('invalid')
    expect(outcome.payload).toMatchObject({ reason: 'unsupported_pair' })
  })

  it('still carries the requester’s correlation id, so the refusal names which negotiation it killed', async () => {
    const outcome = await dispatch({}, payloadFor(RFQ_PAIR_ONCHAIN_RECEIVE))
    expect(outcome.payload).toMatchObject({ rfq_id: RFQ_ID })
  })
})
