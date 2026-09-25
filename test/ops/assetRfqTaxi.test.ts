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
import { assetRfqQuotePayload } from '@arkade-os/solver-corridors/wire/assetRfqPayloads.js'
import {
  AssetRfqSwapService,
  CARRIER_FILL_MARGIN_SECONDS,
  type AssetRfqDeps,
  type ReceiveCarrierQuotes,
} from '@arkade-os/solver-corridors/asset/assetRfqOrchestrator.js'
import { esploraChainTip } from '@arkade-os/solver-rails/onchain/chainTip.js'
import type { EsploraClient } from '@arkade-os/solver-rails-esplora/esplora.js'
import {
  carrierAdmissionSlack,
  carrierChainTip,
  createTaxiReceiveCarrierReader,
  spendableCarrierCoins,
  TAXI_FILL_RATE_LIMIT,
  TAXI_QUOTE_GLOBAL_RATE_LIMIT,
  TAXI_QUOTE_RATE_LIMIT,
  TAXI_QUOTE_TIMEOUT_MS,
  taxiClientCache,
  taxiReceiveCarrier,
  type CarrierCoin,
  type TaxiCarrierClient,
  type TaxiCarrierComposition,
  type TaxiReceiveCarrierDeps,
} from '@arkade-os/solver-app/ops/assetRfqTaxi.js'
import type { TaxiUrlPolicy } from '@arkade-os/solver-app/ops/taxiUrlGuard.js'

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

const RECEIVER_ADDRESS = new ArkAddress(SERVER_KEY, PAYOUT_KEY, HRP).encode()

const assetWire = (id: string): { txid: string; groupIndex: number } => {
  const parsed = asset.AssetId.fromString(id)
  return { txid: hex.encode(Uint8Array.from(parsed.txid).reverse()), groupIndex: parsed.groupIndex }
}

const TIP = 1_000_000
const EXIT_DELAY = 5n
const VALIDITY_SECONDS = 30

const TRUST = {
  serverKey: SERVER_KEY,
  emulatorKey: EMULATOR_KEY,
  dustSats: DUST,
  vtxoMinAmount: VTXO_MIN,
  hrp: HRP,
  locktimeDomain: 'height' as const,
  inputExpiryMargin: EXIT_DELAY,
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
    receiverKey?: Uint8Array
    covenantAddress?: string
    expiresAt?: number
    quoteId?: string
    /** The returnable loan, in sats. `DUST` makes the whole dust a loan. */
    topup?: bigint
    /** Opt-in per the SDK wire shape: present only when asked for. */
    payer?: 'receiver'
    /** Receiver-paid only; zero sats unless named. */
    receiverFare?: { currency: 'sats' | 'asset'; units: bigint }
  } = {},
): Record<string, unknown> => {
  const domain = over.domain ?? 'height'
  const recovery = over.recovery ?? RECOVERY
  const floor = over.floor ?? FLOOR
  const batch = over.batch ?? BATCH
  const id = over.assetId ?? ASSET
  const topup = over.topup ?? DUST - VTXO_MIN
  const receiverKey = over.receiverKey ?? PAYOUT_KEY
  const wire = assetWire(id)
  const parsed = asset.AssetId.fromString(id)
  const tagged = (value: bigint): Tagged => ({ kind: domain, value: String(value) })
  // Covenant-bound, so the address commits to it, unlike `params.fare`.
  const receiverFare = over.payer ? (over.receiverFare ?? { currency: 'sats' as const, units: 0n }) : undefined
  const fareWire = receiverFare && { currency: receiverFare.currency, units: String(receiverFare.units) }
  const covenant = new DustCovenantScript({
    serverKey: SERVER_KEY,
    emulatorKey: EMULATOR_KEY,
    vtxoMinAmount: VTXO_MIN,
    params: {
      receiverKey,
      senderKey: MAKER_KEY,
      operatorKey: OPERATOR_KEY,
      dust: DUST,
      topup,
      assetId: { txid: Uint8Array.from(parsed.txid).reverse(), groupIndex: parsed.groupIndex },
      locktime: recovery,
      recoveryRecipient: 'receiver',
      claimMode: 'recycle',
      ...(receiverFare ? { receiverFare } : {}),
    },
  })
  return {
    quoteId: over.quoteId ?? 'q-1',
    state: over.state ?? 'quoted',
    receiverAddress: over.receiverAddress ?? new ArkAddress(SERVER_KEY, receiverKey, HRP).encode(),
    makerPublicKey: hex.encode(MAKER_KEY),
    params: {
      receiverKey: hex.encode(receiverKey),
      senderKey: hex.encode(MAKER_KEY),
      operatorKey: hex.encode(OPERATOR_KEY),
      dust: String(DUST),
      topup: String(topup),
      assetId: wire,
      locktime: String(recovery),
      recoveryRecipient: 'receiver',
      claimMode: 'recycle',
      ...(fareWire ? { receiverFare: fareWire } : {}),
    },
    covenantAddress: over.covenantAddress ?? covenant.address(HRP, SERVER_KEY).encode(),
    fare: { currency: 'sats', units: over.fareUnits ?? '4' },
    // The wire decoder requires these three together, or none; an asset fare names its asset.
    ...(fareWire
      ? {
          payer: over.payer,
          receiverFare: fareWire.currency === 'asset' ? { ...fareWire, assetId: wire } : fareWire,
          unclaimedMode: 'reclaim',
        }
      : {}),
    batchExpiry: tagged(batch),
    inputExpiryFloor: tagged(floor),
    recoveryLocktime: tagged(recovery),
    createdAt: 1_000,
    expiresAt: over.expiresAt ?? 5_000,
  }
}

