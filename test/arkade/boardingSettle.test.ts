/**
 * What a boarding settle offers the operator, and what it refuses to send. The
 * server evaluates the SAME fee programs over its own copy, so every case here
 * is a difference that would be a rejected intent.
 */

import { describe, it, expect } from 'vitest'
import { ArkAddress } from '@arkade-os/sdk'
import { planBoardingSettle, type BoardingUtxo } from '@arkade-os/solver-arkade/arkade/boardingSettle.js'
import type { PoolRung } from '@arkade-os/solver-arkade/arkade/vtxoPool.js'

const ADDRESS = new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(3), 'tark').encode()

const utxo = (value: number, txid = `b-${value}`, confirmed = true): BoardingUtxo => ({
  txid,
  vout: 0,
  value,
  status: { confirmed },
})

const plan = (boarding: BoardingUtxo[], overrides: Partial<Parameters<typeof planBoardingSettle>[0]> = {}) =>
  planBoardingSettle({
    boarding,
    expired: new Set<string>(),
    intentFee: {},
    vtxoMaxAmount: -1n,
    dust: 1000n,
    address: ADDRESS,
    target: [] as PoolRung[],
    ...overrides,
  })

const total = (outputs: readonly bigint[]) => outputs.reduce((sum, amount) => sum + amount, 0n)

describe('planBoardingSettle', () => {
  it('offers the whole boarded value when the operator charges nothing', () => {
    const result = plan([utxo(50_000), utxo(30_000)])

    expect(result.settle).toBe(true)
    if (!result.settle) return
    expect(result.inputs.map((i) => i.txid)).toEqual(['b-50000', 'b-30000'])
    expect(total(result.outputs)).toBe(80_000n)
  })

  it('pays a per-input ONCHAIN fee, which is the program boarding is priced by', () => {
    const result = plan([utxo(50_000), utxo(30_000)], { intentFee: { onchainInput: '250.0' } })

    expect(result.settle).toBe(true)
    if (!result.settle) return
    expect(total(result.outputs)).toBe(79_500n)
  })

  // Boarding inputs are not VTXOs; charging it would over-pay the operator.
  it('does not pay the offchain input fee on a boarding input', () => {
    const result = plan([utxo(50_000)], { intentFee: { offchainInput: 'amount * 0.5' } })

    expect(result.settle).toBe(true)
    if (!result.settle) return
    expect(total(result.outputs)).toBe(50_000n)
  })

  it('prices the output fee too, at each piece’s own size', () => {
    const result = plan([utxo(100_000)], {
      intentFee: { offchainOutput: 'amount * 0.01' },
      target: [{ size: 25_000, want: 2 }],
    })

    expect(result.settle).toBe(true)
    if (!result.settle) return
    expect(result.outputs.slice(0, 2)).toEqual([25_000n, 25_000n])
    const withFees = result.outputs.reduce((sum, amount) => sum + amount + amount / 100n, 0n)
    expect(withFees).toBeLessThanOrEqual(100_000n)
  })

  it('drops an input worth less than its own fee instead of settling it', () => {
    const result = plan([utxo(50_000), utxo(1_500)], { intentFee: { onchainInput: '2000.0' } })

    expect(result.settle).toBe(true)
    if (!result.settle) return
    expect(result.inputs.map((i) => i.txid)).toEqual(['b-50000'])
  })

  it('carves the deposit into the pool’s shape rather than one coin', () => {
    const result = plan([utxo(500_000)], {
      target: [
        { size: 25_000, want: 4 },
        { size: 100_000, want: 3 },
      ],
    })

    expect(result.settle).toBe(true)
    if (!result.settle) return
    expect(result.outputs.length).toBeGreaterThan(1)
    expect(total(result.outputs)).toBe(500_000n)
  })

  // One output over the ceiling is refused outright, so a bigger deposit has to
  // come back as several pieces or not at all.
  it('keeps every piece under the operator’s per-output ceiling', () => {
    const result = plan([utxo(500_000)], { vtxoMaxAmount: 150_000n })

    expect(result.settle).toBe(true)
    if (!result.settle) return
    expect(result.outputs.every((amount) => amount <= 150_000n)).toBe(true)
  })

  it('refuses an input the sweep owns, however much it is worth', () => {
    const gone = utxo(500_000, 'gone')
    const result = plan([gone], { expired: new Set(['gone:0']) })

    expect(result).toEqual({ settle: false, reason: 'nothing-settleable' })
  })

  it('refuses an unconfirmed input', () => {
    const result = plan([utxo(500_000, 'pending', false)])

    expect(result).toEqual({ settle: false, reason: 'nothing-settleable' })
  })

  it('refuses when there is nothing at the boarding address', () => {
    expect(plan([])).toEqual({ settle: false, reason: 'nothing-boarded' })
  })

  // FeeAmount.value is a raw float and .satoshis is Math.ceil(value). Guarding on
  // one and deducting the other admits a coin that contributes nothing.
  it('drops an input whose ceiled fee leaves it nothing to contribute', () => {
    // 249.75 ceils to 250, so the 250 coin nets exactly nothing.
    const result = plan([utxo(2_000_000), utxo(250)], { intentFee: { onchainInput: 'amount * 0.999' } })

    expect(result.settle).toBe(true)
    if (!result.settle) return
    expect(result.inputs.map((i) => i.txid)).toEqual(['b-2000000'])
  })

  it('refuses when every input is below its own fee', () => {
    const result = plan([utxo(1_500)], { intentFee: { onchainInput: '2000.0' } })

    expect(result).toEqual({ settle: false, reason: 'below-its-own-fee' })
  })

  it('refuses when the fees have driven the output under dust', () => {
    const result = plan([utxo(1_200)], { intentFee: { onchainInput: '900.0' } })

    expect(result).toEqual({ settle: false, reason: 'below-dust' })
  })
})
