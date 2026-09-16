/**
 * E2E — `arkade:BTC<->arkade:<asset>` over RFQ via the RELAY transport,
 * in BOTH directions (`docs/rfq-protocol.md` § 7.2).
 *
 * This is the relay counterpart of `assetRfqCorridor.e2e.test.ts` (which calls
 * `corridor.quote` directly): here the client's `rfq_request` travels over the
 * dev-broker relay framing (`scripts/mock-relay.mjs` shape) through the
 * shipped `RelayIngress`, and the reply comes back the same way — the same
 * bytes the HTTP bodies carry, per the ingress module's contract. The client
 * half goes through `@arkade-os/swap`'s own `relayTransport` + `requestArkadeSwap`,
 * so the quote/derive/verify/fund path is the SDK's, not a hand-rolled copy.
 *
 * Needs arkd, the emulator, spendable sats and a minted asset
 * (`scripts/regtest-mint-asset.mjs`). Run: `pnpm test:e2e assetRfqRelay`.
 */

import { createServer, type Server } from 'node:http'
import { randomBytes, randomInt } from 'node:crypto'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { schnorr } from '@noble/curves/secp256k1.js'
import { ArkAddress, asset, hasTerminalSpend, Transaction } from '@arkade-os/sdk'
import { relayTransport, requestArkadeSwap, type Offer } from '@arkade-os/swap'
import { base64, hex } from '@scure/base'
import { createPriceFeed } from '@arkade-os/solver-core/price/feed.js'
import { GiveUp, poll, sleep } from '@arkade-os/solver-core/util/poll.js'
import { createCorridorReaderSet, createCorridorSet } from '@arkade-os/solver-core/core/corridor.js'
import type { AssetLeg } from '@arkade-os/solver-core/core/assetRfq.js'
import { offerInventoryFrom } from '@arkade-os/solver-arkade/arkade/offerInventory.js'
import { ASSET_CARRIER_SATS, fulfillOffer } from '@arkade-os/solver-arkade/arkade/offerFulfill.js'
import {
  offerExitDelay,
  offerFromTerms,
  offerScriptFrom,
  type OfferDerivation,
} from '@arkade-os/solver-arkade/arkade/offerTerms.js'
import {
  AssetRfqSwapService,
  type AssetRfqMarket,
  type ObservedDeposit,
  type OfferTerms,
} from '@arkade-os/solver-corridors/asset/assetRfqOrchestrator.js'
import { AssetRfqSwapStore, type AssetRfqSwapRow } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import { assetRfqCorridor, assetRfqDescriptor, assetRfqReader } from '@arkade-os/solver-corridors/corridors/assetRfq.js'
import { RelayIngress } from '@arkade-os/solver-transport/ingress/relay.js'
import {
  devCodec,
  matchesFilter,
  webSocketRelayConnection,
  type RelayEvent,
} from '@arkade-os/solver-transport/relay/connection.js'
import { requireStack } from './support/preflight.js'
import {
  assertArkadeSpendable,
  openArkade,
  SETUP_TIMEOUT_MS,
  SWAP_TIMEOUT_MS,
  tempStoreDir,
  type E2eArkade,
} from './support/stack.js'

const ARKD_URL = process.env.ARK_SERVER_URL ?? 'http://localhost:7070'

/**
 * Relay addressing identity, DISTINCT from the covenant maker key: the broker
 * delivers every event to every matching subscriber, so sharing one pubkey for
 * addressing and for the covenant echoes our own request back to us — and
 * `expectQuote` throws on the first reply carrying our rfq_id whatever its
 * type (`unexpected reply: rfq_request`). Fresh per transport, so concurrent
 * tests never share a subscription either.
 */
const relayClientKey = (): string => hex.encode(schnorr.getPublicKey(randomBytes(32)))

/** Enough for deposits in both directions plus carriers and change. */
const NEEDED_SATS = 150_000

/** One asset unit per sat at `baseDecimals: 8`, so every amount below reads as itself. */
const FEED_PRICE = '100000000'

const FEE_BPS = 50

let arkade: E2eArkade
let feed: Server
let feedUrl: string
let assetId: string
let makerPkScript: string
let makerPublicKey: string
let dir: string

/** In-process mock relay (same frames as `scripts/mock-relay.mjs`). */
let broker: WebSocketServer
let relayUrl: string

