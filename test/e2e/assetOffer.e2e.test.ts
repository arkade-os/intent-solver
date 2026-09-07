/**
 * The offer path end to end: publish one, discover it off arkd's filtered
 * stream, decide it, and settle it against the emulator.
 *
 * This suite is the ONLY thing that exercises `fulfillOffer` for real. Its
 * construction is spec-shaped and unit-guarded, but "builds correctly" and
 * "settles" are different claims and only this makes the second.
 *
 * THIS WALLET IS BOTH SIDES. The solver is never a maker in production — an
 * offer is a standing commitment with no expiry, so publishing one writes a
 * free option. Here it is the only way to get a real offer to fill, and paying
 * ourselves still exercises the covenant, the emulator and arkd exactly as a
 * third-party maker would.
 */
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createOffer, decodeOffer, OFFER_PACKET_TYPE, type Offer } from '@arkade-os/swap'
import { asset, Extension } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { Transaction } from '@scure/btc-signer'
import {
  openArkade,
  assertArkadeSpendable,
  SWAP_TIMEOUT_MS,
  SETUP_TIMEOUT_MS,
  tempStoreDir,
  type E2eArkade,
} from './support/stack.js'
import { streamOfferTxs, OFFER_PACKET_FILTER } from '@arkade-os/solver-arkade/arkade/offerStream.js'
import { offerIsConsistent } from '@arkade-os/solver-arkade/arkade/offerConsistency.js'
import { offerDepositFrom } from '@arkade-os/solver-arkade/arkade/offerDeposit.js'
import { offerOutputsAt } from '@arkade-os/solver-arkade/arkade/offerOutputs.js'
import { fulfillOffer } from '@arkade-os/solver-arkade/arkade/offerFulfill.js'
import { createPriceFeed } from '@arkade-os/solver-core/price/feed.js'
import { poll } from '@arkade-os/solver-core/util/poll.js'
import { assetMarketPolicy } from '@arkade-os/solver-core/core/assetMarketConfig.js'
import { AssetOfferService, assertMarketsPriced, parseAssetMarkets } from '@arkade-os/solver-app/ops/assetOffers.js'
import { createServices } from '@arkade-os/solver-app/ops/services.js'
import { loadConfig } from '@arkade-os/solver-app/config.js'
import { servedBy } from '@arkade-os/solver-app/admin/servedBy.js'
import { AdminStore } from '@arkade-os/solver-app/admin/db.js'
import { OfferFillStore } from '@arkade-os/solver-corridors/db/offerFills.js'
import { betterSqliteDriver } from '@arkade-os/solver-db/driver.js'

const ARKD_URL = process.env.ARK_SERVER_URL ?? 'http://localhost:7070'
/** Two deposits and the maker payment, with room for fees. */
const NEEDED_SATS = 40_000

let arkade: E2eArkade

/** The first asset this wallet actually holds, or null when it holds none. */
const heldAsset = async (): Promise<{ assetId: string; amount: bigint } | null> => {
  const balance = await arkade.ctx.wallet.getBalance()
  const held = (balance.availableAssets ?? []) as { assetId: string; amount: bigint }[]
  const usable = held.find((entry) => BigInt(entry.amount) > 0n)
  return usable ? { assetId: usable.assetId, amount: BigInt(usable.amount) } : null
}

beforeAll(async () => {
  arkade = await openArkade()
  await assertArkadeSpendable(arkade, NEEDED_SATS)
}, SETUP_TIMEOUT_MS)

afterAll(() => arkade?.close())

