import { base64, hex } from '@scure/base'
import { createCsvWindowFacts } from '@arkade-os/solver-arkade/arkade/csvWindowProvider.js'
import { describe, expect, it } from 'vitest'

const txid = 'cd'.repeat(32)
const pkScript = `5120${'ab'.repeat(32)}`
const tipHash = 'aa'.repeat(32)
const ancestorHash = 'bb'.repeat(32)
const blockHash = 'ee'.repeat(32)
const point = { txid, vout: 3, value: 1234 }
const confirmed = {
  status: 'CSV_ORIGIN_STATUS_CONFIRMED',
  pkScript: base64.encode(hex.decode(pkScript)),
  valueSats: '1234',
  tipBlockHash: tipHash,
  tipHeight: 200,
  originLowerBoundMtp: 1_800_000_000,
  reorgDepth: 6,
  confirmed: { blockHash, blockHeight: 194, priorBlockMtp: 1_800_000_000, confirmations: 7 },
}
const virtual = {
  status: 'CSV_ORIGIN_STATUS_VIRTUAL',
  pkScript: base64.encode(hex.decode(pkScript)),
  valueSats: '1234',
  tipBlockHash: tipHash,
  tipHeight: 200,
  originLowerBoundMtp: 1_800_000_000,
  reorgDepth: 6,
  virtualOrigin: {
    lowerBoundBlockHash: ancestorHash,
    lowerBoundHeight: 194,
    lowerBoundPriorBlockMtp: 1_800_000_000,
    absenceTipBlockHash: tipHash,
    absenceTipHeight: 200,
    lineageReference: 'batch:abc',
  },
}

const responding =
  (body: unknown, status = 200): typeof fetch =>
  async () =>
    Response.json(body, { status })

describe('Arkd CSV origin adapter', () => {
  it('maps the common-ancestor floor from the public indexer route', async () => {
    let requested: URL | undefined
    const fetchImpl: typeof fetch = async (input) => {
      requested = new URL(String(input))
      return Response.json({
        tipBlockHash: tipHash,
        tipHeight: 200,
        reorgDepth: 6,
        lowerBoundBlockHash: ancestorHash,
        lowerBoundHeight: 194,
        lowerBoundPriorBlockMtp: 1_800_000_000,
      })
    }
    const floor = await createCsvWindowFacts('https://arkd.example/', fetchImpl).futureOriginLowerBoundMtp()
    expect(requested?.pathname).toBe('/v1/indexer/csv-origin-floor')
    expect(floor).toEqual({
      originLowerBoundMtp: 1_800_000_000,
      tipHash,
      tipHeight: 200,
      ancestorHash,
      ancestorHeight: 194,
      ancestorMedianTimePast: 1_800_000_000,
      reorgBudgetBlocks: 6,
    })
  })

  it('passes exact output parameters and maps confirmed evidence', async () => {
    let requested: URL | undefined
    const fetchImpl: typeof fetch = async (input) => {
      requested = new URL(String(input))
      return Response.json(confirmed)
    }
    const origin = await createCsvWindowFacts('https://arkd.example', fetchImpl).origin(point, pkScript)
    expect(requested?.pathname).toBe(`/v1/indexer/csv-origin/vtxo/${txid}/3`)
    expect(requested?.searchParams.get('expectedPkScriptHex')).toBe(pkScript)
    expect(requested?.searchParams.get('expectedValueSats')).toBe('1234')
    expect(origin).toEqual({
      kind: 'confirmed',
      ...point,
      pkScript,
      blockHash,
      blockHeight: 194,
      confirmations: 7,
      priorBlockMtp: 1_800_000_000,
      originLowerBoundMtp: 1_800_000_000,
      tipHash,
      tipHeight: 200,
      reorgBudgetBlocks: 6,
    })
  })

  it('maps authenticated virtual absence and ancestry evidence', async () => {
    const origin = await createCsvWindowFacts('https://arkd.example', responding(virtual)).origin(point, pkScript)
    expect(origin).toEqual({
      kind: 'virtual',
      ...point,
      pkScript,
      absentAtTipHash: tipHash,
      tipHash,
      tipHeight: 200,
      originLowerBoundMtp: 1_800_000_000,
      ancestorHash,
      ancestorHeight: 194,
      ancestorMedianTimePast: 1_800_000_000,
      reorgBudgetBlocks: 6,
      ancestryProofRef: 'batch:abc',
    })
  })

  it.each([
    ['unknown', { status: 'CSV_ORIGIN_STATUS_UNKNOWN' }],
    ['mismatched value', { ...confirmed, valueSats: '1235' }],
    ['mismatched script', { ...confirmed, pkScript: base64.encode(hex.decode(`5120${'ac'.repeat(32)}`)) }],
    ['shallow confirmation', { ...confirmed, confirmed: { ...confirmed.confirmed, confirmations: 6 } }],
    ['conflicting origin', { ...confirmed, virtualOrigin: virtual.virtualOrigin }],
    [
      'bad virtual absence tip',
      {
        ...virtual,
        virtualOrigin: { ...virtual.virtualOrigin, absenceTipBlockHash: blockHash },
      },
    ],
    ['missing lineage', { ...virtual, virtualOrigin: { ...virtual.virtualOrigin, lineageReference: '' } }],
    ['wrong reorg depth', { ...virtual, reorgDepth: 5 }],
  ])('rejects %s evidence', async (_name, body) => {
    await expect(
      createCsvWindowFacts('https://arkd.example', responding(body)).origin(point, pkScript),
    ).rejects.toThrow()
  })

  it('does not interpret an unavailable endpoint as virtual absence', async () => {
    await expect(
      createCsvWindowFacts('https://arkd.example', responding({}, 404)).origin(point, pkScript),
    ).rejects.toThrow(/HTTP 404/)
  })

  it('rejects an inconsistent future origin floor', async () => {
    const body = {
      tipBlockHash: tipHash,
      tipHeight: 200,
      reorgDepth: 6,
      lowerBoundBlockHash: ancestorHash,
      lowerBoundHeight: 195,
      lowerBoundPriorBlockMtp: 1_800_000_000,
    }
    await expect(
      createCsvWindowFacts('https://arkd.example', responding(body)).futureOriginLowerBoundMtp(),
    ).rejects.toThrow()
  })
})
