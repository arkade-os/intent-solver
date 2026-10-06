import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { ArkAddress, asset, RestIndexerProvider } from '@arkade-os/sdk'
import { TaxiClient } from '@arkade-taxi/client'
import { requestTaxiArkadeSwap } from '@arkade-taxi/client/wallet'
import { nostrRfqTransport } from '@arkade-os/swap/nostr'
import { hex } from '@scure/base'
import { createArkadeContext, type ArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { AdminStore } from '@arkade-os/solver-app/admin/db.js'
import { runFloatLifecycle } from '@arkade-os/solver-app/ops/float.js'
import type { Services } from '@arkade-os/solver-app/ops/services.js'
import { createCorridorReaderSet } from '@arkade-os/solver-core/core/corridor.js'
import { DEFAULT_SERVING } from '@arkade-os/solver-core/core/assetMarketConfig.js'
import { betterSqliteDriver } from '@arkade-os/solver-db/driver.js'
import { NETWORKS } from '@arkade-os/solver-core/core/networks.js'
import { poll } from '@arkade-os/solver-core/util/poll.js'
import { openArkade, SETUP_TIMEOUT_MS, SWAP_TIMEOUT_MS, type E2eArkade } from './support/stack.js'

let taxiUrl = 'http://localhost:8080'
const relayUrl = process.env.E2E_NOSTR_RELAY_URL ?? 'ws://localhost:7777'
const solverAdminPort = process.env.SOLVER_E2E_ADMIN_PORT ?? '8788'
const solverAdmin = `http://127.0.0.1:${solverAdminPort}`
let arkade: E2eArkade
let solver: ArkadeContext
let buyer: ArkadeContext
let taxi: TaxiClient
let assetId: string
let daemon: ChildProcess
let feed: Server
let workdir: string
let daemonLog = ''
let solverPublicKey = ''
let buyerBefore: { sats: number; assets: bigint }
let solverBefore: { sats: number; assets: bigint }
let taxiBefore: { sats: bigint; assets: string[] }
let originalTaxiRules: Record<string, unknown>[] | undefined

type TaxiFareWire = {
  id: string
  currency: 'sats' | 'sameAsset' | 'token'
  assetId?: { txid: string; groupIndex: number }
  pricing: Record<string, unknown>
}

type TaxiRuleWire = {
  assetId: null | '*' | { txid: string; groupIndex: number }
  enabled: boolean
  claim: 'recycle' | 'purchase' | 'either'
  maxTopupSats: string | null
  fares: TaxiFareWire[]
  unclaimedMode?: string
}

const adminUrl = () => process.env.TAXI_ADMIN_URL || 'http://localhost:8081'

const patchTaxiRules = async (rules: Record<string, unknown>[]): Promise<void> => {
  const response = await fetch(`${adminUrl()}/admin/api/policy`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-taxi-operator': 'intent-solver-e2e' },
    body: JSON.stringify({ assetRules: rules }),
  })
  if (!response.ok) throw new Error(`Taxi policy update returned HTTP ${response.status}: ${await response.text()}`)
}

const policyRulesForPatch = (rules: TaxiRuleWire[]): Record<string, unknown>[] =>
  rules.map((rule) => ({
    assetId: rule.assetId,
    enabled: rule.enabled,
    claim: rule.claim,
    maxTopupSats: rule.maxTopupSats,
    fares: rule.fares.map(({ id, currency, assetId: fareAssetId, pricing }) => ({
      id,
      currency: { kind: currency, ...(currency === 'token' ? { assetId: fareAssetId } : {}) },
      pricing,
    })),
  }))

const ensureTaxiAssetTerms = async (id: string): Promise<void> => {
  const response = await fetch(`${adminUrl()}/admin/api/policy`)
  if (!response.ok) throw new Error(`Taxi policy read returned HTTP ${response.status}`)
  const policy = (await response.json()) as { assetRules: TaxiRuleWire[] }
  originalTaxiRules = policyRulesForPatch(policy.assetRules)
  const wire = assetWire(id)
  const assetRuleId = { txid: hex.encode(wire.txid), groupIndex: wire.groupIndex }
  const preserved = policy.assetRules.filter(
    (rule) =>
      typeof rule.assetId !== 'object' ||
      rule.assetId === null ||
      rule.assetId.txid !== assetRuleId.txid ||
      rule.assetId.groupIndex !== assetRuleId.groupIndex,
  )
  await patchTaxiRules([
    ...policyRulesForPatch(preserved),
    {
      assetId: assetRuleId,
      enabled: true,
      claim: 'recycle',
      maxTopupSats: null,
      fares: [{ id: 'sats', currency: { kind: 'sats' }, pricing: { kind: 'flat', units: '0' } }],
    },
  ])
}

