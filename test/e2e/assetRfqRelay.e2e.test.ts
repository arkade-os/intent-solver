/**
 * E2E — `arkade:BTC<->arkade:<asset>` over RFQ via the RELAY transport,
 * in BOTH directions (`docs/rfq-protocol.md` § 7.2).
 *
 * This is the relay counterpart of `assetRfqCorridor.e2e.test.ts` (which calls
 * `corridor.quote` directly): here the client's `rfq_request` travels over the
 * regtest Nostr relay through the shipped `RelayIngress`, and the reply comes
 * back as a signed, encrypted Nostr event. The client half goes through
 * `@arkade-os/swap`'s own transport and `requestArkadeSwap`,
 * so the quote/derive/verify/fund path is the SDK's, not a hand-rolled copy.
 *
 * Needs arkd, the emulator, spendable sats and a minted asset
 * (`scripts/regtest-mint-asset.mjs`). Run: `pnpm test:e2e assetRfqRelay`.
 */

import { createServer, type Server } from 'node:http'
import { randomBytes, randomInt } from 'node:crypto'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { ArkAddress, asset, hasTerminalSpend, Transaction } from '@arkade-os/sdk'
import { requestArkadeSwap, type Offer } from '@arkade-os/swap'
import { nostrRfqTransport } from '@arkade-os/swap/nostr'
import { base64, hex } from '@scure/base'
import { createPriceFeed } from '@arkade-os/solver-core/price/feed.js'
import { GiveUp, poll } from '@arkade-os/solver-core/util/poll.js'
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
import { webSocketRelayConnection } from '@arkade-os/solver-transport/relay/connection.js'
import { nostrCodecForWallet } from '@arkade-os/solver-transport/relay/nostr.js'
import { createArkadeContext, type ArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'
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

const relayUrl = process.env.E2E_NOSTR_RELAY_URL ?? 'ws://localhost:7777'
const openTransport = () => nostrRfqTransport({ relays: [relayUrl], solverPubkey: makerPublicKey })

const party = async (): Promise<ArkadeContext> =>
  createArkadeContext({
    mnemonic: generateMnemonic(wordlist, 128),
    arkServerUrl: ARKD_URL,
    databasePath: join(tempStoreDir(), 'wallet.sqlite'),
    isMainnet: arkade.profile.isMainnet,
    arkadeHrp: arkade.profile.arkadeHrp,
    expectedArkdNetwork: arkade.profile.arkdNetwork,
  })

const assetUnits = async (wallet: ArkadeContext['wallet']): Promise<bigint> => {
  const balance = await wallet.getBalance()
  return (balance.availableAssets ?? [])
    .filter((entry) => entry.assetId === assetId)
    .reduce((total, entry) => total + BigInt(entry.amount), 0n)
}

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

beforeAll(async () => {
  await requireStack('arkade asset RFQ over Nostr', ['arkd', 'emulator'])
  const relay = await fetch(relayUrl.replace(/^ws/, 'http'), {
    headers: { accept: 'application/nostr+json' },
    signal: AbortSignal.timeout(5_000),
  })
  if (!relay.ok) throw new Error(`regtest Nostr relay is unavailable: HTTP ${relay.status}`)
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
  dir = tempStoreDir()
}, SETUP_TIMEOUT_MS)

afterAll(async () => {
  if (feed) await new Promise<void>((resolve) => feed.close(() => resolve()))
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
  carrierSats: arkade.ctx.dustSats,
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

/**
 * Wait for the fill's spend to reach the indexer.
 *
 * Polling `depositAt(...) === null` would wait out the propagation race, but is
 * WEAKER than the single read it replaces: `depositAt` answers null for an empty
 * indexer response too, so one transient blank anywhere in the window passes.
 * Waiting for the vtxo to come back CARRYING a terminal spend cannot be satisfied
 * that way — `getVtxos` is called with no filter, so spent outputs are still
 * returned, which is why `depositAt` has to filter them locally.
 */
const depositSpent = async (offerPkScript: string): Promise<'spent'> =>
  poll(
    async () => {
      const { vtxos } = await arkade.ctx.wallet.indexerProvider.getVtxos({ scripts: [offerPkScript] })
      if (!vtxos?.length) return null
      return vtxos.every((vtxo) => hasTerminalSpend(vtxo) || vtxo.isSwept === true) ? 'spent' : null
    },
    {
      attempts: 15,
      intervalMs: 1_000,
      whenExhausted: `the deposit at ${offerPkScript} was never spent by the fill`,
    },
  )

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
const harness = async (over: Partial<AssetRfqMarket> = {}): Promise<Harness> => {
  const markets = [market(over)]
  const store = await AssetRfqSwapStore.open(join(dir, `assetrfq-relay-${randomBytes(6).toString('hex')}.sqlite`))
  const service = new AssetRfqSwapService({
    store,
    markets,
    solverPubkey: makerPublicKey,
    quoteValiditySeconds: 600,
    dustSats: arkade.ctx.dustSats,
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
  const mnemonic = process.env.ARK_MNEMONIC
  if (!mnemonic) throw new Error('ARK_MNEMONIC is required for the solver Nostr identity')
  const connection = webSocketRelayConnection(relayUrl, {
    codec: nostrCodecForWallet(mnemonic, arkade.profile.isMainnet, makerPublicKey),
  })
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

describe('Alice, Bob and the solver over the regtest Nostr relay', () => {
  it(
    'Alice swaps BTC for an asset, which the solver delivers to Bob',
    async () => {
      const { ingress, store, tickAll } = await harness()
      const alice = await party()
      const bob = await party()
      try {
        const bobAddress = await bob.wallet.getAddress()
        const aliceAddress = await alice.wallet.getAddress()
        expect(aliceAddress).not.toBe(bobAddress)
        expect(await assetUnits(bob.wallet)).toBe(0n)
        const aliceFundingTxid = await arkade.ctx.wallet.send({ address: aliceAddress, amount: 40_000 })
        await poll(
          async () =>
            (await alice.wallet.getSpendableVtxos({ withRecoverable: false })).some(
              (coin) => coin.txid === aliceFundingTxid,
            ),
          { attempts: 30, intervalMs: 1_000, whenExhausted: 'Alice never received her BTC float' },
        )
        const aliceBefore = (await alice.wallet.getBalance()).available
        const transport = openTransport()
        const amount = depositSats(20_000)
        const rfqId = randomBytes(32).toString('hex')
        const swap = await requestArkadeSwap(alice.wallet, ARKD_URL, transport, {
          amount,
          rfqId,
          wantAsset: asset.AssetId.fromString(assetId),
          receiveAddress: bobAddress,
        })
        expect(swap.fundAmount).toBe(amount)
        await transport.close()

        const fundingTxid = await alice.wallet.send({
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
        expect(await depositSpent(filled.offerPkScript)).toBe('spent')

        const { txs } = await arkade.ctx.wallet.indexerProvider.getVirtualTxs([filled.fillTxid!])
        const fill = Transaction.fromPSBT(base64.decode(txs[0]!))
        expect(hex.encode(fill.getOutput(0)!.script!)).toBe(hex.encode(ArkAddress.decode(bobAddress).pkScript))
        expect(fill.getOutput(0)!.amount).toBe(ASSET_CARRIER_SATS)
        await poll(async () => (await assetUnits(bob.wallet)) === filled.toAmount, {
          attempts: 30,
          intervalMs: 1_000,
          whenExhausted: 'Bob never received the swapped asset',
        })
        expect(await assetUnits(alice.wallet)).toBe(0n)
        expect((await alice.wallet.getBalance()).available).toBeLessThan(aliceBefore)

        // Status over the relay too: the receipt is the fill txid (no preimage
        // on this class), and it must be the fill this swap settled with.
        const statusTransport = openTransport()
        const status = await statusTransport.status(rfqId)
        await statusTransport.close()
        expect(status).toMatchObject({ type: 'rfq_status', state: 'settled' })
        expect(status?.profile['fill_txid']).toBe(filled.fillTxid)
      } finally {
        alice.close()
        bob.close()
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
        const transport = openTransport()
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
        expect(await depositSpent(filled.offerPkScript)).toBe('spent')

        // The fill pays sats to the maker's script on this direction.
        const { txs } = await arkade.ctx.wallet.indexerProvider.getVirtualTxs([filled.fillTxid!])
        const fill = Transaction.fromPSBT(base64.decode(txs[0]!))
        expect(hex.encode(fill.getOutput(0)!.script!)).toBe(makerPkScript)
        expect(fill.getOutput(0)!.amount).toBe(BigInt(swap.quote.to_amount))

        const statusTransport = openTransport()
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
})
