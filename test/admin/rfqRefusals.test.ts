import { describe, it, expect, vi } from 'vitest'
import { buildAdminApp } from '@arkade-os/solver-app/admin/server.js'
import { createRfqRefusalTail, recordRfqRefusals } from '@arkade-os/solver-app/admin/rfqRefusals.js'
import { buildApp } from '@arkade-os/solver-transport/http/server.js'
import { RelayIngress } from '@arkade-os/solver-transport/ingress/relay.js'
import { reportRfqRefusal } from '@arkade-os/solver-transport/ingress/refusals.js'
import type { RelayConnection, RelayEvent } from '@arkade-os/solver-transport/relay/connection.js'
import { createCorridorReaderSet } from '@arkade-os/solver-core/core/corridor.js'
import { forgeInvoice } from '@arkade-os/solver-rails-fake/ln/fake/bolt11.js'
import { decodeInvoice } from '@arkade-os/solver-core/invoice/decode.js'
import { setFrom } from '../support/corridorSet.js'

const RFQ_ID = 'ab'.repeat(32)
const invoice = forgeInvoice({
  network: 'tbs',
  amountSats: 2002,
  paymentHash: new Uint8Array(32).fill(7),
  timestamp: 1_788_956_950,
  expirySeconds: 14_400,
  minFinalCltvBlocks: 624,
})
const request = {
  v: 1,
  type: 'rfq_request',
  rfq_id: RFQ_ID,
  pair: 'arkade:BTC->lightning:BTC',
  amount_side: 'to',
  profile: {
    invoice,
    refund_address: 'tark1private-refund-address',
    client_refund_pubkey: 'cd'.repeat(32),
  },
}

const setup = () => {
  const quote = vi.fn(async (rawInvoice: string) => {
    decodeInvoice(rawInvoice)
    return { accepted: false as const, reason: 'pricing_unavailable' as never }
  })
  const store = {
    findByRfqId: async () => null,
    findLiveByPaymentHash: async () => null,
  }
  const corridors = setFrom({ send: { quote } as never }, { store: store as never })
  const readers = createCorridorReaderSet([])
  const rfqRefusals = createRfqRefusalTail()
  const log = vi.fn()
  const onRefusal = recordRfqRefusals(rfqRefusals, log, () => 1234)
  const admin = buildAdminApp({ services: { rfqRefusals } as never, startedAt: 1, mode: 'relay' })
  return { quote, corridors, readers, rfqRefusals, log, onRefusal, admin }
}