const heldAsset = async (wantedId?: string): Promise<{ assetId: string; amount: bigint } | null> => {
  const balance = await arkade.ctx.wallet.getBalance()
  const held = (balance.availableAssets ?? []) as { assetId: string; amount: bigint }[]
  const usable = held.find(
    (entry) => BigInt(entry.amount) > 0n && (wantedId === undefined || entry.assetId === wantedId),
  )
  return usable ? { assetId: usable.assetId, amount: BigInt(usable.amount) } : null
}

const startFeed = async (price: string): Promise<{ server: Server; url: string }> => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ price }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('price feed did not bind a port')
  return { server, url: `http://127.0.0.1:${address.port}/price` }
}

const startBroker = (): Promise<{ server: WebSocketServer; url: string }> => {
  const server = new WebSocketServer({ port: 0 })
  const subscribers = new Map<import('ws').WebSocket, Map<string, { recipient?: string }>>()
  server.on('connection', (socket) => {
    subscribers.set(socket, new Map())
    socket.on('close', () => subscribers.delete(socket))
    socket.on('message', (raw) => {
      let frame: { op: string; id?: string; filter?: { recipient?: string }; event?: RelayEvent }
      try {
        frame = JSON.parse(String(raw))
      } catch {
        return
      }
      if (frame.op === 'sub' && frame.id) subscribers.get(socket)?.set(frame.id, frame.filter ?? {})
      if (frame.op === 'unsub' && frame.id) subscribers.get(socket)?.delete(frame.id)
      if (frame.op === 'event' && frame.event) {
        for (const [peer, subs] of subscribers) {
          for (const filter of subs.values()) {
            if (matchesFilter(frame.event, filter)) {
              peer.send(JSON.stringify({ op: 'event', event: frame.event }))
              break
            }
          }
        }
      }
    })
  })
  return new Promise((resolve) => {
    server.on('listening', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('relay broker did not bind a port')
      resolve({ server, url: `ws://127.0.0.1:${(address as { port: number }).port}` })
    })
  })
}

beforeAll(async () => {
  await requireStack('arkade asset RFQ over relay', ['arkd', 'emulator'])
  arkade = await openArkade()
  await assertArkadeSpendable(arkade, NEEDED_SATS)
  const held = await heldAsset()
  if (!held) {
    throw new Error(
      'this wallet holds no asset; mint one before running the asset RFQ e2e:\n' +
        `  node --experimental-eventsource --env-file=${process.env.E2E_ENV_FILE ?? '.env.regtest.lnd'} scripts/regtest-mint-asset.mjs 1000000 ARFQ`,
    )
  }
  assetId = held.assetId
  makerPkScript = hex.encode(ArkAddress.decode(await arkade.ctx.wallet.getAddress()).pkScript)
  makerPublicKey = hex.encode(await arkade.ctx.identity.xOnlyPublicKey())
  const started = await startFeed(FEED_PRICE)
  feed = started.server
  feedUrl = started.url
  const relay = await startBroker()
  broker = relay.server
  relayUrl = relay.url
  dir = tempStoreDir()
  // The codec is imported so a framing drift fails here rather than as a
  // silent timeout below: the broker speaks dev frames by construction.
  expect(devCodec).toBeDefined()
}, SETUP_TIMEOUT_MS)

afterAll(async () => {
  if (feed) await new Promise<void>((resolve) => feed.close(() => resolve()))
  // Guarded, not optional-chained: with no broker the executor below would
  // never resolve and would hide the setup failure behind a hang.
  if (broker) {
    for (const client of broker.clients) client.terminate()
    await new Promise<void>((resolve) => broker.close(() => resolve()))
  }
  arkade?.close()
})

const market = (over: Partial<AssetRfqMarket> = {}): AssetRfqMarket => ({
  base: null,
  quote: assetId,
  symbol: 'ARFQ',
  baseDecimals: 8,
  quoteDecimals: 0,
  feeBps: FEE_BPS,
  sellBase: { min: 1n, max: 10n ** 12n },
  buyBase: { min: 1n, max: 10n ** 12n },
  feedUrl,
  pricePath: '/price',
  ...over,
})

const emulatorXOnly = (): Uint8Array => hex.decode(arkade.emulator.pubkey).slice(-32)

