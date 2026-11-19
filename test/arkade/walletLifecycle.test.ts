import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArkAddress, Wallet } from '@arkade-os/sdk'
import type { WalletRepository } from '@arkade-os/sdk'
import type { Database } from 'better-sqlite3'
import { createArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'

const databases = vi.hoisted(() => [] as Database[])

vi.mock('better-sqlite3', async (importOriginal) => {
  const { default: SQLite } = await importOriginal<{ default: typeof import('better-sqlite3') }>()
  return {
    default: vi.fn(function (path: string) {
      const database = new SQLite(path)
      databases.push(database)
      return database
    }),
  }
})

afterEach(() => {
  for (const database of databases.splice(0)) if (database.open) database.close()
  vi.restoreAllMocks()
})

const open = async () => {
  const serverKey = new Uint8Array(32).fill(1)
  const dispose = vi.fn(async () => {})
  let repository!: WalletRepository
  vi.spyOn(Wallet, 'create').mockImplementation(async (config) => {
    repository = config.storage!.walletRepository!
    await repository.getWalletState()
    return {
      arkProvider: {
        getInfo: async () => ({ network: 'regtest', dust: 330, unilateralExitDelay: 86400 }),
      },
      arkServerPublicKey: serverKey,
      getAddress: async () => new ArkAddress(serverKey, serverKey, 'tark').encode(),
      dispose,
    } as unknown as Awaited<ReturnType<typeof Wallet.create>>
  })
  const context = await createArkadeContext({
    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    operatorUrl: 'http://arkd.test',
    databasePath: ':memory:',
    isMainnet: false,
    arkadeHrp: 'tark',
    expectedArkdNetwork: 'regtest',
  })
  return { context, dispose, repository, database: databases.at(-1)! }
}

describe('Arkade context shutdown', () => {
  it('drains pending wallet writes before closing SQLite and shares concurrent shutdown', async () => {
    const { context, dispose, repository, database } = await open()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const pendingWrite = gate.then(() => repository.deleteVtxos('shutdown'))
    dispose.mockImplementation(() => pendingWrite)
    const closing = context.close()
    const concurrent = context.close()
    let completed = false
    void Promise.resolve(closing).then(() => (completed = true))
    await Promise.resolve()
    const completedBeforeDrain = completed
    const openBeforeDrain = database.open
    release()
    await expect(pendingWrite).resolves.toBeUndefined()
    await closing
    expect(concurrent).toBe(closing)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(completedBeforeDrain).toBe(false)
    expect(openBeforeDrain).toBe(true)
    expect(database.open).toBe(false)
    await expect(repository.deleteVtxos('closed')).rejects.toThrow(/not open/)
  })

  it('keeps SQLite open when wallet disposal fails and retains the failed shutdown', async () => {
    const { context, dispose, repository, database } = await open()
    const failure = new Error('wallet cleanup failed')
    dispose.mockRejectedValue(failure)
    const closing = context.close()
    await expect(closing).rejects.toBe(failure)
    expect(database.open).toBe(true)
    await expect(repository.deleteVtxos('still-open')).resolves.toBeUndefined()
    expect(context.close()).toBe(closing)
    await expect(context.close()).rejects.toBe(failure)
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
