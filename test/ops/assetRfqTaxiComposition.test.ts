/**
 * Turning the Taxi adapter on, and — the half that matters more — leaving it
 * off: an operator who sets no `TAXI_URL` must get the solver they had before
 * this existed. Asserted by watching every seam the composition is given and
 * requiring that none is touched, rather than by reading the code.
 */

import { describe, it, expect } from 'vitest'
import { ArkAddress } from '@arkade-os/sdk'
import { AssetRfqSwapStore } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import { AssetRfqSwapService, type AssetRfqDeps } from '@arkade-os/solver-corridors/asset/assetRfqOrchestrator.js'
import { createReservationLedger } from '@arkade-os/solver-arkade/arkade/reservations.js'
import type { CarrierAttemptRecord } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import {
  createCarrierPinLedger,
  decodeCarrierAttemptInputs,
  encodeCarrierAttemptInputs,
  restoreCarrierAttemptPins,
  taxiReceiveCarrier,
  type TaxiCarrierComposition,
  type TaxiCarrierTrust,
} from '@arkade-os/solver-app/ops/assetRfqTaxi.js'
import { completeTaxiReceiveCarrier } from '@arkade-os/solver-app/ops/assetRfqTaxiAdapter.js'
import { createServicesBody } from '../support/createServicesBody.js'

const ASSET = `${'aa'.repeat(31)}bb0100`
/** A real Arkade address, because the fill half decodes it to a pkScript. */
const PROCEEDS_ADDRESS = new ArkAddress(
  Uint8Array.from({ length: 32 }, () => 1),
  Uint8Array.from({ length: 32 }, () => 7),
  'tark',
).encode()
const MAKER_PK_SCRIPT = `5120${'c'.repeat(64)}`
const MAKER_KEY = 'b'.repeat(64)

const TRUST: TaxiCarrierTrust = {
  serverKey: Uint8Array.from({ length: 32 }, () => 1),
  emulatorKey: Uint8Array.from({ length: 32 }, () => 2),
  dustSats: 330n,
  vtxoMinAmount: 1n,
  hrp: 'tark',
  locktimeDomain: 'height',
  inputExpiryMargin: 5n,
}

