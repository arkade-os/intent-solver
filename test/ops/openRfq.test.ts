import { describe, expect, it, vi } from 'vitest'
import { openRfqPairs, openRfqPreview } from '@arkade-os/solver-app/ops/openRfq.js'
import { deploymentCard, evmCardMarketsOf, type CardSource } from '@arkade-os/solver-app/admin/routes/card.js'
import { validateCard, cardErrors } from '@arkade-os/solver-discovery'
import type { Services } from '@arkade-os/solver-app/ops/services.js'
import {
  buildSolverCard,
  publishableEvmMarkets,
  signSolverCard,
  type EvmCardMarket,
} from '@arkade-os/solver-core/core/registryCard.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { giveSatsFor, payoutSatsFor } from '@arkade-os/solver-core/core/corridorPolicy.js'
import type { OpenRfqV2 } from '@arkade-os/solver-core/core/openRfqV2.js'

const asset = 'ab'.repeat(34)
const btc = 'arkade:bitcoin/slip44:0'
const token = { address: `0x${'ab'.repeat(20)}`, symbol: 'USDC', decimals: 6 }
const fee = { bps: 30, flatSats: 50 }
const bounds = { minSats: 1000, maxSats: 100000 }
const evmPolicies = [
  { corridor: `arkade:BTC->ethereum:${token.address}`, token, direction: 'send', enabled: true, limits: bounds, fee },
  {
    corridor: `ethereum:${token.address}->arkade:BTC`,
    token,
    direction: 'receive',
    enabled: true,
    limits: bounds,
    fee,
  },
]
const open = (pair: string, amount: string, amount_side: 'from' | 'to' = 'from'): OpenRfqV2 => ({
  v: 2,
  type: 'rfq_open',
  open_id: 'cd'.repeat(32),
  pair,
  amount,
  amount_side,
  bids_until: 1800000005,
})
const source = () => ({
  config: {
    network: 'bitcoin',
    evmChain: { chainId: 1 },
    evmMarkets: [{ token, priceFeed: 'https://prices.example/btc', pricePath: '/price' }],
  },
  bootPolicy: {
    evmCorridors: evmPolicies,
    corridorFees: { 'arkade:BTC->lightning:BTC': fee, 'lightning:BTC->arkade:BTC': fee },
    corridorLimits: { 'arkade:BTC->lightning:BTC': bounds, 'lightning:BTC->arkade:BTC': bounds },
  },
  policy: { evmCorridors: evmPolicies },
  corridors: { get: vi.fn(() => ({})) },
  assetRfqMarkets: [
    {
      base: asset,
      quote: null,
      baseDecimals: 18,
      quoteDecimals: 8,
      feeBps: 0,
      symbol: 'TOKEN',
      sellBase: { min: 1n, max: 100000000n },
      buyBase: { min: 1n, max: 10n ** 30n - 1n },
      carrierSats: 0n,
      feedUrl: 'https://prices.example/token',
      pricePath: '/price',
    },
  ],
  arkade: { dustSats: 1n },
  assetRfqService: { quote: vi.fn() },
})