const derivation = (): OfferDerivation => ({
  serverPubkey: arkade.ctx.wallet.arkServerPublicKey,
  emulatorPubkey: emulatorXOnly(),
  hrp: arkade.profile.arkadeHrp,
  exitDelay: offerExitDelay(arkade.ctx.advertisedExitDelay),
})

const deriveOffer = (terms: OfferTerms): { pkScript: string; address: string } => offerScriptFrom(derivation())(terms)

const termsOf = (row: AssetRfqSwapRow): OfferTerms => ({
  wantAmount: row.toAmount,
  wantAssetId: row.toAssetId,
  offerAssetId: row.fromAssetId,
  makerPkScript: row.makerPkScript,
  makerPublicKey: row.makerPublicKey,
})

const depositAt = async (offerPkScript: string): Promise<ObservedDeposit | null> => {
  const { vtxos } = await arkade.ctx.wallet.indexerProvider.getVtxos({ scripts: [offerPkScript] })
  const live = (vtxos ?? []).filter((vtxo) => !hasTerminalSpend(vtxo) && vtxo.isSwept !== true)
  const biggest = live.sort((a, b) => Number(b.value) - Number(a.value))[0]
  if (!biggest) return null
  const assets = ((biggest as { assets?: { assetId: string; amount: bigint }[] }).assets ?? []).map((entry) => ({
    assetId: entry.assetId,
    amount: BigInt(entry.amount),
  }))
  return { txid: biggest.txid, vout: biggest.vout, sats: BigInt(biggest.value), assets }
}

const balance = async (): Promise<ReadonlyMap<AssetLeg, bigint>> =>
  offerInventoryFrom(await arkade.ctx.wallet.getBalance())

const settle = async (row: AssetRfqSwapRow): Promise<string> => {
  const deposit = await depositAt(row.offerPkScript)
  if (!deposit) throw new Error(`nothing live at ${row.offerPkScript} to fill`)
  const offer: Offer = {
    ...offerFromTerms(termsOf(row), emulatorXOnly(), offerExitDelay(arkade.ctx.advertisedExitDelay)),
    swapPkScript: hex.decode(row.offerPkScript),
  }
  return fulfillOffer(arkade.ctx, arkade.emulator.url, offer, {
    txid: deposit.txid,
    vout: deposit.vout,
    value: Number(deposit.sats),
    ...(row.fromAssetId !== null
      ? { assetAmount: deposit.assets.find((a) => a.assetId === row.fromAssetId)?.amount }
      : {}),
  })
}

interface Harness {
  ingress: RelayIngress
  store: AssetRfqSwapStore
  pairSell: string
  tickAll: () => Promise<void>
}

/** Both asset directions behind ONE relay ingress, as a deployment serves them. */
const harness = async (): Promise<Harness> => {
  const markets = [market()]
  const store = await AssetRfqSwapStore.open(join(dir, `assetrfq-relay-${randomBytes(6).toString('hex')}.sqlite`))
  const service = new AssetRfqSwapService({
    store,
    markets,
    solverPubkey: makerPublicKey,
    quoteValiditySeconds: 600,
    carrierSats: arkade.ctx.dustSats,
    deriveOffer,
    depositAt,
    balance,
    fetchPrice: createPriceFeed(),
    settle,
  })
  const sell = assetRfqDescriptor(markets[0]!, 'sell_base')
  const buy = assetRfqDescriptor(markets[0]!, 'buy_base')
  const corridors = createCorridorSet([assetRfqCorridor(sell, service, store), assetRfqCorridor(buy, service, store)])
  const readers = createCorridorReaderSet([assetRfqReader(sell, store), assetRfqReader(buy, store)])
  const connection = webSocketRelayConnection(relayUrl)
  const ingress = new RelayIngress({ corridors, readers, connection, providerPubkey: makerPublicKey })
  await ingress.start()
  return {
    ingress,
    store,
    pairSell: sell.pair,
    tickAll: async () => {
      await service.tickAll()
    },
  }
}

/** Jittered: identical terms compile to one address, so a fixed amount would let
 * an earlier run's unspent deposit read as this one's funding. */
const depositSats = (base: number): bigint => BigInt(base + randomInt(1, 400))