const covenantScriptOf = (quote: Record<string, unknown>): string =>
  hex.encode(ArkAddress.decode(quote.covenantAddress as string).pkScript)

const MAKER_PK_SCRIPT = covenantScriptOf(quoteFixture())
const RECEIVER_PK_SCRIPT = hex.encode(ArkAddress.decode(RECEIVER_ADDRESS).pkScript)

const infoFixture = (
  over: {
    serverKey?: Uint8Array
    emulatorKey?: Uint8Array
    assetId?: string
    fareUnits?: string
    fares?: readonly Record<string, unknown>[]
  } = {},
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
      fares: over.fares ?? [{ id: 'flat', currency: 'sats', pricing: { kind: 'flat', units: over.fareUnits ?? '4' } }],
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

/** A `TaxiCarrierClient` stand-in; `requestVerifiedSwapFillQuote`/`submitSwapFill` are T21's, unused here. */
const taxiClient = (
  info: () => Promise<unknown> = async () => infoFixture(),
  getReceiveQuote: (id: string) => Promise<unknown> = async () => quoteFixture(),
): TaxiCarrierClient =>
  ({
    info,
    getReceiveQuote,
    requestVerifiedSwapFillQuote: async () => {
      throw new Error('not wired in this fixture')
    },
    submitSwapFill: async () => {
      throw new Error('not wired in this fixture')
    },
  }) as never

const reader = (
  over: Partial<TaxiReceiveCarrierDeps> & { quote?: Record<string, unknown>; info?: Record<string, unknown> } = {},
) => {
  const asked: string[] = []
  const quote = over.quote ?? quoteFixture()
  const client = taxiClient(
    async () => over.info ?? infoFixture(),
    async (id) => {
      asked.push(id)
      return quote
    },
  )
  const deps: TaxiReceiveCarrierDeps = {
    clientFor: () => client,
    trust: TRUST,
    maxServiceFareSats: 10n,
    coins: async () => [],
    reserved: () => new Set<string>(),
    quoteValiditySeconds: VALIDITY_SECONDS,
    tipHeight: async () => TIP,
    ...over,
  }
  return {
    asked,
    deps,
    read: createTaxiReceiveCarrierReader(deps),
    request: (fields: Record<string, unknown> = {}) => request({ makerPkScript: covenantScriptOf(quote), ...fields }),
  }
}

const request = (over: Record<string, unknown> = {}) => ({
  quoteId: 'q-1',
  makerPkScript: MAKER_PK_SCRIPT,
  makerPublicKey: hex.encode(MAKER_KEY),
  assetId: ASSET,
  now: 2_000,
  admission: false,
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
      taxiKey: hex.encode(OPERATOR_KEY),
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

  it('refuses a quote naming a receiver address its covenant does not commit to', async () => {
    const substituted = new ArkAddress(SERVER_KEY, key(7), HRP).encode()
    const { read } = reader({ quote: quoteFixture({ receiverAddress: substituted }) })
    await expect(read.resolve(request())).rejects.toThrow(/substituted the receiver key/)
  })

  it("refuses a request paying the receiver's own address, which the Taxi refuses at fill, on both entry points", async () => {
    const { read } = reader()
    await expect(read.resolve(request({ makerPkScript: RECEIVER_PK_SCRIPT }))).rejects.toThrow(
      /is not the verified quote's receive covenant/,
    )
    await expect(read.available(request({ makerPkScript: RECEIVER_PK_SCRIPT }))).rejects.toThrow(
      /is not the verified quote's receive covenant/,
    )
  })

  it("refuses a request paying another receiver's covenant", async () => {
    const stranger = covenantScriptOf(quoteFixture({ receiverKey: key(7) }))
    const { read } = reader()
    await expect(read.resolve(request({ makerPkScript: stranger }))).rejects.toThrow(
      /is not the verified quote's receive covenant/,
    )
  })

  // The covenant does not commit to the payee's server or network, so this client check is the only guard on them.
  it.each([
    ['another Arkade server', new ArkAddress(key(9), PAYOUT_KEY, HRP).encode()],
    ['another network', new ArkAddress(SERVER_KEY, PAYOUT_KEY, 'ark').encode()],
  ])('refuses a quote whose payee address is on %s', async (_why, receiverAddress) => {
    const { read } = reader({ quote: quoteFixture({ receiverAddress }) })
    await expect(read.resolve(request())).rejects.toThrow(/receiver address is not trusted and canonical/)
  })

  it("refuses a self-consistent quote for another receiver against the payer's covenant", async () => {
    const { read } = reader({ quote: quoteFixture({ receiverKey: key(7) }) })
    await expect(read.resolve(request())).rejects.toThrow(/is not the verified quote's receive covenant/)
  })

  it('refuses a quote for a different asset', async () => {
    const { read } = reader({ quote: quoteFixture({ assetId: `${'cc'.repeat(32)}0100` }) })
    await expect(read.resolve(request())).rejects.toThrow(/substituted the asset/)
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

  it('re-reads a quote bound to the named fill, and refuses one bound elsewhere or still quoted', async () => {
    const bound = (boundFillId: string) => ({ ...quoteFixture({ state: 'bound' }), boundFillId })
    const fill = request({ boundFillId: 'fill-1' })
    await expect(reader({ quote: bound('fill-1') }).read.resolve(fill)).resolves.toMatchObject({ quoteId: 'q-1' })
    await expect(reader({ quote: bound('fill-2') }).read.resolve(fill)).rejects.toThrow(
      /q-1 is bound to fill-2, not bound to fill fill-1/,
    )
    await expect(reader().read.resolve(fill)).rejects.toThrow(/q-1 is quoted, not bound to fill fill-1/)
  })

  it('refuses a body answering under another quote id, on both entry points', async () => {
    const { read } = reader({ quote: quoteFixture({ quoteId: 'q-2' }) })
    await expect(read.resolve(request())).rejects.toThrow(/answered as q-2/)
    await expect(read.available(request())).rejects.toThrow(/answered as q-2/)
  })

  it('refuses a payout script that is not a taproot output, without asking Taxi', async () => {
    const getReceiveQuote = vi.fn(async () => quoteFixture() as never)
    const { read } = reader({ clientFor: () => taxiClient(async () => infoFixture(), getReceiveQuote) })
    await expect(read.resolve(request({ makerPkScript: '0014' + 'a'.repeat(40) }))).rejects.toThrow(/taproot/)
    expect(getReceiveQuote).not.toHaveBeenCalled()
  })

  it('refuses an asset id this chain cannot name, without asking Taxi', async () => {
    const getReceiveQuote = vi.fn(async () => quoteFixture() as never)
    const { read } = reader({ clientFor: () => taxiClient(async () => infoFixture(), getReceiveQuote) })
    await expect(read.resolve(request({ assetId: 'not-an-asset' }))).rejects.toThrow()
    expect(getReceiveQuote).not.toHaveBeenCalled()
  })
})

/** Ruling 3: the only new read off a named Taxi is `info.operatorKey`; `deps.trust` stays shared either way. */
describe('a request-named Taxi (Ruling 3)', () => {
  const NAMED = { url: 'https://other.example', operatorKey: hex.encode(OPERATOR_KEY) }

  it('resolves a request-named Taxi rather than the configured one', async () => {
    const seen: (string | undefined)[] = []
    const client = taxiClient()
    const { read } = reader({
      clientFor: (url) => {
        seen.push(url)
        return client
      },
    })
    await read.resolve(request({ taxi: NAMED }))
    expect(seen).toEqual([NAMED.url])
  })

  it('falls back to the configured Taxi when the request names none', async () => {
    const seen: (string | undefined)[] = []
    const client = taxiClient()
    const { read } = reader({
      clientFor: (url) => {
        seen.push(url)
        return client
      },
    })
    await read.resolve(request())
    expect(seen).toEqual([undefined])
  })

  it('refuses a Taxi whose info names a different operator key', async () => {
    const { read } = reader()
    await expect(read.resolve(request({ taxi: { url: NAMED.url, operatorKey: hex.encode(key(9)) } }))).rejects.toThrow(
      /operator key/,
    )
  })

  it('verifies against the running context, never the named Taxi', async () => {
    const { read } = reader({ info: infoFixture({ serverKey: key(9) }) })
    await expect(read.resolve(request({ taxi: NAMED }))).rejects.toThrow(/untrusted server/)
  })
})

/** Ruling 4: `taxiKey` is the VERIFIED `info.operatorKey`, never copied off the request. */
describe('the resolved quote carries the verified operator key (Ruling 4)', () => {
  it('sets taxiKey from info for a request-named Taxi', async () => {
    const { read } = reader()
    const quote = await read.resolve(
      request({ taxi: { url: 'https://other.example', operatorKey: hex.encode(OPERATOR_KEY) } }),
    )
    expect(quote.taxiKey).toBe(hex.encode(OPERATOR_KEY))
  })

  // Catches a "copied off the request" bug: no `request.taxi` here at all.
  it('sets taxiKey from info even when the request names no Taxi', async () => {
    const { read } = reader()
    const quote = await read.resolve(request())
    expect(quote.taxiKey).toBe(hex.encode(OPERATOR_KEY))
  })
})

/** Ruling 4 end to end: the REAL reader through `AssetRfqSwapService.quote()`. */
describe('a recycle_receiver RFQ through the real reader (Ruling 4)', () => {
  const harness = async (read: Pick<ReceiveCarrierQuotes, 'resolve' | 'available'>) => {
    const store = await AssetRfqSwapStore.open(':memory:')
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
      quoteValiditySeconds: VALIDITY_SECONDS,
      dustSats: DUST,
      // The fixture's own clock scale, matching `request()`'s default `now`.
      now: () => 2_000,
      fetchPrice: async () => ({ mantissa: 100_000n, scale: 0 }),
      deriveOffer: () => ({ pkScript: `5120${'d'.repeat(64)}`, address: 'ark1qoffer' }),
      depositAt: async () => null,
      balance: async () => new Map([[ASSET, 10n ** 18n]]),
      settle: async () => 'fa'.repeat(32),
      newId: () => 'swap-1',
      // COMPLETE: a half-adapter is refused before it prices anything (above).
      receiveCarrierQuotes: {
        ...read,
        settle: async () => {
          throw new Error('not exercised by a quote-only test')
        },
        reconcile: async () => {
          throw new Error('not exercised by a quote-only test')
        },
      },
    }
    return new AssetRfqSwapService(deps)
  }

  const rfqRequest = (over: Record<string, unknown> = {}) => ({
    rfqId: 'a'.repeat(64),
    pair: `arkade:BTC->arkade:${ASSET}`,
    amount: 100_000_000n,
    amountSide: 'from' as const,
    makerPkScript: covenantScriptOf(receiverPaidQuote()),
    makerPublicKey: hex.encode(MAKER_KEY),
    carrier: {
      mode: 'recycle_receiver' as const,
      quoteId: 'q-1',
      taxiUrl: 'https://taxi.example',
      taxiKey: hex.encode(OPERATOR_KEY),
    },
    ...over,
  })

  /** The whole dust as loan, no receipt, no fare. */
  const receiverPaidQuote = () => quoteFixture({ topup: DUST, fareUnits: '0', payer: 'receiver' })

  it('carries the verified receiver fare, so the orchestrator can weigh it against the delivery', async () => {
    const { read } = reader({ quote: receiverPaidQuote(), info: infoFixture({ fareUnits: '0' }) })
    const quote = await read.resolve(
      request({ makerPkScript: covenantScriptOf(receiverPaidQuote()), receiverPaid: true }),
    )
    expect(quote.receiverFare).toEqual({ currency: 'sats', units: 0n })
    expect(await reader().read.resolve(request())).not.toHaveProperty('receiverFare')
  })

  it('accepts a receiver-paid quote, priced at zero with carrier_sats absent', async () => {
    const { read } = reader({
      quote: receiverPaidQuote(),
      info: infoFixture({ fareUnits: '0' }),
      coins: async () => [coin({ txid: 'c'.repeat(64), assets: [{ assetId: ASSET, amount: 10n ** 18n }] })],
    })
    const service = await harness(read)
    const outcome = await service.quote(rfqRequest())
    expect(outcome).toMatchObject({ accepted: true, carrierSats: 0n })
    if (!outcome.accepted) throw new Error('expected acceptance')
    expect(assetRfqQuotePayload(outcome.swap, 'a'.repeat(64), outcome.carrierSats)).not.toHaveProperty('carrier_sats')
  })

  it('refuses a request naming a taxi key the Taxi does not answer to', async () => {
    const { read } = reader()
    const service = await harness(read)
    const outcome = await service.quote(
      rfqRequest({
        carrier: {
          mode: 'recycle_receiver',
          quoteId: 'q-1',
          taxiUrl: 'https://taxi.example',
          taxiKey: hex.encode(key(9)),
        },
      }),
    )
    expect(outcome).toMatchObject({ accepted: false, reason: 'price_unavailable' })
  })
})

/** The RFQ names no fare, and without an id the client checks the Taxi's first-listed one. */
describe('a receiver-paid quote is checked against the fare it was priced at', () => {
  const FARES = [
    { id: 'cheap', currency: 'sats', pricing: { kind: 'flat', units: '7' } },
    { id: 'fast', currency: 'sats', pricing: { kind: 'flat', units: '9' } },
    { id: 'share', currency: 'sats', pricing: { kind: 'proportional', bps: 100, minUnits: '1', maxUnits: null } },
    { id: 'in-kind', currency: 'sameAsset', pricing: { kind: 'flat', units: '50' } },
  ]
  const resolveAt = (receiverFare: { currency: 'sats' | 'asset'; units: bigint }) => {
    const quote = quoteFixture({ topup: DUST, fareUnits: '0', payer: 'receiver', receiverFare })
    const { read } = reader({ quote, info: infoFixture({ fares: FARES }) })
    return read.resolve(request({ makerPkScript: covenantScriptOf(quote), receiverPaid: true }))
  }

  it.each([
    ['a later flat fare', { currency: 'sats', units: 9n }],
    ['a proportional fare, 1% of the whole-dust loan', { currency: 'sats', units: 3n }],
    ['a fare in the delivered asset', { currency: 'asset', units: 50n }],
  ] as const)('verifies a quote priced at %s', async (_why, receiverFare) => {
    await expect(resolveAt(receiverFare)).resolves.toMatchObject({ receiverFare })
  })

  it.each([
    ['sats units no fare prices', { currency: 'sats', units: 8n }],
    ['asset units only a sats fare prices', { currency: 'asset', units: 7n }],
  ] as const)('refuses a quote at %s', async (_why, receiverFare) => {
    await expect(resolveAt(receiverFare)).rejects.toThrow(/q-1 is priced at no fare the Taxi advertises/)
  })
})

describe('the per-URL client cache', () => {
  const POLICY: TaxiUrlPolicy = { isMainnet: false, allowPrivate: true }

  it('reuses one client across repeated calls to the same URL', () => {
    const clientFor = taxiClientCache({ policy: POLICY })
    const first = clientFor('https://taxi.example')
    for (let i = 0; i < 4; i++) expect(clientFor('https://taxi.example')).toBe(first)
  })

  it('shares one client across case and trailing-dot variants of the same host', () => {
    const clientFor = taxiClientCache({ policy: POLICY })
    expect(clientFor('https://Taxi.example')).toBe(clientFor('https://taxi.example.'))
  })

  it('bounds the cache at 32 entries, evicting the oldest first', () => {
    const clientFor = taxiClientCache({ policy: POLICY })
    const first = clientFor('https://taxi-0.example')
    for (let i = 1; i < 40; i++) clientFor(`https://taxi-${i}.example`)
    expect(clientFor('https://taxi-0.example')).not.toBe(first)
    const last = clientFor('https://taxi-39.example')
    expect(clientFor('https://taxi-39.example')).toBe(last)
  })

  it('gives fill-time requests their own bounded budget per host, which quote traffic cannot spend', async () => {
    let reached = 0
    const clientFor = taxiClientCache({
      policy: POLICY,
      fetch: async () => {
        reached += 1
        return new Response(JSON.stringify(infoFixture()), { status: 200 })
      },
    })
    const spend = async (budget: 'quote' | 'fill', times: number) => {
      for (let i = 0; i < times; i++)
        await clientFor('https://taxi.example', budget)
          .info()
          .catch(() => undefined)
    }
    await spend('quote', TAXI_QUOTE_RATE_LIMIT + 5)
    expect(reached).toBe(TAXI_QUOTE_RATE_LIMIT)
    await spend('fill', TAXI_FILL_RATE_LIMIT + 5)
    expect(reached).toBe(TAXI_QUOTE_RATE_LIMIT + TAXI_FILL_RATE_LIMIT)
  })

  it('caps quote reads across every host, so fresh subdomains cannot outrun it, and leaves fills their own budget', async () => {
    let reached = 0
    const clientFor = taxiClientCache({
      policy: POLICY,
      fetch: async () => {
        reached += 1
        return new Response(JSON.stringify(infoFixture()), { status: 200 })
      },
    })
    for (let i = 0; i < TAXI_QUOTE_GLOBAL_RATE_LIMIT; i++) await clientFor(`https://t${i}.taxi.example`, 'quote').info()
    expect(reached).toBe(TAXI_QUOTE_GLOBAL_RATE_LIMIT)

    await expect(clientFor('https://fresh.taxi.example', 'quote').info()).rejects.toMatchObject({
      cause: { message: 'taxi quote reads are rate-limited across every host' },
    })
    expect(reached).toBe(TAXI_QUOTE_GLOBAL_RATE_LIMIT)
    await expect(clientFor('https://fresh.taxi.example', 'fill').info()).resolves.toBeDefined()
  })

  it('gives quote reads a shorter timeout than fill reads', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      const clientFor = taxiClientCache({
        policy: POLICY,
        fetch: async () => new Response(JSON.stringify(infoFixture()), { status: 200 }),
      })
      await clientFor('https://taxi.example', 'quote').info()
      expect(timeout).toHaveBeenLastCalledWith(TAXI_QUOTE_TIMEOUT_MS)
      await clientFor('https://taxi.example', 'fill').info()
      expect(timeout).toHaveBeenLastCalledWith(5_000)
      expect(TAXI_QUOTE_TIMEOUT_MS).toBeLessThan(5_000)
    } finally {
      timeout.mockRestore()
    }
  })

  it('still lets a fill read a named Taxi after a storm of quotes naming it has spent the quote budget', async () => {
    const fetchStub: typeof fetch = async (input) =>
      new Response(JSON.stringify(String(input).endsWith('/v1/info') ? infoFixture() : quoteFixture()), {
        status: 200,
      })
    const { read } = reader({ clientFor: taxiClientCache({ policy: POLICY, fetch: fetchStub }) })
    const named = { taxi: { url: 'https://taxi.example', operatorKey: hex.encode(OPERATOR_KEY) } }
    for (let i = 0; i < TAXI_QUOTE_RATE_LIMIT / 2; i++) await read.resolve(request({ ...named, admission: true }))
    await expect(read.resolve(request({ ...named, admission: true }))).rejects.toThrow()

    await expect(read.resolve(request(named))).resolves.toMatchObject({ quoteId: 'q-1' })
    await expect(read.available(request(named))).resolves.toBeInstanceOf(Map)
  })

  it('falls back to the configured Taxi for a request naming none, and refuses when none is configured', () => {
    const configured = taxiClientCache({ configuredUrl: 'https://configured.example', policy: POLICY })
    const first = configured(undefined)
    expect(configured(undefined)).toBe(first)
    expect(configured('https://other.example')).not.toBe(first)

    const unconfigured = taxiClientCache({ policy: POLICY })
    expect(() => unconfigured(undefined)).toThrow(/no receive-carrier Taxi is configured/)
  })

  it('bounds reads from the configured Taxi too', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const fetchStub: typeof fetch = async () => new Response(null, { status: 302, headers: { location: '/elsewhere' } })
    try {
      const clientFor = taxiClientCache({
        configuredUrl: 'https://configured.example',
        policy: POLICY,
        fetch: fetchStub,
      })
      await expect(clientFor().info()).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/response was a redirect/) },
      })
      expect(timeout).toHaveBeenLastCalledWith(5_000)
    } finally {
      timeout.mockRestore()
    }
  })
})

