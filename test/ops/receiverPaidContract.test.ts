/**
 * The receiver-paid contract against a Taxi's real wire: a loopback HTTP stub serving `/v1/info`,
 * `/v1/receive-quotes/:id` and `/v1/swap-fills`, read by the shipped adapter through the vendored
 * client, with no TAXI_URL. The stub binds the receive quote when it quotes a fill, as the Taxi does;
 * only the graph's rebuild and signature are faked, since no arkd here serves the deposit.
 * The SDK-built cases also run sender-paid `recycle`, which needs the stub configured as TAXI_URL.
 */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { base64, hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { ArkAddress, asset, CSVMultisigTapscript, DefaultVtxo, SingleKey, Transaction } from '@arkade-os/sdk'
import { decodeOffer, requestArkadeSwap, type RfqQuote, type RfqTransport } from '@arkade-os/swap'
import {
  digestJointGraph,
  OFFER_FILL_TEMPLATE,
  TaxiClient,
  verifyReceiveQuote,
  type JointGraph,
} from '@arkade-taxi/client'
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
const receiveQuoteWire = (id: TaxiIdentity, payer: Payer = 'receiver', floor = 1_100_000) => {
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
    inputExpiryFloor: height(floor),
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

interface SwapFillRequestWire {
  operationId: string
  receiveQuoteId: string
  offerHex: string
  solverInputs: { txid: string; vout: number }[]
  contributionSats: string
  maxFare: { currency: string; units: string }
  fundingTxid: string
  fundingVout: number
  validUntil: number
}

interface StubTaxi {
  url: string
  requests: string[]
  swapFills: SwapFillRequestWire[]
  accepted: string[]
}

/** The one clock the solver and the stub share; each stub request first moves it by `latency` seconds. */
const clock = { now: NOW, latency: 0 }

/** What the Taxi serves once the swap-fill quote has bound the receive quote. */
interface AfterBind {
  bindTo?: string
  floor?: number
  operator?: Uint8Array
}

const FILL_ID = 'fill-1'

const psbtOf = (ins: readonly (readonly [string, number])[]): string => {
  const tx = new Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true })
  for (const [txid, index] of ins) tx.addInput({ txid, index })
  tx.addOutput({ script: ArkAddress.decode(PROCEEDS_ADDRESS).pkScript, amount: 1_000n })
  return base64.encode(tx.toPSBT())
}

/** The deposit, then each solver coin: what the client's plan check parses and digests. */
const fillGraph = (deposit: { txid: string; vout: number }, solver: readonly { txid: string; vout: number }[]) => {
  const ins = [deposit, ...solver].map(({ txid, vout }) => [txid, vout] as const)
  const plan = {
    arkTx: psbtOf(ins),
    checkpoints: ins.map((input) => psbtOf([input])),
    inputOwners: [null, ...solver.map(() => 'solver')],
  }
  return { ...plan, graphId: digestJointGraph(plan, OFFER_FILL_TEMPLATE) } satisfies JointGraph
}

const swapFillQuoteWire = (fill: SwapFillRequestWire, covenant: string, expiresAt: number) => {
  const graph = fillGraph({ txid: fill.fundingTxid, vout: fill.fundingVout }, fill.solverInputs)
  return {
    fillId: FILL_ID,
    operationId: fill.operationId,
    expiresAt,
    template: 'taxi-fill/1',
    contributionSats: fill.contributionSats,
    fare: { currency: 'sats', units: '0' },
    graph: {
      arkTx: graph.arkTx,
      checkpoints: graph.checkpoints,
      graphId: graph.graphId,
      template: 'taxi-fill/1',
      inputs: [
        { owner: 'offer-covenant', txid: fill.fundingTxid, vout: fill.fundingVout },
        ...fill.solverInputs.map(({ txid, vout }) => ({ owner: 'solver', txid, vout })),
      ],
      outputs: [
        { role: 'receiver', vout: 0, script: covenant, sats: String(DUST), assets: [] },
        {
          role: 'solver',
          vout: 1,
          script: hex.encode(ArkAddress.decode(PROCEEDS_ADDRESS).pkScript),
          sats: '1000',
          assets: [],
        },
      ],
    },
  }
}