describe('RFQ refusal diagnostics', () => {
  it.each(['http', 'relay'] as const)('shows a pre-swap CLTV refusal in the admin API over %s', async (transport) => {
    const deps = setup()
    let reply: unknown
    if (transport === 'http') {
      const app = buildApp({ ...deps, network: 'mutinynet' })
      const res = await app.request('/v1/swap', { method: 'POST', body: JSON.stringify(request) })
      expect(res.status).toBe(400)
      reply = await res.json()
    } else {
      let deliver!: (event: RelayEvent) => void | Promise<void>
      const connection: RelayConnection = {
        subscribe: async (_filter, handler) => {
          deliver = handler
          return { close: async () => {} }
        },
        publish: async (event) => {
          reply = event.payload
        },
        close: async () => {},
        isConnected: () => true,
      }
      const ingress = new RelayIngress({ ...deps, connection, providerPubkey: 'ef'.repeat(32) })
      await ingress.start()
      await deliver({ id: 'event', author: 'client', createdAtMs: 1234, payload: request })
      await ingress.stop()
    }
    expect(reply).toEqual({
      v: 1,
      type: 'rfq_refusal',
      rfq_id: RFQ_ID,
      reason: 'unsupported_payload',
      error_code: 'invoice_cltv_too_large',
      field: 'profile.invoice',
      actual: 624,
      limit: 288,
      unit: 'blocks',
    })
    expect(deps.quote).toHaveBeenCalledOnce()
    const response = await deps.admin.request('/api/rfq-refusals')
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      entries: { at: number; transport: string; requestType: string; rfqId: string | null; detail: string }[]
      ephemeral: boolean
    }
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0]).toMatchObject({ at: 1234, transport, requestType: 'rfq_request', rfqId: RFQ_ID })
    expect(body.entries[0]!.detail).toContain('final delta 624 > 288')
    expect(body.ephemeral).toBe(true)
    expect(deps.log).toHaveBeenCalled()
    for (const value of Object.values(request.profile)) expect(JSON.stringify(body)).not.toContain(value)
  })

  it('records malformed HTTP bodies and status IDs without retaining raw values', async () => {
    const deps = setup()
    const app = buildApp({ ...deps, network: 'mutinynet' })
    await app.request('/v1/swap', { method: 'POST', body: 'private-invalid-json' })
    await app.request('/v1/rfq/private-invalid-id')
    const entries = deps.rfqRefusals.recent().entries
    expect(entries.map((entry) => entry.requestType)).toEqual(['rfq_status_request', 'rfq_request'])
    expect(entries.every((entry) => entry.rfqId === null)).toBe(true)
    expect(JSON.stringify(entries)).not.toContain('private-invalid')
  })

  it('records an unknown relay status as a refusal, but not an HTTP 404', () => {
    const deps = setup()
    const outcome = {
      kind: 'unknown',
      payload: { type: 'rfq_refusal', rfq_id: RFQ_ID, reason: 'unsupported_payload' },
      detail: 'no negotiation with this rfq_id in any corridor',
    }
    reportRfqRefusal(deps.onRefusal, 'relay', 'rfq_status_request', outcome)
    reportRfqRefusal(deps.onRefusal, 'http', 'rfq_status_request', outcome)
    expect(deps.rfqRefusals.recent().entries).toHaveLength(1)
    expect(deps.rfqRefusals.recent().entries[0]?.detail).toContain('no negotiation')
  })

  it('bounds retained entries and text, and returns independent snapshots', () => {
    const tail = createRfqRefusalTail(2)
    const observer = recordRfqRefusals(tail, () => {})
    for (const at of [1, 2, 3]) {
      reportRfqRefusal(observer, 'relay', 'rfq_request', {
        kind: 'invalid',
        detail: `${at}${'x'.repeat(2000)}`,
        payload: { reason: 'unsupported_payload' },
      })
    }
    const snapshot = tail.recent()
    expect(snapshot.entries).toHaveLength(2)
    expect(snapshot.entries[0]?.detail).toHaveLength(1024)
    expect(snapshot.entries[0]?.detail).toContain('3')
    snapshot.entries[0]!.detail = 'modified'
    expect(tail.recent().entries[0]?.detail).not.toBe('modified')
  })

  it.each(['http', 'relay'] as const)('sanitizes and bounds text before the %s observer', (transport) => {
    const observer = vi.fn()
    reportRfqRefusal(observer, transport, 'rfq_request', {
      kind: 'invalid',
      detail: `first\r\nforged\u001b[31m\u2028next${'x'.repeat(5000)}`,
      payload: { reason: `bad\r\n\u0000reason${'x'.repeat(200)}` },
    })
    const [, detail, metadata] = observer.mock.calls[0]!
    expect(detail).toHaveLength(1024)
    expect(detail.startsWith('invalid: first  forged [31m next')).toBe(true)
    expect(metadata.reason).toHaveLength(100)
    expect(metadata.reason.startsWith('bad   reason')).toBe(true)
  })

  it('sanitizes direct recorder input before both the log and retained tail', () => {
    const tail = createRfqRefusalTail()
    const record = vi.spyOn(tail, 'record')
    const log = vi.fn()
    const observer = recordRfqRefusals(tail, log)
    observer('relay refused', `first\n\u202e${'x'.repeat(2000)}`, {
      transport: 'relay',
      requestType: 'rfq_request',
      rfqId: null,
      reason: `bad\r\n${'x'.repeat(200)}`,
    })
    const entry = tail.recent().entries[0]!
    expect(entry.reason).toHaveLength(100)
    expect(entry.reason.startsWith('bad  ')).toBe(true)
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ reason: entry.reason, detail: entry.detail }))
    expect(entry.detail).toHaveLength(1024)
    expect(entry.detail.startsWith('first  ')).toBe(true)
    expect(log).toHaveBeenCalledWith('relay refused:', entry.detail)
  })

  it('does not let a diagnostic sink change the response path', () => {
    expect(() =>
      reportRfqRefusal(
        () => {
          throw new Error('log unavailable')
        },
        'relay',
        'rfq_request',
        { kind: 'invalid', payload: { reason: 'unsupported_payload' } },
      ),
    ).not.toThrow()
  })
})
