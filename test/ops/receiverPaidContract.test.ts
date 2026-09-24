/**
 * The receiver-paid contract against a Taxi's real wire: a loopback HTTP stub serving `/v1/info`,
 * `/v1/receive-quotes/:id` and `/v1/swap-fills`, read by the shipped adapter through the vendored
 * client, with no TAXI_URL. It stops before a signed graph: that handshake is arkade-taxi's to prove.
 */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { ArkAddress, asset, DefaultVtxo, SingleKey } from '@arkade-os/sdk'
import { AssetRfqSwapStore } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import {
  AssetRfqSwapService,
  type AssetRfqMarket,
  type ObservedDeposit,
} from '@arkade-os/solver-corridors/asset/assetRfqOrchestrator.js'
import { assetRfqCorridor, assetRfqDescriptor } from '@arkade-os/solver-corridors/corridors/assetRfq.js'
import { createReservationLedger } from '@arkade-os/solver-arkade/arkade/reservations.js'
import { offerExitDelay, offerHexFrom, offerScriptFrom } from '@arkade-os/solver-arkade/arkade/offerTerms.js'
import {
  createCarrierPinLedger,
  taxiReceiveCarrier,
  type CarrierCoin,
  type TaxiCarrierTrust,
} from '@arkade-os/solver-app/ops/assetRfqTaxi.js'
import { completeTaxiReceiveCarrier } from '@arkade-os/solver-app/ops/assetRfqTaxiAdapter.js'
import { normalizeTaxiUrl, type TaxiUrlPolicy } from '@arkade-os/solver-app/ops/taxiUrlGuard.js'

const require = createRequire(import.meta.url)
const covenantEntry = createRequire(require.resolve('@arkade-taxi/client')).resolve('@arkade-taxi/covenant')
const { DustCovenantScript } = (await import(pathToFileURL(covenantEntry).href)) as {
  DustCovenantScript: new (options: {
    serverKey: Uint8Array
    emulatorKey: Uint8Array
    params: Record<string, unknown>
    vtxoMinAmount: bigint
  }) => { address: (hrp: string, serverKey: Uint8Array) => { encode: () => string } }
}

const secret = (seed: number): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? seed : 7))
const key = (seed: number): Uint8Array => schnorr.getPublicKey(secret(seed))

const SERVER = key(1)
const EMULATOR = key(2)
const OPERATOR = key(3)
const PAYOUT = key(4)
const MAKER = key(5)
const SOLVER = key(6)
const HRP = 'tark'
const DUST = 330n
const RECEIVER_FARE = '25'
const ASSET = `${'aa'.repeat(31)}bb0100`
const NOW = 2_000
const TIP = 1_000_000
const DEPOSIT = '1'.repeat(64)
const AMOUNT = 20_000n

// The guard refuses a loopback host unless the operator allows private ones.
const POLICY: TaxiUrlPolicy = { isMainnet: false, allowPrivate: true }

const TRUST: TaxiCarrierTrust = {
  serverKey: SERVER,
  emulatorKey: EMULATOR,
  dustSats: DUST,
  vtxoMinAmount: 1n,
  hrp: HRP,
  locktimeDomain: 'height',
  inputExpiryMargin: 5n,
}

const MAKER_PK_SCRIPT = hex.encode(new ArkAddress(SERVER, PAYOUT, HRP).pkScript)
const PROCEEDS_ADDRESS = new ArkAddress(SERVER, SOLVER, HRP).encode()

const assetWire = () => {
  const parsed = asset.AssetId.fromString(ASSET)
  return { txid: hex.encode(Uint8Array.from(parsed.txid).reverse()), groupIndex: parsed.groupIndex }
}

const SOLVER_SCRIPT = new DefaultVtxo.Script({
  pubKey: SOLVER,
  serverPubKey: SERVER,
  csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
})
const COIN: CarrierCoin = {
  txid: '2'.repeat(64),
  vout: 0,
  value: 10_000,
  expiresAtHeight: 1_200_000,
  assets: [{ assetId: ASSET, amount: 10n ** 6n }],
  tapTree: SOLVER_SCRIPT.encode(),
  forfeitTapLeafScript: SOLVER_SCRIPT.forfeit(),
  script: hex.encode(SOLVER_SCRIPT.pkScript),
}