const watched = (over: Partial<TaxiCarrierComposition> = {}) => {
  const touched: string[] = []
  const urls: string[] = []
  const deps: TaxiCarrierComposition = {
    trust: async () => {
      touched.push('trust')
      return TRUST
    },
    maxServiceFareSats: 330n,
    contracts: async () => {
      touched.push('contracts')
      return { getContractsWithVtxos: async () => [] }
    },
    reserved: () => {
      touched.push('reserved')
      return new Set<string>()
    },
    quoteValiditySeconds: 30,
    tipHeight: async () => {
      touched.push('tipHeight')
      return 1_000_000
    },
    fetch: (async (input: unknown) => {
      urls.push(String(input))
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch,
    ...over,
  }
  return { touched, urls, deps }
}

describe('an unconfigured solver composes no Taxi at all', () => {
  it('returns no adapter and touches not one seam', async () => {
    const { deps, touched, urls } = watched()
    expect(await taxiReceiveCarrier(deps)).toBeUndefined()
    // Not merely "no HTTP": no trust resolution either.
    expect(touched).toEqual([])
    expect(urls).toEqual([])
  })

  it('refuses a blank URL rather than turning the rail on pointed nowhere', async () => {
    for (const taxiUrl of ['', '   ']) {
      const { deps, touched } = watched({ taxiUrl })
      expect(await taxiReceiveCarrier(deps)).toBeUndefined()
      expect(touched).toEqual([])
    }
  })
})

describe('a configured solver is pointable by that URL alone', () => {
  it('reads the operator named by the knob, and no other host', async () => {
    const { deps, urls } = watched({ taxiUrl: 'http://taxi.example:7080' })
    const carrier = await taxiReceiveCarrier(deps)
    await expect(
      carrier!.resolve({
        quoteId: 'q-1',
        makerPkScript: MAKER_PK_SCRIPT,
        makerPublicKey: MAKER_KEY,
        assetId: ASSET,
        now: 2_000,
      }),
    ).rejects.toThrow()
    expect(urls.sort()).toEqual(['http://taxi.example:7080/v1/info', 'http://taxi.example:7080/v1/receive-quotes/q-1'])
  })

  it('resolves the trusted identity once, from the running context rather than the URL', async () => {
    const { deps, touched } = watched({ taxiUrl: 'http://taxi.example:7080' })
    await taxiReceiveCarrier(deps)
    expect(touched).toEqual(['trust'])
  })

  it('refuses to compose a height-typed deployment with no chain tip wired', async () => {
    const { deps } = watched({ taxiUrl: 'http://taxi.example:7080', tipHeight: undefined })
    await expect(taxiReceiveCarrier(deps)).rejects.toThrow(/chain tip/)
  })
})

describe('the composed adapter is refused, never degraded', () => {
  it('carries the read half only, so the completeness gate can see it is partial', async () => {
    const { deps } = watched({ taxiUrl: 'http://taxi.example:7080' })
    expect(Object.keys((await taxiReceiveCarrier(deps))!).sort()).toEqual(['available', 'resolve'])
  })

  it('carries all four once the fill half is composed over it', async () => {
    const { deps } = watched({ taxiUrl: 'http://taxi.example:7080' })
    const store = await AssetRfqSwapStore.open(':memory:', () => 1_000)

    const whole = completeTaxiReceiveCarrier((await taxiReceiveCarrier(deps))!, {
      taxiUrl: 'http://taxi.example:7080',
      store,
      chain: { getVtxos: async () => ({ vtxos: [] }), getVirtualTxs: async () => ({ txs: [] }) } as never,
      pins: createCarrierPinLedger(),
      coins: async () => [],
      reserved: () => new Set<string>(),
      reserve: () => () => {},
      wallet: {} as never,
      identity: {} as never,
      arkServerUrl: 'http://ark',
      dustSats: 330n,
      offerHex: () => 'abcd',
      proceedsAddress: PROCEEDS_ADDRESS,
      solverKeys: ['e'.repeat(64)],
      serverKey: () => TRUST.serverKey,
      now: () => 1_000,
    })

    expect(Object.keys(whole).sort()).toEqual(['available', 'reconcile', 'resolve', 'settle'])
    await store.close()
  })

  it('makes the real orchestrator refuse a recycle rather than price one', async () => {
    const { deps, urls } = watched({ taxiUrl: 'http://taxi.example:7080' })
    let clock = 1_000
    const store = await AssetRfqSwapStore.open(':memory:', () => clock)
    const orchestrator: AssetRfqDeps = {
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
      dustSats: 330n,
      now: () => clock,
      fetchPrice: async () => ({ mantissa: 100_000n, scale: 0 }),
      deriveOffer: () => ({ pkScript: `5120${'d'.repeat(64)}`, address: 'ark1qoffer' }),
      depositAt: async () => null,
      balance: async () => new Map([[ASSET, 10n ** 18n]]),
      settle: async () => 'fa'.repeat(32),
      newId: () => 'swap-1',
      receiveCarrierQuotes: await taxiReceiveCarrier(deps),
    }
    expect(
      await new AssetRfqSwapService(orchestrator).quote({
        rfqId: 'a'.repeat(64),
        pair: `arkade:BTC->arkade:${ASSET}`,
        amount: 100_000_000n,
        amountSide: 'from',
        makerPkScript: MAKER_PK_SCRIPT,
        makerPublicKey: MAKER_KEY,
        carrier: { mode: 'recycle', quoteId: 'q-1' },
      }),
    ).toMatchObject({ accepted: false, reason: 'price_unavailable' })
    // The refusal precedes the boundary: a degraded one would have asked.
    expect(urls).toEqual([])
    await store.close()
  })
})

describe('restoring the pins an unresolved attempt still owns', () => {
  const record = (id: string, inputs: unknown): CarrierAttemptRecord =>
    ({ row: { id }, attempt: { phase: 'prepared', snapshot: { inputs } } }) as unknown as CarrierAttemptRecord

  it('pins nothing when no attempt is outstanding', async () => {
    const ledger = createReservationLedger()
    const pins = createCarrierPinLedger()
    expect(await restoreCarrierAttemptPins({ attempts: async () => [], reserve: ledger.reserve, pins })).toHaveLength(0)
    expect(ledger.reserved().size).toBe(0)
    expect(pins.held()).toEqual([])
  })

  it('re-pins every outpoint an unresolved attempt named', async () => {
    const ledger = createReservationLedger()
    const pins = createCarrierPinLedger()
    const restored = await restoreCarrierAttemptPins({
      attempts: async () => [
        record('swap-1', [
          { txid: 'a'.repeat(64), vout: 0 },
          { txid: 'b'.repeat(64), vout: 3 },
        ]),
      ],
      reserve: ledger.reserve,
      pins,
    })
    expect(restored).toEqual(['swap-1'])
    expect([...ledger.reserved()].sort()).toEqual([`${'a'.repeat(64)}:0`, `${'b'.repeat(64)}:3`])
  })

  it('hands every release to the ledger, leaving none to drop', async () => {
    const ledger = createReservationLedger()
    const pins = createCarrierPinLedger()
    await restoreCarrierAttemptPins({
      attempts: async () => [record('swap-1', [{ txid: 'a'.repeat(64), vout: 0 }])],
      reserve: ledger.reserve,
      pins,
    })
    expect(pins.held()).toEqual(['swap-1'])
    for (const pin of pins.heldFor('swap-1')) pin.release()
    expect(ledger.reserved().size).toBe(0)
  })

  it('refuses to start on an attempt whose snapshot names no inputs', async () => {
    // Skipping would free a coin an in-flight fill may already have spent.
    const ledger = createReservationLedger()
    await expect(
      restoreCarrierAttemptPins({
        attempts: async () => [record('swap-2', undefined)],
        reserve: ledger.reserve,
        pins: createCarrierPinLedger(),
      }),
    ).rejects.toThrow(/swap-2/)
    expect(ledger.reserved().size).toBe(0)
  })

  it('refuses an outpoint that is not canonical rather than pinning the wrong coin', async () => {
    const ledger = createReservationLedger()
    await expect(
      restoreCarrierAttemptPins({
        attempts: async () => [record('swap-3', [{ txid: 'A'.repeat(64), vout: 0 }])],
        reserve: ledger.reserve,
        pins: createCarrierPinLedger(),
      }),
    ).rejects.toThrow(/swap-3/)
  })
})

/** The store treats the snapshot as opaque JSON, so a key chosen independently
 * at either end would brick boot with nothing to catch it. One codec, and a
 * round trip through the REAL store that fails if the two ends drift. */
describe('the snapshot input shape has one definition, exercised end to end', () => {
  const OUTPOINTS = [
    { txid: 'a'.repeat(64), vout: 0 },
    { txid: 'b'.repeat(64), vout: 7 },
  ]

  it('reads back exactly what it wrote', () => {
    expect(decodeCarrierAttemptInputs(encodeCarrierAttemptInputs(OUTPOINTS), 'swap-1')).toEqual(OUTPOINTS)
  })

  it('refuses to write an outpoint it would refuse to read', () => {
    expect(() => encodeCarrierAttemptInputs([{ txid: 'A'.repeat(64), vout: 0 }])).toThrow(/non-canonical/)
    expect(() => encodeCarrierAttemptInputs([])).toThrow(/names no inputs/)
  })

  it('survives the store the settle slice will write it through', async () => {
    let clock = 1_000
    const store = await AssetRfqSwapStore.open(':memory:', () => clock)
    await store.insertQuote({
      id: 'swap-1',
      rfqId: 'a'.repeat(64),
      pair: `arkade:BTC->arkade:${ASSET}`,
      fromAssetId: null,
      toAssetId: ASSET,
      fromAmount: 1_000n,
      toAmount: 10n,
      makerPkScript: MAKER_PK_SCRIPT,
      makerPublicKey: MAKER_KEY,
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
    await store.transition('swap-1', 'quoted', 'funded', {})
    await store.transition('swap-1', 'funded', 'filling', {})
    expect(
      await store.prepareCarrierAttempt('swap-1', { ...encodeCarrierAttemptInputs(OUTPOINTS), operation: 'op-1' }),
    ).toBe(true)

    const ledger = createReservationLedger()
    const restored = await restoreCarrierAttemptPins({
      attempts: () => store.listUnresolvedCarrierAttempts(),
      reserve: ledger.reserve,
      pins: createCarrierPinLedger(),
    })
    expect(restored).toEqual(['swap-1'])
    expect([...ledger.reserved()].sort()).toEqual([`${'a'.repeat(64)}:0`, `${'b'.repeat(64)}:7`])
    await store.close()
  })
})

/** Asserted against source for the reason `createServicesBody` gives. Only the
 * ORDER and the guard — both halves are exercised behaviourally above. */
describe('createServices reaches Taxi through exactly one guarded seam', () => {
  const body = () => createServicesBody()

  it('passes the knob straight through, and builds no client itself', () => {
    expect(body().match(/taxiReceiveCarrier\(/g)).toHaveLength(1)
    expect(body()).toContain('taxiUrl: config.taxiUrl')
    expect(body()).not.toContain('new TaxiClient(')
  })

  it('hands it to the RFQ service, which is the only thing that can reach it', () => {
    expect(body()).toContain('receiveCarrierQuotes: receiveCarrier')
  })

  it('completes the adapter only where the read half exists, on the SAME pin ledger', () => {
    const source = body()
    expect(source.match(/completeTaxiReceiveCarrier\(/g)).toHaveLength(1)
    expect(source).toMatch(/taxiCarrier === undefined[\s\S]{0,120}?\? undefined/)
    // Both halves resolve through one ledger, or a reconcile would free nothing.
    expect(source).toMatch(/completeTaxiReceiveCarrier\(taxiCarrier, \{[\s\S]{0,600}?pins: carrierPins,/)
  })

  it('pays a fill into an address this wallet owns, never one the quote names', () => {
    expect(body()).toContain('proceedsAddress: await arkade.wallet.getAddress()')
  })

  it('takes the trusted identity from the running context, never from the URL', () => {
    expect(body()).toContain('serverKey: arkade.wallet.arkServerPublicKey')
    expect(body()).toContain('emulatorKey: assetRfqDerivation.emulatorPubkey')
    expect(body()).toContain('inputExpiryMargin: BigInt(arkade.advertisedExitDelay)')
  })

  it('anchors the floor on the UNCACHED tip, never the reader the LN services share', () => {
    expect(body()).toContain('carrierChainTip(createEsploraClient(config.chainTipEsploraUrl)).height')
    expect(body()).not.toMatch(/tipHeight:[^\n]*\bchainTip\b/)
  })

  it('restores the pins before the service that ticks them exists', () => {
    const restore = 'await restoreCarrierAttemptPins('
    const service = 'new AssetRfqSwapService('
    expect(body()).toContain(restore)
    expect(body()).toContain(service)
    expect(body().indexOf(restore)).toBeLessThan(body().indexOf(service))
  })

  it('gates the restore on rows found, never on the knob', () => {
    // An operator who unsets `TAXI_URL` with an attempt outstanding still owes
    // its coins. The store is already open, so a never-configured solver pays
    // one SELECT that returns nothing.
    const source = body()
    expect(source.match(/restoreCarrierAttemptPins\(/g)).toHaveLength(1)
    expect(source).not.toMatch(/if \(taxiCarrier[^\n]*\n[\s\S]{0,400}?restoreCarrierAttemptPins\(/)
    expect(source).toContain('attempts: () => assetRfqStore.listUnresolvedCarrierAttempts()')
  })

  it('hands the restored releases to a ledger instead of dropping them', () => {
    const source = body()
    expect(source).toContain('const carrierPins = createCarrierPinLedger()')
    expect(source).toContain('pins: carrierPins')
    expect(source.indexOf('createCarrierPinLedger()')).toBeLessThan(source.indexOf('restoreCarrierAttemptPins('))
  })
})
