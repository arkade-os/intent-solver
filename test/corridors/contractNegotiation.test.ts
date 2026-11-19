import { describe, expect, it } from 'vitest'
import {
  createCorridorSet,
  type Corridor,
  type CorridorRfqOutcome,
  type QuoteOptions,
} from '@arkade-os/solver-core/core/corridor.js'
import type { CorridorDescriptor } from '@arkade-os/solver-core/core/corridorDescriptor.js'
import * as contracts from '@arkade-os/solver-core/core/rfqContract.js'

const V2 = contracts.RFQ_ASSET_SWAP_V2
const V3 = 'asset-swap-v3'
const RFQ = { v: 1, type: 'rfq_request', rfq_id: 'a'.repeat(64), pair: 'a->b' }
const QUOTE: CorridorRfqOutcome = { kind: 'quote', payload: { type: 'rfq_quote', rfq_id: RFQ.rfq_id } }
const descriptor: CorridorDescriptor = {
  pair: RFQ.pair,
  envStem: 'ASSET',
  contractVersion: V2,
  contractVersions: [V3, V2],
  payoutRail: 'arkade',
  states: { live: ['quoted'], exposed: [], delivered: ['settled'] },
}

const provider = (quote: Corridor['quote'], contractVersions: readonly string[] | undefined = [V3, V2]): Corridor => ({
  descriptor: { ...descriptor, contractVersions },
  quote,
  statusFor: async () => null,
  tick: async () => {},
  tickAll: async () => 0,
  park: async () => ({ state: 'stuck' }),
  findRecoverable: async () => [],
  committedSats: async () => 0,
  page: async () => ({ swaps: [], nextCursor: null }),
  detail: async () => null,
  close: async () => {},
})

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('refuses a versionless quote when the provider advertises no baseline capability', async () => {
  let called = false
  const corridor = createCorridorSet([
    provider(async () => {
      called = true
      return QUOTE
    }, []),
  ]).get(RFQ.pair)!
  expect((await corridor.quote(RFQ)).kind).toBe('refused')
  expect(called).toBe(false)
})

