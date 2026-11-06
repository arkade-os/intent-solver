import { hex } from '@scure/base'
import { REFUND_SAFETY_MARGIN } from '@arkade-os/solver-core/core/send.js'
import { relativeDelayFrom, SEQUENCE_GRANULARITY_SECONDS } from '@arkade-os/solver-core/core/timelocks.js'
import { covenantScriptFromRow, type CovenantScriptRow } from '@arkade-os/solver-arkade/arkade/covenantRow.js'

export interface CsvWindowOutpoint {
  txid: string
  vout: number
  value: number
}

export interface CsvWindowOriginFloor {
  originLowerBoundMtp: number
  tipHash: string
  tipHeight: number
  ancestorHash: string
  ancestorHeight: number
  ancestorMedianTimePast: number
  reorgBudgetBlocks: number
}

export type CsvWindowOrigin =
  | {
      kind: 'confirmed'
      txid: string
      vout: number
      value: number
      pkScript: string
      blockHash: string
      blockHeight: number
      confirmations: number
      priorBlockMtp: number
      originLowerBoundMtp: number
      tipHash: string
      tipHeight: number
      reorgBudgetBlocks: number
    }
  | {
      kind: 'virtual'
      txid: string
      vout: number
      value: number
      pkScript: string
      absentAtTipHash: string
      tipHash: string
      tipHeight: number
      originLowerBoundMtp: number
      ancestorHash: string
      ancestorHeight: number
      ancestorMedianTimePast: number
      reorgBudgetBlocks: number
      ancestryProofRef: string
    }

/** Implementations must establish active-chain membership or authoritative absence, never infer absence from a 404. */
export interface CsvWindowFacts {
  futureOriginLowerBoundMtp(): Promise<CsvWindowOriginFloor>
  origin(point: CsvWindowOutpoint, expectedPkScript: string): Promise<CsvWindowOrigin>
}

export const CSV_REORG_BUDGET_BLOCKS = 6

export const checkedFutureOriginLowerBoundMtp = (floor: CsvWindowOriginFloor): number => {
  if (
    !validTime(floor.originLowerBoundMtp) ||
    !validHash(floor.tipHash) ||
    !Number.isSafeInteger(floor.tipHeight) ||
    floor.tipHeight < CSV_REORG_BUDGET_BLOCKS ||
    !validHash(floor.ancestorHash) ||
    floor.ancestorHeight !== floor.tipHeight - CSV_REORG_BUDGET_BLOCKS ||
    !validTime(floor.ancestorMedianTimePast) ||
    floor.originLowerBoundMtp !== floor.ancestorMedianTimePast ||
    floor.reorgBudgetBlocks !== CSV_REORG_BUDGET_BLOCKS
  ) {
    throw new Error('CSV window origin floor is not tied to the six block common ancestor')
  }
  return floor.originLowerBoundMtp
}

const validTime = (value: number): boolean => Number.isSafeInteger(value) && value > 0 && value <= 0xffff_ffff
const validSats = (value: number): boolean => Number.isSafeInteger(value) && value > 0 && value <= 2_100_000_000_000_000
const validHash = (value: string): boolean => /^[0-9a-f]{64}$/i.test(value)

export const assertClientSoloCsvWindow = async (
  row: CovenantScriptRow,
  outpoints: readonly CsvWindowOutpoint[],
  facts: CsvWindowFacts,
): Promise<void> => {
  if (!row.clientRefundPubkey) throw new Error(`swap ${row.id}: no client solo refund leaf`)
  if (!validTime(row.refundLocktime) || row.refundLocktime < 500_000_000) {
    throw new Error(`swap ${row.id}: CSV time window requires a seconds refund deadline`)
  }
  const script = covenantScriptFromRow(row)
  if (hex.encode(script.pkScript) !== row.pkScript.toLowerCase()) {
    throw new Error(`swap ${row.id}: CSV window script does not match funded lockup`)
  }
  const delay = relativeDelayFrom(row.refundWithoutReceiverDelay)
  if (delay.unit !== 'seconds' || !validTime(delay.value) || delay.value % SEQUENCE_GRANULARITY_SECONDS !== 0) {
    throw new Error(`swap ${row.id}: client solo refund CSV is not a representable seconds delay`)
  }
  if (
    outpoints.length === 0 ||
    new Set(outpoints.map((point) => `${point.txid}:${point.vout}`)).size !== outpoints.length
  ) {
    throw new Error(`swap ${row.id}: CSV window needs distinct funded outpoints`)
  }
  const threshold = row.refundLocktime + REFUND_SAFETY_MARGIN
  if (!Number.isSafeInteger(threshold) || threshold > 0xffff_ffff) {
    throw new Error(`swap ${row.id}: CSV window deadline overflows`)
  }
  for (const point of outpoints) {
    if (!validHash(point.txid) || !Number.isSafeInteger(point.vout) || point.vout < 0 || !validSats(point.value)) {
      throw new Error(`swap ${row.id}: invalid CSV window outpoint`)
    }
    const origin = await facts.origin(point, row.pkScript)
    if (
      origin.txid.toLowerCase() !== point.txid.toLowerCase() ||
      origin.vout !== point.vout ||
      origin.value !== point.value ||
      origin.pkScript.toLowerCase() !== row.pkScript.toLowerCase()
    ) {
      throw new Error(`swap ${row.id}: CSV window origin does not match ${point.txid}:${point.vout}`)
    }
    const mtp = origin.originLowerBoundMtp
    if (
      !validTime(mtp) ||
      origin.reorgBudgetBlocks !== CSV_REORG_BUDGET_BLOCKS ||
      !Number.isSafeInteger(origin.tipHeight) ||
      origin.tipHeight < CSV_REORG_BUDGET_BLOCKS ||
      (origin.kind === 'confirmed'
        ? !validHash(origin.blockHash) ||
          !Number.isSafeInteger(origin.blockHeight) ||
          origin.blockHeight < 1 ||
          !Number.isSafeInteger(origin.confirmations) ||
          origin.confirmations < CSV_REORG_BUDGET_BLOCKS + 1 ||
          origin.tipHeight - origin.blockHeight + 1 !== origin.confirmations ||
          !validHash(origin.tipHash) ||
          !validTime(origin.priorBlockMtp) ||
          origin.originLowerBoundMtp !== origin.priorBlockMtp
        : !validHash(origin.absentAtTipHash) ||
          !validHash(origin.tipHash) ||
          origin.absentAtTipHash.toLowerCase() !== origin.tipHash.toLowerCase() ||
          !validHash(origin.ancestorHash) ||
          origin.ancestorHeight !== origin.tipHeight - CSV_REORG_BUDGET_BLOCKS ||
          !validTime(origin.ancestorMedianTimePast) ||
          typeof origin.ancestryProofRef !== 'string' ||
          !origin.ancestryProofRef.trim() ||
          origin.originLowerBoundMtp !== origin.ancestorMedianTimePast)
    ) {
      throw new Error(`swap ${row.id}: CSV window origin has incomplete active-chain evidence`)
    }
    const maturity = mtp + delay.value
    if (!Number.isSafeInteger(maturity) || maturity > 0xffff_ffff || maturity <= threshold) {
      throw new Error(
        `swap ${row.id}: client solo refund CSV can mature before the scripted refund deadline plus safety margin`,
      )
    }
  }
}
