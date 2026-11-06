import type { RebalancePolicy } from '../ports/rebalance.js'

const integer = (value: unknown, name: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`)
  }
  return value
}

const object = (value: unknown, name: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value as Record<string, unknown>
}

export const disabledRebalancePolicy = (): RebalancePolicy => ({
  enabled: false,
  reserveSats: 0,
  maxDebitSats: 0,
  dailyDebitSats: 0,
  maxFeeSats: 0,
  maxFeeBps: 0,
  minTransferSats: 0,
  cooldownSeconds: 300,
  targets: {},
})

export const validateRebalancePolicy = (value: unknown): RebalancePolicy => {
  const input = object(value, 'policy')
  if (typeof input.enabled !== 'boolean') throw new Error('enabled must be a boolean')
  const policy: RebalancePolicy = {
    enabled: input.enabled,
    reserveSats: integer(input.reserveSats, 'reserveSats'),
    maxDebitSats: integer(input.maxDebitSats, 'maxDebitSats'),
    dailyDebitSats: integer(input.dailyDebitSats, 'dailyDebitSats'),
    maxFeeSats: integer(input.maxFeeSats, 'maxFeeSats'),
    maxFeeBps: integer(input.maxFeeBps, 'maxFeeBps'),
    minTransferSats: integer(input.minTransferSats, 'minTransferSats'),
    cooldownSeconds: integer(input.cooldownSeconds, 'cooldownSeconds'),
    targets: Object.fromEntries(
      Object.entries(object(input.targets, 'targets')).map(([id, value]) => {
        if (!id.trim()) throw new Error('target pool identity must not be empty')
        const target = object(value, `targets.${id}`)
        const minimumSats = integer(target.minimumSats, `targets.${id}.minimumSats`)
        const targetSats = integer(target.targetSats, `targets.${id}.targetSats`)
        if (minimumSats >= targetSats) throw new Error(`targets.${id}: minimum must be below target`)
        return [id, { minimumSats, targetSats }]
      }),
    ),
  }
  if (policy.maxFeeBps > 10_000) throw new Error('maxFeeBps must not exceed 10000')
  if (policy.enabled && (!policy.maxDebitSats || !policy.dailyDebitSats || !policy.minTransferSats)) {
    throw new Error('enabled policy requires positive debit limits and minimum transfer size')
  }
  if (input.counterparty !== undefined) {
    const counterparty = object(input.counterparty, 'counterparty')
    if (typeof counterparty.solverPubkey !== 'string' || !/^[a-fA-F0-9]{64}$/.test(counterparty.solverPubkey)) {
      throw new Error('counterparty solverPubkey must be a 64-character hex key')
    }
    if (!Array.isArray(counterparty.relays) || counterparty.relays.length === 0) {
      throw new Error('counterparty requires relay URLs')
    }
    const relays = counterparty.relays.map((relay: unknown) => {
      if (typeof relay !== 'string') throw new Error('relay must be a URL')
      const url = new URL(relay)
      if (!['wss:', 'ws:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
        throw new Error('relay must be a websocket URL without credentials or fragment')
      }
      return relay
    })
    policy.counterparty = { solverPubkey: counterparty.solverPubkey, relays }
  }
  return policy
}

export const selectRebalanceTarget = (
  policy: RebalancePolicy,
  balances: Record<string, number | null>,
  pending: Record<string, number>,
  now: number,
  lastAttempt: number,
): { poolId: string; netSats: number } | null => {
  if (!policy.enabled || !Number.isSafeInteger(now) || !Number.isSafeInteger(lastAttempt) || now < lastAttempt)
    return null
  if (lastAttempt > 0 && now - lastAttempt < policy.cooldownSeconds) return null
  const candidates = Object.entries(policy.targets).flatMap(([poolId, target]) => {
    const balance = balances[poolId]
    const credit = pending[poolId] ?? 0
    if (
      target.minimumSats <= 0 ||
      typeof balance !== 'number' ||
      !Number.isSafeInteger(balance) ||
      balance < 0 ||
      balance >= target.minimumSats ||
      !Number.isSafeInteger(credit) ||
      credit < 0
    )
      return []
    const net = BigInt(target.targetSats) - BigInt(balance) - BigInt(credit)
    if (net < BigInt(policy.minTransferSats) || net <= 0n) return []
    return [{ poolId, netSats: Number(net), balance, minimum: target.minimumSats }]
  })
  candidates.sort((a, b) => {
    const left = BigInt(a.balance) * BigInt(b.minimum)
    const right = BigInt(b.balance) * BigInt(a.minimum)
    return left < right ? -1 : left > right ? 1 : a.poolId < b.poolId ? -1 : a.poolId > b.poolId ? 1 : 0
  })
  const selected = candidates[0]
  return selected ? { poolId: selected.poolId, netSats: selected.netSats } : null
}

export const checkRebalanceFees = (policy: RebalancePolicy, netSats: number, debitSats: number): void => {
  integer(netSats, 'netSats')
  integer(debitSats, 'debitSats')
  integer(policy.maxFeeSats, 'maxFeeSats')
  integer(policy.maxFeeBps, 'maxFeeBps')
  if (netSats === 0 || debitSats < netSats) throw new Error('source debit must cover positive net credit')
  const fees = BigInt(debitSats) - BigInt(netSats)
  if (fees > BigInt(policy.maxFeeSats) || fees * 10_000n > BigInt(netSats) * BigInt(policy.maxFeeBps)) {
    throw new Error('rebalance fees exceed policy limits')
  }
}
