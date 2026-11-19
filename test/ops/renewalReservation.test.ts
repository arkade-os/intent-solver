import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { BatchRegistration, SettleParams } from '@arkade-os/sdk'
import { SQLiteBatchRegistrationRepository } from '@arkade-os/sdk/repositories/sqlite'
import { createReservationLedger } from '@arkade-os/solver-arkade/arkade/reservations.js'
import { sqliteExecutor, type ArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { settleReservedRenewal } from '@arkade-os/solver-app/ops/float.js'

const directory = mkdtempSync(join(tmpdir(), 'solver-renewal-'))
const executors: ReturnType<typeof sqliteExecutor>[] = []
const point = { txid: 'ab'.repeat(32), vout: 0 }
const params = { inputs: [{ ...point, value: 10_000 }], outputs: [] } as unknown as SettleParams
const registration: BatchRegistration = {
  proofTxId: 'cd'.repeat(32),
  state: 'waiting_for_batch',
  createdAt: 1,
  updatedAt: 1,
  registerProof: 'registered-proof',
  registerProofMessage: '{}',
  deleteProof: 'delete-proof',
  deleteProofMessage: '{}',
  partialForfeits: [],
  proofInputs: [point],
}

const repository = (name: string) => {
  const executor = sqliteExecutor(join(directory, name))
  executors.push(executor)
  return new SQLiteBatchRegistrationRepository(executor)
}
const context = (repo: SQLiteBatchRegistrationRepository, settle: ReturnType<typeof vi.fn>) =>
  ({ wallet: { intentRepository: repo, settle }, reservations: createReservationLedger() }) as unknown as ArkadeContext

afterEach(() => {
  for (const executor of executors.splice(0)) executor.close()
})

afterAll(() => {
  if (!directory.startsWith(join(tmpdir(), 'solver-renewal-'))) throw new Error('unexpected renewal fixture path')
  rmSync(directory, { recursive: true, force: true })
})

describe('renewal reservation ownership', () => {
  it('keeps an uncertain registered input locked across restart and releases it after confirmed cancellation', async () => {
    const repo = repository('restart.sqlite')
    const failed = vi.fn(async () => {
      await repo.saveBatchRegistration(registration)
      throw new Error('registration response lost')
    })
    const initial = context(repo, failed)
    await expect(settleReservedRenewal(initial, params)).rejects.toThrow('registration response lost')
    expect(initial.reservations.reserved().size).toBe(0)
    expect(await repo.getLockedVtxoOutpoints()).toEqual([point])
    executors.pop()!.close()

    const reopened = repository('restart.sqlite')
    const settle = vi.fn(async () => 'settled')
    const restarted = context(reopened, settle)
    await expect(settleReservedRenewal(restarted, params)).rejects.toThrow('reserved by another operation')
    expect(settle).not.toHaveBeenCalled()
    await reopened.saveBatchRegistration({ ...registration, state: 'cancelled' })
    await expect(settleReservedRenewal(restarted, params)).resolves.toBe('settled')
    expect(restarted.reservations.reserved().size).toBe(0)
  })

  it('excludes a concurrent spend before registration has been persisted', async () => {
    const repo = repository('concurrent.sqlite')
    let finish!: (txid: string) => void
    const settle = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)))
    const arkade = context(repo, settle)
    const first = settleReservedRenewal(arkade, params)
    await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce())
    await expect(settleReservedRenewal(arkade, params)).rejects.toThrow('reserved by another operation')
    finish('settled')
    await expect(first).resolves.toBe('settled')
    expect(arkade.reservations.reserved().size).toBe(0)
  })

  it('fails closed if durable ownership cannot be read', async () => {
    const repo = repository('unreadable.sqlite')
    vi.spyOn(repo, 'getLockedVtxoOutpoints').mockRejectedValue(new Error('database unavailable'))
    const settle = vi.fn()
    const arkade = context(repo, settle)
    await expect(settleReservedRenewal(arkade, params)).rejects.toThrow('database unavailable')
    expect(settle).not.toHaveBeenCalled()
    expect(arkade.reservations.reserved().size).toBe(0)
  })
})
