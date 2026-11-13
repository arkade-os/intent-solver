import type { SqlDriver } from '@arkade-os/solver-core/core/driver.js'
import type { RebalanceTransfer } from '@arkade-os/solver-core/ports/rebalance.js'
import { pageResult, type PageRequest, type PageResult } from '@arkade-os/sdk'
import type { RfqSwapPageCursor, RfqSwapPageFilter } from '@arkade-os/swap'
import { normalizeRfqSwapRecord, type RfqSwapRecord, type RfqSwapRecordStore } from '@arkade-os/swap/protocol'
import { rebalanceRfqSql, rebalanceSql } from './rebalanceStore.sql.js'

const safeInteger = (value: unknown, name: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`)
  }
  return value
}

const decimal = (value: number, name: string): string => String(safeInteger(value, name))
const amount = (value: unknown, name: string): number => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`invalid persisted ${name}`)
  return safeInteger(Number(value), name)
}

/** `data` is the JSON-encoded {@link RebalanceTransfer}; the other columns index it. */
export interface RebalanceTransferRow {
  id: string
  request_key: string
  state: RebalanceTransfer['state']
  created_at: number
  charged_at: number | null
  debit_sats: string
  data: string
}

export interface RebalanceClockRow {
  id: 1
  last_attempt: number
}

export interface RebalanceRfqRow {
  rfq_id: string
  record_json: string
  fund_amount: number
  valid_until: number
}

export interface TransferCursor {
  createdAt: number
  id: string
}

const validCursor = (value: unknown): value is TransferCursor =>
  !!value &&
  typeof value === 'object' &&
  Number.isSafeInteger((value as TransferCursor).createdAt) &&
  (value as TransferCursor).createdAt >= 0 &&
  typeof (value as TransferCursor).id === 'string' &&
  /^[a-zA-Z0-9_-]{1,128}$/.test((value as TransferCursor).id)

export const parseTransferCursor = (value: string): TransferCursor => {
  try {
    if (!/^[a-zA-Z0-9_-]{1,256}$/.test(value)) throw new Error()
    const pair: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error()
    const cursor = { createdAt: pair[0], id: pair[1] }
    if (!validCursor(cursor) || Buffer.from(JSON.stringify(pair)).toString('base64url') !== value) throw new Error()
    return cursor
  } catch {
    throw new Error('invalid transfer cursor')
  }
}

const transferCursor = (value: TransferCursor): string =>
  Buffer.from(JSON.stringify([value.createdAt, value.id])).toString('base64url')

const encode = (row: RebalanceTransfer): string =>
  JSON.stringify({
    ...row,
    netSats: decimal(row.netSats, 'netSats'),
    debitSats: decimal(row.debitSats, 'debitSats'),
    feeSats: decimal(row.feeSats, 'feeSats'),
    ...(row.receivingFeeAllowanceSats === undefined
      ? {}
      : { receivingFeeAllowanceSats: decimal(row.receivingFeeAllowanceSats, 'receivingFeeAllowanceSats') }),
    ...(row.creditedSats === undefined ? {} : { creditedSats: decimal(row.creditedSats, 'creditedSats') }),
    ...(row.sourceInputsClearedAt === undefined
      ? {}
      : { sourceInputsClearedAt: safeInteger(row.sourceInputsClearedAt, 'sourceInputsClearedAt') }),
    deposit: {
      ...row.deposit,
      amountSats: decimal(row.deposit.amountSats, 'deposit.amountSats'),
      netSats: decimal(row.deposit.netSats, 'deposit.netSats'),
      feeSats: decimal(row.deposit.feeSats, 'deposit.feeSats'),
    },
    inputs: row.inputs.map((input) => ({ ...input, value: decimal(input.value, 'input.value') })),
  })

const decode = (data: string): RebalanceTransfer => {
  const row = JSON.parse(data)
  return {
    ...row,
    netSats: amount(row.netSats, 'netSats'),
    debitSats: amount(row.debitSats, 'debitSats'),
    feeSats: amount(row.feeSats, 'feeSats'),
    ...(row.receivingFeeAllowanceSats === undefined
      ? {}
      : { receivingFeeAllowanceSats: amount(row.receivingFeeAllowanceSats, 'receivingFeeAllowanceSats') }),
    ...(row.creditedSats === undefined ? {} : { creditedSats: amount(row.creditedSats, 'creditedSats') }),
    ...(row.sourceInputsClearedAt === undefined
      ? {}
      : { sourceInputsClearedAt: safeInteger(row.sourceInputsClearedAt, 'sourceInputsClearedAt') }),
    deposit: {
      ...row.deposit,
      amountSats: amount(row.deposit.amountSats, 'deposit.amountSats'),
      netSats: amount(row.deposit.netSats, 'deposit.netSats'),
      feeSats: amount(row.deposit.feeSats, 'deposit.feeSats'),
    },
    inputs: row.inputs.map((input: { value: unknown }) => ({ ...input, value: amount(input.value, 'input.value') })),
  }
}

const params = (row: RebalanceTransfer): unknown[] => [
  row.state,
  safeInteger(row.createdAt, 'createdAt'),
  row.chargedAt === undefined ? null : safeInteger(row.chargedAt, 'chargedAt'),
  decimal(row.debitSats, 'debitSats'),
  encode(row),
]

export interface RebalanceRepository {
  create(row: RebalanceTransfer): Promise<void>
  save(row: RebalanceTransfer): Promise<void>
  get(id: string): Promise<RebalanceTransfer | undefined>
  byKey(key: string): Promise<RebalanceTransfer | undefined>
  list(limit?: number): Promise<RebalanceTransfer[]>
  page(limit?: number, before?: TransferCursor): Promise<{ transfers: RebalanceTransfer[]; nextCursor: string | null }>
  active(): Promise<RebalanceTransfer[]>
  protectedTerminalInputs(): Promise<RebalanceTransfer[]>
  checkpointTransfers(since: number): Promise<RebalanceTransfer[]>
  rollingDebit(now: number): Promise<number>
  lastAttempt(): Promise<number>
  recordAttempt(now: number): Promise<void>
}

export class RebalanceStore implements RebalanceRepository {
  private constructor(private readonly driver: SqlDriver) {}

  static async open(driver: SqlDriver): Promise<RebalanceStore> {
    await driver.exec(rebalanceSql.createSchema)
    return new RebalanceStore(driver)
  }

  async create(row: RebalanceTransfer): Promise<void> {
    await this.driver.run(rebalanceSql.insertTransfer, [...params(row), row.id, row.requestKey])
  }

  async save(row: RebalanceTransfer): Promise<void> {
    const result = await this.driver.run(rebalanceSql.saveTransfer, [
      ...params(row),
      row.id,
      row.requestKey,
      row.state,
      row.state,
      row.chargedAt ?? null,
      String(row.debitSats),
    ])
    if (result.changes !== 1)
      throw new Error('rebalance transfer missing, request key changed, or unsafe state/charge transition')
  }

  async get(id: string): Promise<RebalanceTransfer | undefined> {
    const row = await this.driver.get<Pick<RebalanceTransferRow, 'data'>>(rebalanceSql.selectTransferById, [id])
    return row ? decode(row.data) : undefined
  }

  async byKey(key: string): Promise<RebalanceTransfer | undefined> {
    const row = await this.driver.get<Pick<RebalanceTransferRow, 'data'>>(rebalanceSql.selectTransferByRequestKey, [
      key,
    ])
    return row ? decode(row.data) : undefined
  }

  async list(limit = 100): Promise<RebalanceTransfer[]> {
    safeInteger(limit, 'limit')
    const rows = await this.driver.all<Pick<RebalanceTransferRow, 'data'>>(rebalanceSql.selectNewestTransfers, [limit])
    return rows.map((row) => decode(row.data))
  }

  async page(
    limit = 20,
    before?: TransferCursor,
  ): Promise<{ transfers: RebalanceTransfer[]; nextCursor: string | null }> {
    safeInteger(limit, 'limit')
    if (limit < 1 || limit > 100 || (before && !validCursor(before))) throw new Error('invalid transfer page')
    const rows = await this.driver.all<{ data: string; createdAt: number; id: string }>(
      rebalanceSql.selectTransferPage(!!before),
      before ? [before.createdAt, before.createdAt, before.id, limit + 1] : [limit + 1],
    )
    const visible = rows.slice(0, limit)
    const last = visible.at(-1)
    return {
      transfers: visible.map((row) => decode(row.data)),
      nextCursor: rows.length > limit && last ? transferCursor(last) : null,
    }
  }

  async active(): Promise<RebalanceTransfer[]> {
    const rows = await this.driver.all<Pick<RebalanceTransferRow, 'data'>>(rebalanceSql.selectActiveTransfers)
    return rows.map((row) => decode(row.data))
  }

  async protectedTerminalInputs(): Promise<RebalanceTransfer[]> {
    const rows = await this.driver.all<Pick<RebalanceTransferRow, 'data'>>(rebalanceSql.selectChargedTerminalTransfers)
    return rows.map((row) => decode(row.data)).filter((row) => row.sourceInputsClearedAt === undefined)
  }

  async checkpointTransfers(since: number): Promise<RebalanceTransfer[]> {
    safeInteger(since, 'checkpoint time')
    const rows = await this.driver.all<Pick<RebalanceTransferRow, 'data'>>(rebalanceSql.selectCheckpointTransfers, [
      since,
    ])
    return rows.map((row) => decode(row.data))
  }

  async rollingDebit(now: number): Promise<number> {
    safeInteger(now, 'now')
    const row = await this.driver.get<{ total: number }>(rebalanceSql.sumChargedDebitInWindow, [now - 86_400, now])
    return safeInteger(row?.total ?? 0, 'rolling debit')
  }

  async lastAttempt(): Promise<number> {
    const row = await this.driver.get<{ at: number }>(rebalanceSql.selectLastAttempt)
    return safeInteger(row?.at ?? 0, 'last attempt')
  }

  async recordAttempt(now: number): Promise<void> {
    safeInteger(now, 'attempt time')
    await this.driver.run(rebalanceSql.recordAttempt, [now])
  }
}

// Rows written before swap 0.1.0 carry fundingArkTxid/refundArkTxid/lockupSpendArkTxids.
const parseRecord = (json: string): RfqSwapRecord => normalizeRfqSwapRecord(JSON.parse(json) as RfqSwapRecord)

export interface StoredRfq {
  record: RfqSwapRecord
  fundAmount: number
  validUntil: number
}

export interface RebalanceRfqRepository extends RfqSwapRecordStore {
  init(): Promise<void>
  create(value: StoredRfq): Promise<void>
  stored(id: string): Promise<StoredRfq | undefined>
  getAllRfqSwaps(): Promise<RfqSwapRecord[]>
  getRfqSwapsPage(
    filter: RfqSwapPageFilter,
    page: PageRequest<RfqSwapPageCursor>,
  ): Promise<PageResult<RfqSwapRecord, RfqSwapPageCursor>>
}

export class SqliteRebalanceRfqRepository implements RebalanceRfqRepository {
  constructor(private readonly driver: SqlDriver) {}

  async init(): Promise<void> {
    await this.driver.exec(rebalanceRfqSql.createTable)
  }

  async create(value: StoredRfq): Promise<void> {
    await this.driver.run(rebalanceRfqSql.insert, [
      value.record.rfqId,
      JSON.stringify(value.record),
      value.fundAmount,
      value.validUntil,
    ])
  }

  async stored(id: string): Promise<StoredRfq | undefined> {
    const row = await this.driver.get<Omit<RebalanceRfqRow, 'rfq_id'>>(rebalanceRfqSql.selectById, [id])
    return (
      row && {
        record: parseRecord(row.record_json),
        fundAmount: row.fund_amount,
        validUntil: row.valid_until,
      }
    )
  }

  async saveRfqSwap(record: RfqSwapRecord): Promise<void> {
    const result = await this.driver.run(rebalanceRfqSql.updateRecord, [JSON.stringify(record), record.rfqId])
    if (result.changes !== 1) throw new Error('rebalance recovery origin is missing')
  }

  async getRfqSwap(id: string): Promise<RfqSwapRecord | undefined> {
    return (await this.stored(id))?.record
  }
  async getAllRfqSwaps(): Promise<RfqSwapRecord[]> {
    return (await this.driver.all<Pick<RebalanceRfqRow, 'record_json'>>(rebalanceRfqSql.selectAllRecords)).map((row) =>
      parseRecord(row.record_json),
    )
  }
  async getRfqSwapsPage(
    filter: RfqSwapPageFilter,
    page: PageRequest<RfqSwapPageCursor>,
  ): Promise<PageResult<RfqSwapRecord, RfqSwapPageCursor>> {
    const sorted = (await this.getAllRfqSwaps())
      .filter((record) => filter.state === undefined || record.state === filter.state)
      .filter((record) => filter.since === undefined || record.updatedAt >= filter.since)
      .sort((a, b) => a.updatedAt - b.updatedAt || (a.rfqId < b.rfqId ? -1 : a.rfqId > b.rfqId ? 1 : 0))
    const after = page.after
    const remaining = after
      ? sorted.filter(
          (r) => r.updatedAt > after.updatedAt || (r.updatedAt === after.updatedAt && r.rfqId > after.rfqId),
        )
      : sorted
    return pageResult(remaining, page.limit, (record) => ({ updatedAt: record.updatedAt, rfqId: record.rfqId }))
  }
  async removeRfqSwap(id: string): Promise<void> {
    await this.driver.run(rebalanceRfqSql.deleteById, [id])
  }
}