/** G4: the composed reader exists whether or not `TAXI_URL` is configured. */
describe('composing the receive-carrier reader is independent of TAXI_URL (G4)', () => {
  const POLICY: TaxiUrlPolicy = { isMainnet: false, allowPrivate: true }

  const composition = (over: Partial<TaxiCarrierComposition> = {}): TaxiCarrierComposition => ({
    trust: async () => TRUST,
    maxServiceFareSats: 10n,
    contracts: async () => ({ getContractsWithVtxos: async () => [] }),
    reserved: () => new Set<string>(),
    quoteValiditySeconds: VALIDITY_SECONDS,
    tipHeight: async () => TIP,
    policy: POLICY,
    ...over,
  })

  it('always returns a reader, even with no TAXI_URL configured', async () => {
    expect(await taxiReceiveCarrier(composition({ taxiUrl: undefined }))).toBeDefined()
  })

  it('refuses a request naming no Taxi when none is configured', async () => {
    const read = await taxiReceiveCarrier(composition({ taxiUrl: undefined }))
    await expect(read.resolve(request())).rejects.toThrow(/no receive-carrier Taxi is configured/)
    await expect(read.available(request())).rejects.toThrow(/no receive-carrier Taxi is configured/)
  })

  it('resolves a request-named Taxi even with no TAXI_URL configured', async () => {
    const calls: string[] = []
    const fetchStub: typeof fetch = async (input) => {
      calls.push(String(input))
      throw new Error('reached the network')
    }
    const read = await taxiReceiveCarrier(composition({ taxiUrl: undefined, fetch: fetchStub }))
    await expect(
      read.resolve(request({ taxi: { url: 'https://other.example', operatorKey: hex.encode(OPERATOR_KEY) } })),
    ).rejects.toThrow()
    expect(calls[0]).toBe('https://other.example/v1/info')
  })

  it('never guards the configured Taxi: a mainnet policy does not gate it (G3)', async () => {
    const calls: string[] = []
    const fetchStub: typeof fetch = async (input) => {
      calls.push(String(input))
      throw new Error('reached the network')
    }
    const read = await taxiReceiveCarrier(
      composition({
        taxiUrl: 'http://127.0.0.1:9',
        policy: { isMainnet: true, allowPrivate: false },
        fetch: fetchStub,
      }),
    )
    await expect(read.resolve(request())).rejects.toThrow(/could not be sent/)
    expect(calls[0]).toBe('http://127.0.0.1:9/v1/info')
  })
})