describe('public price previews', () => {
  it('prices an asset amount beyond double precision without reserving or opening a swap', async () => {
    const services = source()
    const preview = openRfqPreview(services as unknown as Services, {
      fetchPrice: async () => ({ mantissa: 5n, scale: 1 }),
      now: () => 1800000000,
    })
    const listed = buildSolverCard({
      name: 'asset-solver',
      network: 'bitcoin',
      discoveryPubkey: 'ab'.repeat(32),
      relays: ['wss://relay.example'],
      corridors: {},
      assetMarkets: services.assetRfqMarkets,
    })
    expect(validateCard(listed).ok).toBe(true)
    expect(await preview(open(`${btc}~arkade:bitcoin/asset:${asset}`, '100000000'))).toEqual({
      from_amount: '100000000',
      to_amount: '2000000000000000000',
      valid_until: 1800000035,
    })
    expect(services.assetRfqService.quote).not.toHaveBeenCalled()
  })

  it('uses real fee inversion and each BTC corridor bound side', async () => {
    const preview = openRfqPreview(source() as unknown as Services, { now: () => 1800000000 })
    expect(await preview(open(`${btc}~bolt11:bitcoin/slip44:0`, '1000', 'to'))).toMatchObject({
      from_amount: String(giveSatsFor(1000, fee)),
      to_amount: '1000',
    })
    expect(await preview(open(`bolt11:bitcoin/slip44:0~${btc}`, '1000'))).toMatchObject({
      from_amount: '1000',
      to_amount: String(payoutSatsFor(1000, fee)),
    })
    expect(await preview(open(`${btc}~bolt11:bitcoin/slip44:0`, '1000'))).toBeUndefined()
  })

  it('matches directed asset fees and the priced carrier on both amount sides', async () => {
    const base = source()
    const services = {
      ...base,
      arkade: { dustSats: 330n },
      assetRfqMarkets: [
        {
          ...base.assetRfqMarkets[0]!,
          base: null,
          quote: asset,
          baseDecimals: 8,
          quoteDecimals: 2,
          feeBps: 30,
          carrierSats: 330n,
          sellBase: { min: 1n, max: 100000000n },
          buyBase: { min: 1n, max: 100000000n },
        },
      ],
    }
    const preview = openRfqPreview(services as unknown as Services, {
      fetchPrice: async () => ({ mantissa: 100000n, scale: 0 }),
      now: () => 1800000000,
    })
    const tokenId = `arkade:bitcoin/asset:${asset}`
    expect(await preview(open(`${btc}~${tokenId}`, '25000'))).toMatchObject({ from_amount: '25000', to_amount: '2459' })
    expect(await preview(open(`${btc}~${tokenId}`, '2459', 'to'))).toMatchObject({
      from_amount: '25000',
      to_amount: '2459',
    })
    expect(await preview(open(`${tokenId}~${btc}`, '2492'))).toMatchObject({ from_amount: '2492', to_amount: '25175' })
    expect(await preview(open(`${tokenId}~${btc}`, '25175', 'to'))).toMatchObject({
      from_amount: '2492',
      to_amount: '25175',
    })
  })

  it('prices both EVM exact-in directions using their own native units', async () => {
    const preview = openRfqPreview(source() as unknown as Services, {
      fetchPrice: async () => ({ mantissa: 100000n, scale: 0 }),
      now: () => 1800000000,
    })
    const evm = `eip155:1/erc20:${token.address}`
    expect(await preview(open(`${btc}~${evm}`, '10000'))).toMatchObject({ from_amount: '10000', to_amount: '9920000' })
    expect(await preview(open(`${evm}~${btc}`, '10000000'))).toMatchObject({
      from_amount: '10000000',
      to_amount: '9920',
    })
    expect(await preview(open(`${btc}~${evm}`, '10000000', 'to'))).toBeUndefined()
  })

  it('honors the current serve list before feeds and after asynchronous pricing', async () => {
    const services = source()
    const fetchPrice = vi.fn(async () => {
      services.corridors.get.mockReturnValue(undefined as never)
      return { mantissa: 2n, scale: 0 }
    })
    const preview = openRfqPreview(services as unknown as Services, { fetchPrice })
    expect(await preview(open(`${btc}~arkade:bitcoin/asset:${asset}`, '100000000'))).toBeUndefined()
    expect(await preview(open(`${btc}~arkade:bitcoin/asset:${asset}`, '100000000'))).toBeUndefined()
    expect(fetchPrice).toHaveBeenCalledOnce()
  })

  it('prices boot EVM terms when unrelated live settings expose pending fee or limit overrides', async () => {
    const services = source()
    services.policy = {
      evmCorridors: evmPolicies.map((policy) => ({
        ...policy,
        fee: { bps: 0, flatSats: 0 },
        limits: { minSats: 1, maxSats: 1000000 },
      })),
    }
    const preview = openRfqPreview(services as unknown as Services, {
      fetchPrice: async () => ({ mantissa: 100000n, scale: 0 }),
      now: () => 1800000000,
    })
    expect(evmCardMarketsOf(services as unknown as CardSource).publishable[0]?.send?.fee).toEqual(fee)
    expect(await preview(open(`${btc}~eip155:1/erc20:${token.address}`, '10000'))).toMatchObject({
      to_amount: '9920000',
    })
    expect(await preview(open(`${btc}~eip155:1/erc20:${token.address}`, '200000'))).toBeUndefined()
    services.policy.evmCorridors = []
    expect(await preview(open(`${btc}~eip155:1/erc20:${token.address}`, '10000'))).toBeUndefined()
  })

  it('leaves time to choose when collection uses the entire thirty-second window', async () => {
    const preview = openRfqPreview(source() as unknown as Services, { now: () => 1800000000 })
    expect(await preview({ ...open(`${btc}~bolt11:bitcoin/slip44:0`, '10000'), bids_until: 1800000030 })).toMatchObject(
      { valid_until: 1800000060 },
    )
  })
})

