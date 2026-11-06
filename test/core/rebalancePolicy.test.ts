import { describe, expect, it } from 'vitest'
import {
  checkRebalanceFees,
  disabledRebalancePolicy,
  selectRebalanceTarget,
  validateRebalancePolicy,
} from '../../packages/solver-core/src/core/rebalancePolicy.js'
import type { RebalancePolicy } from '../../packages/solver-core/src/ports/rebalance.js'

const policy = (): RebalancePolicy => ({
  ...disabledRebalancePolicy(),
  enabled: true,
  maxDebitSats: 10_000,
  dailyDebitSats: 30_000,
  maxFeeSats: 100,
  maxFeeBps: 100,
  minTransferSats: 100,
  targets: {
    'rail:onchain': { minimumSats: 1_000, targetSats: 2_000 },
    'rail:lightning': { minimumSats: 2_000, targetSats: 4_000 },
  },
})

describe('rebalance policy', () => {
  it('starts disabled with no monetary defaults', () => {
    expect(disabledRebalancePolicy()).toEqual({
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
    expect(validateRebalancePolicy(disabledRebalancePolicy())).toEqual(disabledRebalancePolicy())
  })

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '10'])('rejects unsafe sats %s', (value) => {
    expect(() => validateRebalancePolicy({ ...policy(), reserveSats: value })).toThrow()
  })

  it('requires explicit spend limits and valid target ranges', () => {
    expect(() => validateRebalancePolicy({ ...disabledRebalancePolicy(), enabled: true })).toThrow()
    for (const field of ['maxDebitSats', 'dailyDebitSats', 'minTransferSats']) {
      expect(() => validateRebalancePolicy({ ...policy(), [field]: 0 })).toThrow()
    }
    expect(() => validateRebalancePolicy({ ...policy(), maxFeeBps: 10_001 })).toThrow()
    expect(() => validateRebalancePolicy({ ...policy(), enabled: 'yes' })).toThrow()
    expect(() =>
      validateRebalancePolicy({ ...policy(), targets: { a: { minimumSats: 10, targetSats: 10 } } }),
    ).toThrow()
    expect(() => validateRebalancePolicy({ ...policy(), targets: [] })).toThrow()
    expect(() => validateRebalancePolicy(null)).toThrow()
  })

  it('validates an explicit discovery key and relay URLs', () => {
    const counterparty = { solverPubkey: 'ab'.repeat(32), relays: ['wss://relay.example', 'ws://localhost:8080'] }
    expect(validateRebalancePolicy({ ...policy(), counterparty }).counterparty).toEqual(counterparty)
    for (const key of ['ab'.repeat(31), 'g'.repeat(64)]) {
      expect(() =>
        validateRebalancePolicy({ ...policy(), counterparty: { ...counterparty, solverPubkey: key } }),
      ).toThrow()
    }
    for (const relays of [[], ['https://relay.example'], ['not a URL'], ['wss://user:password@relay.example']]) {
      expect(() => validateRebalancePolicy({ ...policy(), counterparty: { ...counterparty, relays } })).toThrow()
    }
  })

  it('ranks scarcity, subtracts pending credits and resolves ties by identity', () => {
    expect(selectRebalanceTarget(policy(), { 'rail:onchain': 200, 'rail:lightning': 200 }, {}, 1_000, 0)).toEqual({
      poolId: 'rail:lightning',
      netSats: 3_800,
    })
    expect(
      selectRebalanceTarget(
        policy(),
        { 'rail:onchain': 100, 'rail:lightning': 200 },
        { 'rail:lightning': 500 },
        1_000,
        0,
      ),
    ).toEqual({
      poolId: 'rail:lightning',
      netSats: 3_300,
    })
  })

  it('does not authorize unknown balances, invalid pending credits, or zero minima', () => {
    expect(selectRebalanceTarget(policy(), { 'rail:onchain': null }, {}, 1_000, 0)).toBeNull()
    expect(selectRebalanceTarget(policy(), { 'rail:onchain': NaN }, {}, 1_000, 0)).toBeNull()
    expect(selectRebalanceTarget(policy(), { 'rail:onchain': 0 }, { 'rail:onchain': -1 }, 1_000, 0)).toBeNull()
    expect(
      selectRebalanceTarget(
        { ...policy(), targets: { a: { minimumSats: 0, targetSats: 1_000 } } },
        { a: 0 },
        {},
        1_000,
        0,
      ),
    ).toBeNull()
  })

  it('enforces disabled policy, cooldown, trigger boundary and minimum transfer size', () => {
    expect(selectRebalanceTarget(disabledRebalancePolicy(), { a: 0 }, {}, 1_000, 0)).toBeNull()
    expect(selectRebalanceTarget(policy(), { 'rail:onchain': 0 }, {}, 1_000, 999)).toBeNull()
    expect(selectRebalanceTarget(policy(), { 'rail:onchain': 0 }, {}, 1_000, 700)).not.toBeNull()
    expect(selectRebalanceTarget(policy(), { 'rail:onchain': 1_000 }, {}, 1_000, 0)).toBeNull()
    expect(selectRebalanceTarget(policy(), { 'rail:onchain': 0 }, { 'rail:onchain': 1_950 }, 1_000, 0)).toBeNull()
  })

  it('enforces both fee caps without rounding away a fractional-sat limit', () => {
    expect(() => checkRebalanceFees(policy(), 100, 101)).not.toThrow()
    expect(() => checkRebalanceFees(policy(), 99, 100)).toThrow()
    expect(() => checkRebalanceFees({ ...policy(), maxFeeSats: 0 }, 10_000, 10_001)).toThrow()
    expect(() => checkRebalanceFees(policy(), 100, 99)).toThrow()
    expect(() => checkRebalanceFees(policy(), Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).not.toThrow()
    expect(() => checkRebalanceFees(policy(), 0, 1)).toThrow()
    expect(() => checkRebalanceFees(policy(), 100, Infinity)).toThrow()
  })

  it('keeps exact fee comparisons above the safe range of intermediate products', () => {
    const bounded = { ...policy(), maxFeeSats: Number.MAX_SAFE_INTEGER, maxFeeBps: 1 }
    const net = 4_503_599_627_370_495
    expect(() => checkRebalanceFees(bounded, net, net + 450_359_962_737)).not.toThrow()
    expect(() => checkRebalanceFees(bounded, net, net + 450_359_962_738)).toThrow()
    expect(validateRebalancePolicy({ ...policy(), maxFeeSats: 0, maxFeeBps: 0 }).enabled).toBe(true)
  })
})
