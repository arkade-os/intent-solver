import { randomUUID, createHash } from 'node:crypto'
import { createSerialiser } from '@arkade-os/solver-core/util/serialise.js'
import {
  checkRebalanceFees,
  selectRebalanceTarget,
  validateRebalancePolicy,
} from '@arkade-os/solver-core/core/rebalancePolicy.js'
import type {
  DepositKind,
  RebalanceBackend,
  RebalanceDeposit,
  RebalancePolicy,
  RebalancePool,
  RebalanceTransfer,
} from '@arkade-os/solver-core/ports/rebalance.js'
import type { RebalanceStore } from './rebalanceStore.js'

export interface RebalanceSource {
  quote(
    deposit: RebalanceDeposit,
    policy: RebalancePolicy,
  ): Promise<{
    debitSats: number
    feeSats: number
    inputs: RebalanceTransfer['inputs']
    expiresAt: number
    routeData?: Record<string, unknown>
  }>
  reserve(row: RebalanceTransfer, policy: RebalancePolicy, restoring?: boolean): Promise<() => void>
  submit(row: RebalanceTransfer): Promise<string>
  reconcile(row: RebalanceTransfer): Promise<{ state: 'unknown' | 'submitted' | 'refunded'; fundingTxid?: string }>
  close?(): Promise<void>
}

interface RebalanceDeps {
  store: RebalanceStore
  backend: RebalanceBackend
  source: RebalanceSource
  policy: RebalancePolicy
  savePolicy(policy: RebalancePolicy): Promise<void>
  now?: () => number
}

const revision = (policy: RebalancePolicy): string =>
  createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16)
const positiveSats = (value: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('amount must be a positive whole safe number of sats')
}

export class RebalanceService {
  private readonly serialise = createSerialiser()
  private readonly holds = new Map<string, () => void>()
  private currentPolicy: RebalancePolicy
  private stopped = false
  private ticking?: Promise<void>
  private evaluation?: { at: number; reason: string }
  private readonly now: () => number

  private constructor(private readonly deps: RebalanceDeps) {
    this.currentPolicy = validateRebalancePolicy(deps.policy)
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  }

  static async create(deps: RebalanceDeps, opts: { active?: boolean } = {}): Promise<RebalanceService> {
    const service = new RebalanceService(deps)
    // Reservations are process-local and the recovery rewrite mutates live rows, so only the one
    // daemon that drives rebalancing may run them; a one-shot CLI sharing the db builds passive.
    if (opts.active === false) return service
    deps.backend.protectDeposits?.(() => deps.store.active())
    for (const row of await deps.store.active()) {
      if (row.state === 'submitting') {
        row.state = 'needs_reconciliation'
        row.error = 'Process stopped during submission; reconcile before any new spend.'
        await deps.store.save(row)
      }
      if (!row.fundingTxid) service.holds.set(row.id, await deps.source.reserve(row, service.currentPolicy, true))
    }
    return service
  }

  policy(): RebalancePolicy {
    return structuredClone(this.currentPolicy)
  }

  async setPolicy(value: unknown): Promise<RebalancePolicy> {
    return this.serialise(async () => {
      const next = validateRebalancePolicy(value)
      await this.deps.savePolicy(next)
      this.currentPolicy = next
      return this.policy()
    })
  }

  private async pools(): Promise<readonly RebalancePool[]> {
    const pools = await this.deps.backend.pools()
    if (new Set(pools.map((pool) => pool.id)).size !== pools.length)
      throw new Error('duplicate rebalance pool identity')
    return pools
  }

  async overview() {
    const pools = await this.pools()
    const readings = await Promise.all(
      pools.map(async (pool) => {
        try {
          const balanceSats = await pool.readBalance()
          if (!Number.isSafeInteger(balanceSats) || balanceSats < 0) throw new Error('invalid spendable balance')
          return { id: pool.id, label: pool.label, kinds: [...pool.kinds], balanceSats }
        } catch (error) {
          return { id: pool.id, label: pool.label, kinds: [...pool.kinds], balanceSats: null, error: String(error) }
        }
      }),
    )
    return {
      policy: this.policy(),
      policyRevision: revision(this.currentPolicy),
      pools: readings,
      transfers: await this.deps.store.list(),
      lastEvaluation: this.evaluation,
    }
  }

