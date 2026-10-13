import type { SqlDriver } from '@arkade-os/solver-core/core/driver.js'
import type { RebalanceTransfer } from '@arkade-os/solver-core/ports/rebalance.js'

const ACTIVE = "'submitting', 'pending', 'needs_reconciliation'"
const SCHEMA = `
CREATE TABLE IF NOT EXISTS rebalance_transfer (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  charged_at INTEGER,
  debit_sats TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rebalance_active_source
  ON rebalance_transfer ((1)) WHERE state IN (${ACTIVE});
CREATE INDEX IF NOT EXISTS idx_rebalance_charged ON rebalance_transfer (charged_at);
CREATE TABLE IF NOT EXISTS rebalance_clock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_attempt INTEGER NOT NULL
);
`

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

const encode = (row: RebalanceTransfer): string =>
  JSON.stringify({
    ...row,
    netSats: decimal(row.netSats, 'netSats'),
    debitSats: decimal(row.debitSats, 'debitSats'),
    feeSats: decimal(row.feeSats, 'feeSats'),
    ...(row.creditedSats === undefined ? {} : { creditedSats: decimal(row.creditedSats, 'creditedSats') }),
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
    ...(row.creditedSats === undefined ? {} : { creditedSats: amount(row.creditedSats, 'creditedSats') }),
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
    await driver.exec(SCHEMA)
    return new RebalanceStore(driver)
  }

  async create(row: RebalanceTransfer): Promise<void> {
    await this.driver.run(
      'INSERT INTO rebalance_transfer (state, created_at, charged_at, debit_sats, data, id, request_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [...params(row), row.id, row.requestKey],
    )
  }

  async save(row: RebalanceTransfer): Promise<void> {
    const result = await this.driver.run(
      `UPDATE rebalance_transfer SET state = ?, created_at = ?, charged_at = ?, debit_sats = ?, data = ?
       WHERE id = ? AND request_key = ?
       AND (state NOT IN (${ACTIVE}) OR ? NOT IN ('quoted', 'cancelled', 'failed'))
       AND (state NOT IN ('completed', 'refunded', 'failed', 'cancelled') OR state = ?)
       AND (charged_at IS NULL OR (charged_at = ? AND debit_sats = ?))`,
      [...params(row), row.id, row.requestKey, row.state, row.state, row.chargedAt ?? null, String(row.debitSats)],
    )
    if (result.changes !== 1)
      throw new Error('rebalance transfer missing, request key changed, or unsafe state/charge transition')
  }

  async get(id: string): Promise<RebalanceTransfer | undefined> {
    const row = await this.driver.get<{ data: string }>('SELECT data FROM rebalance_transfer WHERE id = ?', [id])
    return row ? decode(row.data) : undefined
  }

  async byKey(key: string): Promise<RebalanceTransfer | undefined> {
    const row = await this.driver.get<{ data: string }>('SELECT data FROM rebalance_transfer WHERE request_key = ?', [
      key,
    ])
    return row ? decode(row.data) : undefined
  }

  async list(limit = 100): Promise<RebalanceTransfer[]> {
    safeInteger(limit, 'limit')
    const rows = await this.driver.all<{ data: string }>(
      'SELECT data FROM rebalance_transfer ORDER BY created_at DESC, id DESC LIMIT ?',
      [limit],
    )
    return rows.map((row) => decode(row.data))
  }

  async active(): Promise<RebalanceTransfer[]> {
    const rows = await this.driver.all<{ data: string }>(
      `SELECT data FROM rebalance_transfer WHERE state IN (${ACTIVE})`,
    )
    return rows.map((row) => decode(row.data))
  }

  async rollingDebit(now: number): Promise<number> {
    safeInteger(now, 'now')
    const row = await this.driver.get<{ total: number }>(
      "SELECT COALESCE(SUM(CAST(debit_sats AS INTEGER)), 0) AS total FROM rebalance_transfer WHERE charged_at > ? AND charged_at <= ? AND state NOT IN ('failed', 'cancelled')",
      [now - 86_400, now],
    )
    return safeInteger(row?.total ?? 0, 'rolling debit')
  }

  async lastAttempt(): Promise<number> {
    const row = await this.driver.get<{ at: number }>(
      `SELECT MAX(at) AS at FROM (
        SELECT COALESCE(MAX(charged_at), 0) AS at FROM rebalance_transfer
        UNION ALL SELECT last_attempt AS at FROM rebalance_clock WHERE id = 1
      )`,
    )
    return safeInteger(row?.at ?? 0, 'last attempt')
  }

  async recordAttempt(now: number): Promise<void> {
    safeInteger(now, 'attempt time')
    await this.driver.run(
      'INSERT INTO rebalance_clock (id, last_attempt) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET last_attempt = MAX(last_attempt, excluded.last_attempt)',
      [now],
    )
  }
}