/** `recovery < floor <= batch` is an ORDERING: `recovery=1 / floor=2` satisfies
 * it and admits a coin expiring next block. */
describe('the input expiry floor is anchored, not merely ordered', () => {
  it('refuses a floor that clears the tip by less than one exit delay', async () => {
    const { read } = reader({
      quote: quoteFixture({ recovery: 1n, floor: 2n, batch: BigInt(TIP) + 100n }),
    })
    await expect(read.resolve(request())).rejects.toThrow(/input expiry floor is below the caller minimum/)
  })

  it('admits a floor exactly one exit delay past the tip', async () => {
    const floor = BigInt(TIP) + EXIT_DELAY
    const { read, request } = reader({ quote: quoteFixture({ recovery: floor - 1n, floor, batch: floor }) })
    await expect(read.resolve(request())).resolves.toMatchObject({
      inputExpiryFloor: { kind: 'height', value: floor },
    })
  })

  it('refuses the same floor one short of that, on both entry points', async () => {
    const floor = BigInt(TIP) + EXIT_DELAY - 1n
    const { read } = reader({ quote: quoteFixture({ recovery: floor - 1n, floor, batch: floor }) })
    await expect(read.resolve(request())).rejects.toThrow(/below the caller minimum/)
    await expect(read.available(request())).rejects.toThrow(/below the caller minimum/)
  })

  it('anchors a seconds-typed deployment on the request clock, with no tip to read', async () => {
    const now = 1_700_000_000
    const floor = BigInt(now) + EXIT_DELAY
    const { read, request } = reader({
      trust: { ...TRUST, locktimeDomain: 'time' },
      tipHeight: undefined,
      quote: quoteFixture({ domain: 'time', recovery: floor - 1n, floor, batch: floor, expiresAt: now + 100 }),
    })
    await expect(read.resolve(request({ now }))).resolves.toMatchObject({
      inputExpiryFloor: { kind: 'time', value: floor },
    })
    await expect(read.resolve(request({ now: now + 1 }))).rejects.toThrow(/below the caller minimum/)
  })

  it('follows a block mined inside the shared tip cache window, so the floor never trails the chain', async () => {
    let height = TIP
    const client = { getText: async () => String(height) } as unknown as EsploraClient
    // The hazard, demonstrated first: the shared reader still answers the
    // pre-mine height, and a floor computed from it sits behind the chain.
    const shared = esploraChainTip(client, { now: () => 0 })
    expect(await shared.height()).toBe(TIP)

    const floor = BigInt(TIP) + EXIT_DELAY
    const tip = carrierChainTip(client)
    const { read, request } = reader({
      tipHeight: tip.height,
      quote: quoteFixture({ recovery: floor - 1n, floor, batch: floor }),
    })
    await expect(read.resolve(request())).resolves.toMatchObject({ inputExpiryFloor: { value: floor } })

    height = TIP + 1
    expect(await shared.height()).toBe(TIP)
    await expect(read.resolve(request())).rejects.toThrow(/below the caller minimum/)
  })

  it('refuses to build a height-typed reader with no tip to anchor on', () => {
    expect(() =>
      createTaxiReceiveCarrierReader({
        clientFor: () => taxiClient(),
        trust: TRUST,
        maxServiceFareSats: 10n,
        coins: async () => [],
        reserved: () => new Set<string>(),
        quoteValiditySeconds: VALIDITY_SECONDS,
      }),
    ).toThrow(/chain tip/)
  })
})

