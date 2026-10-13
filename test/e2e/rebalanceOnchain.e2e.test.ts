import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { generateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { createCorridorReaderSet } from '@arkade-os/solver-core/core/corridor.js'
import type { SqlDriver } from '@arkade-os/solver-core/core/driver.js'
import type { RebalancePolicy } from '@arkade-os/solver-core/ports/rebalance.js'
import { poll } from '@arkade-os/solver-core/util/poll.js'
import { betterSqliteDriver } from '@arkade-os/solver-db/driver.js'
import { RebalanceService } from '@arkade-os/solver-app/ops/rebalance.js'
import { createArkadeRebalanceSource } from '@arkade-os/solver-app/ops/rebalanceRoutes.js'
import { RebalanceStore } from '@arkade-os/solver-app/ops/rebalanceStore.js'
import type { Services } from '@arkade-os/solver-app/ops/services.js'
import { createLndRebalanceBackend } from '@arkade-os/solver-rails-lnd/rebalance.js'
import { requireStack } from './support/preflight.js'
import { mineBlocks } from './support/chain.js'
import { openRebalanceArkade } from './support/rebalanceArkade.js'
import {
  assertArkadeSpendable,
  e2eNetwork,
  openOnchainBackend,
  openSolverLightning,
  SETUP_TIMEOUT_MS,
  SWAP_TIMEOUT_MS,
  tempStoreDir,
  type E2eArkade,
} from './support/stack.js'

const AMOUNT_SATS = 50_000
const SOURCE_SATS = 100_000
const policy: RebalancePolicy = {
  enabled: false,
  reserveSats: 10_000,
  maxDebitSats: 75_000,
  dailyDebitSats: 75_000,
  maxFeeSats: 25_000,
  maxFeeBps: 5_000,
  minTransferSats: 10_000,
  cooldownSeconds: 300,
  targets: {},
}

let arkade: E2eArkade
let donor: E2eArkade
let onchain: Awaited<ReturnType<typeof openOnchainBackend>>
let ln: Awaited<ReturnType<typeof openSolverLightning>>
let driver: SqlDriver
let store: RebalanceStore
let service: RebalanceService

const sourceBalance = async (): Promise<number> =>
  (await arkade.ctx.wallet.getSpendableVtxos({ withRecoverable: false }))
    .filter((coin) => !coin.assets?.length)
    .reduce((total, coin) => total + coin.value, 0)

describe('e2e Arkade surplus rebalance to own onchain wallet', () => {
  beforeAll(async () => {
    expect(e2eNetwork()).toBe('regtest')
    await requireStack('Arkade onchain rebalance', ['arkd', 'emulator', 'lnd', 'esplora'])
    donor = await openRebalanceArkade()
    const dir = tempStoreDir()
    arkade = await openRebalanceArkade({
      mnemonic: generateMnemonic(wordlist),
      databasePath: join(dir, 'source-wallet.sqlite'),
    })
    expect(arkade.network).toBe('regtest')
    onchain = await openOnchainBackend()
    ln = await openSolverLightning()
    driver = betterSqliteDriver(join(dir, 'rebalance.sqlite'))
    store = await RebalanceStore.open(driver)
    const source = await createArkadeRebalanceSource(
      {
        config: { network: arkade.network },
        providerPubkey: await arkade.ctx.identity.xOnlyPublicKey().then((key) => Buffer.from(key).toString('hex')),
        arkade: arkade.ctx,
        readers: createCorridorReaderSet([]),
        onchain,
      } as Services,
      driver,
      new AdmissionControl(),
    )
    service = await RebalanceService.create({
      store,
      backend: createLndRebalanceBackend(ln, onchain),
      source,
      policy,
      savePolicy: async () => {},
    })
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await service?.close()
    await driver?.close()
    await ln?.close()
    await onchain?.close?.()
    arkade?.close()
    donor?.close()
  })

  it(
    'settles the collaborative exit, confirms the exact backend credit, and persists completion',
    async () => {
      await assertArkadeSpendable(donor, SOURCE_SATS)
      expect(await sourceBalance()).toBe(0)
      const sourceFundingTxid = await donor.ctx.wallet.send({
        address: await arkade.ctx.wallet.getAddress(),
        amount: SOURCE_SATS,
      })
      await poll(async () => ((await sourceBalance()) === SOURCE_SATS ? true : null), {
        attempts: 40,
        intervalMs: 3000,
        whenExhausted: 'fresh rebalance source did not receive its controlled input',
      })
      await assertArkadeSpendable(arkade, policy.maxDebitSats + policy.reserveSats)
      const sourceBefore = await sourceBalance()
      const destinationBefore = (await onchain.getBalance()).confirmedSats
      const quoted = await service.quote({
        poolId: 'rail:onchain',
        amountSats: AMOUNT_SATS,
        kind: 'onchain',
        requestKey: randomUUID(),
      })
      expect(quoted.state).toBe('quoted')
      expect(quoted.deposit.netSats).toBe(AMOUNT_SATS)
      expect(quoted.inputs).toHaveLength(1)
      expect(quoted.inputs[0]).toMatchObject({ txid: sourceFundingTxid, value: SOURCE_SATS })
      expect(quoted.feeSats).toBeLessThanOrEqual(policy.maxFeeSats)
      expect(quoted.debitSats).toBeLessThanOrEqual(policy.maxDebitSats)
      expect(await sourceBalance()).toBe(sourceBefore)
      expect(await onchain.findOutputs({ address: quoted.deposit.destination })).toEqual([])

      const submitted = await service.submit(quoted.id)
      expect(submitted.state, submitted.error).toBe('pending')
      expect(submitted.fundingTxid).toMatch(/^[0-9a-f]{64}$/)
      expect((await store.get(quoted.id))?.state).toBe('pending')
      expect((await service.submit(quoted.id)).fundingTxid).toBe(submitted.fundingTxid)
      await mineBlocks(1)

      const completed = await poll(
        async () => {
          await service.tick()
          const row = await store.get(quoted.id)
          if (row?.state === 'completed') return row
          if (row && row.state !== 'pending') throw new Error(`unexpected rebalance state ${row.state}: ${row.error}`)
          return null
        },
        { attempts: 200, intervalMs: 3000, whenExhausted: 'rebalance did not confirm its own onchain receipt' },
      )
      expect(completed.creditedSats).toBe(AMOUNT_SATS)
      expect(completed.fundingTxid).toBe(submitted.fundingTxid)
      expect(await store.active()).toEqual([])
      const outputs = await onchain.findOutputs({ address: quoted.deposit.destination })
      expect(outputs).toHaveLength(1)
      expect(outputs[0]).toMatchObject({
        txid: submitted.fundingTxid,
        valueSats: AMOUNT_SATS,
      })
      expect(outputs[0]!.confirmations).toBeGreaterThanOrEqual(1)
      expect((await onchain.getBalance()).confirmedSats - destinationBefore).toBe(AMOUNT_SATS)

      const sourceAfter = await poll(
        async () => {
          const balance = await sourceBalance()
          const spent = sourceBefore - balance
          return spent >= AMOUNT_SATS && spent <= quoted.debitSats ? balance : null
        },
        {
          attempts: 40,
          intervalMs: 3000,
          whenExhausted: 'source balance did not reflect the approved rebalance debit',
        },
      )
      expect(sourceBefore - sourceAfter).toBeGreaterThanOrEqual(AMOUNT_SATS)
      expect(sourceBefore - sourceAfter).toBeLessThanOrEqual(quoted.debitSats)
      const inputs = await arkade.ctx.wallet.indexerProvider.getVtxos({
        outpoints: quoted.inputs.map(({ txid, vout }) => ({ txid, vout })),
      })
      expect(inputs.vtxos).toHaveLength(quoted.inputs.length)
      expect(inputs.vtxos.every((coin) => coin.settledBy === submitted.fundingTxid)).toBe(true)
      await expect((await RebalanceStore.open(driver)).get(quoted.id)).resolves.toMatchObject({
        state: 'completed',
        creditedSats: AMOUNT_SATS,
        fundingTxid: submitted.fundingTxid,
      })
    },
    SWAP_TIMEOUT_MS,
  )
})