const DERIVATION = { serverPubkey: SERVER, emulatorPubkey: EMULATOR, hrp: HRP, exitDelay: offerExitDelay(144) }

const MARKET: AssetRfqMarket = {
  base: null,
  quote: ASSET,
  symbol: 'USDA',
  baseDecimals: 8,
  quoteDecimals: 0,
  feeBps: 0,
  sellBase: { min: 1n, max: 10n ** 12n },
  buyBase: { min: 1n, max: 10n ** 12n },
  feedUrl: 'http://feed.invalid',
  pricePath: '/price',
  carrierSats: DUST,
}

/** What a Taxi answers as: its operator key and the Arkade server it claims. */
interface TaxiIdentity {
  operator: Uint8Array
  server: Uint8Array
}

const infoWire = (id: TaxiIdentity) => ({
  protocolVersion: 1,
  operatorKey: hex.encode(id.operator),
  serverKey: hex.encode(id.server),
  emulatorKey: hex.encode(EMULATOR),
  arkdUrl: 'http://arkd.invalid',
  emulatorUrl: 'http://emulator.invalid',
  dust: String(DUST),
  vtxoMinAmount: '1',
  assetRules: [
    {
      assetId: assetWire(),
      enabled: true,
      claim: 'either',
      maxTopupSats: null,
      fares: [{ id: 'flat', currency: 'sats', pricing: { kind: 'flat', units: RECEIVER_FARE } }],
    },
  ],
  maxPerPaymentTopupSats: '10000',
  paused: false,
})

/** `receiveQuotes.ts` `toResponse` for `payer: 'receiver'`: the whole dust as loan, a zero fill fare. */
const receiveQuoteWire = (id: TaxiIdentity) => {
  const parsed = asset.AssetId.fromString(ASSET)
  const covenant = new DustCovenantScript({
    serverKey: id.server,
    emulatorKey: EMULATOR,
    vtxoMinAmount: 1n,
    params: {
      receiverKey: PAYOUT,
      senderKey: MAKER,
      operatorKey: id.operator,
      dust: DUST,
      topup: DUST,
      assetId: { txid: Uint8Array.from(parsed.txid).reverse(), groupIndex: parsed.groupIndex },
      locktime: 1_000_000n,
      recoveryRecipient: 'receiver',
      claimMode: 'recycle',
      receiverFare: { currency: 'sats', units: BigInt(RECEIVER_FARE) },
    },
  })
  const height = (value: number) => ({ kind: 'height', value: String(value) })
  return {
    quoteId: 'q-1',
    state: 'quoted',
    receiverAddress: new ArkAddress(SERVER, PAYOUT, HRP).encode(),
    makerPublicKey: hex.encode(MAKER),
    params: {
      receiverKey: hex.encode(PAYOUT),
      senderKey: hex.encode(MAKER),
      operatorKey: hex.encode(id.operator),
      dust: String(DUST),
      topup: String(DUST),
      assetId: assetWire(),
      locktime: '1000000',
      recoveryRecipient: 'receiver',
      claimMode: 'recycle',
      receiverFare: { currency: 'sats', units: RECEIVER_FARE },
    },
    covenantAddress: covenant.address(HRP, id.server).encode(),
    fare: { currency: 'sats', units: '0' },
    payer: 'receiver',
    receiverFare: { currency: 'sats', units: RECEIVER_FARE },
    unclaimedMode: 'reclaim',
    batchExpiry: height(1_200_000),
    inputExpiryFloor: height(1_100_000),
    recoveryLocktime: height(1_000_000),
    createdAt: 1_000,
    expiresAt: 5_000,
  }
}

interface StubTaxi {
  url: string
  requests: string[]
  swapFills: Record<string, unknown>[]
}