describe('admission demands the slack the quote can outlive', () => {
  it('refuses at admission the height-domain floor one mined block would strand', async () => {
    let height = TIP
    const floor = BigInt(TIP) + EXIT_DELAY
    const { read, request } = reader({
      tipHeight: async () => height,
      quote: quoteFixture({ recovery: floor - 1n, floor, batch: floor }),
    })

    await expect(read.resolve(request({ admission: true }))).rejects.toThrow(/below the caller minimum/)

    await expect(read.resolve(request())).resolves.toMatchObject({ inputExpiryFloor: { value: floor } })
    height = TIP + 1
    await expect(read.available(request())).rejects.toThrow(/below the caller minimum/)
  })

  const tightestAdmissible = () => BigInt(TIP) + EXIT_DELAY + carrierAdmissionSlack('height', VALIDITY_SECONDS)

  it('admits no floor that two blocks mined inside the window would strand', async () => {
    let height = TIP
    const floor = tightestAdmissible()
    const { read, request } = reader({
      tipHeight: async () => height,
      quote: quoteFixture({ recovery: floor - 1n, floor, batch: floor }),
    })

    await expect(read.resolve(request({ admission: true }))).resolves.toMatchObject({
      inputExpiryFloor: { value: floor },
    })
    height = TIP + 2
    await expect(read.available(request())).resolves.toEqual(new Map([[null, 0n]]))
  })

  it('sizes the height slack for a fast-block network, not a ten-minute one', () => {
    expect(carrierAdmissionSlack('height', 30)).toBe(8n)
    expect(carrierAdmissionSlack('height', 300)).toBe(26n)
    expect(carrierAdmissionSlack('height', 900)).toBe(66n)
    expect(carrierAdmissionSlack('time', 30)).toBe(60n)
  })

  it('admits one with the window’s slack, and it still fills a block later', async () => {
    let height = TIP
    const floor = BigInt(TIP) + EXIT_DELAY + carrierAdmissionSlack('height', VALIDITY_SECONDS)
    const { read, request } = reader({
      tipHeight: async () => height,
      quote: quoteFixture({ recovery: floor - 1n, floor, batch: floor }),
    })

    await expect(read.resolve(request({ admission: true }))).resolves.toMatchObject({
      inputExpiryFloor: { value: floor },
    })
    height = TIP + 1
    await expect(read.available(request())).resolves.toEqual(new Map([[null, 0n]]))
  })

  it('raises a seconds-typed admission past the validity window and fill margin', async () => {
    const now = 1_700_000_000
    const short = BigInt(now) + EXIT_DELAY
    const trust = { ...TRUST, locktimeDomain: 'time' as const }
    const seconds = (floor: bigint) =>
      quoteFixture({ domain: 'time', recovery: floor - 1n, floor, batch: floor, expiresAt: now + 1_000 })

    const { read: tight, request: tightRequest } = reader({ trust, tipHeight: undefined, quote: seconds(short) })
    await expect(tight.resolve(tightRequest({ now, admission: true }))).rejects.toThrow(/below the caller minimum/)

    const tooTight = short + BigInt(VALIDITY_SECONDS)
    const { read: unsafe, request: unsafeRequest } = reader({ trust, tipHeight: undefined, quote: seconds(tooTight) })
    await expect(unsafe.resolve(unsafeRequest({ now, admission: true }))).rejects.toThrow(/below the caller minimum/)

    const roomy = short + carrierAdmissionSlack('time', VALIDITY_SECONDS)
    const { read, request: roomyRequest } = reader({ trust, tipHeight: undefined, quote: seconds(roomy) })
    await expect(read.resolve(roomyRequest({ now, admission: true }))).resolves.toMatchObject({
      inputExpiryFloor: { kind: 'time', value: roomy },
    })
    await expect(read.available(roomyRequest({ now: now + VALIDITY_SECONDS }))).resolves.toEqual(new Map([[null, 0n]]))
    await expect(
      read.available(roomyRequest({ now: now + VALIDITY_SECONDS + CARRIER_FILL_MARGIN_SECONDS })),
    ).resolves.toEqual(new Map([[null, 0n]]))
  })

  it('leaves the fill-time reads at the exact anchored floor', async () => {
    const floor = BigInt(TIP) + EXIT_DELAY
    const { read, request } = reader({ quote: quoteFixture({ recovery: floor - 1n, floor, batch: floor }) })
    await expect(read.resolve(request())).resolves.toMatchObject({ inputExpiryFloor: { value: floor } })
    await expect(read.available(request())).resolves.toEqual(new Map([[null, 0n]]))
  })
})

describe('inventory against the quote’s own input expiry floor', () => {
  it('reads the reservation ledger after the coin read, not before it', async () => {
    // A pin taken while the coin read was in flight is still a pin.
    const pinned = new Set<string>()
    const { read } = reader({
      coins: async () => {
        pinned.add(`${'a'.repeat(64)}:0`)
        return [coin({ txid: 'a'.repeat(64), assets: [{ assetId: ASSET, amount: 9n }] })]
      },
      // A fresh copy per read, as the real ledger answers: a shared Set would
      // let an early read pick up the later mutation and pass either way.
      reserved: () => new Set(pinned),
    })
    expect(await read.available(request())).toEqual(new Map([[null, 0n]]))
  })

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
