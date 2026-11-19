import type { SQLExecutor } from '@arkade-os/sdk/repositories/sqlite'
import { hex } from '@scure/base'
import type { ReservationLedger, ReleaseReservation } from './reservations.js'
import {
  validateDirectFillGraph,
  validateDirectFillConflict,
  validateDirectFillFundingAssets,
  type DirectFillGraph,
} from './directFillGraph.js'

export interface DirectFillParent {
  kind: 'offer' | 'rfq' | 'standalone'
  id: string
}

export interface DirectFillOutpoint {
  txid: string
  vout: number
}

export interface DirectFillFunding extends DirectFillOutpoint {
  value: number
  script: string
  assets: { assetId: string; amount: string }[]
}

export interface DirectFillAttempt {
  key: string
  parent: DirectFillParent
  deposit: DirectFillOutpoint
  offerPkScript: string
  funding: DirectFillFunding[]
  proceedsScript: string
  createdAt: number
  phase: 'prepared' | 'submitting' | 'cancelling' | 'settled' | 'cancelled' | 'abandoned'
  graph?: DirectFillGraph
  conflict?: DirectFillGraph
  outcomeTxid?: string
  acknowledged: boolean
}

const keyOf = (parent: DirectFillParent): string => `${parent.kind}:${parent.id}`
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const TXID = /^[0-9a-f]{64}$/
const outpointValid = (coin: DirectFillOutpoint): boolean =>
  typeof coin?.txid === 'string' && TXID.test(coin.txid) && Number.isSafeInteger(coin.vout) && coin.vout >= 0

export class DirectFillAttempts {
  private readonly pins = new Map<string, ReleaseReservation>()
  private readonly active = new Set<string>()

  private constructor(
    private readonly db: SQLExecutor,
    private readonly reservations: ReservationLedger,
    private readonly walletIdentity: string,
    private readonly proceedsScript: string,
    private readonly now: () => number,
  ) {}

