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
import { esploraChainTip } from '@arkade-os/solver-rails/onchain/chainTip.js'
import type { EsploraClient } from '@arkade-os/solver-rails-esplora/esplora.js'
import {
  carrierAdmissionSlack,
  carrierChainTip,
  createTaxiReceiveCarrierReader,
  spendableCarrierCoins,
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

const MAKER_PK_SCRIPT = hex.encode(new ArkAddress(SERVER_KEY, PAYOUT_KEY, HRP).pkScript)
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
  const client = taxiClient(
    async () => over.info ?? infoFixture(),
    async (id) => {
      asked.push(id)
      return over.quote ?? quoteFixture()
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

  it('falls back to the configured Taxi for a request naming none, and refuses when none is configured', () => {
    const configured = taxiClientCache({ configuredUrl: 'https://configured.example', policy: POLICY })
    const first = configured(undefined)
    expect(configured(undefined)).toBe(first)
    expect(configured('https://other.example')).not.toBe(first)

    const unconfigured = taxiClientCache({ policy: POLICY })
    expect(() => unconfigured(undefined)).toThrow(/no receive-carrier Taxi is configured/)
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
    const { read } = reader({ quote: quoteFixture({ recovery: floor - 1n, floor, batch: floor }) })
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
    const { read } = reader({
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
    const { read } = reader({
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
    const { read } = reader({
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
    const { read } = reader({
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
    expect(carrierAdmissionSlack('time', 30)).toBe(30n)
  })

  it('admits one with the window’s slack, and it still fills a block later', async () => {
    let height = TIP
    const floor = BigInt(TIP) + EXIT_DELAY + carrierAdmissionSlack('height', VALIDITY_SECONDS)
    const { read } = reader({
      tipHeight: async () => height,
      quote: quoteFixture({ recovery: floor - 1n, floor, batch: floor }),
    })

    await expect(read.resolve(request({ admission: true }))).resolves.toMatchObject({
      inputExpiryFloor: { value: floor },
    })
    height = TIP + 1
    await expect(read.available(request())).resolves.toEqual(new Map([[null, 0n]]))
  })

  it('raises a seconds-typed admission by the whole validity window', async () => {
    const now = 1_700_000_000
    const short = BigInt(now) + EXIT_DELAY
    const trust = { ...TRUST, locktimeDomain: 'time' as const }
    const seconds = (floor: bigint) =>
      quoteFixture({ domain: 'time', recovery: floor - 1n, floor, batch: floor, expiresAt: now + 1_000 })

    const { read: tight } = reader({ trust, tipHeight: undefined, quote: seconds(short) })
    await expect(tight.resolve(request({ now, admission: true }))).rejects.toThrow(/below the caller minimum/)

    const roomy = short + BigInt(VALIDITY_SECONDS)
    const { read } = reader({ trust, tipHeight: undefined, quote: seconds(roomy) })
    await expect(read.resolve(request({ now, admission: true }))).resolves.toMatchObject({
      inputExpiryFloor: { kind: 'time', value: roomy },
    })
    await expect(read.available(request({ now: now + VALIDITY_SECONDS }))).resolves.toEqual(new Map([[null, 0n]]))
  })

  it('leaves the fill-time reads at the exact anchored floor', async () => {
    const floor = BigInt(TIP) + EXIT_DELAY
    const { read } = reader({ quote: quoteFixture({ recovery: floor - 1n, floor, batch: floor }) })
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
