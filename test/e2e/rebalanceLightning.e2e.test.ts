import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { hex } from '@scure/base'
import { WebSocket as WsClient } from 'ws'
import { createArkadeContext, type ArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { createCorridorReaderSet, createCorridorSet } from '@arkade-os/solver-core/core/corridor.js'
import type { SqlDriver } from '@arkade-os/solver-core/core/driver.js'
import type { RebalancePolicy } from '@arkade-os/solver-core/ports/rebalance.js'
import { poll } from '@arkade-os/solver-core/util/poll.js'
import { betterSqliteDriver } from '@arkade-os/solver-db/driver.js'
import { RebalanceService } from '@arkade-os/solver-app/ops/rebalance.js'
import { createArkadeRebalanceSource } from '@arkade-os/solver-app/ops/rebalanceRoutes.js'
import { RebalanceStore } from '@arkade-os/solver-app/ops/rebalanceStore.js'
import type { Services } from '@arkade-os/solver-app/ops/services.js'
import { lightningSendCorridor } from '@arkade-os/solver-corridors/corridors/adapters.js'
import { SwapStore } from '@arkade-os/solver-corridors/db/swaps.js'
import { arkadeOpsFromContext } from '@arkade-os/solver-corridors/send/arkadeOps.js'
import { SendSwapService } from '@arkade-os/solver-corridors/send/orchestrator.js'
import { createLndRebalanceBackend } from '@arkade-os/solver-rails-lnd/rebalance.js'
import { RelayIngress } from '@arkade-os/solver-transport/ingress/relay.js'
import { webSocketRelayConnection } from '@arkade-os/solver-transport/relay/connection.js'
import { deriveNostrIdentity, nostrCodec } from '@arkade-os/solver-transport/relay/nostr.js'
import { solverInvoice } from './support/counterparty.js'
import { esploraUrl, requireStack } from './support/preflight.js'
import { openRebalanceArkade } from './support/rebalanceArkade.js'
import { openPeerLightning, startRebalanceRelay } from './support/rebalancePeer.js'
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
let arkade: E2eArkade
let peerArkade: ArkadeContext
let onchain: Awaited<ReturnType<typeof openOnchainBackend>>
let ln: Awaited<ReturnType<typeof openSolverLightning>>
let peerLn: Awaited<ReturnType<typeof openPeerLightning>>
let peerStore: SwapStore
let peerService: SendSwapService
let peerPubkey: string
let relay: Awaited<ReturnType<typeof startRebalanceRelay>>
let connection: ReturnType<typeof webSocketRelayConnection>
let ingress: RelayIngress
let driver: SqlDriver
let store: RebalanceStore
let service: RebalanceService

const sourceBalance = async (): Promise<number> =>
  (await arkade.ctx.wallet.getSpendableVtxos({ withRecoverable: false }))
    .filter((coin) => !coin.assets?.length)
    .reduce((total, coin) => total + coin.value, 0)

describe('e2e Arkade surplus rebalance to own Lightning channels through another solver', () => {
  beforeAll(async () => {
    expect(e2eNetwork()).toBe('regtest')
    await requireStack('Arkade Lightning rebalance', ['arkd', 'emulator', 'lnd', 'ln-counterparty'])
    arkade = await openRebalanceArkade()
    expect(arkade.network).toBe('regtest')
    const dir = tempStoreDir()
    onchain = await openOnchainBackend()
    ln = await openSolverLightning()
    peerLn = await openPeerLightning(dir)
    expect(await peerLn.walletFingerprint()).not.toBe(await ln.walletFingerprint())
    const mnemonic = generateMnemonic(wordlist)
    const peerIdentity = deriveNostrIdentity(mnemonic, false)
    peerPubkey = peerIdentity.pubkey
    peerArkade = await createArkadeContext({
      mnemonic,
      databasePath: join(dir, 'peer-arkade.sqlite'),
      arkServerUrl: arkade.ctx.arkServerUrl,
      isMainnet: false,
      arkadeHrp: arkade.profile.arkadeHrp,
      expectedArkdNetwork: arkade.profile.arkdNetwork,
      esploraUrl: esploraUrl(),
    })
    expect(hex.encode(await peerArkade.identity.xOnlyPublicKey())).toBe(peerIdentity.pubkey)
    peerStore = await SwapStore.open(join(dir, 'peer-swaps.sqlite'))
    peerService = new SendSwapService({
      store: peerStore,
      ln: peerLn,
      arkade: await arkadeOpsFromContext(peerArkade, arkade.emulator),
      limits: arkade.limits,
      invoicePrefix: arkade.profile.invoicePrefix,
      maxExposedSats: arkade.maxExposedSats,
      totalCommitted: () => peerStore.committedSats(),
      admission: new AdmissionControl(),
    })
    relay = await startRebalanceRelay()
    connection = webSocketRelayConnection(relay.url, {
      codec: nostrCodec(peerIdentity),
      WebSocketCtor: WsClient as unknown as typeof WebSocket,
    })
    const corridor = lightningSendCorridor(peerService, peerStore)
    ingress = new RelayIngress({
      connection,
      providerPubkey: peerIdentity.pubkey,
      corridors: createCorridorSet([corridor]),
      readers: createCorridorReaderSet([corridor]),
    })
    await ingress.start()
    driver = betterSqliteDriver(join(dir, 'rebalance.sqlite'))
    store = await RebalanceStore.open(driver)
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
      counterparty: { solverPubkey: peerIdentity.pubkey, relays: [relay.url] },
    }
    const source = await createArkadeRebalanceSource(
      {
        config: { network: arkade.network },
        providerPubkey: hex.encode(await arkade.ctx.identity.xOnlyPublicKey()),
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
    await ingress?.stop()
    await connection?.close()
    await relay?.close()
    await peerStore?.close()
    await driver?.close()
    await peerLn?.close()
    await ln?.close()
    await onchain?.close?.()
    peerArkade?.close()
    arkade?.close()
  })

  it(
    'funds a verified external RFQ, settles the destination invoice, and proves both wallets changed',
    async () => {
      await assertArkadeSpendable(arkade, 85_000)
      const sourceBefore = await sourceBalance()
      const destinationBefore = (await ln.getBalance()).availableSats
      const peerBefore = (await peerLn.getBalance()).availableSats
      const quote = await service.quote({
        poolId: 'rail:lightning',
        amountSats: AMOUNT_SATS,
        kind: 'lightning',
        requestKey: randomUUID(),
      })
      expect(quote.state).toBe('quoted')
      expect(quote.routeData?.rfqId).toBeTypeOf('string')
      expect(await sourceBalance()).toBe(sourceBefore)
      const peerQuoted = await peerStore.findByRfqId(quote.routeData!.rfqId as string)
      expect(peerQuoted?.state).toBe('quoted')
      expect(peerQuoted?.paymentHash).toBe(quote.deposit.paymentHash)
      expect(relay.published.some((event) => event.pubkey === peerPubkey)).toBe(true)

      const submitted = await service.submit(quote.id)
      expect(submitted.state, submitted.error).toBe('pending')
      expect(submitted.fundingTxid).toMatch(/^[0-9a-f]{64}$/)
      expect((await store.get(quote.id))?.state).toBe('pending')
      const completed = await poll(
        async () => {
          await peerService.tickAll()
          await service.tick()
          const peer = await peerStore.get(peerQuoted!.id)
          const row = await store.get(quote.id)
          if (peer.state === 'claimed' && row?.state === 'completed') return { peer, row }
          if (['refused', 'stuck'].includes(peer.state)) throw new Error(`external peer stopped at ${peer.state}`)
          return null
        },
        { attempts: 200, intervalMs: 3000, whenExhausted: 'external rebalance RFQ did not settle and claim' },
      )
      expect(completed.row.creditedSats).toBe(AMOUNT_SATS)
      expect(completed.peer.claimArkTxid).toMatch(/^[0-9a-f]{64}$/)
      const invoice = await solverInvoice(quote.deposit.paymentHash!)
      expect(invoice.state).toBe('SETTLED')
      expect(Number(invoice.amt_paid_sat)).toBe(AMOUNT_SATS)
      expect(invoice.r_preimage).toBe(completed.peer.preimage)
      expect((await ln.getBalance()).availableSats - destinationBefore).toBe(AMOUNT_SATS)
      expect(peerBefore - (await peerLn.getBalance()).availableSats).toBeGreaterThanOrEqual(AMOUNT_SATS)
      const sourceAfter = await poll(
        async () => {
          const balance = await sourceBalance()
          const spent = sourceBefore - balance
          return spent >= AMOUNT_SATS && spent <= quote.debitSats ? balance : null
        },
        { attempts: 40, intervalMs: 3000, whenExhausted: 'source wallet did not reflect external RFQ funding' },
      )
      expect(sourceBefore - sourceAfter).toBeGreaterThanOrEqual(AMOUNT_SATS)
      expect(sourceBefore - sourceAfter).toBeLessThanOrEqual(quote.debitSats)
      expect(await store.active()).toEqual([])
      await expect((await RebalanceStore.open(driver)).get(quote.id)).resolves.toMatchObject({
        state: 'completed',
        creditedSats: AMOUNT_SATS,
        fundingTxid: submitted.fundingTxid,
      })
    },
    SWAP_TIMEOUT_MS,
  )
})