/** `swapFillQuotes.ts` ~:336-409: an unbound receive quote, and an offer paying its covenant on its terms. */
const receiveQuoteRefusal = (quote: ReturnType<typeof receiveQuoteWire>, fill: SwapFillRequestWire) => {
  const offer = decodeOffer(hex.decode(fill.offerHex))
  const covenant = hex.encode(ArkAddress.decode(quote.covenantAddress).pkScript)
  if (
    hex.encode(offer.makerPublicKey) !== quote.makerPublicKey ||
    hex.encode(offer.makerPkScript) !== covenant ||
    offer.wantAsset?.toString() !== ASSET ||
    offer.wantAmount <= 0n ||
    fill.contributionSats !== quote.params.topup ||
    fill.maxFare.currency !== 'sats' ||
    BigInt(fill.maxFare.units) < BigInt(quote.fare.units)
  ) {
    return { code: 'receive_quote_mismatch', error: 'offer, contribution, or fare cap differs from the receive quote' }
  }
  return undefined
}

const open: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of open.splice(0)) await close()
  Object.assign(clock, { now: NOW, latency: 0 })
})

interface StubOptions {
  notReady?: boolean
  afterBind?: AfterBind
  /** From this read of `q-1` on, the Taxi is unreachable, refuses, or serves a quote that fails verification. */
  failReadsFrom?: { read: number; how: 'unreachable' | 'refusing' | 'hostile' }
  submitFails?: boolean
  /** The receive quotes' own expiry; the Taxi's default lifetime is 60s. */
  quoteExpiresAt?: number
}