  async quote(params: {
    poolId: string
    amountSats: number
    requestKey: string
    kind?: DepositKind
  }): Promise<RebalanceTransfer> {
    return this.serialise(() => this.makeQuote(params, 'manual'))
  }

  private async makeQuote(
    params: { poolId: string; amountSats: number; requestKey: string; kind?: DepositKind },
    origin: 'manual' | 'automatic',
  ): Promise<RebalanceTransfer> {
    if (this.stopped) throw new Error('rebalancing is stopping')
    positiveSats(params.amountSats)
    if (typeof params.requestKey !== 'string' || !params.requestKey.trim() || params.requestKey.length > 128)
      throw new Error('request key is required and must be at most 128 characters')
    const existing = await this.deps.store.byKey(params.requestKey)
    if (existing) {
      if (
        existing.poolId !== params.poolId ||
        existing.netSats !== params.amountSats ||
        (params.kind && existing.deposit.kind !== params.kind)
      )
        throw new Error('request key already belongs to a different transfer')
      return existing
    }
    const policy = this.currentPolicy
    if (params.amountSats < policy.minTransferSats || policy.maxDebitSats === 0 || policy.dailyDebitSats === 0)
      throw new Error('configure debit limits and minimum transfer size before rebalancing')
    const pool = (await this.pools()).find((pool) => pool.id === params.poolId)
    if (!pool) throw new Error('rebalance destination pool is unavailable')
    const failures: string[] = []
    const quotes: RebalanceTransfer[] = []
    for (const kind of pool.kinds) {
      if (params.kind && params.kind !== kind) continue
      try {
        const totalAllowance = Math.min(
          policy.maxFeeSats,
          Number((BigInt(params.amountSats) * BigInt(policy.maxFeeBps)) / 10000n),
        )
        let feeAllowance = totalAllowance
        let deposit!: RebalanceDeposit
        let source!: Awaited<ReturnType<RebalanceSource['quote']>>
        for (let estimate = 0; estimate < 3; estimate++) {
          deposit = await pool.prepare(kind, params.amountSats, feeAllowance)
          if (deposit.kind !== kind || deposit.netSats !== params.amountSats || !deposit.destination)
            throw new Error('invalid destination deposit quote')
          positiveSats(deposit.amountSats)
          if (
            !Number.isSafeInteger(deposit.feeSats) ||
            deposit.feeSats < 0 ||
            deposit.amountSats - deposit.netSats !== deposit.feeSats
          )
            throw new Error('deposit fee allowance does not match quoted credit')
          source = await this.deps.source.quote(deposit, policy)
          const sourceFee = source.debitSats - deposit.amountSats
          if (!Number.isSafeInteger(sourceFee) || sourceFee < 0) throw new Error('invalid source fee estimate')
          if (source.debitSats - params.amountSats <= totalAllowance) break
          const remaining = totalAllowance - sourceFee
          if (remaining < 0 || remaining >= feeAllowance) break
          feeAllowance = remaining
        }
        checkRebalanceFees(policy, params.amountSats, source.debitSats)
        if (source.debitSats > policy.maxDebitSats) throw new Error('transfer exceeds per-transfer debit limit')
        if (source.debitSats + (await this.deps.store.rollingDebit(this.now())) > policy.dailyDebitSats)
          throw new Error('transfer exceeds rolling 24-hour debit limit')
        if (source.feeSats !== source.debitSats - params.amountSats)
          throw new Error('source quote fee does not match debit')
        const now = this.now()
        const expiresAt = Math.min(now + 60, source.expiresAt, deposit.expiresAt ?? Infinity)
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new Error('rebalance quote expired')
        quotes.push({
          id: randomUUID(),
          requestKey: params.requestKey,
          origin,
          poolId: pool.id,
          netSats: params.amountSats,
          debitSats: source.debitSats,
          feeSats: source.feeSats,
          inputs: source.inputs,
          routeData: source.routeData,
          policyRevision: revision(policy),
          createdAt: now,
          updatedAt: now,
          expiresAt,
          state: 'quoted',
          deposit,
        })
      } catch (error) {
        failures.push(`${kind}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    quotes.sort((a, b) => a.debitSats - b.debitSats || a.deposit.kind.localeCompare(b.deposit.kind))
    const selected = quotes[0]
    if (!selected) throw new Error(failures.join('; ') || 'requested deposit route is unavailable')
    await this.deps.store.create(selected)
    return selected
  }

  async submit(id: string): Promise<RebalanceTransfer> {
    return this.serialise(() => this.send(id))
  }

  private async send(id: string): Promise<RebalanceTransfer> {
    const row = await this.deps.store.get(id)
    if (!row) throw new Error('rebalance quote not found')
    if (row.state !== 'quoted') return row
    if (this.stopped) throw new Error('rebalancing is stopping')
    if (row.expiresAt <= this.now()) throw new Error('rebalance quote expired; request another preview')
    if (row.policyRevision !== revision(this.currentPolicy)) throw new Error('policy changed; request another preview')
    if ((await this.deps.store.active()).length) throw new Error('an active rebalance transfer must resolve first')
    checkRebalanceFees(this.currentPolicy, row.netSats, row.debitSats)
    if (row.debitSats + (await this.deps.store.rollingDebit(this.now())) > this.currentPolicy.dailyDebitSats)
      throw new Error('rolling 24-hour debit limit reached')
    const release = await this.deps.source.reserve(row, this.currentPolicy)
    row.state = 'submitting'
    row.chargedAt = this.now()
    row.updatedAt = this.now()
    try {
      await this.deps.store.save(row)
    } catch (error) {
      release()
      throw error
    }
    this.holds.set(row.id, release)
    try {
      const txid = await this.deps.source.submit(row)
      if (!/^[0-9a-f]{64}$/i.test(txid))
        throw new Error('submission returned no valid transaction id; reconcile before retrying')
      row.fundingTxid = txid
      row.state = 'pending'
      row.updatedAt = this.now()
      await this.deps.store.save(row)
      this.release(row.id)
    } catch (error) {
      row.state = 'needs_reconciliation'
      row.error = error instanceof Error ? error.message : String(error)
      row.updatedAt = this.now()
      await this.deps.store.save(row)
    }
    return row
  }

  async cancel(id: string): Promise<RebalanceTransfer> {
    return this.serialise(async () => {
      const row = await this.deps.store.get(id)
      if (!row || row.state !== 'quoted') throw new Error('only an unsubmitted quote can be cancelled')
      row.state = 'cancelled'
      row.updatedAt = this.now()
      await this.deps.store.save(row)
      return row
    })
  }

  private release(id: string): void {
    this.holds.get(id)?.()
    this.holds.delete(id)
  }

  tick(): Promise<void> {
    if (this.ticking) return this.ticking
    this.ticking = this.serialise(async () => {
      if (this.stopped) return
      if (!this.currentPolicy.enabled && !(await this.deps.store.active()).length && !this.deps.backend.maintain) {
        this.evaluation = { at: this.now(), reason: 'automatic rebalancing disabled' }
        return
      }
      let pools: readonly RebalancePool[] = []
      let poolError: string | undefined
      try {
        pools = await this.pools()
      } catch (error) {
        poolError = error instanceof Error ? error.message : String(error)
      }
      for (const row of await this.deps.store.active()) {
        let receiptError: string | undefined
        try {
          const pool = pools.find((pool) => pool.id === row.poolId)
          if (!pool) throw new Error(poolError ?? 'destination pool unavailable; transfer remains tracked')
          const receipt = await pool.receipt(row.deposit, row.fundingTxid)
          if (receipt.state === 'credited') {
            if (!Number.isSafeInteger(receipt.netSats) || receipt.netSats! < row.netSats)
              throw new Error('destination credited less than the quoted minimum')
            row.state = 'completed'
            row.creditedSats = receipt.netSats
            delete row.error
            await this.deps.store.save({ ...row, updatedAt: this.now() })
            this.release(row.id)
            continue
          }
          if (receipt.state === 'failed')
            receiptError = receipt.reason ?? 'destination deposit failed; source recovery remains tracked'
        } catch (error) {
          receiptError = error instanceof Error ? error.message : String(error)
        }
        if (receiptError) row.error = receiptError
        try {
          const observed = await this.deps.source.reconcile(row)
          if (observed.state === 'submitted' && observed.fundingTxid) {
            if (!/^[0-9a-f]{64}$/i.test(observed.fundingTxid))
              throw new Error('invalid source reconciliation transaction id')
            row.fundingTxid = observed.fundingTxid
            row.state = 'pending'
            if (!receiptError) delete row.error
            await this.deps.store.save({ ...row, updatedAt: this.now() })
            this.release(row.id)
          } else if (observed.state === 'refunded') {
            row.state = 'refunded'
            await this.deps.store.save({ ...row, updatedAt: this.now() })
            this.release(row.id)
          } else if (row.error) await this.deps.store.save({ ...row, updatedAt: this.now() })
        } catch (error) {
          const sourceError = error instanceof Error ? error.message : String(error)
          row.error = receiptError ? `${receiptError}; source recovery: ${sourceError}` : sourceError
          await this.deps.store.save({ ...row, updatedAt: this.now() })
        }
      }
      const policy = this.currentPolicy
      this.evaluation = { at: this.now(), reason: 'automatic rebalancing disabled' }
      try {
        await this.deps.backend.maintain?.()
      } catch (error) {
        this.evaluation.reason = `Deposit maintenance: ${error instanceof Error ? error.message : String(error)}`
        return
      }
      if (!policy.enabled) return
      if (poolError) {
        this.evaluation.reason = poolError
        return
      }
      if ((await this.deps.store.active()).length) {
        this.evaluation.reason = 'waiting for active transfer'
        return
      }
      const balances: Record<string, number | null> = {}
      for (const pool of pools) {
        try {
          balances[pool.id] = await pool.readBalance()
        } catch {
          balances[pool.id] = null
        }
      }
      const target = selectRebalanceTarget(policy, balances, {}, this.now(), await this.deps.store.lastAttempt())
      if (!target) {
        this.evaluation.reason = 'no eligible deficit, or cooldown active'
        return
      }
      await this.deps.store.recordAttempt(this.now())
      try {
        const maximum = Math.min(
          target.netSats,
          policy.maxDebitSats,
          policy.dailyDebitSats - (await this.deps.store.rollingDebit(this.now())),
        )
        if (maximum < policy.minTransferSats) throw new Error('remaining daily allowance below minimum transfer size')
        let amount = maximum
        let quoted: RebalanceTransfer | undefined
        for (let attempt = 0; attempt < 8 && amount >= policy.minTransferSats; attempt++) {
          try {
            quoted = await this.makeQuote(
              { poolId: target.poolId, amountSats: amount, requestKey: randomUUID() },
              'automatic',
            )
            break
          } catch (error) {
            if (attempt === 7 || amount === policy.minTransferSats) throw error
            amount = Math.max(policy.minTransferSats, Math.floor(amount / 2))
          }
        }
        if (!quoted) throw new Error('source surplus cannot cover minimum transfer size')
        await this.send(quoted.id)
        this.evaluation.reason = 'refill submitted'
      } catch (error) {
        this.evaluation.reason = error instanceof Error ? error.message : String(error)
      }
    }).finally(() => {
      this.ticking = undefined
    })
    return this.ticking
  }

  async close(): Promise<void> {
    this.stopped = true
    await this.ticking
    await this.serialise(async () => this.deps.source.close?.())
  }
}
