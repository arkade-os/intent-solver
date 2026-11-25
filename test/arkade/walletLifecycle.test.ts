import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArkAddress, Wallet } from '@arkade-os/sdk'
import type { WalletRepository } from '@arkade-os/sdk'
import type { Database } from 'better-sqlite3'
import { createArkadeContext, type DelayedReleaseBatchRegistrations } from '@arkade-os/solver-arkade/arkade/wallet.js'

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

const open = async (sessionDuration = 10n, dispose = vi.fn(async () => {})) => {
  const serverKey = new Uint8Array(32).fill(1)
  let repository!: WalletRepository
  let journal!: DelayedReleaseBatchRegistrations
  vi.spyOn(Wallet, 'create').mockImplementation(async (config) => {
    repository = config.storage!.walletRepository!
    journal = config.storage!.intentRepository as DelayedReleaseBatchRegistrations
    await repository.getWalletState()
    return {
      arkProvider: {
        getInfo: async () => ({ network: 'regtest', dust: 330, unilateralExitDelay: 86400, sessionDuration }),
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
  return { context, dispose, repository, journal, database: databases.at(-1)! }
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

  it('closes what a refused start opened, keeping SQLite open if the wallet will not dispose', async () => {
    const disposed = vi.fn(async () => {})
    await expect(open(0n, disposed)).rejects.toThrow('sessionDuration=0')
    expect(disposed).toHaveBeenCalledOnce()
    expect(databases.at(-1)!.open).toBe(false)
    const stuck = vi.fn(async () => {}).mockRejectedValue(new Error('wallet cleanup failed'))
    await expect(open(0n, stuck)).rejects.toThrow('sessionDuration=0')
    expect(stuck).toHaveBeenCalledOnce()
    expect(databases.at(-1)!.open).toBe(true)
  })
})

describe('intent journal release delay', () => {
  it('is two of the server’s sessions, and a server advertising none is refused', async () => {
    expect((await open(30n)).journal.releaseDelayMs).toBe(60_000)
    await expect(open(0n)).rejects.toThrow('sessionDuration=0')
  })
})