const startTaxi = async (id: TaxiIdentity, options: StubOptions = {}): Promise<StubTaxi> => {
  const stub: Omit<StubTaxi, 'url'> = { requests: [], swapFills: [], accepted: [] }
  const bound = new Map<string, string>()
  const quoteExpiresAt = options.quoteExpiresAt ?? 5_000
  let fillExpiresAt = 0
  let reads = 0
  // `getReceiveQuote` expires an unbound quote past its expiry; a bound one lives on with its fill.
  const served = (payer: Payer) => {
    const boundFillId = bound.get(QUOTE_ID[payer])
    if (boundFillId !== undefined) {
      const quote = receiveQuoteWire(id, payer, options.afterBind?.floor)
      return { ...quote, expiresAt: quoteExpiresAt, state: 'bound', boundFillId }
    }
    const state = clock.now >= quoteExpiresAt ? 'expired' : 'quoted'
    return { ...receiveQuoteWire(id, payer), expiresAt: quoteExpiresAt, state }
  }
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const route = `${request.method} ${request.url}`
    stub.requests.push(route)
    clock.now += clock.latency
    const reply = (status: number, payload: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }
    const operator = bound.size > 0 ? (options.afterBind?.operator ?? id.operator) : id.operator
    if (route === 'GET /v1/info') return reply(200, infoWire({ ...id, operator }))
    const fail = options.failReadsFrom
    if (route === 'GET /v1/receive-quotes/q-1' && fail !== undefined && ++reads >= fail.read) {
      if (fail.how === 'unreachable') return void request.socket.destroy()
      if (fail.how === 'refusing') return reply(503, { error: 'service is not ready', code: 'not_ready' })
      return reply(200, { ...served('receiver'), covenantAddress: receiveQuoteWire(id, 'sender').covenantAddress })
    }
    if (route === 'GET /v1/receive-quotes/q-1') return reply(200, served('receiver'))
    if (route === 'GET /v1/receive-quotes/q-2') return reply(200, served('sender'))
    if (route === 'POST /v1/swap-fills') {
      const fill = JSON.parse(body) as SwapFillRequestWire
      stub.swapFills.push(fill)
      // `routes.ts` `assertFinancialMutationReady`: refused before any graph exists.
      if (options.notReady) return reply(503, { error: 'service is not ready', code: 'not_ready' })
      // `swapFillQuotes.ts` `assertDeadlineLive`, then the receive quote must be unbound and unexpired.
      if (fill.validUntil <= clock.now) {
        return reply(409, { error: 'caller deadline has passed', code: 'swap_fill_deadline_expired' })
      }
      if (bound.has(fill.receiveQuoteId) || quoteExpiresAt <= clock.now) {
        return reply(409, { error: 'receive quote is missing, expired, bound', code: 'receive_quote_unavailable' })
      }
      const quote = receiveQuoteWire(id, fill.receiveQuoteId === QUOTE_ID.receiver ? 'receiver' : 'sender')
      const refusal = receiveQuoteRefusal(quote, fill)
      if (refusal) return reply(400, refusal)
      // `swapFillQuotes.ts` ~:814: quoting the fill binds the receive quote to it.
      bound.set(fill.receiveQuoteId, options.afterBind?.bindTo ?? FILL_ID)
      fillExpiresAt = Math.min(fill.validUntil, quoteExpiresAt)
      const covenant = hex.encode(ArkAddress.decode(quote.covenantAddress).pkScript)
      return reply(200, swapFillQuoteWire(fill, covenant, fillExpiresAt))
    }
    if (route === `POST /v1/swap-fills/${FILL_ID}/submit`) {
      if (options.submitFails) return reply(500, { error: 'internal error', code: 'internal' })
      // `swapFillSubmit.ts` ~:358.
      if (fillExpiresAt <= clock.now) {
        return reply(409, { error: `swap fill ${FILL_ID} quote expired`, code: 'quote_expired' })
      }
      stub.accepted.push(FILL_ID)
      const fill = stub.swapFills.at(-1)!
      return reply(200, {
        fillId: FILL_ID,
        operationId: fill.operationId,
        state: 'submitting',
        updatedAt: clock.now,
        expiresAt: fillExpiresAt,
      })
    }
    return reply(404, { error: `${route} not found`, code: 'not_found' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  open.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { ...stub, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

/** `taxiUrl` is the configured Taxi a sender-paid `recycle` resolves against; receiver-paid names its own. */
const solver = async (taxiUrl?: string) => {
  const store = await AssetRfqSwapStore.open(':memory:', () => clock.now)
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
    now: () => clock.now,
    fill: {
      rebuild: async ({ row, inputs }) => fillGraph({ txid: row.depositTxid!, vout: row.depositVout! }, inputs),
      sign: async (graph) => graph,
    },
  })
  const service = new AssetRfqSwapService({
    store,
    markets: [MARKET],
    solverPubkey: hex.encode(SOLVER),
    quoteValiditySeconds: 30,
    dustSats: DUST,
    now: () => clock.now,
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

const receiverPaid = (taxi: StubTaxi, taxiKey: Uint8Array) => ({
  mode: 'recycle_receiver',
  quote_id: 'q-1',
  taxi_url: taxi.url,
  taxi_key: hex.encode(taxiKey),
})

const rfqWith = (carrier: Record<string, unknown>, makerPkScript: string, rfqId = 'c'.repeat(64)) => ({
  v: 1,
  type: 'rfq_request',
  rfq_id: rfqId,
  pair: `arkade:BTC->arkade:${ASSET}`,
  amount_side: 'from',
  amount: AMOUNT.toString(),
  profile: { maker_pk_script: makerPkScript, maker_public_key: hex.encode(MAKER), carrier },
})

const rfq = (taxi: StubTaxi, taxiKey: Uint8Array, makerPkScript = MAKER_PK_SCRIPT) =>
  rfqWith(receiverPaid(taxi, taxiKey), makerPkScript)

/** Quote, fund, and drive the row to its fill: one pass sees the deposit, the next settles. */
const quoteAndFill = async (s: Awaited<ReturnType<typeof solver>>, request: Record<string, unknown>, latency = 0) => {
  const outcome = await s.corridor.quote(request)
  expect(outcome.kind, JSON.stringify(outcome)).toBe('quote')
  const row = (await s.store.findByRfqId(request.rfq_id as string))!
  clock.latency = latency
  s.fund()
  await s.corridor.tickAll()
  await s.corridor.tickAll()
  return row
}

const submitRoute = `POST /v1/swap-fills/${FILL_ID}/submit`

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
    expect(taxi.requests.filter((route) => route === submitRoute)).toHaveLength(1)
    expect(await s.store.readCarrierAttempt(row.id)).toMatchObject({
      phase: 'submitting',
      snapshot: { provider: taxi.url, provider_key: hex.encode(OPERATOR) },
    })
    expect((await s.store.get(row.id)).state).toBe('filling')
    expect(s.pins.held()).toEqual([row.id])
    expect(s.errors).toEqual([])
  })

  it('refuses the row and frees its pins when the Taxi is not ready before any graph exists', async () => {
    const taxi = await startTaxi({ operator: OPERATOR, server: SERVER }, { notReady: true })
    const s = await solver()

    const row = await quoteAndFill(s, rfq(taxi, OPERATOR))
    expect(taxi.requests).not.toContain(submitRoute)
    expect(await s.store.readCarrierAttempt(row.id)).toMatchObject({ phase: 'not_submitted' })
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

describe('a fill through a Taxi that binds its receive quote when it quotes the fill', () => {
  const MODES = {
    recycle: {
      carrier: () => ({ mode: 'recycle', quote_id: QUOTE_ID.sender }),
      makerPkScript: covenantScriptOf('sender'),
    },
    recycle_receiver: { carrier: (taxi: StubTaxi) => receiverPaid(taxi, OPERATOR), makerPkScript: MAKER_PK_SCRIPT },
  }
  const start = async (mode: keyof typeof MODES, afterBind?: AfterBind) => {
    const taxi = await startTaxi({ operator: OPERATOR, server: SERVER }, { afterBind })
    const s = await solver(mode === 'recycle' ? taxi.url : undefined)
    const row = await quoteAndFill(s, rfqWith(MODES[mode].carrier(taxi), MODES[mode].makerPkScript))
    return { taxi, s, row }
  }

  it.each(['recycle', 'recycle_receiver'] as const)('submits a %s fill once the quote is bound to it', async (mode) => {
    const { taxi, s, row } = await start(mode)
    expect(taxi.requests.filter((route) => route === submitRoute)).toHaveLength(1)
    expect(await s.store.readCarrierAttempt(row.id)).toMatchObject({ phase: 'submitting' })
    expect(s.pins.held()).toEqual([row.id])
    expect(s.errors).toEqual([])
  })

  it.each([
    ['recycle_receiver', 'bound to another fill', { bindTo: 'fill-2' }, /not bound to fill fill-1/],
    ['recycle', 'bound to another fill', { bindTo: 'fill-2' }, /not bound to fill fill-1/],
    ['recycle_receiver', 'serving another input expiry floor', { floor: 1_150_000 }, /pinned an input expiry floor/],
    ['recycle_receiver', 'naming another operator', { operator: key(9) }, /operator key differs/],
    ['recycle', 'naming another operator', { operator: key(9) }, /substituted the operator key/],
  ] as const)(
    'refuses a %s fill before submitting when the quote is %s, and frees the pins',
    async (mode, _why, afterBind, why) => {
      const { taxi, s, row } = await start(mode, afterBind)
      expect(taxi.swapFills).toHaveLength(1)
      expect(taxi.requests).not.toContain(submitRoute)
      expect(await s.store.readCarrierAttempt(row.id)).toMatchObject({ phase: 'not_submitted' })
      expect((await s.store.get(row.id)).state).toBe('refused')
      expect(s.pins.held()).toEqual([])
      expect([...s.ledger.reserved()]).toEqual([])
      expect(s.errors).toEqual([expect.objectContaining({ message: expect.stringMatching(why) })])
    },
  )
})

/** A 60s receive quote leaves `valid_until` at NOW + 30. Each Taxi round trip below moves the clock `latency` seconds,
 * so the funded fill's own reads carry it past `valid_until`, and at 9s past the receive quote's expiry too. */
describe("a fill decided by valid_until runs on to the receive quote's own expiry, and no further", () => {
  const QUOTE_EXPIRES_AT = NOW + 60

  it.each(['recycle_receiver', 'recycle'] as const)(
    'fills a %s row whose Taxi round trips outlast valid_until, inside the margin',
    async (mode) => {
      const taxi = await startTaxi({ operator: OPERATOR, server: SERVER }, { quoteExpiresAt: QUOTE_EXPIRES_AT })
      const s = await solver(mode === 'recycle' ? taxi.url : undefined)
      const request =
        mode === 'recycle'
          ? rfqWith({ mode: 'recycle', quote_id: QUOTE_ID.sender }, covenantScriptOf('sender'))
          : rfq(taxi, OPERATOR)

      const row = await quoteAndFill(s, request, 5)
      expect(s.errors).toEqual([])
      expect(taxi.accepted).toEqual([FILL_ID])
      expect(row.validUntil).toBe(NOW + 30)
      expect(clock.now).toBeGreaterThan(row.validUntil)
      expect(taxi.swapFills).toEqual([expect.objectContaining({ validUntil: QUOTE_EXPIRES_AT })])
    },
  )

  it('refuses before submitting, freeing the pins, a fill whose reads carry it past the receive quote', async () => {
    const taxi = await startTaxi({ operator: OPERATOR, server: SERVER }, { quoteExpiresAt: QUOTE_EXPIRES_AT })
    const s = await solver()

    const row = await quoteAndFill(s, rfq(taxi, OPERATOR), 9)
    expect(taxi.swapFills).toHaveLength(1)
    expect(taxi.requests).not.toContain(submitRoute)
    expect(await s.store.readCarrierAttempt(row.id)).toMatchObject({ phase: 'not_submitted' })
    expect((await s.store.get(row.id)).state).toBe('refused')
    expect(s.pins.held()).toEqual([])
    expect([...s.ledger.reserved()]).toEqual([])
    expect(s.errors).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/expired before it was sent/) }),
    ])
  })
})