  static async open(
    db: SQLExecutor,
    reservations: ReservationLedger,
    walletIdentity: string,
    proceedsScript: string,
    now: () => number = () => Math.floor(Date.now() / 1000),
  ): Promise<DirectFillAttempts> {
    await db.run(`CREATE TABLE IF NOT EXISTS direct_fill_attempt (
      id TEXT PRIMARY KEY, wallet_identity TEXT NOT NULL, deposit TEXT NOT NULL,
      acknowledged INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL)`)
    await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS direct_fill_deposit_hold
      ON direct_fill_attempt(wallet_identity, deposit) WHERE acknowledged = 0`)
    if (!/^5120[0-9a-f]{64}$/.test(proceedsScript))
      throw new Error('direct fill requires the current wallet P2TR script')
    const store = new DirectFillAttempts(db, reservations, walletIdentity, proceedsScript, now)
    for (const attempt of await store.list()) {
      store.pin(attempt)
      if (attempt.phase === 'prepared') await store.change(attempt, { ...attempt, phase: 'abandoned' })
    }
    return store
  }

  private parse(row: {
    id: string
    wallet_identity: string
    deposit: string
    acknowledged: number
    body: string
  }): DirectFillAttempt {
    const attempt = JSON.parse(row.body) as DirectFillAttempt
    if (
      row.wallet_identity !== this.walletIdentity ||
      !attempt ||
      !['offer', 'rfq', 'standalone'].includes(attempt.parent?.kind) ||
      typeof attempt.parent.id !== 'string' ||
      !attempt.parent.id ||
      attempt.key !== keyOf(attempt.parent) ||
      row.id !== attempt.key ||
      !outpointValid(attempt.deposit) ||
      row.deposit !== `${attempt.deposit.txid}:${attempt.deposit.vout}` ||
      !Array.isArray(attempt.funding) ||
      attempt.funding.length === 0 ||
      !attempt.funding.every(outpointValid) ||
      !attempt.funding.every(
        (coin) =>
          Number.isSafeInteger(coin.value) &&
          coin.value > 0 &&
          /^(?:[0-9a-f]{2})+$/.test(coin.script) &&
          Array.isArray(coin.assets) &&
          coin.assets.every((asset) => /^[0-9a-f]{68}$/.test(asset.assetId) && /^[1-9][0-9]*$/.test(asset.amount)) &&
          new Set(coin.assets.map((asset) => asset.assetId)).size === coin.assets.length,
      ) ||
      new Set(attempt.funding.map((coin) => `${coin.txid}:${coin.vout}`)).size !== attempt.funding.length ||
      !/^(?:[0-9a-f]{2})+$/.test(attempt.offerPkScript) ||
      attempt.proceedsScript !== this.proceedsScript ||
      !Number.isSafeInteger(attempt.createdAt) ||
      attempt.createdAt < 0 ||
      !['prepared', 'submitting', 'cancelling', 'settled', 'cancelled', 'abandoned'].includes(attempt.phase) ||
      typeof attempt.acknowledged !== 'boolean' ||
      Number(attempt.acknowledged) !== row.acknowledged
    )
      throw new Error(`invalid direct fill journal row ${row.id}`)
    if (!['prepared', 'abandoned'].includes(attempt.phase)) {
      if (!attempt.graph) throw new Error(`direct fill ${row.id} has no committed graph`)
      const built = validateDirectFillGraph(attempt.graph, [attempt.deposit, ...attempt.funding])
      validateDirectFillFundingAssets(attempt.graph, attempt.funding)
      if (hex.encode(built.checkpoints[0]!.getInput(0).witnessUtxo!.script) !== attempt.offerPkScript) {
        throw new Error(`direct fill ${row.id} deposit script changed`)
      }
      for (const [index, coin] of attempt.funding.entries()) {
        const witness = built.checkpoints[index + 1]!.getInput(0).witnessUtxo!
        if (witness.amount !== BigInt(coin.value) || hex.encode(witness.script) !== coin.script) {
          throw new Error(`direct fill ${row.id} funding commitment changed`)
        }
      }
    }
    if (['cancelling', 'cancelled'].includes(attempt.phase) && !attempt.conflict) {
      throw new Error(`direct fill ${row.id} has no committed conflict`)
    }
    if (attempt.conflict) validateDirectFillConflict(attempt.conflict, attempt.funding, attempt.proceedsScript)
    if (
      ['prepared', 'abandoned'].includes(attempt.phase) &&
      (attempt.graph || attempt.conflict || attempt.outcomeTxid)
    ) {
      throw new Error(`direct fill ${row.id} has graph evidence before submission`)
    }
    if (['settled', 'cancelled'].includes(attempt.phase) && !TXID.test(attempt.outcomeTxid ?? '')) {
      throw new Error(`direct fill ${row.id} has no proven outcome`)
    }
    if (
      attempt.phase === 'settled' &&
      attempt.outcomeTxid !== validateDirectFillGraph(attempt.graph!, [attempt.deposit, ...attempt.funding]).txid
    ) {
      throw new Error(`direct fill ${row.id} outcome differs from original graph`)
    }
    if (
      attempt.phase === 'cancelled' &&
      attempt.outcomeTxid !==
        validateDirectFillConflict(attempt.conflict!, attempt.funding, attempt.proceedsScript).txid
    ) {
      throw new Error(`direct fill ${row.id} outcome differs from conflict graph`)
    }
    if (attempt.acknowledged && !['settled', 'cancelled', 'abandoned'].includes(attempt.phase)) {
      throw new Error(`direct fill ${row.id} acknowledged before resolution`)
    }
    return attempt
  }

  async read(key: string): Promise<DirectFillAttempt | undefined> {
    const row = await this.db.get<{
      id: string
      wallet_identity: string
      deposit: string
      acknowledged: number
      body: string
    }>('SELECT * FROM direct_fill_attempt WHERE id = ?', [key])
    return row ? this.parse(row) : undefined
  }

  async list(): Promise<DirectFillAttempt[]> {
    for (const [key, release] of this.pins) {
      const stored = await this.read(key)
      if (!stored) throw new Error(`direct fill ${key} pinned journal row vanished`)
      if (stored.acknowledged) {
        release()
        this.pins.delete(key)
      }
    }
    const rows = await this.db.all<{
      id: string
      wallet_identity: string
      deposit: string
      acknowledged: number
      body: string
    }>('SELECT * FROM direct_fill_attempt WHERE acknowledged = 0 ORDER BY id')
    return rows.map((row) => this.parse(row))
  }

  private pin(attempt: DirectFillAttempt): void {
    if (!attempt.acknowledged && !this.pins.has(attempt.key)) {
      this.pins.set(attempt.key, this.reservations.reserve(attempt.funding))
    }
  }

  async prepare(
    input: Pick<DirectFillAttempt, 'parent' | 'deposit' | 'funding' | 'offerPkScript' | 'proceedsScript'>,
  ): Promise<DirectFillAttempt> {
    const attempt: DirectFillAttempt = {
      ...input,
      key: keyOf(input.parent),
      phase: 'prepared',
      createdAt: this.now(),
      acknowledged: false,
    }
    this.parse({
      id: attempt.key,
      wallet_identity: this.walletIdentity,
      deposit: `${attempt.deposit.txid}:${attempt.deposit.vout}`,
      acknowledged: 0,
      body: JSON.stringify(attempt),
    })
    if (this.active.has(attempt.key)) throw new Error(`direct fill ${attempt.key} is already in flight`)
    this.active.add(attempt.key)
    try {
      await this.db.run('INSERT INTO direct_fill_attempt(id, wallet_identity, deposit, body) VALUES (?, ?, ?, ?)', [
        attempt.key,
        this.walletIdentity,
        `${attempt.deposit.txid}:${attempt.deposit.vout}`,
        JSON.stringify(attempt),
      ])
      const stored = await this.read(attempt.key)
      if (!same(stored, attempt)) throw new Error(`direct fill ${attempt.key} critical write did not persist`)
      this.pin(attempt)
      return attempt
    } catch (error) {
      this.active.delete(attempt.key)
      const stored = await this.read(attempt.key)
      if (stored) this.pin(stored)
      throw error
    }
  }

  async change(expected: DirectFillAttempt, next: DirectFillAttempt): Promise<boolean> {
    if (expected.acknowledged) throw new Error('direct fill already acknowledged')
    const edges: Record<DirectFillAttempt['phase'], readonly DirectFillAttempt['phase'][]> = {
      prepared: ['submitting', 'abandoned'],
      submitting: ['cancelling', 'settled'],
      cancelling: ['settled', 'cancelled'],
      settled: [],
      cancelled: [],
      abandoned: [],
    }
    if (expected.phase !== next.phase && !edges[expected.phase].includes(next.phase)) {
      throw new Error(`illegal direct fill transition ${expected.phase} -> ${next.phase}`)
    }
    if (
      expected.key !== next.key ||
      !same(expected.parent, next.parent) ||
      !same(expected.deposit, next.deposit) ||
      !same(expected.funding, next.funding) ||
      expected.offerPkScript !== next.offerPkScript ||
      expected.proceedsScript !== next.proceedsScript ||
      expected.createdAt !== next.createdAt ||
      (expected.graph !== undefined && !same(expected.graph, next.graph)) ||
      (expected.conflict !== undefined && !same(expected.conflict, next.conflict))
    ) {
      throw new Error('direct fill immutable commitment changed')
    }
    const body = JSON.stringify(next)
    this.parse({
      id: next.key,
      wallet_identity: this.walletIdentity,
      deposit: `${next.deposit.txid}:${next.deposit.vout}`,
      acknowledged: Number(next.acknowledged),
      body,
    })
    const changed = await this.db.get<{ id: string }>(
      'UPDATE direct_fill_attempt SET body = ?, acknowledged = ? WHERE id = ? AND body = ? RETURNING id',
      [body, Number(next.acknowledged), expected.key, JSON.stringify(expected)],
    )
    if (!changed) return false
    if (!same(await this.read(next.key), next)) throw new Error(`direct fill ${next.key} CAS readback failed`)
    return true
  }

  finishInvocation(key: string): void {
    this.active.delete(key)
  }
  invocationActive(key: string): boolean {
    return this.active.has(key)
  }

  async acknowledge(expected: DirectFillAttempt): Promise<boolean> {
    const next = { ...expected, acknowledged: true }
    try {
      if (!(await this.change(expected, next)) && !same(await this.read(expected.key), next)) return false
    } catch (error) {
      if (!same(await this.read(expected.key), next)) throw error
    }
    this.pins.get(expected.key)?.()
    this.pins.delete(expected.key)
    return true
  }
}
