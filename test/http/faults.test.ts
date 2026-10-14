/**
 * What the HTTP transport does when something THROWS, as opposed to refusing.
 * The relay has always caught and answered `pricing_unavailable`; this side did
 * not, so a throw became a bare 500 that no operator log recorded.
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
    // Iterating, because that is how `respondToRfqStatus` reads.
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

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ v: 1, type: 'rfq_refusal', rfq_id: RFQ_ID, reason: 'pricing_unavailable' })
  })

  it('echoes the rfq_id back, so the client can tie the refusal to its request', async () => {
    const app = buildApp({ corridors: throwingCorridors(), readers: okReaders(), network: 'regtest' })

    const body = (await (await quote(app, request)).json()) as { rfq_id?: string }

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

    // A client polling its own swap would read 404 as proof it never existed.
    expect(response.status).toBe(500)
    expect(response.status).not.toBe(404)
    expect(onError).toHaveBeenCalledWith('http status', BOOM)
  })

  it('still answers 404 when the readers genuinely have no such swap', async () => {
    const app = buildApp({ corridors: okCorridors(), readers: okReaders(), network: 'regtest' })

    const response = await status(app)

    // The catch must not have turned every miss into a fault.
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ v: 1, type: 'not_found' })
  })
})

describe('rfq_reveal over HTTP', () => {
  const reveal = { v: 1, type: 'rfq_reveal', rfq_id: RFQ_ID, preimage: '07'.repeat(32) }
  const withReveal = (outcome: unknown): CorridorSet =>
    ({
      get: () => undefined,
      size: 1,
      [Symbol.iterator]: function* () {
        yield { descriptor: { pair: 'evm' }, reveal: async () => outcome }
      },
    }) as never as CorridorSet

  it.each([
    [{ kind: 'accepted' }, 202, 'rfq_reveal_ack'],
    [{ kind: 'refused', detail: 'swap is quoted' }, 422, 'rfq_refusal'],
    [{ kind: 'unknown' }, 404, 'rfq_refusal'],
  ])('maps %o to %i', async (outcome, status, type) => {
    const app = buildApp({ corridors: withReveal(outcome), readers: okReaders(), network: 'regtest' })
    const response = await quote(app, reveal)
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ type })
  })

  it('answers a thrown corridor fault with a 500 and reports it', async () => {
    const onError = vi.fn()
    const corridors = withReveal(undefined)
    const broken = {
      ...corridors,
      [Symbol.iterator]: function* () {
        yield { descriptor: { pair: 'evm' }, reveal: async () => Promise.reject(BOOM) }
      },
    } as never as CorridorSet
    const response = await quote(
      buildApp({ corridors: broken, readers: okReaders(), network: 'regtest', onError }),
      reveal,
    )
    expect(response.status).toBe(500)
    expect(onError).toHaveBeenCalledWith('http reveal', BOOM)
  })
})