describe('e2e arkade offers — publish, discover, settle', () => {
  it(
    'discovers a published offer on the filtered stream and settles it',
    async () => {
      const held = await heldAsset()
      if (!held) throw new Error('this wallet holds no asset; mint one before running the offer e2e')

      // The maker deposits sats and wants an ASSET, so the fill exercises the
      // asset packet and the group-index-0 rule the covenant depends on.
      const wantAmount = 1n
      const depositSats = 1_000

      const controller = new AbortController()
      const seen: { txid: string; tx: string }[] = []
      const watching = (async () => {
        for await (const event of streamOfferTxs({
          arkdUrl: ARKD_URL,
          expressions: [OFFER_PACKET_FILTER],
          signal: controller.signal,
        })) {
          seen.push(event)
          break
        }
      })()

      // Give the subscription a moment to be established before publishing;
      // arkd matches on arrival, so an offer funded first is simply missed.
      await new Promise((resolve) => setTimeout(resolve, 3_000))

      const offer = await createOffer(arkade.ctx.wallet, ARKD_URL, {
        wantAmount,
        wantAsset: asset.AssetId.fromString(held.assetId),
      })
      const fundingTxid = await arkade.ctx.wallet.send({
        address: offer.address,
        amount: depositSats,
        extensions: [offer.extension],
      })

      await Promise.race([watching, new Promise((resolve) => setTimeout(resolve, 60_000))])
      controller.abort()

      // DISCOVERY. The filter is arkd's, so this also proves it matched on the
      // offer packet rather than on everything.
      const event = seen.find((candidate) => candidate.txid === fundingTxid)
      expect(event, `the stream never delivered ${fundingTxid}`).toBeDefined()

      // The offer as a FILLER sees it: decoded from the funding tx's extension,
      // never from what `createOffer` returned to us.
      const funding = Transaction.fromPSBT(base64.decode(event!.tx))
      const packet = Extension.fromTx(funding).getPacketByType(OFFER_PACKET_TYPE)
      expect(packet, 'the funding tx carries no offer packet').not.toBeNull()
      const discovered: Offer = decodeOffer(packet!.serialize())

      // § 5.1 against the offer we recovered from the chain.
      expect(offerIsConsistent(discovered, arkade.ctx.wallet.arkServerPublicKey)).toBe(true)

      // The deposit is OBSERVED at the script, never read from the packet.
      const outputs = Array.from({ length: funding.outputsLength }, (_unused, vout) => {
        const out = funding.getOutput(vout)
        return {
          script: Buffer.from(out?.script ?? new Uint8Array()).toString('hex'),
          value: Number(out?.amount ?? 0n),
          vout,
        }
      })
      const swapScriptHex = Buffer.from(discovered.swapPkScript).toString('hex')
      const depositOut = outputs.find((out) => out.script.toLowerCase() === swapScriptHex.toLowerCase())
      expect(depositOut, 'no output at the swap script').toBeDefined()
      const deposit = offerDepositFrom(swapScriptHex, [{ script: depositOut!.script, value: depositOut!.value }])
      expect(deposit.sats).toBe(BigInt(depositSats))

      // SETTLEMENT. The emulator evaluates the covenant against what we built;
      // a refusal here is the security model working, not a flake.
      const fillTxid = await fulfillOffer(arkade.ctx, arkade.emulator.url, discovered, {
        txid: fundingTxid,
        vout: depositOut!.vout,
        value: depositOut!.value,
      })
      expect(fillTxid).toMatch(/^[0-9a-f]{64}$/)
      expect(fillTxid).not.toBe(fundingTxid)
    },
    SWAP_TIMEOUT_MS,
  )
})

/**
 * The incident's numbers: a market floored at 500 asset units, an offer wanting
 * 206. The solver was right to decline it and left no log, no row and no
 * console line, so every case here asserts the DECISION and the TRACE.
 *
 * ONE published offer judged four times, each judgement on its own store so
 * `findLiveByOutpoint` cannot short-circuit a later one.
 */
