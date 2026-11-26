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
import { ArkAddress, asset, Transaction } from '@arkade-os/sdk'
import { relayTransport, requestArkadeSwap } from '@arkade-os/swap/protocol'
import { attesting } from '@arkade-os/swap/advanced'
import { base64, hex } from '@scure/base'
import { generateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { createPriceFeed } from '@arkade-os/solver-core/price/feed.js'
import { RFQ_ASSET_SWAP_DIRECTED, RFQ_ASSET_SWAP_DIRECTED_NONCE } from '@arkade-os/solver-core/core/rfqContract.js'
import { GiveUp, poll, sleep } from '@arkade-os/solver-core/util/poll.js'
import { createCorridorReaderSet, createCorridorSet } from '@arkade-os/solver-core/core/corridor.js'
import type { AssetLeg } from '@arkade-os/solver-core/core/assetRfq.js'
import { depositSpentBy } from '@arkade-os/solver-arkade/arkade/depositSpend.js'
import { offerInventoryFrom } from '@arkade-os/solver-arkade/arkade/offerInventory.js'
import { ASSET_CARRIER_SATS } from '@arkade-os/solver-arkade/arkade/offerFulfill.js'
import { largestOfferOutpoint, liveOfferOutpoints } from '@arkade-os/solver-arkade/arkade/offerOutpoints.js'
import { offerExitDelay, offerScriptFrom, type OfferDerivation } from '@arkade-os/solver-arkade/arkade/offerTerms.js'
import { quotedOfferSettleFor } from '@arkade-os/solver-arkade/arkade/quotedOfferSettle.js'
import { createArkadeContext, type ArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'
import {
  AssetRfqSwapService,
  type AssetRfqMarket,
  type ObservedDeposit,
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

const ARKD_URL = process.env.ARKADE_OPERATOR_URL ?? 'http://localhost:7070'

/**
 * Relay addressing identity, DISTINCT from the covenant maker key: the broker
 * delivers every event to every matching subscriber, so sharing one pubkey for
 * addressing and for the covenant echoes our own request back to us — and
 * `expectQuote` throws on the first reply carrying our rfq_id whatever its
 * type (`unexpected reply: rfq_request`). Fresh per transport, so concurrent
 * tests never share a subscription either.
 */
const relayClientKey = (): string => hex.encode(schnorr.getPublicKey(randomBytes(32)))

/** The in-process solver answers as `makerPublicKey`, and the client binds that responder as the taker. */
const requestTransport = () =>
  attesting(relayTransport(relayUrl, { solverPubkey: makerPublicKey, clientPubkey: relayClientKey() }), makerPublicKey)

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
  await arkade?.close()
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
  carrierSats: arkade.ctx.dustSats,
  ...over,
})

const emulatorXOnly = (): Uint8Array => hex.decode(arkade.emulator.pubkey).slice(-32)

const derivation = (): OfferDerivation => ({
  serverPubkey: arkade.ctx.wallet.arkServerPublicKey,
  emulatorPubkey: emulatorXOnly(),
  hrp: arkade.profile.arkadeHrp,
  exitDelay: offerExitDelay(arkade.ctx.advertisedExitDelay),
  taker: hex.decode(makerPublicKey),
})

const depositAt = async (
  offerPkScript: string,
  depositLeg: AssetLeg = null,
  matches?: (deposit: ObservedDeposit) => boolean,
): Promise<ObservedDeposit | null> =>
  largestOfferOutpoint(await liveOfferOutpoints(arkade.ctx, offerPkScript), depositLeg, matches)

const indexedSpender = (txid: string, vout: number): Promise<string> =>
  poll(() => depositSpentBy(arkade.ctx.wallet.indexerProvider, { txid, vout }), {
    attempts: 15,
    intervalMs: 1_000,
    whenExhausted: `the indexer never returned a spender for deposit ${txid}:${vout}`,
  })

const balance = async (): Promise<ReadonlyMap<AssetLeg, bigint>> =>
  offerInventoryFrom(await arkade.ctx.wallet.getBalance())

const waitForWalletBalance = (
  ctx: ArkadeContext,
  matches: (sats: number, assets: ReadonlyMap<AssetLeg, bigint>) => boolean,
) =>
  poll(
    async () => {
      const balance = await ctx.wallet.getBalance()
      return matches(Number(balance.available), offerInventoryFrom(balance)) ? true : null
    },
    { attempts: 30, intervalMs: 1_000, whenExhausted: 'the wallet never showed the expected balance' },
  )

interface Harness {
  ingress: RelayIngress
  store: AssetRfqSwapStore
  pairSell: string
  tickAll: () => Promise<void>
}

/** Both asset directions behind ONE relay ingress, as a deployment serves them. */
const harness = async (
  over: Partial<AssetRfqMarket> = {},
  supportedContractVersions?: ReadonlySet<string>,
): Promise<Harness> => {
  const markets = [market(over)]
  const store = await AssetRfqSwapStore.open(join(dir, `assetrfq-relay-${randomBytes(6).toString('hex')}.sqlite`))
  const service = new AssetRfqSwapService({
    store,
    markets,
    solverPubkey: makerPublicKey,
    quoteValiditySeconds: 600,
    dustSats: arkade.ctx.dustSats,
    minOutputSats: arkade.ctx.dustSats > arkade.ctx.vtxoMinSats ? arkade.ctx.dustSats : arkade.ctx.vtxoMinSats,
    deriveOffer: offerScriptFrom(derivation()),
    depositAt,
    balance,
    fetchPrice: createPriceFeed(),
    settle: quotedOfferSettleFor({ ctx: arkade.ctx, emulatorUrl: arkade.emulator.url, derivation: derivation() }),
  })
  const sell = assetRfqDescriptor(markets[0]!, 'sell_base')
  const buy = assetRfqDescriptor(markets[0]!, 'buy_base')
  const corridors = createCorridorSet([assetRfqCorridor(sell, service, store), assetRfqCorridor(buy, service, store)], {
    supportedContractVersions,
  })
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
    'quotes and atomically settles two different assets between separate wallets in both directions',
    async () => {
      const maker = await createArkadeContext({
        mnemonic: generateMnemonic(wordlist),
        databasePath: join(dir, `pair-maker-${randomBytes(6).toString('hex')}.sqlite`),
        operatorUrl: process.env.ARKADE_OPERATOR_URL ?? ARKD_URL,
        esploraUrl: process.env.ARKADE_ESPLORA_URL ?? process.env.ESPLORA_URL,
        isMainnet: arkade.profile.isMainnet,
        arkadeHrp: arkade.profile.arkadeHrp,
        expectedArkdNetwork: arkade.profile.arkdNetwork,
      })
      const pairFeed = await startFeed('2')
      try {
        const address = await maker.wallet.getAddress()
        const solverStart = (await heldAsset(assetId))!.amount
        const carrier = arkade.ctx.vtxoMinSats > arkade.ctx.dustSats ? arkade.ctx.vtxoMinSats : arkade.ctx.dustSats
        await arkade.ctx.wallet.send({ address, amount: 30_000 })
        await waitForWalletBalance(maker, (sats) => sats >= 30_000)
        const issued = await maker.wallet.assetManager.issue({ amount: 10_000n })
        const otherAsset = issued.assetId
        await waitForWalletBalance(maker, (_sats, assets) => assets.get(otherAsset) === 10_000n)
        const { ingress, store, tickAll } = await harness({
          base: otherAsset,
          baseDecimals: 0,
          feeBps: 0,
          feedUrl: pairFeed.url,
        })
        const transport = requestTransport()
        try {
          const trade = async (from: string, to: string, amount: bigint, amountSide: 'from' | 'to') => {
            const rfqId = randomBytes(32).toString('hex')
            const swap = await requestArkadeSwap(maker.wallet, transport, {
              amount,
              amountSide,
              rfqId,
              offerAsset: asset.AssetId.fromString(from),
              wantAsset: asset.AssetId.fromString(to),
            })
            expect(swap.quote.pair).toBe(`arkade:${from}->arkade:${to}`)
            expect(swap.carrierSats).toBe(carrier)
            const fundingTxid = await maker.wallet.send({
              address: swap.address,
              amount: Number(swap.carrierSats),
              assets: [{ assetId: from, amount: swap.fundAmount }],
              extensions: [swap.extension],
            })
            const id = (await store.findLiveByOfferScript(hex.encode(swap.swapPkScript)))!.id
            const funded = await driveTo(tickAll, store, id, 'funded')
            expect(funded.depositTxid).toBe(fundingTxid)
            const fill = await driveTo(tickAll, store, id, 'filled')
            expect(fill.contractVersion).toBe(RFQ_ASSET_SWAP_DIRECTED_NONCE)
            expect(fill.fillTxid).toMatch(/^[0-9a-f]{64}$/)
            expect(await transport.status(rfqId)).toMatchObject({
              state: 'settled',
              profile: { fill_txid: fill.fillTxid },
            })
            return fill
          }
          const forward = await trade(otherAsset, assetId, 1_500n, 'from')
          expect(forward).toMatchObject({ fromAmount: 1_500n, toAmount: 3_000n })
          await waitForWalletBalance(maker, (_sats, assets) => assets.get(assetId) === 3_000n)
          await waitForWalletBalance(
            arkade.ctx,
            (_sats, assets) => assets.get(otherAsset) === 1_500n && assets.get(assetId) === solverStart - 3_000n,
          )

          const reverse = await trade(assetId, otherAsset, 500n, 'to')
          expect(reverse).toMatchObject({ fromAmount: 1_000n, toAmount: 500n })
          await waitForWalletBalance(
            maker,
            (_sats, assets) => assets.get(assetId) === 2_000n && assets.get(otherAsset) === 9_000n,
          )
          await waitForWalletBalance(
            arkade.ctx,
            (_sats, assets) => assets.get(otherAsset) === 1_000n && assets.get(assetId) === solverStart - 2_000n,
          )
          await arkade.ctx.wallet.send({
            address,
            amount: Number(carrier),
            assets: [{ assetId: otherAsset, amount: 1_000n }],
          })
        } finally {
          await transport.close()
          await ingress.stop()
          await store.close()
        }
      } finally {
        await new Promise<void>((resolve) => pairFeed.server.close(() => resolve()))
        await maker.close()
      }
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'settles two identical BTC->asset swaps over the relay with distinct deposits',
    async () => {
      const { ingress, store, tickAll } = await harness()
      const transport = requestTransport()
      const amount = depositSats(20_000)
      const wantAsset = asset.AssetId.fromString(assetId)
      const request = (rfqId: string) => requestArkadeSwap(arkade.ctx.wallet, transport, { amount, rfqId, wantAsset })
      const swapOnce = async (rfqId: string) => {
        const swap = await request(rfqId)
        expect(swap.fundAmount).toBe(amount)

        const fundingTxid = await arkade.ctx.wallet.send({
          address: swap.address,
          amount: Number(swap.fundAmount),
          extensions: [swap.extension],
        })
        expect(fundingTxid).toMatch(/^[0-9a-f]{64}$/)

        const quote = await store.findLiveByOfferScript(hex.encode(swap.swapPkScript))
        expect(quote?.rfqId).toBe(rfqId)
        const id = quote!.id
        const funded = await driveTo(tickAll, store, id, 'funded')
        expect(funded.depositTxid).toBe(fundingTxid)

        const filled = await driveTo(tickAll, store, id, 'filled')
        expect(filled.contractVersion).toBe(RFQ_ASSET_SWAP_DIRECTED_NONCE)
        expect(filled.fillTxid).toMatch(/^[0-9a-f]{64}$/)
        const checkpointTxid = await indexedSpender(fundingTxid, funded.depositVout!)

        const { txs } = await arkade.ctx.wallet.indexerProvider.getVirtualTxs([filled.fillTxid!])
        const fill = Transaction.fromPSBT(base64.decode(txs[0]!))
        expect(hex.encode(fill.getInput(0).txid!)).toBe(checkpointTxid)
        expect(hex.encode(fill.getOutput(0)!.script!)).toBe(makerPkScript)
        expect(fill.getOutput(0)!.amount).toBe(ASSET_CARRIER_SATS)

        // Status over the relay too: the receipt is the fill txid (no preimage
        // on this class), and it must be the fill this swap settled with.
        const status = await transport.status(rfqId)
        expect(status).toMatchObject({ type: 'rfq_status', state: 'settled' })
        expect(status?.profile['fill_txid']).toBe(filled.fillTxid)
        return filled
      }
      try {
        const firstId = randomBytes(32).toString('hex')
        const first = await swapOnce(firstId)
        await expect(request(firstId)).rejects.toMatchObject({ name: 'SwapRefusal', reason: 'quote_conflict' })

        const second = await swapOnce(randomBytes(32).toString('hex'))
        expect(second.toAmount).toBe(first.toAmount)
        expect(second.offerPkScript).not.toBe(first.offerPkScript)
        expect(second.depositTxid).not.toBe(first.depositTxid)
        expect(second.fillTxid).not.toBe(first.fillTxid)
      } finally {
        await transport.close()
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
        const transport = requestTransport()
        // Bound to `assetId`: the balance this asserts must be the asset the
        // request and `wallet.send` below actually move.
        const held = await heldAsset(assetId)
        expect(held, 'wallet holds no asset for the asset->BTC leg').not.toBeNull()
        const amount = BigInt(2000 + randomInt(1, 500))
        expect(held!.amount).toBeGreaterThanOrEqual(amount)
        const rfqId = randomBytes(32).toString('hex')
        const swap = await requestArkadeSwap(arkade.ctx.wallet, transport, {
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
        expect(filled.contractVersion).toBe(RFQ_ASSET_SWAP_DIRECTED_NONCE)
        expect(filled.fillTxid).toMatch(/^[0-9a-f]{64}$/)
        const checkpointTxid = await indexedSpender(fundingTxid, funded.depositVout!)

        // The fill pays sats to the maker's script on this direction.
        const { txs } = await arkade.ctx.wallet.indexerProvider.getVirtualTxs([filled.fillTxid!])
        const fill = Transaction.fromPSBT(base64.decode(txs[0]!))
        expect(hex.encode(fill.getInput(0).txid!)).toBe(checkpointTxid)
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
    'quotes exact-out through the swap client and fills it, in both directions',
    async () => {
      // `amountSide: 'to'` threw in the client until @arkade-os/swap 0.0.20
      // (ts-sdk#931), so this path has only ever been proven against the
      // corridor's own API, never through a real caller.
      const { ingress, store, tickAll } = await harness()
      try {
        const transport = requestTransport()

        const wantUnits = BigInt(1200 + randomInt(1, 300))
        const buy = await requestArkadeSwap(arkade.ctx.wallet, transport, {
          amount: wantUnits,
          amountSide: 'to',
          rfqId: randomBytes(32).toString('hex'),
          wantAsset: asset.AssetId.fromString(assetId),
        })
        expect(BigInt(buy.quote.to_amount)).toBe(wantUnits)
        expect(buy.fundAmount).toBe(BigInt(buy.quote.from_amount))
        expect(buy.fundAmount).toBeGreaterThan(0n)

        const buyTxid = await arkade.ctx.wallet.send({
          address: buy.address,
          amount: Number(buy.fundAmount),
          extensions: [buy.extension],
        })
        const buyId = (await store.listNonTerminal())[0]!.id
        expect((await driveTo(tickAll, store, buyId, 'funded')).depositTxid).toBe(buyTxid)
        expect((await driveTo(tickAll, store, buyId, 'filled')).toAmount).toBe(wantUnits)

        const wantSats = BigInt(1500 + randomInt(1, 300))
        const sell = await requestArkadeSwap(arkade.ctx.wallet, transport, {
          amount: wantSats,
          amountSide: 'to',
          rfqId: randomBytes(32).toString('hex'),
          offerAsset: asset.AssetId.fromString(assetId),
        })
        expect(BigInt(sell.quote.to_amount)).toBe(wantSats)
        expect(sell.fundAmount).toBe(BigInt(sell.quote.from_amount))
        expect((await heldAsset(assetId))!.amount).toBeGreaterThanOrEqual(sell.fundAmount)
        await transport.close()

        const sellTxid = await arkade.ctx.wallet.send({
          address: sell.address,
          amount: Number(sell.carrierSats),
          assets: [{ assetId, amount: sell.fundAmount }],
          extensions: [sell.extension],
        })
        const sellId = (await store.listNonTerminal())[0]!.id
        expect((await driveTo(tickAll, store, sellId, 'funded')).depositTxid).toBe(sellTxid)
        expect((await driveTo(tickAll, store, sellId, 'filled')).toAmount).toBe(wantSats)
      } finally {
        await store.close()
        await ingress.stop()
      }
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'funds the carrier the solver published, and attaches none to a BTC deposit',
    async () => {
      // Deliberately NOT the SDK's compile-time constant: a client that ignored
      // `carrier_sats` would fund that instead, and the deposit would not match.
      const published = arkade.ctx.dustSats + 70n
      expect(published, 'the fixture must differ from the constant or this proves nothing').not.toBe(ASSET_CARRIER_SATS)
      const { ingress, store, tickAll } = await harness({ carrierSats: published })
      try {
        const transport = requestTransport()

        const swap = await requestArkadeSwap(arkade.ctx.wallet, transport, {
          amount: BigInt(1200 + randomInt(1, 300)),
          rfqId: randomBytes(32).toString('hex'),
          offerAsset: asset.AssetId.fromString(assetId),
        })
        expect(swap.quote.carrier_sats).toBe(published.toString())
        expect(swap.carrierSats).toBe(published)

        const fundingTxid = await arkade.ctx.wallet.send({
          address: swap.address,
          amount: Number(swap.carrierSats),
          assets: [{ assetId, amount: swap.fundAmount }],
          extensions: [swap.extension],
        })
        const deposit = await poll(async () => await depositAt(hex.encode(swap.swapPkScript)), {
          attempts: 15,
          intervalMs: 1_000,
          whenExhausted: 'the funded carrier never reached the indexer',
        })
        expect(deposit.sats).toBe(published)

        const id = (await store.listNonTerminal())[0]!.id
        expect((await driveTo(tickAll, store, id, 'funded')).depositTxid).toBe(fundingTxid)
        expect((await driveTo(tickAll, store, id, 'filled')).fillTxid).toMatch(/^[0-9a-f]{64}$/)

        // The negative half: the same carrier is published on a BTC deposit,
        // where it is already netted out of `to_amount`. Consuming it there
        // would overfund every such deposit by one dust.
        await waitForWalletBalance(arkade.ctx, (_sats, assets) => (assets.get(assetId) ?? 0n) >= 5_000n)
        const btc = await requestArkadeSwap(arkade.ctx.wallet, transport, {
          amount: 5_000n,
          rfqId: randomBytes(32).toString('hex'),
          wantAsset: asset.AssetId.fromString(assetId),
        })
        expect(btc.quote.carrier_sats).toBe(published.toString())
        expect(btc.carrierSats).toBe(0n)
        await transport.close()
      } finally {
        await store.close()
        await ingress.stop()
      }
    },
    SWAP_TIMEOUT_MS,
  )

  // A live quote per combination: only a real payout off a real arkd proves the
  // configured spread reached pricing rather than being dropped on the way in.
  const payoutsFor = async (over: Partial<AssetRfqMarket>) => {
    const { ingress, store } = await harness(over)
    try {
      const transport = requestTransport()
      const sell = await requestArkadeSwap(arkade.ctx.wallet, transport, {
        amount: 20_000n,
        rfqId: randomBytes(32).toString('hex'),
        wantAsset: asset.AssetId.fromString(assetId),
      })
      const buy = await requestArkadeSwap(arkade.ctx.wallet, transport, {
        amount: 2000n,
        rfqId: randomBytes(32).toString('hex'),
        offerAsset: asset.AssetId.fromString(assetId),
      })
      await transport.close()
      return { sell: BigInt(sell.quote.to_amount), buy: BigInt(buy.quote.to_amount) }
    } finally {
      await store.close()
      await ingress.stop()
    }
  }

  it(
    'prices each direction at its own spread, end to end over the relay',
    async () => {
      const symmetric = await payoutsFor({})
      const narrowSell = await payoutsFor({ sellBaseFeeBps: 0 })
      const wideBuy = await payoutsFor({ buyBaseFeeBps: 900 })
      const both = await payoutsFor({ sellBaseFeeBps: 0, buyBaseFeeBps: 900 })

      // Narrowing the sell side pays the maker more; the buy side is untouched.
      expect(narrowSell.sell).toBeGreaterThan(symmetric.sell)
      expect(narrowSell.buy).toBe(symmetric.buy)

      // Widening the buy side pays less; the sell side is untouched.
      expect(wideBuy.buy).toBeLessThan(symmetric.buy)
      expect(wideBuy.sell).toBe(symmetric.sell)

      // Both at once is each one's effect, not a blend.
      expect(both.sell).toBe(narrowSell.sell)
      expect(both.buy).toBe(wideBuy.buy)

      for (const p of [symmetric, narrowSell, wideBuy, both]) {
        expect(p.buy).toBeGreaterThanOrEqual(arkade.ctx.dustSats)
        expect(p.sell).toBeGreaterThan(0n)
      }
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'refuses an asset request with an empty profile over the relay, in the closed vocabulary',
    async () => {
      const { ingress, store, pairSell } = await harness()
      try {
        const transport = requestTransport()
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
            // Negotiated, or the refusal would be for that and never reach the profile.
            contract_versions: [RFQ_ASSET_SWAP_DIRECTED],
          }),
        ).rejects.toMatchObject({ name: 'SwapRefusal', reason: 'unsupported_payload' })

        // A payout alone under dust now quotes: the maker's carrier comes back on
        // top, lifting output 0 clear of what arkd would reject.
        const tiny = await requestArkadeSwap(arkade.ctx.wallet, transport, {
          amount: 100n,
          offerAsset: asset.AssetId.fromString(assetId),
        })
        expect(BigInt(tiny.quote.to_amount)).toBeGreaterThan(arkade.ctx.dustSats)
        await transport.close()
      } finally {
        await store.close()
        await ingress.stop()
      }
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'falls back to the original directed version and reports quoted, funded, and settled',
    async () => {
      // Quote validity is a harness constant (600s) here, so the lapse path is
      // not reachable from this test and is covered by
      // `assetRfqCorridor.e2e.test.ts`. This asserts the relay status face.
      const { ingress, store, tickAll } = await harness({}, new Set([RFQ_ASSET_SWAP_DIRECTED]))
      try {
        const transport = requestTransport()
        const amount = depositSats(4_000)
        const rfqId = randomBytes(32).toString('hex')
        const swap = await requestArkadeSwap(arkade.ctx.wallet, transport, {
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
        expect(filled.contractVersion).toBe(RFQ_ASSET_SWAP_DIRECTED)
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
