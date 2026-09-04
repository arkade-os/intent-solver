/**
 * E2E — `arkade:BTC->arkade:<asset>` over RFQ (`docs/rfq-protocol.md` § 7.2),
 * the route where the client asks first and funds the address it is quoted.
 * `assetOffer.e2e.test.ts` drives the packet route to the same settlement.
 *
 * TWO THINGS ARE SUPPLIED HERE, and only these two. The price feed is a local
 * HTTP server read by the shipped `createPriceFeed()`, so quoted arithmetic is
 * assertable. And the four Arkade seams are wired in this file because NOTHING
 * IN `packages/` WIRES THEM: `createServices` never builds an
 * `AssetRfqSwapService`, and no production `deriveOffer`/`depositAt`/`settle`
 * exists in the tree — a gap this test documents rather than papers over.
 * Service, corridor, store, `offerVtxoScript`, the deposit read, the float and
 * `fulfillOffer` are all the real ones against a real stack. This wallet is
 * both sides, and the client half goes through `@arkade-os/swap`'s own
 * `createOffer`, so the address check below is two independent derivations.
 *
 * Needs arkd, the emulator, spendable sats and a minted asset
 * (`scripts/regtest-mint-asset.mjs`). Run: `pnpm test:e2e`.
 */

import { createServer, type Server } from 'node:http'
import { randomBytes, randomInt } from 'node:crypto'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ArkAddress, hasTerminalSpend, asset, Transaction } from '@arkade-os/sdk'
import { createOffer, cancelOffer, offerVtxoScript, InMemoryAssetSwapRepository, type Offer } from '@arkade-os/swap'
import { base64, hex } from '@scure/base'
import { createPriceFeed } from '@arkade-os/solver-core/price/feed.js'
import { GiveUp, poll, sleep } from '@arkade-os/solver-core/util/poll.js'
import type { AssetLeg } from '@arkade-os/solver-core/core/assetRfq.js'
import { offerInventoryFrom } from '@arkade-os/solver-arkade/arkade/offerInventory.js'
import { ASSET_CARRIER_SATS, fulfillOffer } from '@arkade-os/solver-arkade/arkade/offerFulfill.js'
import {
  AssetRfqSwapService,
  type AssetRfqMarket,
  type ObservedDeposit,
  type OfferTerms,
} from '@arkade-os/solver-corridors/asset/assetRfqOrchestrator.js'
import { AssetRfqSwapStore, type AssetRfqSwapRow } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import { assetRfqCorridor, assetRfqDescriptor } from '@arkade-os/solver-corridors/corridors/assetRfq.js'
import type { Corridor } from '@arkade-os/solver-core/core/corridor.js'
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

/** Enough for four deposits plus the carrier outputs and change, with room to spare. */
const NEEDED_SATS = 120_000

/** One asset unit per sat at `baseDecimals: 8`, so every amount below reads as itself. */
const FEED_PRICE = '100000000'

/** 0.5%, the same order as the packet path's default margin. */
const FEE_BPS = 50

let arkade: E2eArkade
let feed: Server
let feedUrl: string
let assetId: string
let makerPkScript: string
let makerPublicKey: string
let dir: string

