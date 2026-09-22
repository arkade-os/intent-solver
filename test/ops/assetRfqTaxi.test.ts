/**
 * The production Taxi adapter's READ half: resolving one receive-carrier quote
 * and answering what inventory that quote's own expiry floor leaves spendable.
 *
 * Nothing here can move money — there is no submit, no signing and no
 * checkpoint write in this half — so every case is about refusing: a quote the
 * trusted keys did not underwrite, a quote for another asset or another payout,
 * and coins that cannot be proved to outlive the floor the operator fixed.
 *
 * The quotes are REAL. `verifyReceiveQuote` runs unmodified against a fixture
 * whose covenant address is derived by the same covenant code the operator
 * uses, so a test that passes has exercised the actual verification rather than
 * a stand-in for it.
 */

import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { ArkAddress, asset } from '@arkade-os/sdk'
import { AssetRfqSwapStore } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import {
  AssetRfqSwapService,
  type AssetRfqDeps,
  type ReceiveCarrierQuotes,
} from '@arkade-os/solver-corridors/asset/assetRfqOrchestrator.js'
import {
  createTaxiReceiveCarrierReader,
  spendableCarrierCoins,
  type CarrierCoin,
  type TaxiReceiveCarrierDeps,
} from '@arkade-os/solver-app/ops/assetRfqTaxi.js'

/**
 * The covenant package is reachable only THROUGH the frozen client, which is
 * the one `@arkade-taxi/*` archive this workspace declares. `verify.mjs`
 * resolves the same way for the same reason.
 */
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

const key = (seed: number): Uint8Array =>
  schnorr.getPublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? seed : 1)))

const SERVER_KEY = key(1)
const EMULATOR_KEY = key(2)
const OPERATOR_KEY = key(3)
const MAKER_KEY = key(4)
const PAYOUT_KEY = key(5)
const HRP = 'tark'
const DUST = 330n
const VTXO_MIN = 1n
const ASSET = `${'aa'.repeat(31)}bb0100`
const RECOVERY = 1_000_000n
const FLOOR = 1_100_000n
const BATCH = 1_200_000n

const MAKER_PK_SCRIPT = hex.encode(new ArkAddress(SERVER_KEY, PAYOUT_KEY, HRP).pkScript)
const RECEIVER_ADDRESS = new ArkAddress(SERVER_KEY, PAYOUT_KEY, HRP).encode()

const assetWire = (id: string): { txid: string; groupIndex: number } => {
  const parsed = asset.AssetId.fromString(id)
  return { txid: hex.encode(Uint8Array.from(parsed.txid).reverse()), groupIndex: parsed.groupIndex }
}

const TRUST = {
  serverKey: SERVER_KEY,
  emulatorKey: EMULATOR_KEY,
  dustSats: DUST,
  vtxoMinAmount: VTXO_MIN,
  hrp: HRP,
  locktimeDomain: 'height' as const,
}

type Tagged = { kind: 'height' | 'time'; value: string }

