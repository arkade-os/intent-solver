/**
 * The receiver-paid contract against a Taxi's real wire: a loopback HTTP stub serving `/v1/info`,
 * `/v1/receive-quotes/:id` and `/v1/swap-fills`, read by the shipped adapter through the vendored
 * client, with no TAXI_URL. It stops before a signed graph: that handshake is arkade-taxi's to prove.
 * The SDK-built cases also run sender-paid `recycle`, which needs the stub configured as TAXI_URL.
 */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { ArkAddress, asset, CSVMultisigTapscript, DefaultVtxo, SingleKey } from '@arkade-os/sdk'
import { requestArkadeSwap, type RfqQuote, type RfqTransport } from '@arkade-os/swap'
import { TaxiClient, verifyReceiveQuote } from '@arkade-taxi/client'
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
const FLAT_FARE = '25'
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

const PAYOUT_ADDRESS = new ArkAddress(SERVER, PAYOUT, HRP).encode()
const PROCEEDS_ADDRESS = new ArkAddress(SERVER, SOLVER, HRP).encode()

const assetValue = () => {
  const parsed = asset.AssetId.fromString(ASSET)
  return { txid: Uint8Array.from(parsed.txid).reverse(), groupIndex: parsed.groupIndex }
}
const assetWire = () => ({ txid: hex.encode(assetValue().txid), groupIndex: assetValue().groupIndex })

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
      fares: [{ id: 'flat', currency: 'sats', pricing: { kind: 'flat', units: FLAT_FARE } }],
    },
  ],
  maxPerPaymentTopupSats: '10000',
  paused: false,
})

type Payer = 'receiver' | 'sender'
const QUOTE_ID: Record<Payer, string> = { receiver: 'q-1', sender: 'q-2' }

/** `receiveQuotes.ts` `toResponse`: receiver-paid loans the whole dust at a zero fill fare, sender-paid all but the receipt. */
const receiveQuoteWire = (id: TaxiIdentity, payer: Payer = 'receiver') => {
  const receiverPaid = payer === 'receiver'
  const topup = receiverPaid ? DUST : DUST - 1n
  const covenant = new DustCovenantScript({
    serverKey: id.server,
    emulatorKey: EMULATOR,
    vtxoMinAmount: 1n,
    params: {
      receiverKey: PAYOUT,
      senderKey: MAKER,
      operatorKey: id.operator,
      dust: DUST,
      topup,
      assetId: assetValue(),
      locktime: 1_000_000n,
      recoveryRecipient: 'receiver',
      claimMode: 'recycle',
      ...(receiverPaid ? { receiverFare: { currency: 'sats', units: BigInt(FLAT_FARE) } } : {}),
    },
  })
  const height = (value: number) => ({ kind: 'height', value: String(value) })
  return {
    quoteId: QUOTE_ID[payer],
    state: 'quoted',
    receiverAddress: PAYOUT_ADDRESS,
    makerPublicKey: hex.encode(MAKER),
    params: {
      receiverKey: hex.encode(PAYOUT),
      senderKey: hex.encode(MAKER),
      operatorKey: hex.encode(id.operator),
      dust: String(DUST),
      topup: String(topup),
      assetId: assetWire(),
      locktime: '1000000',
      recoveryRecipient: 'receiver',
      claimMode: 'recycle',
      ...(receiverPaid ? { receiverFare: { currency: 'sats', units: FLAT_FARE } } : {}),
    },
    covenantAddress: covenant.address(HRP, id.server).encode(),
    fare: { currency: 'sats', units: receiverPaid ? '0' : FLAT_FARE },
    ...(receiverPaid
      ? { payer: 'receiver', receiverFare: { currency: 'sats', units: FLAT_FARE }, unclaimedMode: 'reclaim' }
      : {}),
    batchExpiry: height(1_200_000),
    inputExpiryFloor: height(1_100_000),
    recoveryLocktime: height(1_000_000),
    createdAt: 1_000,
    expiresAt: 5_000,
  }
}

const covenantScriptOf = (payer: Payer): string =>
  hex.encode(
    ArkAddress.decode(receiveQuoteWire({ operator: OPERATOR, server: SERVER }, payer).covenantAddress).pkScript,
  )

const MAKER_PK_SCRIPT = covenantScriptOf('receiver')

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
    if (route === 'GET /v1/receive-quotes/q-1') return reply(200, receiveQuoteWire(id, 'receiver'))
    if (route === 'GET /v1/receive-quotes/q-2') return reply(200, receiveQuoteWire(id, 'sender'))
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

