/**
 * What a solver answers when asked for a corridor it does not serve.
 *
 * ## The failure this closes
 *
 * `respondToRfqRequest` dispatched three pairs by name and let everything else
 * fall through to the lightning-send handler. That handler parses against a
 * schema built for a BOLT11 profile BEFORE it checks the pair, so an unknown
 * pair failed the schema and came back `unsupported_payload` — telling a client
 * its message was malformed when the message was fine and the corridor was the
 * problem.
 *
 * The dispatch's own comment says this is what it exists to prevent:
 *
 *   > "this solver does not serve that corridor" is a different fact from
 *   > "that pair does not exist"
 *
 * and the fall-through quietly broke it for every pair the list did not name.
 *
 * ## Why it was invisible
 *
 * The answer depended on unrelated configuration. A deployment with no send
 * service hit `if (!services.send) return unsupported()` and answered
 * `unsupported_pair`, correctly. Every deployment that DID serve lightning send
 * — which is every normal one — answered wrongly. So a test written against a
 * minimal fixture would have passed while production misreported.
 *
 * ## Why it matters now
 *
 * `arkade:BTC->arkade:<asset>` is the next pair to be added, and until its
 * handler lands it is exactly an unknown pair. A client probing for asset
 * support would be told its payload was bad and would retry different payloads
 * forever, never learning the corridor is simply not served yet.
 */

import { describe, it, expect } from 'vitest'
import { respondToRfqRequest } from '@arkade-os/solver-transport/ingress/rfq.js'
import { setFrom } from '../support/corridorSet.js'

const request = (pair?: string): Record<string, unknown> => ({
  v: 1,
  type: 'rfq_request',
  rfq_id: 'a'.repeat(16),
  ...(pair === undefined ? {} : { pair }),
  amount: 1_000,
  amount_side: 'from',
})

const reasonFor = async (services: unknown, payload: unknown): Promise<unknown> => {
  const outcome = await respondToRfqRequest(setFrom(services as never), payload)
  return (outcome.payload as { reason?: unknown }).reason
}

/** A deployment that serves lightning send — i.e. the ordinary case. */
const WITH_SEND = { send: {} as never }

describe('a pair this solver does not serve', () => {
  it.each([
    ['the asset corridor, not yet served', 'arkade:BTC->arkade:USD'],
    ['an asset-to-asset pair', 'arkade:USD->arkade:EUR'],
    ['a corridor on another chain', 'arkade:BTC->ethereum:0xa0b8'],
    ['a rail that does not exist', 'arkade:BTC->liquid:BTC'],
    ['a reversed known pair', 'lightning:BTC->onchain:BTC'],
  ])('answers unsupported_pair for %s', async (_why, pair) => {
    expect(await reasonFor(WITH_SEND, request(pair))).toBe('unsupported_pair')
  })

  /**
   * The regression, stated as the property rather than as one example: the
   * answer must not depend on what else the deployment happens to serve.
   *
   * This is the assertion that would have failed before the fix — and only on
   * the `WITH_SEND` side, which is the one production runs.
   */
  it('answers the same whether or not a send service is configured', async () => {
    const pair = 'arkade:BTC->arkade:USD'
    const withSend = await reasonFor(WITH_SEND, request(pair))
    const without = await reasonFor({}, request(pair))
    expect(withSend).toBe(without)
    expect(withSend).toBe('unsupported_pair')
  })

  /**
   * The distinction the fix preserves rather than flattens.
   *
   * A MISSING `pair` is not a corridor fact — the field is required, so the
   * message really is malformed, and calling that `unsupported_pair` would be
   * the same category error in the opposite direction. It still reaches the
   * schema, which reports it as the payload fault it is.
   */
  it('still calls a missing pair a payload fault, not a corridor one', async () => {
    expect(await reasonFor(WITH_SEND, request(undefined))).toBe('unsupported_payload')
  })

  /**
   * The control. Every assertion above expects a refusal, so a dispatch that
   * refused EVERYTHING would satisfy them all. A served pair must still reach
   * its handler rather than being swept up by the new check.
   */
  it('does not refuse a pair it does serve', async () => {
    // No send service configured, so this returns `unsupported_pair` for the
    // absent-service reason — but it proves the send pair is not caught by the
    // unknown-pair branch, which would be indistinguishable if the reason were
    // all we looked at. The `{}` services case reaching the SAME line is the
    // point: `RFQ_PAIR_SEND` passes the new guard and fails only on the service.
    const served = await reasonFor({}, request('arkade:BTC->lightning:BTC'))
    expect(served).toBe('unsupported_pair')
    // And with the service present it is NOT refused as an unknown pair — it
    // gets as far as the handler, whose schema then has its say.
    expect(await reasonFor(WITH_SEND, request('arkade:BTC->lightning:BTC'))).toBe('unsupported_payload')
  })
})