const quoteFixture = (
  over: {
    state?: string
    fareUnits?: string
    recovery?: bigint
    floor?: bigint
    batch?: bigint
    domain?: 'height' | 'time'
    assetId?: string
    receiverAddress?: string
    covenantAddress?: string
    expiresAt?: number
    quoteId?: string
  } = {},
): Record<string, unknown> => {
  const domain = over.domain ?? 'height'
  const recovery = over.recovery ?? RECOVERY
  const floor = over.floor ?? FLOOR
  const batch = over.batch ?? BATCH
  const id = over.assetId ?? ASSET
  const wire = assetWire(id)
  const parsed = asset.AssetId.fromString(id)
  const tagged = (value: bigint): Tagged => ({ kind: domain, value: String(value) })
  const covenant = new DustCovenantScript({
    serverKey: SERVER_KEY,
    emulatorKey: EMULATOR_KEY,
    vtxoMinAmount: VTXO_MIN,
    params: {
      receiverKey: PAYOUT_KEY,
      senderKey: MAKER_KEY,
      operatorKey: OPERATOR_KEY,
      dust: DUST,
      topup: DUST - VTXO_MIN,
      assetId: { txid: Uint8Array.from(parsed.txid).reverse(), groupIndex: parsed.groupIndex },
      locktime: recovery,
      recoveryRecipient: 'receiver',
      claimMode: 'recycle',
    },
  })
  return {
    quoteId: over.quoteId ?? 'q-1',
    state: over.state ?? 'quoted',
    receiverAddress: over.receiverAddress ?? RECEIVER_ADDRESS,
    makerPublicKey: hex.encode(MAKER_KEY),
    params: {
      receiverKey: hex.encode(PAYOUT_KEY),
      senderKey: hex.encode(MAKER_KEY),
      operatorKey: hex.encode(OPERATOR_KEY),
      dust: String(DUST),
      topup: String(DUST - VTXO_MIN),
      assetId: wire,
      locktime: String(recovery),
      recoveryRecipient: 'receiver',
      claimMode: 'recycle',
    },
    covenantAddress: over.covenantAddress ?? covenant.address(HRP, SERVER_KEY).encode(),
    fare: { currency: 'sats', units: over.fareUnits ?? '4' },
    batchExpiry: tagged(batch),
    inputExpiryFloor: tagged(floor),
    recoveryLocktime: tagged(recovery),
    createdAt: 1_000,
    expiresAt: over.expiresAt ?? 5_000,
  }
}

const infoFixture = (
  over: { serverKey?: Uint8Array; emulatorKey?: Uint8Array; assetId?: string } = {},
): Record<string, unknown> => ({
  protocolVersion: 1,
  operatorKey: hex.encode(OPERATOR_KEY),
  serverKey: hex.encode(over.serverKey ?? SERVER_KEY),
  emulatorKey: hex.encode(over.emulatorKey ?? EMULATOR_KEY),
  arkdUrl: 'http://arkd.example',
  emulatorUrl: 'http://emulator.example',
  dust: String(DUST),
  vtxoMinAmount: String(VTXO_MIN),
  assetRules: [
    {
      assetId: assetWire(over.assetId ?? ASSET),
      enabled: true,
      claim: 'either',
      maxTopupSats: null,
      fares: [{ id: 'flat', currency: 'sats', pricing: { kind: 'flat', units: '4' } }],
    },
  ],
  maxPerPaymentTopupSats: '10000',
  paused: false,
})

const coin = (over: Partial<CarrierCoin> & { txid: string }): CarrierCoin => ({
  vout: 0,
  value: 10_000,
  expiresAtHeight: Number(BATCH),
  ...over,
})

const reader = (
  over: Partial<TaxiReceiveCarrierDeps> & { quote?: Record<string, unknown>; info?: Record<string, unknown> } = {},
) => {
  const asked: string[] = []
  const deps: TaxiReceiveCarrierDeps = {
    quotes: {
      info: async () => (over.info ?? infoFixture()) as never,
      getReceiveQuote: async (id: string) => {
        asked.push(id)
        return (over.quote ?? quoteFixture()) as never
      },
    },
    trust: TRUST,
    maxServiceFareSats: 10n,
    coins: async () => [],
    reserved: () => new Set<string>(),
    ...over,
  }
  return { asked, deps, read: createTaxiReceiveCarrierReader(deps) }
}

const request = (over: Record<string, unknown> = {}) => ({
  quoteId: 'q-1',
  makerPkScript: MAKER_PK_SCRIPT,
  makerPublicKey: hex.encode(MAKER_KEY),
  assetId: ASSET,
  now: 2_000,
  ...over,
})

