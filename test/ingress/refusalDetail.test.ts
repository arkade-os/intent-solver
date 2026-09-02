/**
 * A refused request has to leave a trace, and it has to be the RIGHT trace.
 *
 * The closed RFQ vocabulary is coarse on purpose — six distinct faults on the
 * Lightning send leg reach the client as `unsupported_payload`, and that is the
 * contract. The cost was diagnosis: a refusal is an ANSWER rather than an
 * exception, so nothing reached `onError` and the service logged nothing at
 * all. On 2026-08-21 a wallet reported `solver refused: unsupported_payload`
 * and the only other copy of which check fired was inside that wallet.
 *
 * So `detail` rides beside the payload. These tests pin the two properties
 * that make it worth having: it DISTINGUISHES the exits (a detail that said
 * "invalid" for all six would be no better than the log we had), and it never
 * carries a value — an invoice, an address or a pubkey — only field names and
 * check names.
 */

import { describe, it, expect } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { respondToRfqRequest } from '@arkade-os/solver-transport/ingress/rfq.js'
import { setFrom, type RfqServices } from '../support/corridorSet.js'
import type { SendSwapService } from '@arkade-os/solver-corridors/send/orchestrator.js'
import type { SwapStore } from '@arkade-os/solver-corridors/db/swaps.js'

const INVOICE =
  'lnbc21u1pnk8larsp526g88ejh9ac0es9j6juxwenzdzvs6hcrphna5pp3jefpukmtk3hqpp5m206npk0fr6k45u8f90capqw48k3pzymlqhk0j98kyx4mz383pkqdz9235x2gr3w45kx6eqvfex7amwypnx77pqdf6k6urnyphhvetjyp6xsefqd3sh57fqv3hkwxqyp2xqcqz95rzjqv9ruzr6quwpsuwmyshlvenk0xm7djrtt8ugt2ja6cx3dkqtccdgvzzxeyqq28qqqqqqqqqqqqqqq9gq2y9qyysgqvu5k5w9q0xe62envhds058r9h8v5uak09hn3uzlw39sqkcuwh34j44gc53j6x6sg0u6yf6l0durxqqekytupxpf66zc7rc9cpav72ssqpcgv3p'
const REFUND_ADDRESS = 'ark1secretlookingrefundaddressvalue'
const CLIENT_REFUND_PUBKEY = hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(20)))
const RFQ_ID = 'a1'.repeat(32)

/** Every exit under test returns before either is touched. */
const services = { send: {} as SendSwapService } as RfqServices
const store = {} as SwapStore
const onchainStore = {} as never

const request = (over: Record<string, unknown> = {}, profileOver: Record<string, unknown> = {}) => ({
  v: 1,
  type: 'rfq_request',
  rfq_id: RFQ_ID,
  pair: 'arkade:BTC->lightning:BTC',
  amount_side: 'to',
  profile: {
    invoice: INVOICE,
    refund_address: REFUND_ADDRESS,
    client_refund_pubkey: CLIENT_REFUND_PUBKEY,
    ...profileOver,
  },
  ...over,
})

const refuse = (payload: unknown) => respondToRfqRequest(setFrom(services, { store, onchainStore }), payload)

describe('a refusal says which check fired', () => {
  it('names an unknown top-level field, because the schema is strict', async () => {
    const outcome = await refuse(request({ extra_field: 1 }))
    expect(outcome.kind).toBe('invalid')
    expect(outcome.detail).toContain('unrecognized_keys')
    expect(outcome.detail).toContain('extra_field')
  })

  it('names an unknown field inside the profile', async () => {
    const outcome = await refuse(request({}, { note: 'hi' }))
    expect(outcome.detail).toContain('profile')
    expect(outcome.detail).toContain('note')
  })

  it('names client_refund_pubkey when it is the wrong length', async () => {
    // A 33-byte compressed key hex-encodes to 66 chars; the schema wants the
    // 32-byte x-only form. The reference client hex-encodes whatever bytes it
    // is handed, so this is the shape a caller actually gets wrong.
    const outcome = await refuse(request({}, { client_refund_pubkey: `02${CLIENT_REFUND_PUBKEY}` }))
    expect(outcome.detail).toContain('profile.client_refund_pubkey')
  })

  it('distinguishes amount_side from every other payload fault', async () => {
    const outcome = await refuse(request({ amount_side: 'from' }))
    expect(outcome.detail).toContain('amount_side')
    expect(outcome.detail).toContain("must be 'to'")
  })

  it('reports both amounts when the restated amount disagrees with the invoice', async () => {
    const outcome = await refuse(request({ amount: 999_999 }))
    expect(outcome.detail).toContain('999999')
    expect(outcome.detail).toContain('2100')
  })

  it('calls an unserved pair a pair fault, not a payload one', async () => {
    const outcome = await refuse(request({ pair: 'dogecoin:DOGE->lightning:BTC' }))
    expect(outcome.detail).toContain('dogecoin:DOGE->lightning:BTC')
    expect(outcome.detail).toContain('not served')
  })

  it('gives each exit a DIFFERENT detail', async () => {
    const details = await Promise.all(
      [
        request({ extra_field: 1 }),
        request({ amount_side: 'from' }),
        request({ amount: 999_999 }),
        request({ pair: 'dogecoin:DOGE->lightning:BTC' }),
        request({}, { client_refund_pubkey: 'nothex' }),
      ].map(async (payload) => (await refuse(payload)).detail),
    )
    expect(new Set(details).size).toBe(details.length)
  })
})

describe('a refusal never logs a value', () => {
  it('keeps the invoice, the refund address and the pubkey out of the detail', async () => {
    for (const payload of [
      request({ extra_field: 1 }),
      request({ amount_side: 'from' }),
      request({ amount: 999_999 }),
      request({}, { client_refund_pubkey: `02${CLIENT_REFUND_PUBKEY}` }),
    ]) {
      const { detail = '' } = await refuse(payload)
      expect(detail).not.toContain(INVOICE)
      expect(detail).not.toContain(REFUND_ADDRESS)
      expect(detail).not.toContain(CLIENT_REFUND_PUBKEY)
    }
  })

  it('never puts the detail on the wire', async () => {
    const outcome = await refuse(request({ extra_field: 1 }))
    expect(outcome.detail).toBeTruthy()
    expect(JSON.stringify(outcome.payload)).not.toContain('extra_field')
    expect(Object.keys(outcome.payload)).not.toContain('detail')
  })
})