/** The first asset this wallet actually holds, or null when it holds none. */
const heldAsset = async (): Promise<{ assetId: string; amount: bigint } | null> => {
  const balance = await arkade.ctx.wallet.getBalance()
  const held = (balance.availableAssets ?? []) as { assetId: string; amount: bigint }[]
  const usable = held.find((entry) => BigInt(entry.amount) > 0n)
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
  await requireStack('arkade asset RFQ', ['arkd', 'emulator'])
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
  await new Promise<void>((resolve) => feed?.close(() => resolve()))
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

/** The missing production derivation: quoted terms in, the covenant out. */
const offerFrom = (terms: OfferTerms): Omit<Offer, 'swapPkScript'> => ({
  wantAmount: terms.wantAmount,
  ...(terms.wantAssetId !== null ? { wantAsset: asset.AssetId.fromString(terms.wantAssetId) } : {}),
  ...(terms.offerAssetId !== null ? { offerAsset: asset.AssetId.fromString(terms.offerAssetId) } : {}),
  makerPkScript: hex.decode(terms.makerPkScript),
  makerPublicKey: hex.decode(terms.makerPublicKey),
  emulatorPubkey: emulatorXOnly(),
})

const deriveOffer = (terms: OfferTerms): { pkScript: string; address: string } => {
  const serverPubkey = arkade.ctx.wallet.arkServerPublicKey
  const script = offerVtxoScript(offerFrom(terms), serverPubkey)
  return {
    pkScript: hex.encode(script.pkScript),
    address: script.address(arkade.profile.arkadeHrp, serverPubkey).encode(),
  }
}

const termsOf = (row: AssetRfqSwapRow): OfferTerms => ({
  wantAmount: row.toAmount,
  wantAssetId: row.toAssetId,
  offerAssetId: row.fromAssetId,
  makerPkScript: row.makerPkScript,
  makerPublicKey: row.makerPublicKey,
})

/** ONE outpoint, never a sum across the script: `fulfill` spends one input. */
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
  const offer: Offer = { ...offerFrom(termsOf(row)), swapPkScript: hex.decode(row.offerPkScript) }
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
  corridor: Corridor
  store: AssetRfqSwapStore
  pair: string
}

const harness = async (
  over: { markets?: readonly AssetRfqMarket[]; quoteValiditySeconds?: number } = {},
): Promise<Harness> => {
  const markets = over.markets ?? [market()]
  const store = await AssetRfqSwapStore.open(join(dir, `assetrfq-${randomBytes(6).toString('hex')}.sqlite`))
  const service = new AssetRfqSwapService({
    store,
    markets,
    solverPubkey: makerPublicKey,
    quoteValiditySeconds: over.quoteValiditySeconds ?? 600,
    deriveOffer,
    depositAt,
    balance,
    fetchPrice: createPriceFeed(),
    settle,
  })
  const descriptor = assetRfqDescriptor(markets[0]!, 'sell_base')
  return { corridor: assetRfqCorridor(descriptor, service, store), store, pair: descriptor.pair }
}

/** The indexer lags `send`, so this revisits the row as the sweep loop would. */
const driveTo = (
  { corridor, store }: Pick<Harness, 'corridor' | 'store'>,
  id: string,
  state: AssetRfqSwapRow['state'],
): Promise<AssetRfqSwapRow> =>
  poll(
    async () => {
      await corridor.tickAll()
      const row = await store.get(id)
      if (row.state === state) return row
      if (row.state !== 'quoted' && row.state !== 'funded' && row.state !== 'filling') {
        throw new GiveUp(`${id} ended ${row.state}, not ${state}: ${row.failureReason ?? 'no reason recorded'}`)
      }
      return null
    },
    { attempts: 30, intervalMs: 2000, whenExhausted: `${id} never reached ${state}` },
  )

const requestFor = (pair: string, amount: bigint, rfqId = randomBytes(32).toString('hex')) => ({
  v: 1,
  type: 'rfq_request',
  rfq_id: rfqId,
  pair,
  amount_side: 'from',
  amount: amount.toString(),
  profile: { maker_pk_script: makerPkScript, maker_public_key: makerPublicKey },
})

/** Jittered: identical terms compile to one address, so a fixed amount would let
 * an earlier run's unspent deposit read as this one's funding. */
const depositSats = (base: number): bigint => BigInt(base + randomInt(1, 400))

const clientOffer = async (wantAmount: bigint) =>
  createOffer(arkade.ctx.wallet, ARKD_URL, { wantAmount, wantAsset: asset.AssetId.fromString(assetId) })