describe('multi-version corridor negotiation', () => {
  it('exports and enables both asset versions by default', () => {
    expect(contracts).toHaveProperty('RFQ_ASSET_SWAP_V3', V3)
    expect(contracts.RFQ_CONTRACT_VERSIONS).toEqual(expect.arrayContaining([V3, V2]))
  })

  it.each([
    [V3, ['unknown-v1', V3, V2]],
    [V2, [V2, V3]],
  ])('chooses client-preferred %s and strips the wire list', async (selected, listed) => {
    const seen: { payload: unknown; options?: QuoteOptions }[] = []
    const corridor = createCorridorSet([
      provider(async (payload, options) => {
        seen.push({ payload, options })
        return QUOTE
      }),
    ]).get(RFQ.pair)!
    const options = { requesterKey: 'requester' }
    const outcome = await corridor.quote({ ...RFQ, contract_versions: listed }, options)
    expect(seen).toEqual([{ payload: RFQ, options: { requesterKey: 'requester', contractVersion: selected } }])
    expect(seen[0]!.options).not.toBe(options)
    expect(Object.isFrozen(seen[0]!.options)).toBe(true)
    expect(options).toEqual({ requesterKey: 'requester' })
    expect(outcome).toMatchObject({ kind: 'quote', payload: { contract_version: selected } })
  })

  it('keeps concurrent selections and input snapshots independent across awaits', async () => {
    const first = deferred()
    const second = deferred()
    const seen: QuoteOptions[] = []
    const corridor = createCorridorSet([
      provider(async (payload, options) => {
        seen.push(options!)
        await ((payload as typeof RFQ).rfq_id === RFQ.rfq_id ? first.promise : second.promise)
        return QUOTE
      }),
    ]).get(RFQ.pair)!
    const preferred = [V3, V2]
    const options = { requesterKey: 'first' }
    const firstQuote = corridor.quote({ ...RFQ, contract_versions: preferred }, options)
    const secondQuote = corridor.quote({ ...RFQ, rfq_id: 'b'.repeat(64), contract_versions: [V2] })
    preferred.splice(0, preferred.length, V2)
    options.requesterKey = 'changed'
    expect(seen).toEqual([{ requesterKey: 'first', contractVersion: V3 }, { contractVersion: V2 }])
    second.resolve()
    expect(await secondQuote).toMatchObject({ payload: { contract_version: V2 } })
    first.resolve()
    expect(await firstQuote).toMatchObject({ payload: { contract_version: V3 } })
    expect(seen).toEqual([{ requesterKey: 'first', contractVersion: V3 }, { contractVersion: V2 }])
  })

  it('selects V2 when the operator enables only V2', async () => {
    const seen: QuoteOptions[] = []
    const corridor = createCorridorSet(
      [
        provider(async (_payload, options) => {
          seen.push(options!)
          return QUOTE
        }),
      ],
      { supportedContractVersions: new Set([V2]) },
    ).get(RFQ.pair)!
    expect(await corridor.quote({ ...RFQ, contract_versions: [V3, V2] })).toMatchObject({
      payload: { contract_version: V2 },
    })
    expect(seen).toEqual([{ contractVersion: V2 }])
  })

  it('refuses V3-only requests without calling a V2-only deployment', async () => {
    let calls = 0
    const corridor = createCorridorSet(
      [
        provider(async () => {
          calls++
          return QUOTE
        }),
      ],
      { supportedContractVersions: new Set([V2]) },
    ).get(RFQ.pair)!
    expect(await corridor.quote({ ...RFQ, contract_versions: [V3] })).toMatchObject({
      kind: 'refused',
      payload: { error_code: 'contract_version_unsupported', field: 'contract_versions' },
    })
    expect(calls).toBe(0)
  })

  it('does not relabel an original provider quote with the new preference', async () => {
    const original = { ...QUOTE, payload: { ...QUOTE.payload, contract_version: V2, script: 'original-v2-script' } }
    let selected: string | undefined
    const corridor = createCorridorSet([
      provider(async (_payload, options) => {
        selected = options?.contractVersion
        return original
      }),
    ]).get(RFQ.pair)!
    expect(await corridor.quote({ ...RFQ, contract_versions: [V3, V2] })).toBe(original)
    expect(selected).toBe(V3)
    expect(original.payload).toEqual({ ...QUOTE.payload, contract_version: V2, script: 'original-v2-script' })
  })

  it.each([
    ['not requested', [V3], undefined, V2],
    ['disabled', [V3, V2], new Set([V3]), V2],
    ['not supported', [V3, V2, 'other-v1'], undefined, 'other-v1'],
    ['malformed', [V3, V2], undefined, null],
  ] as const)('refuses a provider quote whose original version is %s', async (_reason, asked, supported, original) => {
    const corridor = createCorridorSet(
      [provider(async () => ({ ...QUOTE, payload: { ...QUOTE.payload, contract_version: original } }))],
      { supportedContractVersions: supported },
    ).get(RFQ.pair)!
    expect(await corridor.quote({ ...RFQ, contract_versions: asked })).toMatchObject({
      kind: 'refused',
      payload: { error_code: 'contract_version_unsupported', field: 'contract_versions' },
    })
  })

  it('preserves versionless payload, options and quote identity at the V2 baseline', async () => {
    const options = { requesterKey: 'legacy-requester' }
    const seen: { payload: unknown; options?: QuoteOptions }[] = []
    const corridor = createCorridorSet([
      provider(async (payload, passed) => {
        seen.push({ payload, options: passed })
        return QUOTE
      }),
    ]).get(RFQ.pair)!
    expect(await corridor.quote(RFQ, options)).toBe(QUOTE)
    expect(seen[0]!.payload).toBe(RFQ)
    expect(seen[0]!.options).toBe(options)
    expect(QUOTE.payload).not.toHaveProperty('contract_version')
    expect(corridor.descriptor.contractVersion).toBe(V2)
  })

  it('refuses a versionless request when only the opt-in version is enabled', async () => {
    let calls = 0
    const corridor = createCorridorSet(
      [
        provider(async () => {
          calls++
          return QUOTE
        }),
      ],
      { supportedContractVersions: new Set([V3]) },
    ).get(RFQ.pair)!
    expect(await corridor.quote(RFQ)).toMatchObject({ kind: 'refused', payload: { reason: 'unsupported_pair' } })
    expect(calls).toBe(0)
  })

  it('retains baseline-only negotiation for descriptors without an optional list', async () => {
    const single = provider(async () => QUOTE)
    delete (single.descriptor as { contractVersions?: readonly string[] }).contractVersions
    const corridor = createCorridorSet([single]).get(RFQ.pair)!
    expect(await corridor.quote({ ...RFQ, contract_versions: [V3, V2] })).toMatchObject({
      payload: { contract_version: V2 },
    })
  })
})