describe('resolving one receive-carrier quote', () => {
  it('reads the named quote and returns the terms the operator underwrote', async () => {
    const { read, asked } = reader()
    await expect(read.resolve(request())).resolves.toEqual({
      quoteId: 'q-1',
      makerPkScript: MAKER_PK_SCRIPT,
      makerPublicKey: hex.encode(MAKER_KEY),
      assetId: ASSET,
      physicalSats: 330n,
      loanSats: 329n,
      receiptSats: 1n,
      serviceFareSats: 4n,
      inputExpiryFloor: { kind: 'height', value: FLOOR },
      expiresAt: 5_000,
    })
    // READ, never created: the client owns this quote and the solver only
    // verifies it.
    expect(asked).toEqual(['q-1'])
  })

  it('refuses a quote the trusted Arkade Service key did not underwrite', async () => {
    const { read } = reader({ info: infoFixture({ serverKey: key(9) }) })
    await expect(read.resolve(request())).rejects.toThrow(/untrusted server/)
  })

  it('refuses a quote naming an emulator this deployment does not trust', async () => {
    const { read } = reader({ info: infoFixture({ emulatorKey: key(9) }) })
    await expect(read.resolve(request())).rejects.toThrow(/untrusted emulator/)
  })

  it('refuses a quote that pays out to a different script', async () => {
    const substituted = new ArkAddress(SERVER_KEY, key(7), HRP).encode()
    const { read } = reader({ quote: quoteFixture({ receiverAddress: substituted }) })
    await expect(read.resolve(request())).rejects.toThrow(/receiver address/)
  })

  it('refuses a quote for a different asset', async () => {
    const { read } = reader({ quote: quoteFixture({ assetId: `${'cc'.repeat(32)}0100` }) })
    await expect(read.resolve(request())).rejects.toThrow()
  })

  it('refuses a fare above the ceiling this deployment authorised', async () => {
    const { read } = reader({ maxServiceFareSats: 3n })
    await expect(read.resolve(request())).rejects.toThrow(/fare exceeds the caller ceiling/)
  })

  it('refuses a quote denominated in the other locktime domain', async () => {
    const { read } = reader({
      quote: quoteFixture({
        domain: 'time',
        recovery: 1_700_000_000n,
        floor: 1_700_000_100n,
        batch: 1_700_000_200n,
      }),
    })
    await expect(read.resolve(request())).rejects.toThrow(/below the caller minimum|domain/)
  })

  it('refuses a quote whose input floor does not outlive its own recovery locktime', async () => {
    const { read } = reader({ quote: quoteFixture({ floor: RECOVERY }) })
    await expect(read.resolve(request())).rejects.toThrow(/lifetime ordering is unsafe/)
  })

  it('refuses a quote that is no longer quoted', async () => {
    const { read } = reader({ quote: quoteFixture({ state: 'bound' }) })
    await expect(read.resolve(request())).rejects.toThrow(/not usable/)
  })

  it('refuses a body answering under another quote id, on both entry points', async () => {
    const { read } = reader({ quote: quoteFixture({ quoteId: 'q-2' }) })
    await expect(read.resolve(request())).rejects.toThrow(/answered as q-2/)
    await expect(read.available(request())).rejects.toThrow(/answered as q-2/)
  })

  it('refuses a payout script that is not a taproot output, without asking Taxi', async () => {
    const getReceiveQuote = vi.fn(async () => quoteFixture() as never)
    const { read } = reader({ quotes: { info: async () => infoFixture() as never, getReceiveQuote } })
    await expect(read.resolve(request({ makerPkScript: '0014' + 'a'.repeat(40) }))).rejects.toThrow(/taproot/)
    expect(getReceiveQuote).not.toHaveBeenCalled()
  })

  it('refuses an asset id this chain cannot name, without asking Taxi', async () => {
    const getReceiveQuote = vi.fn(async () => quoteFixture() as never)
    const { read } = reader({ quotes: { info: async () => infoFixture() as never, getReceiveQuote } })
    await expect(read.resolve(request({ assetId: 'not-an-asset' }))).rejects.toThrow()
    expect(getReceiveQuote).not.toHaveBeenCalled()
  })
})

