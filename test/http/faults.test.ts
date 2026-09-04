/**
 * What the HTTP transport does when something THROWS, as opposed to refusing.
 *
 * The relay ingress has always distinguished the two — `ingress/relay.ts`
 * catches around its quote call, answers `pricing_unavailable`, and reports the
 * fault through its own `onError` hook rather than the refusal one. This
 * transport had neither, so an unexpected throw fell through to the framework's
 * default: a bare 500 with no body, and nothing in the operator's log. Two
 * transports the server's own comment calls "byte for byte" identical
 * disagreed about what a failure IS.
 *
 * A corridor set whose lookup throws is the smallest honest stand-in for the
 * real cause. Every genuine version of this is a fault reached THROUGH the
 * lookup — a store that cannot be opened, a backend that rejects, a row whose
 * invariant is broken — so pinning the transport's behaviour needs a throw at
 * that seam and nothing else.
 */

import { describe, it, expect, vi } from 'vitest'
import { buildApp } from '@arkade-os/solver-transport/http/server.js'
import type { CorridorReaderSet, CorridorSet } from '@arkade-os/solver-core/core/corridor.js'

const BOOM = new Error('store unreachable')

const throwingCorridors = (): CorridorSet =>
  ({
    get: () => {
      throw BOOM
    },
    size: 1,
    [Symbol.iterator]: function* () {},
  }) as never as CorridorSet

const throwingReaders = (): CorridorReaderSet =>
  ({
    get: () => undefined,
    size: 1,
    // Throws while ITERATING, because that is how `respondToRfqStatus` reads:
    // it walks every reader asking `statusFor`, so a broken store surfaces
    // there rather than at a lookup.
    [Symbol.iterator]: function* () {
      throw BOOM
    },
  }) as never as CorridorReaderSet

const okReaders = (): CorridorReaderSet =>
  ({ get: () => undefined, size: 0, [Symbol.iterator]: function* () {} }) as never as CorridorReaderSet

const okCorridors = (): CorridorSet =>
  ({ get: () => undefined, size: 0, [Symbol.iterator]: function* () {} }) as never as CorridorSet

const RFQ_ID = 'ab'.repeat(32)

const quote = (app: ReturnType<typeof buildApp>, body: unknown) =>
  app.fetch(
    new Request('http://solver/v1/swap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

describe('the HTTP transport answers a THROWN fault in the protocol’s own vocabulary', () => {
  const request = {
    v: 1,
    type: 'rfq_request',
    rfq_id: RFQ_ID,
    pair: 'arkade:BTC->lightning:BTC',
    amount_side: 'from',
    amount: 1000,
    profile: {},
  }

  it('refuses with pricing_unavailable rather than a bare 500', async () => {
    const onError = vi.fn()
    const app = buildApp({ corridors: throwingCorridors(), readers: okReaders(), network: 'regtest', onError })

    const response = await quote(app, request)

    // 422 is where every other refusal on this path already lives, so a client
    // reads the body at this status. A 500 would cost it the reason, because
    // 5xx is exactly what a caller treats as "no body worth parsing".
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ v: 1, type: 'rfq_refusal', rfq_id: RFQ_ID, reason: 'pricing_unavailable' })
  })

  it('echoes the rfq_id back, so the client can tie the refusal to its request', async () => {
    const app = buildApp({ corridors: throwingCorridors(), readers: okReaders(), network: 'regtest' })

    const body = (await (await quote(app, request)).json()) as { rfq_id?: string }

    // Without this a client with several in flight cannot tell WHICH one died.
    expect(body.rfq_id).toBe(RFQ_ID)
  })

  it('reports the fault through onError, never onRefusal', async () => {
    const onError = vi.fn()
    const onRefusal = vi.fn()
    const app = buildApp({
      corridors: throwingCorridors(),
      readers: okReaders(),
      network: 'regtest',
      onError,
      onRefusal,
    })

    await quote(app, request)

    // The whole point of two hooks: a refusal is this host answering
    // correctly, and folding a fault into that stream buries it in the log an
    // operator scans for ordinary business.
    expect(onError).toHaveBeenCalledWith('http quote', BOOM)
    expect(onRefusal).not.toHaveBeenCalled()
  })

  it('survives a missing onError — the hook is optional, the catch is not', async () => {
    const app = buildApp({ corridors: throwingCorridors(), readers: okReaders(), network: 'regtest' })

    await expect(quote(app, request)).resolves.toMatchObject({ status: 422 })
  })
})

describe('the status endpoint distinguishes “cannot read” from “no such swap”', () => {
  const status = (app: ReturnType<typeof buildApp>) =>
    app.fetch(new Request(`http://solver/v1/rfq/${RFQ_ID}`, { method: 'GET' }))

  it('answers 500 on a throw, NOT the 404 that means the swap does not exist', async () => {
    const onError = vi.fn()
    const app = buildApp({ corridors: okCorridors(), readers: throwingReaders(), network: 'regtest', onError })

    const response = await status(app)

    // The dangerous silent option. A client polling for its own swap reads 404
    // as proof the swap never existed and stops asking — about a swap that may
    // be funded and live. Same discipline as a null balance figure never being
    // rendered as a zero.
    expect(response.status).toBe(500)
    expect(response.status).not.toBe(404)
    expect(onError).toHaveBeenCalledWith('http status', BOOM)
  })

  it('still answers 404 when the readers genuinely have no such swap', async () => {
    const app = buildApp({ corridors: okCorridors(), readers: okReaders(), network: 'regtest' })

    const response = await status(app)

    // The other half of the same claim: the catch must not have turned every
    // miss into a fault.
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ v: 1, type: 'not_found' })
  })
})
