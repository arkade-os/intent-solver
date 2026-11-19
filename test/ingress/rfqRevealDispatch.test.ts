import { describe, it, expect, vi } from 'vitest'
import { respondToRfqReveal } from '@arkade-os/solver-transport/ingress/rfq.js'
import { createCorridorSet, type Corridor, type CorridorRevealOutcome } from '@arkade-os/solver-core/core/corridor.js'

const RFQ_ID = 'a'.repeat(64)
const PREIMAGE = '07'.repeat(32)

const corridor = (pair: string, reveal?: (rfqId: string, preimage: string) => Promise<CorridorRevealOutcome>) =>
  ({ descriptor: { pair, envStem: pair }, ...(reveal ? { reveal } : {}) }) as unknown as Corridor

const ask = (
  corridors: Corridor[],
  payload: unknown = { v: 1, type: 'rfq_reveal', rfq_id: RFQ_ID, preimage: PREIMAGE },
) => respondToRfqReveal(createCorridorSet(corridors), payload)

describe('rfq_reveal dispatch', () => {
  it('skips corridors that relay nothing and those that do not own the id, and acks the owner', async () => {
    const other = vi.fn().mockResolvedValue({ kind: 'unknown' })
    const owner = vi.fn().mockResolvedValue({ kind: 'accepted' })
    const outcome = await ask([corridor('ln'), corridor('evm-a', other), corridor('evm-b', owner)])
    expect(outcome).toEqual({ kind: 'ack', payload: { v: 1, type: 'rfq_reveal_ack', rfq_id: RFQ_ID } })
    expect(owner).toHaveBeenCalledWith(RFQ_ID, PREIMAGE)
  })

  it('answers a refusal with the generic reason and keeps the detail off the wire', async () => {
    const outcome = await ask([corridor('evm', async () => ({ kind: 'refused', detail: 'preimage mismatch' }))])
    expect(outcome.kind).toBe('refused')
    expect(outcome.payload).toMatchObject({ type: 'rfq_refusal', reason: 'unsupported_payload' })
    expect(JSON.stringify(outcome.payload)).not.toContain('mismatch')
  })

  it('reports an id no corridor owns as unknown', async () => {
    await expect(ask([corridor('evm', async () => ({ kind: 'unknown' }))])).resolves.toMatchObject({ kind: 'unknown' })
  })

  it.each([
    ['a short preimage', { v: 1, type: 'rfq_reveal', rfq_id: RFQ_ID, preimage: '07' }],
    ['an extra field', { v: 1, type: 'rfq_reveal', rfq_id: RFQ_ID, preimage: PREIMAGE, pair: 'x' }],
  ])('rejects %s before asking any corridor', async (_name, payload) => {
    const reveal = vi.fn()
    await expect(ask([corridor('evm', reveal)], payload)).resolves.toMatchObject({ kind: 'invalid' })
    expect(reveal).not.toHaveBeenCalled()
  })
})