describe('e2e arkade offers — bounds, refused legibly and accepted at the edge', () => {
  const WANT_UNITS = 206n
  const DEPOSIT_SATS = 1_000
  /** One asset unit per sat at `baseDecimals: 8`, matching the RFQ e2e's feed. */
  const FEED_PRICE = '100000000'

  let dir: string
  let feed: Server
  let feedUrl: string
  let assetId: string
  let discovered: Offer
  let outpoint: { txid: string; vout: number }

  beforeAll(async () => {
    const held = await heldAsset()
    if (!held) throw new Error('this wallet holds no asset; mint one before running the offer e2e')
    if (held.amount < WANT_UNITS) throw new Error(`wallet holds ${held.amount} units, needs ${WANT_UNITS}`)
    assetId = held.assetId

    feed = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ price: FEED_PRICE }))
    })
    await new Promise<void>((resolve) => feed.listen(0, '127.0.0.1', resolve))
    const bound = feed.address()
    if (bound === null || typeof bound === 'string') throw new Error('price feed did not bind a port')
    feedUrl = `http://127.0.0.1:${bound.port}/price`
    dir = tempStoreDir()

    const offer = await createOffer(arkade.ctx.wallet, ARKD_URL, {
      wantAmount: WANT_UNITS,
      wantAsset: asset.AssetId.fromString(assetId),
    })
    const fundingTxid = await arkade.ctx.wallet.send({
      address: offer.address,
      amount: DEPOSIT_SATS,
      extensions: [offer.extension],
    })

    const funding = await poll(
      async () => {
        const { txs } = await arkade.ctx.wallet.indexerProvider.getVirtualTxs([fundingTxid])
        return txs?.[0] ? Transaction.fromPSBT(base64.decode(txs[0])) : null
      },
      { attempts: 30, intervalMs: 2_000, whenExhausted: `the indexer never returned ${fundingTxid}` },
    )

    // Decoded from the chain as a filler sees it, not from what `createOffer` returned.
    const packet = Extension.fromTx(funding).getPacketByType(OFFER_PACKET_TYPE)
    if (!packet) throw new Error('the funding tx carries no offer packet')
    discovered = decodeOffer(packet.serialize())
    const script = hex.encode(discovered.swapPkScript).toLowerCase()
    const vout = Array.from({ length: funding.outputsLength }, (_unused, index) => index).find(
      (index) => hex.encode(funding.getOutput(index)?.script ?? new Uint8Array()).toLowerCase() === script,
    )
    if (vout === undefined) throw new Error('no output at the swap script')
    outpoint = { txid: fundingTxid, vout }

    // Visible to the reader the service uses, or every case below refuses `offer_unfunded`.
    await poll(
      async () => {
        const outputs = await offerOutputsAt(arkade.ctx, script)
        return outputs.some((output) => !output.isSpent && !output.isSwept) || null
      },
      { attempts: 30, intervalMs: 2_000, whenExhausted: 'the deposit never appeared at the offer script' },
    )
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    if (feed) await new Promise<void>((resolve) => feed.close(() => resolve()))
  })

  // The real service against the real chain, only the bounds varying. NO settle
  // port: these cases decide, and must spend nothing.
  const judge = async (sellBase: { min: bigint; max: bigint }) => {
    const store = await OfferFillStore.open(join(dir, `offer-${randomBytes(6).toString('hex')}.sqlite`))
    const refusals: { outpoint: string; reason: string; detail: string }[] = []
    const service = new AssetOfferService({
      store,
      markets: [{ a: null, b: assetId }],
      // Deliberately wide, so a refusal below can only have come from `sellBase`.
      minFillAmount: 1n,
      maxFillAmount: 10n ** 12n,
      pricing: [
        {
          base: null,
          quote: assetId,
          baseDecimals: 8,
          quoteDecimals: 0,
          feedUrl,
          pricePath: '/price',
          // As permissive as the gate allows, isolating BOUNDS from pricing.
          toleranceBps: 9_999,
          feeBps: 0,
          sellBase,
        },
      ],
      fetchPrice: createPriceFeed(),
      balance: () => arkade.ctx.wallet.getBalance(),
      outputsAt: (offerPkScript) => offerOutputsAt(arkade.ctx, offerPkScript),
      serverPubkey: arkade.ctx.wallet.arkServerPublicKey,
      onRefused: (at, reason, detail) => void refusals.push({ outpoint: at, reason, detail }),
    })
    const outcome = await service.consider({ offer: discovered, ...outpoint })
    return { outcome, refusals, store }
  }

  it(
    'refuses an offer under the market minimum, and names the bound that refused it',
    async () => {
      const { outcome, refusals, store } = await judge({ min: 500n, max: 1_000_000n })
      expect(outcome).toEqual({ fill: false, reason: 'amount_out_of_range' })

      expect(refusals).toHaveLength(1)
      expect(refusals[0]!.outpoint).toBe(`${outpoint.txid}:${outpoint.vout}`)
      expect(refusals[0]!.reason).toBe('amount_out_of_range')
      expect(refusals[0]!.detail).toContain(String(WANT_UNITS))
      expect(refusals[0]!.detail).toContain('market bounds 500..1000000')

      expect(await store.listNonTerminal()).toHaveLength(0)
      await store.close()
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'refuses an offer over the market maximum, and names that bound too',
    async () => {
      const { outcome, refusals, store } = await judge({ min: 1n, max: 100n })
      expect(outcome).toEqual({ fill: false, reason: 'amount_out_of_range' })
      expect(refusals[0]!.detail).toContain('market bounds 1..100')
      expect(await store.listNonTerminal()).toHaveLength(0)
      await store.close()
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'ACCEPTS an offer at exactly the minimum',
    async () => {
      const { outcome, refusals, store } = await judge({ min: WANT_UNITS, max: 1_000_000n })
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ fill: true })
      expect(refusals).toEqual([])
      expect(await store.listNonTerminal()).toMatchObject([{ state: 'fillable', wantAmount: WANT_UNITS }])
      await store.close()
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'ACCEPTS an offer at exactly the maximum',
    async () => {
      const { outcome, refusals, store } = await judge({ min: 1n, max: WANT_UNITS })
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ fill: true })
      expect(refusals).toEqual([])
      expect(await store.listNonTerminal()).toHaveLength(1)
      await store.close()
    },
    SWAP_TIMEOUT_MS,
  )

  // The boot-time derivation over a REAL stored market row. `servedBy` is #71's;
  // this pins it against a stored row rather than a hand-built one.
  describe('what this deployment says it will fill', () => {
    const rowFor = (over: Record<string, unknown> = {}) => ({
      base: null,
      quote: assetId,
      baseDecimals: 8,
      quoteDecimals: 0,
      feedUrl,
      pricePath: '/price',
      toleranceBps: 50,
      feeBps: 10,
      sellBase: { min: 500n, max: 1_000_000n },
      buyBase: null,
      enabled: true,
      ...over,
    })

    it('reports a configured market as served by NOTHING when OFFER_MARKETS is unset', async () => {
      const admin = await AdminStore.open(betterSqliteDriver(':memory:'))
      await admin.putMarket(rowFor())
      const boot = { offerMarkets: parseAssetMarkets(undefined), assetRfqTokens: [] }
      expect(boot.offerMarkets).toEqual([])
      expect(servedBy((await admin.listMarkets())[0]!, boot)).toEqual([])
      await admin.close()
    })

    it('refuses to boot when a served market has been disabled', async () => {
      // A disabled row leaves `pricing`, so the pair is served and priced nowhere.
      const admin = await AdminStore.open(betterSqliteDriver(':memory:'))
      await admin.putMarket(rowFor({ enabled: false }))
      const policy = assetMarketPolicy(await admin.listMarkets())
      expect(policy.pricing).toEqual([])
      expect(() => assertMarketsPriced(parseAssetMarkets(`BTC/${assetId}`), policy.pricing)).toThrow(/no pricing/)
      await admin.close()
    })
  })
})

