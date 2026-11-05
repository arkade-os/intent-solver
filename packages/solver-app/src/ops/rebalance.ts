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
import type { RebalanceStore, TransferCursor } from './rebalanceStore.js'

export interface RebalanceSource {
  quote(
    deposit: RebalanceDeposit,
    policy: RebalancePolicy,
    origin?: RebalanceTransfer['origin'],
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
  postNotice?: (text: string) => void
}

const revision = (policy: RebalancePolicy): string =>
  createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16)
const positiveSats = (value: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('amount must be a positive whole safe number of sats')
}
const sats = (value: number): string => value.toLocaleString('en-US')
const poolName = (id: string): string =>
  id === 'rail:shared'
    ? 'the shared backend wallet'
    : id === 'rail:onchain'
      ? 'the backend on-chain wallet'
      : id === 'rail:lightning'
        ? 'the backend Lightning balance'
        : 'the backend pool'
const transferLine = (row: RebalanceTransfer): string =>
  `${row.origin === 'automatic' ? 'Automatic' : 'Manual'} transfer from Arkade to ${poolName(row.poolId)}.\nTransfer ID: ${row.id}`
const skippedReason = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  if (/fee.*(limit|cap|policy)|fees exceed policy/i.test(message)) return 'The quoted fees exceed the policy limit.'
  if (/reserve|inventory|surplus/i.test(message)) return 'Available Arkade funds cannot cover the refill and reserve.'
  if (/allowance|debit limit/i.test(message)) return 'The transfer would exceed a spending limit.'
  if (/counterparty|route.*unavailable/i.test(message)) return 'No approved route can provide this refill.'
  return 'No acceptable transfer quote was available.'
}

export class RebalanceService {
  private readonly serialise = createSerialiser()
  private readonly holds = new Map<string, () => void>()
  private currentPolicy: RebalancePolicy
  private stopped = false
  private ticking?: Promise<void>
  private evaluation?: { at: number; reason: string; nextEligibleAt?: number }
  private lastAttemptFailure?: string
  private readonly now: () => number

  private constructor(private readonly deps: RebalanceDeps) {
    this.currentPolicy = validateRebalancePolicy(deps.policy)
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  }

  private notice(text: string): void {
    try {
      this.deps.postNotice?.(text)
    } catch {
      // A notification failure must not change the recorded transfer state.
    }
  }

