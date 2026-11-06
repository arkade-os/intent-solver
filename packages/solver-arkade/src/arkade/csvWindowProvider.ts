import { base64, hex } from '@scure/base'

type JsonObject = Record<string, unknown>

const REORG_DEPTH = 6
const MAX_SATS = 2_100_000_000_000_000

const object = (value: unknown, name: string): JsonObject => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`CSV origin ${name} is missing or malformed`)
  }
  return value as JsonObject
}

const hash = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`CSV origin ${name} is missing or malformed`)
  }
  return value.toLowerCase()
}

const uint32 = (value: unknown, name: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0xffff_ffff) {
    throw new Error(`CSV origin ${name} is missing or malformed`)
  }
  return value as number
}

const positiveTime = (value: unknown, name: string): number => {
  const time = uint32(value, name)
  if (time === 0) throw new Error(`CSV origin ${name} is missing or malformed`)
  return time
}

const sats = (value: unknown, name: string): number => {
  const amount = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(amount) || (amount as number) <= 0 || (amount as number) > MAX_SATS) {
    throw new Error(`CSV origin ${name} is missing or malformed`)
  }
  return amount as number
}

const script = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('CSV origin pkScript is missing or malformed')
  let decoded: Uint8Array
  try {
    decoded = base64.decode(value)
  } catch {
    throw new Error('CSV origin pkScript is missing or malformed')
  }
  if (base64.encode(decoded) !== value || decoded.length !== 34 || decoded[0] !== 0x51 || decoded[1] !== 0x20) {
    throw new Error('CSV origin pkScript is missing or malformed')
  }
  return hex.encode(decoded)
}

const readJson = async (fetchImpl: typeof fetch, url: URL): Promise<JsonObject> => {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`CSV origin endpoint returned HTTP ${response.status}`)
  return object(await response.json(), 'response')
}