/** `taxiUrl` is the configured Taxi a sender-paid `recycle` resolves against; receiver-paid names its own. */
const solver = async (taxiUrl?: string) => {
  const store = await AssetRfqSwapStore.open(':memory:', () => NOW)
  const ledger = createReservationLedger()
  const pins = createCarrierPinLedger()
  const errors: unknown[] = []
  let deposit: ObservedDeposit | null = null
  const reader = await taxiReceiveCarrier({
    taxiUrl,
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
    taxiUrl,
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

const rfq = (taxi: StubTaxi, taxiKey: Uint8Array, makerPkScript = MAKER_PK_SCRIPT, rfqId = 'c'.repeat(64)) => ({
  v: 1,
  type: 'rfq_request',
  rfq_id: rfqId,
  pair: `arkade:BTC->arkade:${ASSET}`,
  amount_side: 'from',
  amount: AMOUNT.toString(),
  profile: {
    maker_pk_script: makerPkScript,
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

  it("refuses an offer paying the payee's own address, which the Taxi would refuse at fill", async () => {
    const taxi = await startTaxi({ operator: OPERATOR, server: SERVER })
    const s = await solver()

    const plain = hex.encode(ArkAddress.decode(PAYOUT_ADDRESS).pkScript)
    const outcome = await s.corridor.quote(rfq(taxi, OPERATOR, plain))
    expect(outcome).toMatchObject({ kind: 'refused', payload: { reason: 'pricing_unavailable' } })
    expect(await s.store.findByRfqId('c'.repeat(64))).toBeUndefined()
    expect(s.errors).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/not the verified quote's receive covenant/) }),
    ])
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

const startArkd = async (): Promise<string> => {
  const info = {
    signerPubkey: hex.encode(SERVER),
    network: 'regtest',
    unilateralExitDelay: '144',
    dust: String(DUST),
    vtxoMinAmount: '1',
    checkpointTapscript: hex.encode(
      CSVMultisigTapscript.encode({ timelock: { type: 'blocks', value: 10n }, pubkeys: [SERVER] }).script,
    ),
  }
  const server = createServer((request, response) => {
    const found = `${request.method} ${request.url}` === 'GET /v1/info'
    response.writeHead(found ? 200 : 404, { 'content-type': 'application/json' })
    response.end(JSON.stringify(found ? info : {}))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  open.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** The payer: its key is the offer's maker key, and its own address never reaches the offer. */
const payerWallet = {
  getAddress: async () => new ArkAddress(SERVER, MAKER, HRP).encode(),
  identity: { xOnlyPublicKey: async () => MAKER },
  getContractManager: async () =>
    new Proxy({}, { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }),
}

/** What a wallet hands `requestArkadeSwap`: the stub's quote, verified by the Taxi's own client. */
const walletCarrierQuote = async (taxi: StubTaxi, payer: Payer) => {
  const client = new TaxiClient({ baseUrl: taxi.url })
  const [info, quote] = await Promise.all([client.info(), client.getReceiveQuote(QUOTE_ID[payer])])
  return verifyReceiveQuote({
    quote,
    info,
    trustedServerKey: SERVER,
    trustedEmulatorKey: EMULATOR,
    dust: DUST,
    vtxoMinAmount: 1n,
    hrp: HRP,
    now: NOW,
    expect: {
      receiverAddress: PAYOUT_ADDRESS,
      makerPublicKey: MAKER,
      assetId: assetValue(),
      fundingExpiry: { kind: 'height', value: 1_100_000n },
      ...(payer === 'receiver' ? { payer: 'receiver' as const } : {}),
      maxServiceFareSats: DUST,
      minRecoveryLocktime: { kind: 'height', value: 1n },
      minInputExpiryFloor: { kind: 'height', value: 1n },
    },
  }).descriptor
}

/** The solver's corridor behind the SDK's transport seam, JSON both ways as on the wire. */
const solverTransport = (s: Awaited<ReturnType<typeof solver>>) => {
  const sent: Record<string, unknown>[] = []
  const transport: RfqTransport = {
    requestQuote: async (payload) => {
      const request = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
      sent.push(request)
      const outcome = await s.corridor.quote(request)
      if (outcome.kind !== 'quote') {
        const causes = s.errors.map((error) => (error instanceof Error ? error.message : String(error)))
        throw new Error(`solver ${outcome.detail ?? outcome.kind}: ${causes.join('; ')}`)
      }
      return JSON.parse(JSON.stringify(outcome.payload)) as RfqQuote
    },
    status: async () => null,
    close: async () => {},
  }
  return { sent, transport }
}

describe('an RFQ the wallet SDK builds from a Taxi-verified receive quote', () => {
  it.each(['receiver', 'sender'] as const)('is accepted end to end when the %s pays the carrier', async (payer) => {
    const taxi = await startTaxi({ operator: OPERATOR, server: SERVER })
    const arkd = await startArkd()
    const s = await solver(payer === 'sender' ? taxi.url : undefined)
    const quote = await walletCarrierQuote(taxi, payer)
    const { sent, transport } = solverTransport(s)
    const rfqId = 'd'.repeat(64)

    const swap = await requestArkadeSwap(payerWallet as never, arkd, transport, {
      wantAsset: asset.AssetId.fromString(ASSET),
      amount: AMOUNT,
      rfqId,
      emulatorPubkey: '02' + hex.encode(EMULATOR),
      now: NOW,
      carrier:
        payer === 'receiver'
          ? { mode: 'recycleReceiver', quote, taxi: { url: taxi.url, operatorKey: hex.encode(OPERATOR) } }
          : { mode: 'recycle', quote },
    })

    const covenant = hex.encode(ArkAddress.decode(quote.receiveAddress).pkScript)
    expect(covenant).toBe(covenantScriptOf(payer))
    expect(sent).toEqual([expect.objectContaining({ profile: expect.objectContaining({ maker_pk_script: covenant }) })])
    const row = (await s.store.findByRfqId(rfqId))!
    expect(row).toMatchObject({
      makerPkScript: covenant,
      carrierTerms: { mode: payer === 'receiver' ? 'recycle_receiver' : 'recycle', quoteId: QUOTE_ID[payer] },
    })
    expect(swap.address).toBe(row.offerAddress)
    expect(s.errors).toEqual([])
  })
})