describe('EVM card discovery', () => {
  const evm: EvmCardMarket = {
    chainId: 1,
    token,
    priceFeed: 'https://prices.example/btc',
    pricePath: '/price',
    send: { limits: bounds, fee, tokenLimits: { minUnits: 1n, maxUnits: 100000000000n } },
    receive: { limits: bounds, fee: { bps: 20, flatSats: 0 } },
  }
  const card = (markets: EvmCardMarket[]) =>
    buildSolverCard({
      name: 'evm-solver',
      network: 'bitcoin',
      discoveryPubkey: bytesToHex(schnorr.getPublicKey(new Uint8Array(32).fill(1))),
      relays: ['wss://relay.example'],
      corridors: {},
      evmMarkets: markets,
    })

  it('advertises representable ERC20 markets in a v1 signed-card shape and canonical directional topics', async () => {
    const result = await signSolverCard(card([evm]), async (digest) => schnorr.sign(digest, new Uint8Array(32).fill(1)))
    expect(result.version).toBe(1)
    const checked = validateCard(result)
    expect(checked.ok).toBe(true)
    expect(cardErrors(result, 'bitcoin')).toEqual([])
    expect(result.markets[0]).toMatchObject({
      price_decimals: 2,
      quote_asset: { id: `eip155:1/erc20:${token.address}`, decimals: 6 },
      solver_fee: { base: { flat: '50', bps: 30 }, quote: { bps: 20 } },
    })
    expect(openRfqPairs(result)).toEqual([
      `${btc}~eip155:1/erc20:${token.address}`,
      `eip155:1/erc20:${token.address}~${btc}`,
    ])
  })

  it('keeps an executable send direction when the receive flat fee cannot be represented', () => {
    const result = publishableEvmMarkets([{ ...evm, receive: { limits: bounds, fee } }], 'bitcoin')
    expect(result.omitted).toHaveLength(1)
    expect(openRfqPairs(card(result.publishable))).toEqual([`${btc}~eip155:1/erc20:${token.address}`])
  })

  it('keeps the published card on v0 and includes EVM only in the requested inline variant', async () => {
    const base = source()
    const providerPubkey = bytesToHex(schnorr.getPublicKey(new Uint8Array(32).fill(1)))
    const services = {
      ...base,
      providerPubkey,
      assetMarkets: [],
      liveOfferMarkets: [],
      assetRfqMarkets: [],
      config: { ...base.config, solverName: 'evm-solver', relayUrl: 'wss://relay.example', cardRelays: [] },
      bootPolicy: {
        ...base.bootPolicy,
        corridorEnabled: { 'arkade:BTC->lightning:BTC': true },
        offerMinFillAmount: 1n,
        offerMaxFillAmount: 100000n,
      },
      arkade: {
        ...base.arkade,
        identity: { signMessage: async (digest: Uint8Array) => schnorr.sign(digest, new Uint8Array(32).fill(1)) },
      },
    } as unknown as CardSource
    const published = await deploymentCard(services)
    const inline = await deploymentCard(services, undefined, { includeEvm: true })
    expect(published.version).toBe(0)
    expect(published.markets).toHaveLength(1)
    expect(JSON.stringify(published)).not.toContain('eip155:')
    expect(inline.version).toBe(1)
    expect(inline.markets).toHaveLength(2)
    expect(cardErrors(inline, 'bitcoin')).toEqual([])
  })

  it('reports precision the card feed cannot express', () => {
    const result = publishableEvmMarkets([{ ...evm, token: { ...token, decimals: 18 } }], 'bitcoin')
    expect(result.publishable).toEqual([])
    expect(result.omitted[0]).toContain('decimals above 8')
  })
})