describe('e2e arkade asset RFQ — quote, deposit, fill', () => {
  it(
    'quotes a BTC->asset swap, recognises the deposit and fills it',
    async () => {
      const { corridor, store, pair } = await harness()
      const amount = depositSats(20_000)

      const outcome = await corridor.quote(requestFor(pair, amount))
      expect(outcome.kind, JSON.stringify(outcome)).toBe('quote')
      const quote = outcome.payload as {
        from_amount: string
        to_amount: string
        valid_until: number
        profile: { offer_address: string; offer_pk_script: string }
      }
      expect(BigInt(quote.from_amount)).toBe(amount)
      expect(BigInt(quote.to_amount)).toBe(amount - (amount * BigInt(FEE_BPS) + 9_999n) / 10_000n)

      // § 6 compare-only, and why this corridor needs no accept message: the
      // client derives the covenant itself and funds only its own derivation.
      const mine = await clientOffer(BigInt(quote.to_amount))
      expect(hex.encode(mine.swapPkScript)).toBe(quote.profile.offer_pk_script)
      expect(mine.address).toBe(quote.profile.offer_address)

      const fundingTxid = await arkade.ctx.wallet.send({
        address: mine.address,
        amount: Number(amount),
        extensions: [mine.extension],
      })
      expect(fundingTxid).toMatch(/^[0-9a-f]{64}$/)

      const id = (await store.listNonTerminal())[0]!.id
      const funded = await driveTo({ corridor, store }, id, 'funded')
      expect(funded.depositTxid).toBe(fundingTxid)

      const filled = await driveTo({ corridor, store }, id, 'filled')
      expect(filled.fillTxid).toMatch(/^[0-9a-f]{64}$/)
      expect(filled.fillTxid).not.toBe(fundingTxid)

      expect(await depositAt(filled.offerPkScript)).toBeNull()

      // The asset rides the emulator packet, so an output can only show the
      // maker's script and the carrier the covenant obliges; the emulator
      // refusing anything else is what makes the rest of the payment true.
      const { txs } = await arkade.ctx.wallet.indexerProvider.getVirtualTxs([filled.fillTxid!])
      const fill = Transaction.fromPSBT(base64.decode(txs[0]!))
      expect(hex.encode(fill.getOutput(0)!.script!)).toBe(makerPkScript)
      expect(fill.getOutput(0)!.amount).toBe(ASSET_CARRIER_SATS)

      const status = await corridor.statusFor(filled.rfqId)
      expect(status).toMatchObject({ type: 'rfq_status', state: 'settled' })
      await store.close()
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'refuses what it cannot quote, in the closed RFQ vocabulary',
    async () => {
      const { corridor, pair } = await harness({ markets: [market({ sellBase: { min: 1n, max: 100n } })] })

      const unserved = await corridor.quote(requestFor(`arkade:BTC->arkade:${'ab'.repeat(34)}`, 5_000n))
      expect(unserved.kind).toBe('invalid')
      expect(unserved.payload).toMatchObject({ type: 'rfq_refusal', reason: 'unsupported_pair' })

      const tooBig = await corridor.quote(requestFor(pair, 50_000n))
      expect(tooBig.kind).toBe('refused')
      expect(tooBig.payload).toMatchObject({ reason: 'amount_out_of_range' })

      const exactOut = await corridor.quote({ ...requestFor(pair, 50n), amount_side: 'to' })
      expect(exactOut.kind).toBe('refused')
      expect(exactOut.payload).toMatchObject({ reason: 'unsupported_payload' })

      // § 4.5: one rfq_id names one negotiation, whatever became of it.
      const id = randomBytes(32).toString('hex')
      expect((await corridor.quote(requestFor(pair, 50n, id))).kind).toBe('quote')
      const twice = await corridor.quote(requestFor(pair, 50n, id))
      expect(twice.kind).toBe('refused')
      expect(twice.payload).toMatchObject({ reason: 'quote_conflict' })
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'refuses to quote against a feed it cannot read, and against a float it does not hold',
    async () => {
      // A port nothing listens on: a real failed fetch, not a thrown double.
      const dead = await harness({ markets: [market({ feedUrl: 'http://127.0.0.1:1/price' })] })
      const unreadable = await dead.corridor.quote(requestFor(dead.pair, 5_000n))
      expect(unreadable.kind).toBe('refused')
      expect(unreadable.payload).toMatchObject({ reason: 'pricing_unavailable' })
      await dead.store.close()

      // More than the wallet really holds. § 9 allows this pre-check and does
      // not accept it as sufficient; the action-time gate repeats it.
      const held = (await heldAsset())!.amount
      const rich = await harness({ markets: [market({ sellBase: { min: 1n, max: 10n ** 24n } })] })
      const beyond = await rich.corridor.quote(requestFor(rich.pair, held * 10n))
      expect(beyond.kind).toBe('refused')
      expect(beyond.payload).toMatchObject({ reason: 'exposure_cap' })
      await rich.store.close()
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'refuses a deposit that lands after the quote lapsed, and leaves it for the client to reclaim',
    async () => {
      // One second of validity, and no backdating: the funding round trip is
      // what makes the deposit late.
      const { corridor, store, pair } = await harness({ quoteValiditySeconds: 1 })
      const amount = depositSats(4_000)
      const outcome = await corridor.quote(requestFor(pair, amount))
      expect(outcome.kind).toBe('quote')
      const quote = outcome.payload as { to_amount: string; profile: { offer_address: string } }

      const mine = await clientOffer(BigInt(quote.to_amount))
      const fundingTxid = await arkade.ctx.wallet.send({
        address: mine.address,
        amount: Number(amount),
        extensions: [mine.extension],
      })

      // Past `valid_until` before the corridor looks, so § 5's refusal is the
      // one taken: never silently filled, never silently re-priced.
      await sleep(3_000)
      const id = (await store.listNonTerminal())[0]!.id
      await corridor.tickAll()
      const row = await store.get(id)
      expect(row.state).toBe('refused')
      expect(row.failureReason).toContain('quote expired')

      // NOT the solver's to refund — § 7.2's `cancel` is a 2-of-2 of the funder
      // and the Arkade Service — so the client takes it back itself.
      const stranded = await poll(() => depositAt(hex.encode(mine.swapPkScript)), {
        attempts: 20,
        whenExhausted: 'the lapsed deposit never appeared at the offer script',
      })
      expect(stranded.txid).toBe(fundingTxid)

      const cancelTxid = await cancelOffer(arkade.ctx.wallet, ARKD_URL, mine.offerHex, {
        repository: new InMemoryAssetSwapRepository(),
        fundingTxid,
        swapAddress: mine.address,
      })
      expect(cancelTxid).toMatch(/^[0-9a-f]{64}$/)
      expect(await depositAt(hex.encode(mine.swapPkScript))).toBeNull()
      await store.close()
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'never spends a deposit short of the quoted amount',
    async () => {
      const { corridor, store, pair } = await harness()
      const amount = depositSats(6_000)
      const outcome = await corridor.quote(requestFor(pair, amount))
      expect(outcome.kind).toBe('quote')
      const quote = outcome.payload as { to_amount: string }

      // The covenant obliges the full payout whatever was deposited.
      const mine = await clientOffer(BigInt(quote.to_amount))
      const fundingTxid = await arkade.ctx.wallet.send({
        address: mine.address,
        amount: Number(amount) - 1_000,
        extensions: [mine.extension],
      })

      const id = (await store.listNonTerminal())[0]!.id
      await driveTo({ corridor, store }, id, 'funded')

      await corridor.tickAll()
      const row = await store.get(id)
      expect(row.state).toBe('refused')
      expect(row.failureReason).toContain('deposit_short')
      expect(row.fillTxid).toBeNull()
      expect((await depositAt(row.offerPkScript))?.txid).toBe(fundingTxid)

      await cancelOffer(arkade.ctx.wallet, ARKD_URL, mine.offerHex, {
        repository: new InMemoryAssetSwapRepository(),
        fundingTxid,
        swapAddress: mine.address,
      })
      await store.close()
    },
    SWAP_TIMEOUT_MS,
  )
})