describe('inventory against the quote’s own input expiry floor', () => {
  it('counts only coins whose known expiry clears the floor', async () => {
    const { read } = reader({
      coins: async () => [
        coin({ txid: 'a'.repeat(64), expiresAtHeight: Number(FLOOR), assets: [{ assetId: ASSET, amount: 5n }] }),
        coin({ txid: 'b'.repeat(64), expiresAtHeight: Number(FLOOR) - 1, assets: [{ assetId: ASSET, amount: 90n }] }),
      ],
    })
    expect(await read.available(request())).toEqual(
      new Map([
        [null, 9_670n],
        [ASSET, 5n],
      ]),
    )
  })

  it('excludes an outpoint another operation has pinned', async () => {
    const pinned = coin({ txid: 'c'.repeat(64), vout: 2, assets: [{ assetId: ASSET, amount: 7n }] })
    const { read } = reader({
      coins: async () => [pinned, coin({ txid: 'd'.repeat(64), assets: [{ assetId: ASSET, amount: 11n }] })],
      reserved: () => new Set([`${'c'.repeat(64)}:2`]),
    })
    expect((await read.available(request())).get(ASSET)).toBe(11n)
  })

  it('excludes a coin expressed in the other domain, and one claiming both', async () => {
    const { read } = reader({
      coins: async () => [
        {
          txid: 'e'.repeat(64),
          vout: 0,
          value: 500,
          expiresAt: new Date(4_000_000_000_000),
          assets: [{ assetId: ASSET, amount: 3n }],
        },
        {
          txid: 'f'.repeat(64),
          vout: 0,
          value: 500,
          expiresAt: new Date(4_000_000_000_000),
          expiresAtHeight: Number(BATCH),
          assets: [{ assetId: ASSET, amount: 4n }],
        },
        { txid: '0'.repeat(64), vout: 0, value: 500, assets: [{ assetId: ASSET, amount: 5n }] },
      ],
    })
    expect(await read.available(request())).toEqual(new Map([[null, 0n]]))
  })

  it('discounts an asset-bearing coin by one dust on the sats leg, as funding does', async () => {
    const { read } = reader({
      coins: async () => [
        coin({ txid: 'a'.repeat(64), value: 1_000 }),
        coin({ txid: 'b'.repeat(64), value: 1_000, assets: [{ assetId: ASSET, amount: 2n }] }),
      ],
    })
    expect((await read.available(request())).get(null)).toBe(1_000n + 1_000n - DUST)
  })

  it('re-verifies the named quote and reports nothing when it no longer verifies', async () => {
    const { read } = reader({
      quote: quoteFixture({ state: 'expired' }),
      coins: async () => [coin({ txid: 'a'.repeat(64), assets: [{ assetId: ASSET, amount: 8n }] })],
    })
    await expect(read.available(request())).rejects.toThrow(/not usable/)
  })

  it('sums an asset carried by two coins rather than letting the second replace the first', async () => {
    const { read } = reader({
      coins: async () => [
        coin({ txid: 'a'.repeat(64), assets: [{ assetId: ASSET, amount: 6n }] }),
        coin({ txid: 'b'.repeat(64), assets: [{ assetId: ASSET, amount: 4n }] }),
      ],
    })
    expect((await read.available(request())).get(ASSET)).toBe(10n)
  })
})