describe('a named Taxi that fails the fill: refused before any attempt, kept after a submit', () => {
  // Quote time reads `q-1` twice and the funded row's inventory once, so the settle's own read is the fourth.
  it.each(['unreachable', 'refusing', 'hostile'] as const)(
    'refuses the row, never escalating it, when the Taxi is %s at the settle',
    async (how) => {
      const taxi = await startTaxi({ operator: OPERATOR, server: SERVER }, { failReadsFrom: { read: 4, how } })
      const s = await solver()

      const row = await quoteAndFill(s, rfq(taxi, OPERATOR))
      await s.corridor.tickAll()
      expect(taxi.swapFills).toEqual([])
      expect(await s.store.readCarrierAttempt(row.id)).toBeNull()
      expect(await s.store.get(row.id)).toMatchObject({
        state: 'refused',
        failureReason: expect.stringMatching(/^not filled: /),
      })
      expect(s.pins.held()).toEqual([])
      expect([...s.ledger.reserved()]).toEqual([])
    },
  )

  it('keeps the row and its pins when the submit itself fails', async () => {
    const taxi = await startTaxi({ operator: OPERATOR, server: SERVER }, { submitFails: true })
    const s = await solver()

    const row = await quoteAndFill(s, rfq(taxi, OPERATOR))
    await s.corridor.tickAll()
    expect(taxi.requests.filter((route) => route === submitRoute)).toHaveLength(1)
    expect(await s.store.readCarrierAttempt(row.id)).toMatchObject({ phase: 'submitting' })
    expect((await s.store.get(row.id)).state).toBe('filling')
    expect(s.pins.held()).toEqual([row.id])
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
