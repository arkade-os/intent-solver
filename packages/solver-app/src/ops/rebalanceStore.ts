import type { SqlDriver } from '@arkade-os/solver-core/core/driver.js'
import type { RebalanceTransfer } from '@arkade-os/solver-core/ports/rebalance.js'
import * as sql from './rebalanceStore.sql.js'

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

export class RebalanceStore {
  private constructor(private readonly driver: SqlDriver) {}

  static async open(driver: SqlDriver): Promise<RebalanceStore> {
    await driver.exec(sql.SCHEMA)
    return new RebalanceStore(driver)
  }

  async create(row: RebalanceTransfer): Promise<void> {
    await this.driver.run(sql.insertTransfer, [...params(row), row.id, row.requestKey])
  }

  async save(row: RebalanceTransfer): Promise<void> {
    const result = await this.driver.run(sql.saveTransfer, [
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
    const row = await this.driver.get<{ data: string }>(sql.byId, [id])
    return row ? decode(row.data) : undefined
  }

  async byKey(key: string): Promise<RebalanceTransfer | undefined> {
    const row = await this.driver.get<{ data: string }>(sql.byRequestKey, [key])
    return row ? decode(row.data) : undefined
  }

  async list(limit = 100): Promise<RebalanceTransfer[]> {
    safeInteger(limit, 'limit')
    const rows = await this.driver.all<{ data: string }>(sql.list, [limit])
    return rows.map((row) => decode(row.data))
  }

  async page(
    limit = 20,
    before?: TransferCursor,
  ): Promise<{ transfers: RebalanceTransfer[]; nextCursor: string | null }> {
    safeInteger(limit, 'limit')
    if (limit < 1 || limit > 100 || (before && !validCursor(before))) throw new Error('invalid transfer page')
    const rows = await this.driver.all<{ data: string; createdAt: number; id: string }>(
      sql.page(Boolean(before)),
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
    const rows = await this.driver.all<{ data: string }>(sql.active)
    return rows.map((row) => decode(row.data))
  }

  async protectedTerminalInputs(): Promise<RebalanceTransfer[]> {
    const rows = await this.driver.all<{ data: string }>(sql.protectedTerminalInputs)
    return rows.map((row) => decode(row.data)).filter((row) => row.sourceInputsClearedAt === undefined)
  }

  async checkpointTransfers(since: number): Promise<RebalanceTransfer[]> {
    safeInteger(since, 'checkpoint time')
    const rows = await this.driver.all<{ data: string }>(sql.checkpointTransfers, [since])
    return rows.map((row) => decode(row.data))
  }

  async rollingDebit(now: number): Promise<number> {
    safeInteger(now, 'now')
    const row = await this.driver.get<{ total: number }>(sql.rollingDebit, [now - 86_400, now])
    return safeInteger(row?.total ?? 0, 'rolling debit')
  }

  async lastAttempt(): Promise<number> {
    const row = await this.driver.get<{ at: number }>(sql.lastAttempt)
    return safeInteger(row?.at ?? 0, 'last attempt')
  }

  async recordAttempt(now: number): Promise<void> {
    safeInteger(now, 'attempt time')
    await this.driver.run(sql.recordAttempt, [now])
  }
}