describe('the spendable-coin seam', () => {
  it('takes the wallet’s own default and delegate contracts, minus swept and spent outputs', async () => {
    const getContractsWithVtxos = vi.fn(async () => [
      {
        vtxos: [
          { txid: 'a'.repeat(64), vout: 0, value: 1 },
          { txid: 'b'.repeat(64), vout: 0, value: 2, isSwept: true },
          { txid: 'c'.repeat(64), vout: 0, value: 3, isSpent: true },
          { txid: 'd'.repeat(64), vout: 0, value: 4, spentBy: 'e'.repeat(64) },
          { txid: 'f'.repeat(64), vout: 0, value: 5, settledBy: '0'.repeat(64) },
        ],
      },
    ])
    const coins = await spendableCarrierCoins({ getContractsWithVtxos } as never)
    expect(coins.map((c) => c.value)).toEqual([1])
    expect(getContractsWithVtxos).toHaveBeenCalledWith({ type: ['default', 'delegate'] })
  })
})

describe('a half-adapter is refused, never degraded', () => {
  const harness = async (receiveCarrierQuotes: unknown) => {
    let clock = 1_000
    const store = await AssetRfqSwapStore.open(':memory:', () => clock)
    const deps: AssetRfqDeps = {
      store,
      markets: [
        {
          base: null,
          quote: ASSET,
          symbol: 'USDA',
          baseDecimals: 8,
          quoteDecimals: 6,
          feeBps: 50,
          sellBase: { min: 1n, max: 10n ** 24n },
          buyBase: { min: 1n, max: 10n ** 24n },
          feedUrl: 'https://feed.example/btc',
          pricePath: 'price',
          carrierSats: 0n,
        },
      ],
      solverPubkey: 'e'.repeat(64),
      quoteValiditySeconds: 30,
      dustSats: DUST,
      now: () => clock,
      fetchPrice: async () => ({ mantissa: 100_000n, scale: 0 }),
      deriveOffer: () => ({ pkScript: `5120${'d'.repeat(64)}`, address: 'ark1qoffer' }),
      depositAt: async () => null,
      balance: async () => new Map([[ASSET, 10n ** 18n]]),
      settle: async () => 'fa'.repeat(32),
      newId: () => 'swap-1',
      receiveCarrierQuotes: receiveCarrierQuotes as ReceiveCarrierQuotes,
    }
    return { store, service: new AssetRfqSwapService(deps) }
  }

  it('refuses to price a recycle against resolve and available alone, before reaching Taxi', async () => {
    const { read, asked } = reader()
    const { service } = await harness(read)
    expect(
      await service.quote({
        rfqId: 'a'.repeat(64),
        pair: `arkade:BTC->arkade:${ASSET}`,
        amount: 100_000_000n,
        amountSide: 'from',
        makerPkScript: MAKER_PK_SCRIPT,
        makerPublicKey: hex.encode(MAKER_KEY),
        carrier: { mode: 'recycle', quoteId: 'q-1' },
      }),
    ).toMatchObject({ accepted: false, reason: 'price_unavailable' })
    expect(asked).toEqual([])
  })

  it('refuses to fill a funded recycle against resolve and available alone', async () => {
    const { read, asked } = reader()
    const { service, store } = await harness(read)
    await store.insertQuote({
      id: 'swap-2',
      rfqId: 'b'.repeat(64),
      pair: `arkade:BTC->arkade:${ASSET}`,
      fromAssetId: null,
      toAssetId: ASSET,
      fromAmount: 1_000n,
      toAmount: 10n,
      makerPkScript: MAKER_PK_SCRIPT,
      makerPublicKey: hex.encode(MAKER_KEY),
      offerPkScript: `5120${'d'.repeat(64)}`,
      offerAddress: 'ark1qoffer',
      solverPubkey: 'e'.repeat(64),
      validUntil: 9_000,
      carrierTerms: {
        mode: 'recycle',
        quoteId: 'q-1',
        physicalSats: 330n,
        loanSats: 329n,
        receiptSats: 1n,
        serviceFareSats: 4n,
        pricedSats: 5n,
        expiresAt: 9_000,
      },
    })
    await store.transition('swap-2', 'quoted', 'funded', {})
    await service.tick('swap-2')
    expect((await store.get('swap-2')).state).toBe('refused')
    expect(asked).toEqual([])
  })
})