const assetWire = (id: string) => {
  const parsed = asset.AssetId.fromString(id)
  return { txid: Uint8Array.from(parsed.txid).reverse(), groupIndex: parsed.groupIndex }
}

const feedServer = async (): Promise<string> => {
  feed = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ price: '100000000' }))
  })
  await new Promise<void>((resolve) => feed.listen(0, '127.0.0.1', resolve))
  const address = feed.address()
  if (!address || typeof address === 'string') throw new Error('price feed did not start')
  return `http://127.0.0.1:${address.port}/price`
}

const assetUnits = async (wallet: ArkadeContext['wallet']): Promise<bigint> => {
  const balance = await wallet.getBalance()
  return (balance.availableAssets ?? [])
    .filter((entry) => entry.assetId === assetId)
    .reduce((total, entry) => total + BigInt(entry.amount), 0n)
}

const spendableSatInventory = async (wallet: ArkadeContext['wallet']) => {
  const coins = await wallet.getSpendableVtxos({ withRecoverable: false, genericallySpendableOnly: true })
  return {
    total: coins.reduce((sum, coin) => sum + BigInt(coin.value), 0n),
    withoutAssets: coins.filter((coin) => !coin.assets?.length).reduce((sum, coin) => sum + BigInt(coin.value), 0n),
    carryingAssets: coins.filter((coin) => coin.assets?.length).reduce((sum, coin) => sum + BigInt(coin.value), 0n),
  }
}

const taxiInventory = async (): Promise<{ sats: bigint; assets: string[] }> => {
  const adminUrl = process.env.TAXI_ADMIN_URL || 'http://localhost:8081'
  const response = await fetch(`${adminUrl}/admin/api/funding`)
  if (!response.ok) throw new Error(`Taxi funding API returned HTTP ${response.status}`)
  const funding = (await response.json()) as { arkAddress: string }
  const script = hex.encode(ArkAddress.decode(funding.arkAddress).pkScript)
  const { vtxos } = await new RestIndexerProvider(process.env.ARK_SERVER_URL).getVtxos({
    scripts: [script],
    spendableOnly: true,
  })
  const assets = new Map<string, bigint>()
  for (const coin of vtxos) {
    for (const entry of coin.assets ?? []) {
      assets.set(entry.assetId, (assets.get(entry.assetId) ?? 0n) + BigInt(entry.amount))
    }
  }
  return {
    sats: vtxos.reduce((total, coin) => total + BigInt(coin.value), 0n),
    assets: [...assets].map(([id, amount]) => `${id}:${amount}`).sort(),
  }
}

const party = async (mnemonic = generateMnemonic(wordlist, 128)): Promise<ArkadeContext> => {
  const profile = NETWORKS.regtest!
  return createArkadeContext({
    mnemonic,
    arkServerUrl: process.env.ARK_SERVER_URL!,
    esploraUrl: process.env.ARK_ESPLORA_URL ?? process.env.ESPLORA_URL,
    databasePath: join(workdir, `wallet-${Math.random().toString(16).slice(2)}.sqlite`),
    isMainnet: false,
    arkadeHrp: profile.arkadeHrp,
    expectedArkdNetwork: profile.arkdNetwork,
  })
}

const waitForDaemon = async (): Promise<void> => {
  await poll(
    async () => {
      if (daemon.exitCode !== null) throw new Error(`solver exited ${daemon.exitCode}: ${daemonLog}`)
      const health = await fetch(`${solverAdmin}/api/healthz`).then(
        async (response) => (await response.json()) as { ok?: boolean },
        () => null,
      )
      return health?.ok && daemonLog.includes('relay ingress open') ? true : null
    },
    { attempts: 60, intervalMs: 500, whenExhausted: `solver did not become ready: ${daemonLog}` },
  )
}