/**
 * The DAEMON's construction of the offer path, not a hand-built one. Everything
 * above hands `AssetOfferService` its markets directly, which cannot see the
 * chain the operator's evening broke on: `OFFER_MARKETS` -> `parseAssetMarkets`
 * -> `policy.offerMarkets` -> `servesOffers` -> `OfferFillStore.open`.
 */
describe('e2e arkade offers — what OFFER_MARKETS actually builds', () => {
  let dir: string
  let assetId: string
  const saved = new Map<string, string | undefined>()

  const setEnv = (key: string, value: string | undefined): void => {
    if (!saved.has(key)) saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  beforeAll(async () => {
    const held = await heldAsset()
    if (!held) throw new Error('this wallet holds no asset; mint one before running the offer e2e')
    assetId = held.assetId
    dir = tempStoreDir()
  }, SETUP_TIMEOUT_MS)

  afterAll(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  // Its own `SWAP_DB_PATH`/`ARK_DB_PATH`, sharing no handle with the wallet this
  // suite already holds open. A fresh path has no suffixed sibling, so
  // `resolveDbLayout` is consolidated and this IS the admin store boot reads.
  const boot = async (offerMarkets: string | undefined) => {
    const swapDbPath = join(dir, `services-${randomBytes(6).toString('hex')}.sqlite`)
    const admin = await AdminStore.open(betterSqliteDriver(swapDbPath))
    await admin.putMarket({
      base: null,
      quote: assetId,
      baseDecimals: 8,
      quoteDecimals: 0,
      // Never fetched at startup by design, so an unroutable host is honest here.
      feedUrl: 'http://127.0.0.1:1/price',
      pricePath: '/price',
      toleranceBps: 50,
      feeBps: 10,
      sellBase: { min: 500n, max: 1_000_000n },
      buyBase: null,
      enabled: true,
    })
    await admin.close()

    setEnv('SWAP_DB_PATH', swapDbPath)
    setEnv('ARK_DB_PATH', join(dir, `ark-${randomBytes(6).toString('hex')}.sqlite`))
    setEnv('OFFER_MARKETS', offerMarkets)
    setEnv('OFFER_MIN_FILL_AMOUNT', '1')
    setEnv('OFFER_MAX_FILL_AMOUNT', '1000000000000')
    return createServices(loadConfig())
  }

  it(
    'builds the offer path when OFFER_MARKETS names the stored market',
    async () => {
      const services = await boot(`BTC/${assetId}`)
      try {
        expect(services.policy.offerMarkets).toEqual([{ a: null, b: assetId }])
        expect(services.offerStore).not.toBeNull()
        expect(services.assetOffers).not.toBeNull()
      } finally {
        await services.close()
      }
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'builds NOTHING when OFFER_MARKETS is unset, however the market is configured',
    async () => {
      const services = await boot(undefined)
      try {
        expect(services.policy.offerMarkets).toEqual([])
        expect(services.offerStore).toBeNull()
        expect(services.assetOffers).toBeNull()
      } finally {
        await services.close()
      }
    },
    SWAP_TIMEOUT_MS,
  )
})