const open: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of open.splice(0)) await close()
})

const startTaxi = async (id: TaxiIdentity): Promise<StubTaxi> => {
  const stub: Omit<StubTaxi, 'url'> = { requests: [], swapFills: [] }
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const route = `${request.method} ${request.url}`
    stub.requests.push(route)
    const reply = (status: number, payload: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }
    if (route === 'GET /v1/info') return reply(200, infoWire(id))
    if (route === 'GET /v1/receive-quotes/q-1') return reply(200, receiveQuoteWire(id))
    if (route === 'POST /v1/swap-fills') {
      stub.swapFills.push(JSON.parse(body) as Record<string, unknown>)
      // `routes.ts` `assertFinancialMutationReady`: refused before any graph exists.
      return reply(503, { error: 'service is not ready', code: 'not_ready' })
    }
    return reply(404, { error: `${route} not found`, code: 'not_found' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  open.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { ...stub, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

const solver = async () => {
  const store = await AssetRfqSwapStore.open(':memory:', () => NOW)
  const ledger = createReservationLedger()
  const pins = createCarrierPinLedger()
  const errors: unknown[] = []
  let deposit: ObservedDeposit | null = null
  const reader = await taxiReceiveCarrier({
    taxiUrl: undefined,
    policy: POLICY,
    trust: async () => TRUST,
    maxServiceFareSats: DUST,
    contracts: async () => ({ getContractsWithVtxos: async () => [{ vtxos: [COIN] }] }) as never,
    reserved: () => ledger.reserved(),
    quoteValiditySeconds: 30,
    tipHeight: async () => TIP,
  })
  const offerHex = offerHexFrom(DERIVATION)
  const carrier = completeTaxiReceiveCarrier(reader, {
    taxiUrl: undefined,
    policy: POLICY,
    store,
    chain: { getVtxos: async () => ({ vtxos: [] }), getVirtualTxs: async () => ({ txs: [] }) },
    pins,
    coins: async () => [COIN],
    reserved: () => ledger.reserved(),
    reserve: (outpoints) => ledger.reserve(outpoints),
    wallet: {} as never,
    identity: SingleKey.fromPrivateKey(secret(6)),
    arkServerUrl: 'http://arkd.invalid',
    dustSats: DUST,
    offerHex: (row) =>
      offerHex(
        {
          wantAmount: row.toAmount,
          wantAssetId: row.toAssetId,
          offerAssetId: row.fromAssetId,
          makerPkScript: row.makerPkScript,
          makerPublicKey: row.makerPublicKey,
        },
        row.offerPkScript,
      ),
    proceedsAddress: PROCEEDS_ADDRESS,
    solverKeys: [hex.encode(SOLVER)],
    serverKey: () => SERVER,
    now: () => NOW,
  })
  const service = new AssetRfqSwapService({
    store,
    markets: [MARKET],
    solverPubkey: hex.encode(SOLVER),
    quoteValiditySeconds: 30,
    dustSats: DUST,
    now: () => NOW,
    deriveOffer: offerScriptFrom(DERIVATION),
    depositAt: async () => deposit,
    balance: async () => new Map([[ASSET, 10n ** 12n]]),
    fetchPrice: async () => ({ mantissa: 100_000_000n, scale: 0 }),
    settle: async () => {
      throw new Error('a carrier row never takes the generic settle')
    },
    receiveCarrierQuotes: carrier,
    onError: (_id, error) => errors.push(error),
  })
  const corridor = assetRfqCorridor(assetRfqDescriptor(MARKET, 'sell_base'), service, store)
  const fund = () => {
    deposit = { txid: DEPOSIT, vout: 1, sats: AMOUNT, assets: [] }
  }
  return { store, ledger, pins, errors, corridor, fund }
}

const rfq = (taxi: StubTaxi, taxiKey: Uint8Array, rfqId = 'c'.repeat(64)) => ({
  v: 1,
  type: 'rfq_request',
  rfq_id: rfqId,
  pair: `arkade:BTC->arkade:${ASSET}`,
  amount_side: 'from',
  amount: AMOUNT.toString(),
  profile: {
    maker_pk_script: MAKER_PK_SCRIPT,
    maker_public_key: hex.encode(MAKER),
    carrier: { mode: 'recycle_receiver', quote_id: 'q-1', taxi_url: taxi.url, taxi_key: hex.encode(taxiKey) },
  },
})

describe('the receiver-paid carrier against a stub Taxi on the real wire', () => {
  it('resolves a receiver-paid quote, prices it at zero, and fills against the Taxi and key it named', async () => {
    const taxi = await startTaxi({ operator: OPERATOR, server: SERVER })
    expect(() => normalizeTaxiUrl(taxi.url, { ...POLICY, allowPrivate: false })).toThrow(/must not be private/)
    const s = await solver()

    const outcome = await s.corridor.quote(rfq(taxi, OPERATOR))
    expect(outcome.kind, JSON.stringify(outcome)).toBe('quote')
    expect(outcome.payload).toMatchObject({ from_amount: AMOUNT.toString(), to_amount: AMOUNT.toString() })
    expect(outcome.payload).not.toHaveProperty('carrier_sats')
    const row = (await s.store.findByRfqId('c'.repeat(64)))!
    expect(row.carrierTerms).toEqual({
      mode: 'recycle_receiver',
      quoteId: 'q-1',
      physicalSats: DUST,
      loanSats: DUST,
      receiptSats: 0n,
      serviceFareSats: 0n,
      pricedSats: 0n,
      expiresAt: 5_000,
      taxiUrl: taxi.url,
      taxiKey: hex.encode(OPERATOR),
    })

    s.fund()
    await s.corridor.tickAll()
    await s.corridor.tickAll()
    expect(taxi.swapFills).toEqual([
      expect.objectContaining({
        operationId: row.id,
        receiveQuoteId: 'q-1',
        contributionSats: String(DUST),
        maxFare: { currency: 'sats', units: '0' },
        fundingTxid: DEPOSIT,
        fundingVout: 1,
        solverInputs: [expect.objectContaining({ txid: COIN.txid, vout: COIN.vout })],
      }),
    ])
    expect(await s.store.readCarrierAttempt(row.id)).toMatchObject({
      phase: 'not_submitted',
      snapshot: { provider: taxi.url, provider_key: hex.encode(OPERATOR) },
    })
    expect((await s.store.get(row.id)).state).toBe('refused')
    expect(s.pins.held()).toEqual([])
    expect([...s.ledger.reserved()]).toEqual([])
    expect(s.errors).toEqual([expect.objectContaining({ name: 'TaxiError', code: 'not_ready' })])
  })

  it('refuses a Taxi answering to a different operator key than the request named', async () => {
    const taxi = await startTaxi({ operator: key(9), server: SERVER })
    const s = await solver()

    const outcome = await s.corridor.quote(rfq(taxi, OPERATOR))
    expect(outcome).toMatchObject({ kind: 'refused', payload: { reason: 'pricing_unavailable' } })
    expect(await s.store.findByRfqId('c'.repeat(64))).toBeUndefined()
    expect(taxi.requests).toContain('GET /v1/info')
    expect(taxi.swapFills).toEqual([])
    expect(s.errors).toEqual([expect.objectContaining({ message: expect.stringMatching(/operator key differs/) })])
  })

  it("refuses a Taxi whose serverKey is not the running context's", async () => {
    const taxi = await startTaxi({ operator: OPERATOR, server: key(10) })
    const s = await solver()

    const outcome = await s.corridor.quote(rfq(taxi, OPERATOR))
    expect(outcome).toMatchObject({ kind: 'refused', payload: { reason: 'pricing_unavailable' } })
    expect(await s.store.findByRfqId('c'.repeat(64))).toBeUndefined()
    expect(taxi.swapFills).toEqual([])
    expect(s.errors).toEqual([expect.objectContaining({ message: expect.stringMatching(/untrusted server/) })])
  })
})