beforeAll(async () => {
  arkade = await openArkade()
  taxiUrl = process.env.TAXI_URL || taxiUrl
  const held = (await arkade.ctx.wallet.getBalance()).availableAssets?.find((entry) => BigInt(entry.amount) > 0n)
  if (!held) throw new Error('asset RFQ Taxi E2E requires the asset group to mint ARFQ first')
  assetId = held.assetId
  taxi = new TaxiClient({ baseUrl: taxiUrl })
  await ensureTaxiAssetTerms(assetId)
  workdir = mkdtempSync(join(tmpdir(), 'solver-taxi-rfq-'))
  const solverMnemonic = generateMnemonic(wordlist, 128)
  solver = await party(solverMnemonic)
  buyer = await party()
  solverPublicKey = hex.encode(await solver.identity.xOnlyPublicKey())
  const solverAddress = await solver.wallet.getAddress()
  const buyerAddress = await buyer.wallet.getAddress()
  const swapDbPath = join(workdir, 'solver-swaps.sqlite')
  const admin = await AdminStore.open(betterSqliteDriver(swapDbPath))
  await admin.putMarket({
    ...DEFAULT_SERVING,
    symbol: 'ARFQ',
    base: null,
    quote: assetId,
    baseDecimals: 8,
    quoteDecimals: 0,
    feedUrl: await feedServer(),
    pricePath: '/price',
    toleranceBps: 0,
    feeBps: 0,
    sellBase: { min: 1n, max: 1_000_000_000n },
    buyBase: { min: 1n, max: 1_000_000_000n },
    enabled: true,
  })
  await admin.close()
  const solverFunding = await arkade.ctx.wallet.send({
    address: solverAddress,
    amount: 40_000,
    assets: [{ assetId, amount: 500_000n }],
  })
  const buyerFunding = await arkade.ctx.wallet.send({ address: buyerAddress, amount: 100_000 })
  await poll(
    async () => {
      const coins = await solver.wallet.getSpendableVtxos({ withRecoverable: false, genericallySpendableOnly: true })
      return coins.some(
        (coin) =>
          coin.txid === solverFunding &&
          coin.value >= 40_000 &&
          coin.assets?.some((entry) => entry.assetId === assetId && entry.amount === 500_000n),
      )
        ? true
        : null
    },
    { attempts: 30, intervalMs: 1_000, whenExhausted: 'solver did not receive its real sats-and-asset inventory' },
  )
  await poll(
    async () =>
      (await buyer.wallet.getSpendableVtxos({ withRecoverable: false, genericallySpendableOnly: true })).some(
        (coin) => coin.txid === buyerFunding && coin.value >= 100_000,
      )
        ? true
        : null,
    { attempts: 30, intervalMs: 1_000, whenExhausted: 'receiver did not receive its sats float' },
  )
  buyerBefore = { sats: (await buyer.wallet.getBalance()).available, assets: await assetUnits(buyer.wallet) }
  solverBefore = { sats: (await solver.wallet.getBalance()).available, assets: await assetUnits(solver.wallet) }
  taxiBefore = await taxiInventory()
  const coins = await solver.wallet.getSpendableVtxos({ withRecoverable: false, genericallySpendableOnly: true })
  expect(coins.length).toBeGreaterThan(0)
  const release = solver.reservations.reserve(coins)
  try {
    const report = await runFloatLifecycle({
      arkade: solver,
      config: { limits: arkade.limits, maxExposedSats: arkade.limits.maxSats * 3 },
      readers: createCorridorReaderSet([]),
    } as unknown as Services)
    expect(report.migrated).toBe(0)
    expect(report.failures).toContain(
      `deprecated-signer migration deferred: ${coins.length} candidate coin(s) reserved by another operation`,
    )
    expect(solver.reservations.reserved()).toEqual(new Set(coins.map(({ txid, vout }) => `${txid}:${vout}`)))
    expect((await solver.wallet.getBalance()).available).toBe(solverBefore.sats)
    expect(await assetUnits(solver.wallet)).toBe(solverBefore.assets)
  } finally {
    release()
  }
  expect(solver.reservations.reserved().size).toBe(0)
  expect(taxiBefore.sats).toBeGreaterThan(0n)
  const relayCheck = await fetch(relayUrl.replace(/^ws/, 'http'), {
    headers: { accept: 'application/nostr+json' },
    signal: AbortSignal.timeout(5_000),
  })
  if (!relayCheck.ok) throw new Error(`regtest Nostr relay unavailable: HTTP ${relayCheck.status}`)

  const env = {
    ...process.env,
    SWAP_NETWORK: 'regtest',
    LN_BACKEND: 'fake',
    ARK_MNEMONIC: solverMnemonic,
    ARK_SERVER_URL: process.env.ARK_SERVER_URL!,
    EMULATOR_URL: process.env.EMULATOR_URL!,
    ESPLORA_URL: process.env.ESPLORA_URL ?? 'http://localhost:3000/api',
    ARK_ESPLORA_URL: process.env.ARK_ESPLORA_URL ?? process.env.ESPLORA_URL ?? 'http://localhost:3000/api',
    SWAP_DB_PATH: swapDbPath,
    ARK_DB_PATH: join(workdir, 'solver-wallet.sqlite'),
    RELAY_URL: relayUrl,
    RELAY_PROTOCOL: 'nostr',
    TAXI_URL: taxiUrl,
    TAXI_RECEIVER_ALLOW_PRIVATE: '1',
    ASSET_MARKETS: `ARFQ:${assetId}`,
    OPEN_RFQ_MAX_BIDS_PER_MIN: '0',
    NOSTR_AD_PUBLISH: 'off',
    POOL_AUTO_MINT: 'false',
    ADMIN_PORT: solverAdminPort,
    ADMIN_HOST: '127.0.0.1',
  }
  const cli = join(process.cwd(), 'packages/solver-app/dist/cli.js')
  daemon = spawn(process.execPath, ['--enable-source-maps', '--experimental-eventsource', cli, 'relay'], {
    cwd: process.cwd(),
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const append = (chunk: Buffer) => {
    daemonLog = `${daemonLog}${chunk.toString()}`.slice(-12_000)
  }
  daemon.stdout!.on('data', append)
  daemon.stderr!.on('data', append)
  await waitForDaemon()
  await taxi.info()
}, SETUP_TIMEOUT_MS)

afterAll(async () => {
  try {
    if (originalTaxiRules) await patchTaxiRules(originalTaxiRules)
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill('SIGTERM')
      await new Promise<void>((resolve) => daemon.once('exit', () => resolve()))
    }
    await Promise.all([buyer?.close(), solver?.close()].filter(Boolean))
    arkade?.close()
    if (feed) await new Promise<void>((resolve) => feed.close(() => resolve()))
    if (workdir) {
      const target = resolve(workdir)
      if (dirname(target) === resolve(tmpdir()) && basename(target).startsWith('solver-taxi-rfq-')) {
        rmSync(target, { recursive: true, force: true })
      } else {
        console.error(`refusing to remove unexpected E2E temp path: ${target}`)
      }
    }
  }
})

describe('running solver to Taxi on regtest', () => {
  it(
    'answers a wallet RFQ, submits one real Taxi fill, and the receiver recycles the asset claim',
    async () => {
      const info = await taxi.info()
      const buyerAddress = await buyer.wallet.getAddress()
      const makerPublicKey = await buyer.identity.xOnlyPublicKey()
      const now = Math.floor(Date.now() / 1000)
      const { verified } = await taxi.requestVerifiedReceiveQuote({
        receiverAddress: buyerAddress,
        makerPublicKey,
        assetId: assetWire(assetId),
        payer: 'receiver',
        trustedServerKey: arkade.ctx.wallet.arkServerPublicKey,
        trustedEmulatorKey: hex.decode(arkade.emulator.pubkey).slice(-32),
        dust: arkade.ctx.dustSats,
        vtxoMinAmount: arkade.ctx.vtxoMinSats,
        hrp: arkade.profile.arkadeHrp,
        expect: {
          maxServiceFareSats: 0n,
          minRecoveryLocktime: { kind: 'time', value: 1n },
          minInputExpiryFloor: { kind: 'time', value: BigInt(now + 1) },
        },
      })
      expect(verified.descriptor.loanSats).toBe(arkade.ctx.dustSats)
      expect(verified.descriptor.serviceFareSats).toBe(0n)
      const choice = {
        mode: 'recycleReceiver' as const,
        quote: verified.descriptor,
        taxi: { url: taxiUrl, operatorKey: info.operatorKey },
      }
      const transport = nostrRfqTransport({ relays: [relayUrl], solverPubkey: solverPublicKey })
      const rfqId = randomBytes(32).toString('hex')
      const swap = await requestTaxiArkadeSwap(buyer.wallet, process.env.ARK_SERVER_URL!, transport, {
        rfqId,
        amount: 10_000,
        wantAsset: asset.AssetId.fromString(assetId),
        receiveAddress: verified.descriptor.receiveAddress,
        carrier: choice,
      })
      await transport.close()
      expect(swap.carrier?.mode).toBe('recycle_receiver')
      const fundingTxid = await buyer.wallet.send({
        address: swap.address,
        amount: Number(swap.fundAmount),
        extensions: [swap.extension],
      })
      expect(fundingTxid).toMatch(/^[0-9a-f]{64}$/)

      const claim = await poll(
        async () => {
          const snapshot = await taxi.listClaims({ receiverAddresses: [buyerAddress] })
          return snapshot.claims.find((entry) => entry.claimable && entry.claim) ?? null
        },
        { attempts: 120, intervalMs: 1_000, whenExhausted: 'no real Taxi claim appeared' },
      ).catch(async (error: unknown) => {
        let rfqState: unknown
        try {
          const db = betterSqliteDriver(join(workdir, 'solver-swaps.sqlite'))
          try {
            rfqState = await db.get(
              `SELECT id, state, failure_reason, valid_until, deposit_txid, deposit_vout, fill_txid,
                      json_extract(carrier_attempt, '$.phase') AS carrier_attempt_phase
                 FROM asset_rfq_swap WHERE rfq_id = ?`,
              [rfqId],
            )
          } finally {
            await db.close()
          }
        } catch (diagnosticError) {
          rfqState = {
            diagnosticError: diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError),
          }
        }
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; rfq: ${JSON.stringify({ rfqId, fundingTxid, state: rfqState ?? null })}; solver: ${daemonLog}`,
          { cause: error },
        )
      })
      const status = await taxi.status(claim.transferId)
      const transfer = await taxi.verifyIncomingClaim(
        claim,
        {
          receiverAddress: buyerAddress,
          assetId: assetWire(assetId),
          assetUnits: BigInt(swap.quote.to_amount),
          recoveryRecipient: 'receiver',
          claimMode: 'recycle',
        },
        {
          serverKey: arkade.ctx.wallet.arkServerPublicKey,
          emulatorKey: hex.decode(arkade.emulator.pubkey).slice(-32),
          operatorKey: hex.decode(info.operatorKey),
          vtxoMinAmount: arkade.ctx.vtxoMinSats,
          hrp: arkade.profile.arkadeHrp,
        },
        {
          arkdUrl: process.env.ARK_SERVER_URL!,
          emulatorUrl: process.env.EMULATOR_URL!,
          network: 'regtest',
          serverUnrollScript: hex.encode(buyer.wallet.serverUnrollScript.script),
        },
      )
      const floor = BigInt(verified.quote.inputExpiryFloor.value)
      const input = (await buyer.wallet.getSpendableVtxos({ withRecoverable: false, genericallySpendableOnly: true }))
        .filter(
          (coin) =>
            !coin.assets?.length &&
            coin.value >= Number(arkade.ctx.dustSats) &&
            coin.expiresAt !== undefined &&
            BigInt(Math.floor(coin.expiresAt.getTime() / 1000)) >= floor,
        )
        .sort((a, b) => b.value - a.value)[0]
      if (!input?.expiresAt) throw new Error('receiver has no time-expiring sats coin to repay Taxi')
      const claimedTxid = await taxi.recycle(
        transfer,
        {
          input: {
            txid: input.txid,
            vout: input.vout,
            value: BigInt(input.value),
            tapTree: input.tapTree,
            tapLeafScript: input.forfeitTapLeafScript,
          },
          expiry: { kind: 'time', value: BigInt(Math.floor(input.expiresAt.getTime() / 1000)) },
          identity: buyer.identity,
        },
        ArkAddress.decode(buyerAddress).pkScript,
      )
      expect(claimedTxid).toMatch(/^[0-9a-f]{64}$/)
      let lastLedger: Record<string, unknown> = { state: 'not-observed' }
      let settledBalances: Record<string, unknown>
      const observeLedger = async () => {
        const balance = await buyer.wallet.getBalance()
        const buyerAssets = await assetUnits(buyer.wallet)
        const buyerSatInventory = await spendableSatInventory(buyer.wallet)
        const solverBalance = await solver.wallet.getBalance()
        const solverAssets = await assetUnits(solver.wallet)
        const currentTaxi = await taxiInventory()
        const checks = {
          buyerAssets: buyerAssets === BigInt(swap.quote.to_amount),
          solverAssets: solverAssets === solverBefore.assets - BigInt(swap.quote.to_amount),
          buyerSpendableSats: buyerSatInventory.total === BigInt(buyerBefore.sats - Number(swap.fundAmount)),
          buyerDustReserveSats: buyerSatInventory.total - BigInt(balance.available) === arkade.ctx.dustSats,
          buyerAvailableSats: balance.available === Number(buyerSatInventory.total - arkade.ctx.dustSats),
          solverSats: solverBalance.available === solverBefore.sats + Number(swap.quote.from_amount),
          taxiSats: currentTaxi.sats === taxiBefore.sats,
          taxiAssets: currentTaxi.assets.join(',') === taxiBefore.assets.join(','),
        }
        return {
          checks,
          expected: {
            buyerAssets: String(swap.quote.to_amount),
            solverAssets: String(solverBefore.assets - BigInt(swap.quote.to_amount)),
            buyerSpendableSats: buyerBefore.sats - Number(swap.fundAmount),
            buyerDustReserveSats: String(arkade.ctx.dustSats),
            buyerAvailableSats: buyerBefore.sats - Number(swap.fundAmount) - Number(arkade.ctx.dustSats),
            solverSats: solverBefore.sats + Number(swap.quote.from_amount),
            taxi: { sats: String(taxiBefore.sats), assets: taxiBefore.assets },
          },
          observed: {
            buyerAssets: String(buyerAssets),
            solverAssets: String(solverAssets),
            buyerSpendableSats: String(buyerSatInventory.total),
            buyerBareSats: String(buyerSatInventory.withoutAssets),
            buyerAssetBearingSats: String(buyerSatInventory.carryingAssets),
            buyerDustReserveSats: String(buyerSatInventory.total - BigInt(balance.available)),
            buyerAvailableSats: balance.available,
            solverSats: solverBalance.available,
            taxi: { sats: String(currentTaxi.sats), assets: currentTaxi.assets },
          },
        }
      }
      try {
        settledBalances = await poll(
          async () => {
            lastLedger = await observeLedger()
            const checks = lastLedger.checks as Record<string, boolean>
            return Object.values(checks).every(Boolean) ? lastLedger : null
          },
          {
            attempts: 30,
            intervalMs: 1_000,
            whenExhausted: 'ledger did not settle in 30s',
          },
        )
      } catch (error) {
        lastLedger = await observeLedger().catch((cause) => ({ error: String(cause) }))
        const taxiState = await taxi.status(claim.transferId).catch((cause) => ({ error: String(cause) }))
        const finalClaims = await taxi
          .listClaims({ receiverAddresses: [buyerAddress] })
          .catch((cause) => ({ error: String(cause) }))
        const statusTransport = nostrRfqTransport({ relays: [relayUrl], solverPubkey: solverPublicKey })
        let rfqStatus: unknown
        try {
          rfqStatus = await statusTransport.status(rfqId)
        } catch (cause) {
          rfqStatus = { error: String(cause) }
        } finally {
          await statusTransport.close()
        }
        throw new Error(
          `${String(error)}; ledger=${JSON.stringify(lastLedger)}; taxiStatus=${JSON.stringify(taxiState)}; claims=${JSON.stringify(finalClaims)}; rfqStatus=${JSON.stringify(rfqStatus)}`,
        )
      }
      const finalTaxiStatus = await poll(
        async () => {
          const status = await taxi.status(claim.transferId)
          return status.state === 'recycled' && status.spentTxid === claimedTxid ? status : null
        },
        { attempts: 30, intervalMs: 1_000, whenExhausted: 'Taxi did not record the receiver recycle' },
      )
      expect(finalTaxiStatus).toMatchObject({ state: 'recycled', spentTxid: claimedTxid })
      const remainingClaims = (await taxi.listClaims({ receiverAddresses: [buyerAddress] })).claims
      expect(remainingClaims.some((entry) => entry.transferId === claim.transferId)).toBe(false)
      expect(settledBalances.checks).toEqual({
        buyerAssets: true,
        solverAssets: true,
        buyerSpendableSats: true,
        buyerDustReserveSats: true,
        buyerAvailableSats: true,
        solverSats: true,
        taxiSats: true,
        taxiAssets: true,
      })
      const statusTransport = nostrRfqTransport({ relays: [relayUrl], solverPubkey: solverPublicKey })
      try {
        const status = await poll(
          async () => {
            const latest = await statusTransport.status(rfqId)
            return latest?.state === 'settled' ? latest : null
          },
          { attempts: 30, intervalMs: 1_000, whenExhausted: 'solver did not publish the settled RFQ status' },
        )
        expect(status).toMatchObject({ type: 'rfq_status', state: 'settled' })
        expect(status?.profile['fill_txid']).toMatch(/^[0-9a-f]{64}$/)
      } finally {
        await statusTransport.close()
      }
    },
    SWAP_TIMEOUT_MS,
  )
})