  static async create(deps: RebalanceDeps, mode: 'active' | 'passive' = 'active'): Promise<RebalanceService> {
    const service = new RebalanceService(deps)
    // Read-only, so every process registers it: a one-shot's own deposit claims must still honour the live rows.
    deps.backend.protectDeposits?.(() => deps.store.active())
    // Reservations are process-local and the recovery rewrite mutates live rows, so only the one
    // daemon that drives rebalancing may run them; a one-shot CLI sharing the db builds passive.
    if (mode === 'passive') return service
    for (const row of await deps.store.active()) {
      if (row.state === 'submitting') {
        row.state = 'needs_reconciliation'
        row.error = 'Process stopped during submission; reconcile before any new spend.'
        await deps.store.save(row)
        service.notice(
          `⚠️ *Rebalance needs checking*\n${transferLine(row)}\nThe process stopped while sending. The source payment may be in flight; no new refill will start until it is reconciled.`,
        )
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
      this.lastAttemptFailure = undefined
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
    const [page, active] = await Promise.all([this.deps.store.page(100), this.deps.store.active()])
    const known = new Set(page.transfers.map((row) => row.id))
    const transfers = [
      ...page.transfers,
      ...active.filter((row) => {
        if (known.has(row.id)) return false
        known.add(row.id)
        return true
      }),
    ].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    return {
      policy: this.policy(),
      policyRevision: revision(this.currentPolicy),
      pools: readings,
      transfers,
      transfersNextCursor: page.nextCursor,
      lastEvaluation: this.evaluation,
    }
  }

  async transfersPage(limit = 20, before?: TransferCursor) {
    return this.deps.store.page(limit, before)
  }

  async quote(params: {
    poolId: string
    amountSats: number
    requestKey: string
    kind?: DepositKind
    receivingFeeAllowanceSats?: number
  }): Promise<RebalanceTransfer> {
    return this.serialise(() => this.makeQuote(params, 'manual'))
  }

  private async makeQuote(
    params: {
      poolId: string
      amountSats: number
      requestKey: string
      kind?: DepositKind
      receivingFeeAllowanceSats?: number
    },
    origin: 'manual' | 'automatic',
  ): Promise<RebalanceTransfer> {
    if (this.stopped) throw new Error('rebalancing is stopping')
    positiveSats(params.amountSats)
    const receivingFeeAllowanceSats = origin === 'manual' ? (params.receivingFeeAllowanceSats ?? 1000) : undefined
    if (
      receivingFeeAllowanceSats !== undefined &&
      (!Number.isSafeInteger(receivingFeeAllowanceSats) || receivingFeeAllowanceSats < 0)
    )
      throw new Error('receiving fee allowance must be nonnegative whole safe sats')
    if (typeof params.requestKey !== 'string' || !params.requestKey.trim() || params.requestKey.length > 128)
      throw new Error('request key is required and must be at most 128 characters')
    const existing = await this.deps.store.byKey(params.requestKey)
    if (existing) {
      if (
        existing.poolId !== params.poolId ||
        existing.netSats !== params.amountSats ||
        (existing.receivingFeeAllowanceSats !== undefined &&
          existing.receivingFeeAllowanceSats !== receivingFeeAllowanceSats) ||
        (receivingFeeAllowanceSats !== undefined && existing.deposit.feeSats > receivingFeeAllowanceSats) ||
        (params.kind && existing.deposit.kind !== params.kind)
      )
        throw new Error('request key already belongs to a different transfer')
      return existing
    }
    const policy = this.currentPolicy
    if (
      origin === 'automatic' &&
      (params.amountSats < policy.minTransferSats || policy.maxDebitSats === 0 || policy.dailyDebitSats === 0)
    )
      throw new Error('configure debit limits and minimum transfer size before rebalancing')
    const pool = (await this.pools()).find((pool) => pool.id === params.poolId)
    if (!pool) throw new Error('rebalance destination pool is unavailable')
    const failures: string[] = []
    const quotes: RebalanceTransfer[] = []
    for (const kind of pool.kinds) {
      if (params.kind && params.kind !== kind) continue
      try {
        const totalAllowance =
          receivingFeeAllowanceSats ??
          Math.min(policy.maxFeeSats, Number((BigInt(params.amountSats) * BigInt(policy.maxFeeBps)) / 10000n))
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
            deposit.feeSats > feeAllowance ||
            deposit.amountSats - deposit.netSats !== deposit.feeSats
          )
            throw new Error('deposit fee allowance does not match quoted credit')
          source = await this.deps.source.quote(deposit, policy, origin)
          positiveSats(source.debitSats)
          const sourceFee = source.debitSats - deposit.amountSats
          if (!Number.isSafeInteger(sourceFee) || sourceFee < 0) throw new Error('invalid source fee estimate')
          if (origin === 'manual' || source.debitSats - params.amountSats <= totalAllowance) break
          const remaining = totalAllowance - sourceFee
          if (remaining < 0 || remaining >= feeAllowance) break
          feeAllowance = remaining
        }
        if (origin === 'automatic') {
          checkRebalanceFees(policy, params.amountSats, source.debitSats)
          if (source.debitSats > policy.maxDebitSats) throw new Error('transfer exceeds per-transfer debit limit')
          if (source.debitSats + (await this.deps.store.rollingDebit(this.now())) > policy.dailyDebitSats)
            throw new Error('transfer exceeds rolling 24-hour debit limit')
        }
        if (source.feeSats !== source.debitSats - params.amountSats)
          throw new Error('source quote fee does not match debit')
        const now = this.now()
        const expiresAt = Math.min(now + 60, source.expiresAt, deposit.expiresAt ?? Infinity)
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new Error('rebalance quote expired')
        quotes.push({
          id: randomUUID(),
          requestKey: params.requestKey,
          origin,
          ...(receivingFeeAllowanceSats === undefined ? {} : { receivingFeeAllowanceSats }),
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
    if (row.origin !== 'manual' && row.policyRevision !== revision(this.currentPolicy))
      throw new Error('policy changed; request another preview')
    if ((await this.deps.store.active()).length) throw new Error('an active rebalance transfer must resolve first')
    if (row.origin !== 'manual') {
      checkRebalanceFees(this.currentPolicy, row.netSats, row.debitSats)
      if (row.debitSats + (await this.deps.store.rollingDebit(this.now())) > this.currentPolicy.dailyDebitSats)
        throw new Error('rolling 24-hour debit limit reached')
    }
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
    this.notice(
      `⏳ *Rebalance starting*\n${transferLine(row)}\nSubmitting an Arkade payment authorized up to ${sats(row.debitSats)} sats. The destination credit may arrive later; at least ${sats(row.netSats)} sats are expected.`,
    )
    try {
      const txid = await this.deps.source.submit(row)
      if (!/^[0-9a-f]{64}$/i.test(txid))
        throw new Error('submission returned no valid transaction id; reconcile before retrying')
      row.fundingTxid = txid
      row.state = 'pending'
      row.updatedAt = this.now()
      await this.deps.store.save(row)
      this.release(row.id)
      this.notice(
        `⏳ *Rebalance submitted*\n${transferLine(row)}\n${row.deposit.kind === 'onchain' ? 'Bitcoin transaction' : 'Arkade funding transaction'}: ${row.fundingTxid}\nWaiting for at least ${sats(row.netSats)} sats to become spendable at the destination. ${row.deposit.kind === 'onchain' ? 'Bitcoin confirmation and deposit claiming may take time.' : 'The destination invoice must settle.'}`,
      )
    } catch (error) {
      row.state = 'needs_reconciliation'
      row.error = error instanceof Error ? error.message : String(error)
      row.updatedAt = this.now()
      await this.deps.store.save(row)
      this.notice(
        `⚠️ *Rebalance needs checking*\n${transferLine(row)}\nThe Arkade payment was attempted, but its result is uncertain. No new refill will start until it is reconciled.`,
      )
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
            const creditedSats = receipt.netSats
            if (typeof creditedSats !== 'number' || !Number.isSafeInteger(creditedSats) || creditedSats < row.netSats)
              throw new Error('destination credited less than the quoted minimum')
            row.state = 'completed'
            row.creditedSats = creditedSats
            delete row.error
            await this.deps.store.save({ ...row, updatedAt: this.now() })
            this.release(row.id)
            this.notice(
              `✅ *Rebalance credited*\n${transferLine(row)}\n${sats(creditedSats)} sats are now spendable at the destination. The authorized Arkade debit was up to ${sats(row.debitSats)} sats; the final source debit is not recorded separately.`,
            )
            continue
          }
          if (receipt.state === 'failed')
            receiptError = receipt.reason ?? 'destination deposit failed; source recovery remains tracked'
        } catch (error) {
          receiptError = error instanceof Error ? error.message : String(error)
        }
        if (receiptError) row.error = receiptError
        try {
          const previousState = row.state
          const observed = await this.deps.source.reconcile(row)
          if (observed.state === 'submitted' && observed.fundingTxid) {
            if (!/^[0-9a-f]{64}$/i.test(observed.fundingTxid))
              throw new Error('invalid source reconciliation transaction id')
            row.fundingTxid = observed.fundingTxid
            row.state = 'pending'
            if (!receiptError) delete row.error
            await this.deps.store.save({ ...row, updatedAt: this.now() })
            this.release(row.id)
            if (previousState !== 'pending')
              this.notice(
                `⏳ *Rebalance found*\n${transferLine(row)}\nThe Arkade payment was found. Waiting for the destination credit to become spendable.`,
              )
          } else if (observed.state === 'refunded') {
            row.state = 'refunded'
            await this.deps.store.save({ ...row, updatedAt: this.now() })
            this.release(row.id)
            this.notice(
              `↩️ *Rebalance refunded*\n${transferLine(row)}\nThe source refund was observed in Arkade; the destination was not credited. Fees may still apply.`,
            )
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
      const now = this.now()
      const lastAttempt = await this.deps.store.lastAttempt()
      const target = selectRebalanceTarget(policy, balances, {}, now, lastAttempt)
      if (!target) {
        const configured = Object.entries(policy.targets).filter(([, value]) => value.minimumSats > 0)
        const readable = configured.filter(([id]) => {
          const balance = balances[id]
          return typeof balance === 'number' && Number.isSafeInteger(balance) && balance >= 0
        })
        const below = readable.filter(([id, value]) => balances[id]! < value.minimumSats)
        const eligible = below.filter(([id, value]) => value.targetSats - balances[id]! >= policy.minTransferSats)
        if (eligible.length > 0 && lastAttempt > now) {
          this.evaluation.reason = 'The clock is earlier than the last rebalance attempt; automatic refills are paused.'
        } else if (eligible.length > 0 && lastAttempt > 0 && now - lastAttempt < policy.cooldownSeconds) {
          const nextEligibleAt = lastAttempt + policy.cooldownSeconds
          this.evaluation = {
            at: now,
            reason: this.lastAttemptFailure
              ? `Cooling down after a failed attempt: ${this.lastAttemptFailure}`
              : 'Cooling down after the last rebalance attempt.',
            ...(Number.isSafeInteger(nextEligibleAt) && nextEligibleAt <= 8_640_000_000_000 ? { nextEligibleAt } : {}),
          }
        } else if (configured.length === 0) {
          this.evaluation.reason = 'No backend refill trigger is configured.'
        } else if (readable.length < configured.length) {
          this.evaluation.reason =
            'A backend balance could not be read; automatic refill is waiting for a fresh balance.'
        } else if (below.length > 0) {
          this.evaluation.reason = 'The refill amount is below the configured minimum transfer size.'
        } else {
          this.evaluation.reason = 'Backend balances are above their refill triggers.'
        }
        return
      }
      const attemptAt = this.now()
      await this.deps.store.recordAttempt(attemptAt)
      let quoted: RebalanceTransfer | undefined
      try {
        const maximum = Math.min(
          target.netSats,
          policy.maxDebitSats,
          policy.dailyDebitSats - (await this.deps.store.rollingDebit(this.now())),
        )
        if (maximum < policy.minTransferSats) throw new Error('remaining daily allowance below minimum transfer size')
        let amount = maximum
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
        const sent = await this.send(quoted.id)
        this.evaluation.reason = sent.state === 'pending' ? 'refill submitted' : 'refill needs reconciliation'
        this.lastAttemptFailure = undefined
      } catch (error) {
        let storedState: RebalanceTransfer['state'] | undefined
        if (quoted) {
          try {
            storedState = (await this.deps.store.get(quoted.id))?.state
          } catch {
            storedState = undefined
          }
        }
        const noSourceSubmission = !quoted || storedState === 'quoted' || storedState === 'cancelled'
        const reason = noSourceSubmission ? skippedReason(error) : 'The transfer needs checking.'
        this.evaluation.reason = reason
        this.lastAttemptFailure = reason
        this.notice(
          noSourceSubmission
            ? `⚠️ *Automatic rebalance could not start*\nNo funds were sent from Arkade to ${poolName(target.poolId)}. ${reason}\nThe next attempt waits for the configured cooldown.`
            : `⚠️ *Rebalance needs checking*\n${transferLine(quoted!)}\nThe transfer could not be confirmed. Check its state before trying again.`,
        )
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