export const createCsvWindowFacts = (operatorUrl: string, fetchImpl: typeof fetch = fetch) => ({
  futureOriginLowerBoundMtp: async () => {
    const response = await readJson(fetchImpl, new URL('/v1/indexer/csv-origin-floor', operatorUrl))
    const tipHash = hash(response.tipBlockHash, 'tipBlockHash')
    const tipHeight = uint32(response.tipHeight, 'tipHeight')
    const ancestorHash = hash(response.lowerBoundBlockHash, 'lowerBoundBlockHash')
    const ancestorHeight = uint32(response.lowerBoundHeight, 'lowerBoundHeight')
    const ancestorMedianTimePast = positiveTime(response.lowerBoundPriorBlockMtp, 'lowerBoundPriorBlockMtp')
    const reorgBudgetBlocks = uint32(response.reorgDepth, 'reorgDepth')
    if (reorgBudgetBlocks !== REORG_DEPTH || tipHeight < REORG_DEPTH || ancestorHeight !== tipHeight - REORG_DEPTH) {
      throw new Error('CSV origin floor is not tied to the six block common ancestor')
    }
    return {
      originLowerBoundMtp: ancestorMedianTimePast,
      tipHash,
      tipHeight,
      ancestorHash,
      ancestorHeight,
      ancestorMedianTimePast,
      reorgBudgetBlocks,
    }
  },
  origin: async (point: { txid: string; vout: number; value: number }, expectedPkScript: string) => {
    const txid = hash(point.txid, 'txid')
    const vout = uint32(point.vout, 'vout')
    const value = sats(point.value, 'value')
    if (!/^5120[0-9a-f]{64}$/i.test(expectedPkScript)) {
      throw new Error('CSV origin expected pkScript is missing or malformed')
    }
    const url = new URL(`/v1/indexer/csv-origin/vtxo/${txid}/${vout}`, operatorUrl)
    url.searchParams.set('expectedPkScriptHex', expectedPkScript.toLowerCase())
    url.searchParams.set('expectedValueSats', String(value))
    const response = await readJson(fetchImpl, url)
    if (response.status !== 'CSV_ORIGIN_STATUS_CONFIRMED' && response.status !== 'CSV_ORIGIN_STATUS_VIRTUAL') {
      throw new Error('CSV origin is unknown or unsupported')
    }
    const pkScript = script(response.pkScript)
    if (pkScript !== expectedPkScript.toLowerCase() || sats(response.valueSats, 'valueSats') !== value) {
      throw new Error('CSV origin does not match the funded output')
    }
    const tipHash = hash(response.tipBlockHash, 'tipBlockHash')
    const tipHeight = uint32(response.tipHeight, 'tipHeight')
    const originLowerBoundMtp = positiveTime(response.originLowerBoundMtp, 'originLowerBoundMtp')
    const reorgBudgetBlocks = uint32(response.reorgDepth, 'reorgDepth')
    if (reorgBudgetBlocks !== REORG_DEPTH || tipHeight < REORG_DEPTH) {
      throw new Error('CSV origin has an unsupported reorg depth')
    }
    if (response.status === 'CSV_ORIGIN_STATUS_CONFIRMED') {
      if (response.virtualOrigin !== undefined) throw new Error('CSV origin has conflicting evidence')
      const confirmed = object(response.confirmed, 'confirmed')
      const blockHash = hash(confirmed.blockHash, 'blockHash')
      const blockHeight = uint32(confirmed.blockHeight, 'blockHeight')
      const confirmations = uint32(confirmed.confirmations, 'confirmations')
      const priorBlockMtp = positiveTime(confirmed.priorBlockMtp, 'priorBlockMtp')
      if (
        blockHeight < 1 ||
        blockHeight > tipHeight ||
        confirmations < REORG_DEPTH + 1 ||
        tipHeight - blockHeight + 1 !== confirmations ||
        originLowerBoundMtp !== priorBlockMtp
      ) {
        throw new Error('CSV origin confirmed evidence is inconsistent')
      }
      return {
        kind: 'confirmed' as const,
        txid,
        vout,
        value,
        pkScript,
        blockHash,
        blockHeight,
        confirmations,
        priorBlockMtp,
        originLowerBoundMtp,
        tipHash,
        tipHeight,
        reorgBudgetBlocks,
      }
    }
    if (response.confirmed !== undefined) throw new Error('CSV origin has conflicting evidence')
    const virtual = object(response.virtualOrigin, 'virtualOrigin')
    const ancestorHash = hash(virtual.lowerBoundBlockHash, 'lowerBoundBlockHash')
    const ancestorHeight = uint32(virtual.lowerBoundHeight, 'lowerBoundHeight')
    const ancestorMedianTimePast = positiveTime(virtual.lowerBoundPriorBlockMtp, 'lowerBoundPriorBlockMtp')
    const absentAtTipHash = hash(virtual.absenceTipBlockHash, 'absenceTipBlockHash')
    const absentAtTipHeight = uint32(virtual.absenceTipHeight, 'absenceTipHeight')
    const ancestryProofRef = virtual.lineageReference
    if (
      ancestorHeight !== tipHeight - REORG_DEPTH ||
      ancestorMedianTimePast !== originLowerBoundMtp ||
      absentAtTipHash !== tipHash ||
      absentAtTipHeight !== tipHeight ||
      typeof ancestryProofRef !== 'string' ||
      !ancestryProofRef.trim() ||
      ancestryProofRef.length > 512
    ) {
      throw new Error('CSV origin virtual evidence is inconsistent')
    }
    return {
      kind: 'virtual' as const,
      txid,
      vout,
      value,
      pkScript,
      absentAtTipHash,
      tipHash,
      tipHeight,
      originLowerBoundMtp,
      ancestorHash,
      ancestorHeight,
      ancestorMedianTimePast,
      reorgBudgetBlocks,
      ancestryProofRef,
    }
  },
})
