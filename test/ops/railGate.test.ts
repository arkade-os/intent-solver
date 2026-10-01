import { describe, it, expect, vi } from 'vitest'
import { corridorSetFromDeps } from '@arkade-os/solver-app/ops/corridorSet.js'

const RAIL_PAIRS = [
  'arkade:BTC->lightning:BTC',
  'arkade:BTC->onchain:BTC',
  'lightning:BTC->arkade:BTC',
  'onchain:BTC->arkade:BTC',
] as const

const deps = (railUp?: () => boolean) => {
  const service = () => ({ quote: vi.fn(async () => ({ kind: 'quote', payload: {} })) })
  const services = { send: service(), onchain: service(), receive: service(), onchainReceive: service() }
  const set = corridorSetFromDeps({
    service: services.send as never,
    onchainService: services.onchain as never,
    receiveService: services.receive as never,
    onchainReceiveService: services.onchainReceive as never,
    store: {} as never,
    onchainStore: {} as never,
    receiveStore: {} as never,
    onchainReceiveStore: {} as never,
    railUp,
  })
  return { set, services }
}

describe('the rail gate', () => {
  it('refuses every rail corridor while LND is down, without reaching its service', async () => {
    const { set, services } = deps(() => false)
    for (const pair of RAIL_PAIRS) {
      await expect(set.get(pair)!.quote({ rfq_id: 'r1' })).resolves.toMatchObject({
        kind: 'refused',
        payload: { type: 'rfq_refusal', rfq_id: 'r1', reason: 'pricing_unavailable' },
      })
    }
    for (const service of Object.values(services)) expect(service.quote).not.toHaveBeenCalled()
  })

  it('answers exactly as the ungated corridor does while LND is up', async () => {
    const gated = deps(() => true).set
    const ungated = deps().set
    for (const pair of RAIL_PAIRS) {
      expect(await gated.get(pair)!.quote({ rfq_id: 'r1' })).toEqual(await ungated.get(pair)!.quote({ rfq_id: 'r1' }))
    }
  })
})