const driveTo = async (
  tickAll: () => Promise<void>,
  store: AssetRfqSwapStore,
  id: string,
  state: AssetRfqSwapRow['state'],
): Promise<AssetRfqSwapRow> =>
  poll(
    async () => {
      await tickAll()
      const row = await store.get(id)
      if (row.state === state) return row
      if (row.state !== 'quoted' && row.state !== 'funded' && row.state !== 'filling') {
        throw new GiveUp(`${id} ended ${row.state}, not ${state}: ${row.failureReason ?? 'no reason recorded'}`)
      }
      return null
    },
    { attempts: 30, intervalMs: 2000, whenExhausted: `${id} never reached ${state}` },
  )

describe('e2e arkade asset RFQ over relay — quote, deposit, fill, both directions', () => {
  it(
    'quotes BTC->asset over the relay, recognises the deposit and fills it',
    async () => {
      const { ingress, store, tickAll } = await harness()
      try {
        const transport = relayTransport(relayUrl, { solverPubkey: makerPublicKey, clientPubkey: relayClientKey() })
        const amount = depositSats(20_000)
        const rfqId = randomBytes(32).toString('hex')
        const swap = await requestArkadeSwap(arkade.ctx.wallet, ARKD_URL, transport, {
          amount,
          rfqId,
          wantAsset: asset.AssetId.fromString(assetId),
        })
        expect(swap.fundAmount).toBe(amount)
        await transport.close()

        const fundingTxid = await arkade.ctx.wallet.send({
          address: swap.address,
          amount: Number(swap.fundAmount),
          extensions: [swap.extension],
        })
        expect(fundingTxid).toMatch(/^[0-9a-f]{64}$/)

        const id = (await store.listNonTerminal())[0]!.id
        const funded = await driveTo(tickAll, store, id, 'funded')
        expect(funded.depositTxid).toBe(fundingTxid)

        const filled = await driveTo(tickAll, store, id, 'filled')
        expect(filled.fillTxid).toMatch(/^[0-9a-f]{64}$/)
        expect(await depositAt(filled.offerPkScript)).toBeNull()

        const { txs } = await arkade.ctx.wallet.indexerProvider.getVirtualTxs([filled.fillTxid!])
        const fill = Transaction.fromPSBT(base64.decode(txs[0]!))
        expect(hex.encode(fill.getOutput(0)!.script!)).toBe(makerPkScript)
        expect(fill.getOutput(0)!.amount).toBe(ASSET_CARRIER_SATS)

        // Status over the relay too: the receipt is the fill txid (no preimage
        // on this class), and it must be the fill this swap settled with.
        const statusTransport = relayTransport(relayUrl, {
          solverPubkey: makerPublicKey,
          clientPubkey: relayClientKey(),
        })
        const status = await statusTransport.status(rfqId)
        await statusTransport.close()
        expect(status).toMatchObject({ type: 'rfq_status', state: 'settled' })
        expect(status?.profile['fill_txid']).toBe(filled.fillTxid)
      } finally {
        await store.close()
        await ingress.stop()
      }
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'quotes asset->BTC over the relay, recognises the deposit and fills it',
    async () => {
      // The payout must clear taproot dust (330 sats): arkd refuses a smaller
      // output 0, so the corridor refuses to quote one (`resolveAssetQuote`'s
      // dust floor) and these amounts stay an order of magnitude above it.
      const { ingress, store, tickAll } = await harness()
      try {
        const transport = relayTransport(relayUrl, { solverPubkey: makerPublicKey, clientPubkey: relayClientKey() })
        // Bound to `assetId`: the balance this asserts must be the asset the
        // request and `wallet.send` below actually move.
        const held = await heldAsset(assetId)
        expect(held, 'wallet holds no asset for the asset->BTC leg').not.toBeNull()
        const amount = BigInt(2000 + randomInt(1, 500))
        expect(held!.amount).toBeGreaterThanOrEqual(amount)
        const rfqId = randomBytes(32).toString('hex')
        const swap = await requestArkadeSwap(arkade.ctx.wallet, ARKD_URL, transport, {
          amount,
          rfqId,
          offerAsset: asset.AssetId.fromString(assetId),
        })
        expect(swap.fundAmount).toBe(amount)
        expect(BigInt(swap.quote.to_amount)).toBeGreaterThanOrEqual(330n)
        await transport.close()

        const fundingTxid = await arkade.ctx.wallet.send({
          address: swap.address,
          amount: Number(swap.carrierSats),
          assets: [{ assetId, amount: swap.fundAmount }],
          extensions: [swap.extension],
        })
        expect(fundingTxid).toMatch(/^[0-9a-f]{64}$/)

        const id = (await store.listNonTerminal())[0]!.id
        const funded = await driveTo(tickAll, store, id, 'funded')
        expect(funded.depositTxid).toBe(fundingTxid)

        const filled = await driveTo(tickAll, store, id, 'filled')
        expect(filled.fillTxid).toMatch(/^[0-9a-f]{64}$/)
        expect(await depositAt(filled.offerPkScript)).toBeNull()

        // The fill pays sats to the maker's script on this direction.
        const { txs } = await arkade.ctx.wallet.indexerProvider.getVirtualTxs([filled.fillTxid!])
        const fill = Transaction.fromPSBT(base64.decode(txs[0]!))
        expect(hex.encode(fill.getOutput(0)!.script!)).toBe(makerPkScript)
        expect(fill.getOutput(0)!.amount).toBe(BigInt(swap.quote.to_amount))

        const statusTransport = relayTransport(relayUrl, {
          solverPubkey: makerPublicKey,
          clientPubkey: relayClientKey(),
        })
        const status = await statusTransport.status(rfqId)
        await statusTransport.close()
        expect(status).toMatchObject({ type: 'rfq_status', state: 'settled' })
        expect(status?.profile['fill_txid']).toBe(filled.fillTxid)
      } finally {
        await store.close()
        await ingress.stop()
      }
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'refuses an asset request with an empty profile over the relay, in the closed vocabulary',
    async () => {
      const { ingress, store, pairSell } = await harness()
      try {
        const transport = relayTransport(relayUrl, { solverPubkey: makerPublicKey, clientPubkey: relayClientKey() })
        const rfqId = randomBytes(32).toString('hex')
        await expect(
          transport.requestQuote({
            v: 1,
            type: 'rfq_request',
            rfq_id: rfqId,
            pair: pairSell,
            amount_side: 'from',
            amount: '5000',
            profile: {},
          }),
        ).rejects.toMatchObject({ name: 'SwapRefusal' })

        // And a buy payout under taproot dust (330 sats): arkd could never
        // settle it, so the corridor refuses to quote it at all.
        await expect(
          requestArkadeSwap(arkade.ctx.wallet, ARKD_URL, transport, {
            amount: 100n,
            offerAsset: asset.AssetId.fromString(assetId),
          }),
        ).rejects.toMatchObject({ name: 'SwapRefusal', reason: 'amount_out_of_range' })
        await transport.close()
      } finally {
        await store.close()
        await ingress.stop()
      }
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'reports quoted, funded, and settled through polled relay status',
    async () => {
      // Quote validity is a harness constant (600s) here, so the lapse path is
      // not reachable from this test and is covered by
      // `assetRfqCorridor.e2e.test.ts`. This asserts the relay status face.
      const { ingress, store, tickAll } = await harness()
      try {
        const transport = relayTransport(relayUrl, { solverPubkey: makerPublicKey, clientPubkey: relayClientKey() })
        const amount = depositSats(4_000)
        const rfqId = randomBytes(32).toString('hex')
        const swap = await requestArkadeSwap(arkade.ctx.wallet, ARKD_URL, transport, {
          amount,
          rfqId,
          wantAsset: asset.AssetId.fromString(assetId),
        })
        let status = await transport.status(rfqId)
        expect(status).toMatchObject({ type: 'rfq_status', state: 'quoted' })
        await transport.close()

        const fundingTxid = await arkade.ctx.wallet.send({
          address: swap.address,
          amount: Number(swap.fundAmount),
          extensions: [swap.extension],
        })
        const id = (await store.listNonTerminal())[0]!.id
        await driveTo(tickAll, store, id, 'funded')
        await sleep(1_000)
        const filled = await driveTo(tickAll, store, id, 'filled')
        expect(filled.depositTxid).toBe(fundingTxid)

        const statusTransport = relayTransport(relayUrl, {
          solverPubkey: makerPublicKey,
          clientPubkey: relayClientKey(),
        })
        status = await statusTransport.status(rfqId)
        await statusTransport.close()
        expect(status).toMatchObject({ type: 'rfq_status', state: 'settled' })
      } finally {
        await store.close()
        await ingress.stop()
      }
    },
    SWAP_TIMEOUT_MS,
  )
})
