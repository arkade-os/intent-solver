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
import { giveSatsFor, payoutSatsFor, type Fee } from '@arkade-os/solver-core/core/corridorPolicy.js'
import { SendSwapService } from '@arkade-os/solver-corridors/send/orchestrator.js'
import { OnchainSendSwapService } from '@arkade-os/solver-corridors/send/onchainOrchestrator.js'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import type { OpenRfq } from '@arkade-os/solver-core/core/openRfq.js'
import {
  RFQ_ASSET_SWAP_DIRECTED,
  RFQ_ASSET_SWAP_DIRECTED_NONCE,
  RFQ_ASSET_SWAP_V2,
  RFQ_CONTRACT_VERSIONS,
  RFQ_EVM_RECEIVE_V1,
  RFQ_EVM_SEND_V1,
  RFQ_LIGHTNING_SEND_V2,
} from '@arkade-os/solver-core/core/rfqContract.js'

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
// The real send service on a backend with no routing estimator, so it bids the configured fee alone.
const sendService = (corridorFee: Fee, limits: { minSats: number; maxSats: number }) =>
  new SendSwapService({
    ln: { getBalance: async () => ({ availableSats: Number.MAX_SAFE_INTEGER }) },
    limits,
    fee: corridorFee,
    store: { findByStates: async () => [] },
    admission: new AdmissionControl(),
    maxExposedSats: Number.MAX_SAFE_INTEGER,
    totalCommitted: async () => 0,
  } as never)
const open = (pair: string, amount: string, amount_side: 'from' | 'to' = 'from'): OpenRfq => ({
  v: 1,
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
    rfqContractVersions: [...RFQ_CONTRACT_VERSIONS] as string[],
    corridorFees: { 'arkade:BTC->lightning:BTC': fee, 'lightning:BTC->arkade:BTC': fee },
    corridorLimits: { 'arkade:BTC->lightning:BTC': bounds, 'lightning:BTC->arkade:BTC': bounds },
  },
  policy: { evmCorridors: evmPolicies, rfqContractVersions: [...RFQ_CONTRACT_VERSIONS] as string[] },
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
  arkade: {
    dustSats: 1n,
    vtxoMinSats: 1n,
    wallet: {
      getBalance: vi.fn(async () => ({
        available: 100000000,
        availableAssets: [{ assetId: asset, amount: 10n ** 30n }],
      })),
    },
  },
  assetRfqService: { quote: vi.fn() },
  service: sendService(fee, bounds),
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
    expect(await preview(open(`${btc}->arkade:bitcoin/asset:${asset}`, '100000000'))).toEqual({
      from_amount: '100000000',
      to_amount: '2000000000000000000',
      valid_until: 1800000035,
    })
    expect(services.assetRfqService.quote).not.toHaveBeenCalled()
  })

  it('bids for an asset payout only when its exact amount is spendable', async () => {
    const services = source()
    const amount = 2n * 10n ** 18n
    const balance = {
      available: 100000000,
      assets: [{ assetId: asset, amount }],
      availableAssets: [{ assetId: asset, amount: amount - 1n }],
    }
    services.arkade.wallet.getBalance
      .mockResolvedValueOnce(balance)
      .mockResolvedValueOnce({ ...balance, availableAssets: balance.assets })
    const preview = openRfqPreview(services as unknown as Services, {
      fetchPrice: async () => ({ mantissa: 5n, scale: 1 }),
    })
    const request = open(`${btc}->arkade:bitcoin/asset:${asset}`, '100000000')
    expect(await preview(request)).toBeUndefined()
    expect(await preview(request)).toMatchObject({ to_amount: amount.toString() })
    expect(services.assetRfqService.quote).not.toHaveBeenCalled()
  })

  it('does not bid on a bitcoin payout below the VTXO minimum', async () => {
    const services = source()
    services.arkade.vtxoMinSats = 1000n
    const preview = openRfqPreview(services as unknown as Services, {
      fetchPrice: async () => ({ mantissa: 5n, scale: 1 }),
    })
    const pair = `arkade:bitcoin/asset:${asset}->${btc}`
    expect(await preview(open(pair, '999', 'to'))).toBeUndefined()
    expect(await preview(open(pair, '1000', 'to'))).toMatchObject({ to_amount: '1000' })
  })

  it('uses real fee inversion and each BTC corridor bound side', async () => {
    const preview = openRfqPreview(source() as unknown as Services, { now: () => 1800000000 })
    expect(await preview(open(`${btc}->bolt11:bitcoin/slip44:0`, '1000', 'to'))).toMatchObject({
      from_amount: String(giveSatsFor(1000, fee)),
      to_amount: '1000',
    })
    expect(await preview(open(`bolt11:bitcoin/slip44:0->${btc}`, '1000'))).toMatchObject({
      from_amount: '1000',
      to_amount: String(payoutSatsFor(1000, fee)),
    })
    expect(await preview(open(`${btc}->bolt11:bitcoin/slip44:0`, '1000'))).toBeUndefined()
  })

  it.each(['bolt11', 'bitcoin'] as const)('only bids on %s with available capacity and float', async (rail) => {
    const base = source()
    const pair = rail === 'bolt11' ? 'arkade:BTC->lightning:BTC' : 'arkade:BTC->onchain:BTC'
    const admission = new AdmissionControl()
    let available = 0
    let committed = 0
    const owed = 100
    const shared = { admission, fee, limits: bounds, maxExposedSats: 5_000, totalCommitted: async () => committed }
    const services = {
      ...base,
      bootPolicy: {
        ...base.bootPolicy,
        corridorFees: { ...base.bootPolicy.corridorFees, [pair]: fee },
        corridorLimits: { ...base.bootPolicy.corridorLimits, [pair]: bounds },
      },
      service: new SendSwapService({
        ...shared,
        ln: { getBalance: async () => ({ availableSats: available }) },
        store: { findByStates: async () => [{ invoice: 'legacy', amountSats: owed, quotedRoutingFeeSats: 0 }] },
      } as never),
      onchainService: new OnchainSendSwapService({
        ...shared,
        network: 'bitcoin',
        refundDestinationScript: new Uint8Array([0, 20, ...new Uint8Array(20)]),
        float: { read: () => ({ sats: available, ageMs: 0 }), fundingFeeSats: () => 200 },
        store: { owedPayoutSats: async () => owed },
      } as never),
    }
    const preview = openRfqPreview(services as unknown as Services, { now: () => 1800000000 })
    const request = open(`${btc}->${rail}:bitcoin/slip44:0`, '2000', 'to')

    expect(await preview(request)).toBeUndefined()
    available = rail === 'bolt11' ? 2_025 : 2_200
    expect(await preview(request)).toBeUndefined()
    available = 10_000
    committed = 3_000
    expect(await preview(request)).toBeUndefined()
    committed = 0
    const inFlight = await admission.reserve(3_000, shared.totalCommitted, shared.maxExposedSats)
    expect(inFlight).not.toBeNull()
    expect(await preview(request)).toBeUndefined()
    inFlight?.release()
    expect(await preview(request)).toMatchObject({ to_amount: '2000' })
    expect(admission.outstandingSats).toBe(0)
    expect(admission.outstandingFloatSats).toBe(0)
  })

  it('refuses unsafe exact-out inversions while preserving safe maximum free previews', async () => {
    for (const bps of [1, 0]) {
      const base = source()
      const services = {
        ...base,
        bootPolicy: {
          ...base.bootPolicy,
          corridorFees: {
            'arkade:BTC->lightning:BTC': { bps, flatSats: 0 },
            'lightning:BTC->arkade:BTC': { bps, flatSats: 0 },
          },
          corridorLimits: {
            'arkade:BTC->lightning:BTC': { minSats: 1, maxSats: Number.MAX_SAFE_INTEGER },
            'lightning:BTC->arkade:BTC': { minSats: 1, maxSats: Number.MAX_SAFE_INTEGER },
          },
        },
        service: sendService({ bps, flatSats: 0 }, { minSats: 1, maxSats: Number.MAX_SAFE_INTEGER }),
      }
      const preview = openRfqPreview(services as unknown as Services, { now: () => 1800000000 })
      const amount = String(Number.MAX_SAFE_INTEGER)
      for (const pair of [`${btc}->bolt11:bitcoin/slip44:0`, `bolt11:bitcoin/slip44:0->${btc}`]) {
        const result = await preview(open(pair, amount, 'to'))
        if (bps > 0) expect(result).toBeUndefined()
        else expect(result).toMatchObject({ from_amount: amount, to_amount: amount })
      }
    }
  })

  it('delegates onchain exact-in and exact-out amounts without replacing the returned price', async () => {
    const base = source()
    const previewAmounts = vi.fn(() => ({ fromAmount: 10000, toAmount: 9850 }))
    const services = {
      ...base,
      bootPolicy: {
        ...base.bootPolicy,
        corridorFees: { ...base.bootPolicy.corridorFees, 'arkade:BTC->onchain:BTC': fee },
        corridorLimits: { ...base.bootPolicy.corridorLimits, 'arkade:BTC->onchain:BTC': bounds },
      },
      onchainService: { previewAmounts, canBid: async () => true },
    }
    const preview = openRfqPreview(services as unknown as Services, { now: () => 1800000000 })
    const priced = { from_amount: '10000', to_amount: '9850', valid_until: 1800000035 }
    expect(await preview(open(`${btc}->bitcoin:bitcoin/slip44:0`, '10000'))).toEqual(priced)
    expect(await preview(open(`${btc}->bitcoin:bitcoin/slip44:0`, '9850', 'to'))).toEqual(priced)
    expect(previewAmounts).toHaveBeenNthCalledWith(1, 10000, 'from')
    expect(previewAmounts).toHaveBeenNthCalledWith(2, 9850, 'to')
    expect(await preview(open(`${btc}->bitcoin:bitcoin/slip44:0`, '9007199254740992'))).toBeUndefined()
    expect(previewAmounts).toHaveBeenCalledTimes(2)
    expect(services.corridors.get).toHaveBeenCalledWith('arkade:BTC->onchain:BTC')
  })

  it.each(['missing', 'refused'] as const)(
    'does not fall back to generic fees when the onchain preview is %s',
    async (state) => {
      const base = source()
      const previewAmounts = vi.fn(() => undefined)
      const services = {
        ...base,
        bootPolicy: {
          ...base.bootPolicy,
          corridorFees: { ...base.bootPolicy.corridorFees, 'arkade:BTC->onchain:BTC': fee },
          corridorLimits: { ...base.bootPolicy.corridorLimits, 'arkade:BTC->onchain:BTC': bounds },
        },
        onchainService: state === 'missing' ? undefined : { previewAmounts },
      }
      const preview = openRfqPreview(services as unknown as Services, { now: () => 1800000000 })
      expect(await preview(open(`${btc}->bitcoin:bitcoin/slip44:0`, '10000'))).toBeUndefined()
      expect(await preview(open(`${btc}->bitcoin:bitcoin/slip44:0`, '9850', 'to'))).toBeUndefined()
      if (state === 'missing') {
        expect(previewAmounts).not.toHaveBeenCalled()
      } else {
        expect(previewAmounts).toHaveBeenNthCalledWith(1, 10000, 'from')
        expect(previewAmounts).toHaveBeenNthCalledWith(2, 9850, 'to')
      }
    },
  )

  it('enforces the effective onchain from-leg limits on both exact amount sides', async () => {
    const base = source()
    const previewAmounts = vi.fn((amount: number, side: 'from' | 'to') =>
      side === 'from' ? { fromAmount: amount, toAmount: amount - 150 } : { fromAmount: amount + 150, toAmount: amount },
    )
    const services = {
      ...base,
      bootPolicy: {
        ...base.bootPolicy,
        corridorFees: { ...base.bootPolicy.corridorFees, 'arkade:BTC->onchain:BTC': fee },
        corridorLimits: {
          ...base.bootPolicy.corridorLimits,
          'arkade:BTC->onchain:BTC': { minSats: 1000, maxSats: 10000 },
        },
      },
      onchainService: { previewAmounts, canBid: async () => true },
    }
    const preview = openRfqPreview(services as unknown as Services, { now: () => 1800000000 })
    const pair = `${btc}->bitcoin:bitcoin/slip44:0`
    for (const [from_amount, to_amount] of [
      ['1000', '850'],
      ['10000', '9850'],
    ] as const) {
      expect(await preview(open(pair, from_amount))).toMatchObject({ from_amount, to_amount })
      expect(await preview(open(pair, to_amount, 'to'))).toMatchObject({ from_amount, to_amount })
    }
    for (const [from, to] of [
      ['999', '849'],
      ['10001', '9851'],
    ] as const) {
      expect(await preview(open(pair, from))).toBeUndefined()
      expect(await preview(open(pair, to, 'to'))).toBeUndefined()
    }
  })

  it('matches directed asset fees and the priced carrier on both amount sides', async () => {
    const base = source()
    const services = {
      ...base,
      arkade: { ...base.arkade, dustSats: 330n },
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
    expect(await preview(open(`${btc}->${tokenId}`, '25000'))).toMatchObject({
      from_amount: '25000',
      to_amount: '2459',
    })
    expect(await preview(open(`${btc}->${tokenId}`, '2459', 'to'))).toMatchObject({
      from_amount: '25000',
      to_amount: '2459',
    })
    const balance = { total: 25175, available: 25174, availableAssets: [] }
    services.arkade.wallet.getBalance.mockResolvedValueOnce(balance)
    expect(await preview(open(`${tokenId}->${btc}`, '2492'))).toBeUndefined()
    services.arkade.wallet.getBalance.mockResolvedValueOnce({ ...balance, available: balance.total })
    expect(await preview(open(`${tokenId}->${btc}`, '2492'))).toMatchObject({ from_amount: '2492', to_amount: '25175' })
    expect(await preview(open(`${tokenId}->${btc}`, '25175', 'to'))).toMatchObject({
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
    expect(await preview(open(`${btc}->${evm}`, '10000'))).toMatchObject({ from_amount: '10000', to_amount: '9920000' })
    expect(await preview(open(`${evm}->${btc}`, '10000000'))).toMatchObject({
      from_amount: '10000000',
      to_amount: '9920',
    })
    expect(await preview(open(`${btc}->${evm}`, '10000000', 'to'))).toBeUndefined()
  })

  it('honors the current serve list before feeds and after asynchronous pricing', async () => {
    const services = source()
    const fetchPrice = vi.fn(async () => {
      services.corridors.get.mockReturnValue(undefined as never)
      return { mantissa: 2n, scale: 0 }
    })
    const preview = openRfqPreview(services as unknown as Services, { fetchPrice })
    expect(await preview(open(`${btc}->arkade:bitcoin/asset:${asset}`, '100000000'))).toBeUndefined()
    expect(await preview(open(`${btc}->arkade:bitcoin/asset:${asset}`, '100000000'))).toBeUndefined()
    expect(fetchPrice).toHaveBeenCalledOnce()
  })

  it('prices boot EVM terms when unrelated live settings expose pending fee or limit overrides', async () => {
    const services = source()
    services.policy = {
      ...services.policy,
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
    expect(await preview(open(`${btc}->eip155:1/erc20:${token.address}`, '10000'))).toMatchObject({
      to_amount: '9920000',
    })
    expect(await preview(open(`${btc}->eip155:1/erc20:${token.address}`, '200000'))).toBeUndefined()
    services.policy.evmCorridors = []
    expect(await preview(open(`${btc}->eip155:1/erc20:${token.address}`, '10000'))).toBeUndefined()
  })

  it('declines each route whose settlement contract version rfq.contractVersions disables', async () => {
    const tokenId = `arkade:bitcoin/asset:${asset}`
    const evm = `eip155:1/erc20:${token.address}`
    const ln = 'bolt11:bitcoin/slip44:0'
    const priced = async (versions: string[], pair: string, amount: string) => {
      const services = source()
      services.policy = { ...services.policy, rfqContractVersions: versions }
      return openRfqPreview(services as unknown as Services, {
        fetchPrice: async () => ({ mantissa: 100000n, scale: 0 }),
        now: () => 1800000000,
      })(open(pair, amount))
    }
    const all = [...RFQ_CONTRACT_VERSIONS]
    const without = (...dropped: string[]) => all.filter((entry) => !dropped.includes(entry))

    expect(await priced(all, `${btc}->${tokenId}`, '100000')).toBeDefined()
    expect(await priced(all, `${btc}->${evm}`, '10000')).toBeDefined()
    expect(await priced(all, `${btc}->${ln}`, '10000')).toBeDefined()

    expect(await priced(without(RFQ_ASSET_SWAP_V2), `${btc}->${tokenId}`, '100000')).toBeDefined()
    expect(await priced(without(RFQ_ASSET_SWAP_DIRECTED), `${btc}->${tokenId}`, '100000')).toBeDefined()
    expect(await priced(without(RFQ_ASSET_SWAP_DIRECTED_NONCE), `${btc}->${tokenId}`, '100000')).toBeDefined()
    expect(
      await priced(without(RFQ_ASSET_SWAP_DIRECTED, RFQ_ASSET_SWAP_DIRECTED_NONCE), `${btc}->${tokenId}`, '100000'),
    ).toBeUndefined()
    expect(await priced(without(RFQ_EVM_SEND_V1), `${btc}->${evm}`, '10000')).toBeUndefined()
    expect(await priced(without(RFQ_EVM_RECEIVE_V1), `${evm}->${btc}`, '10000000')).toBeUndefined()
    expect(await priced(without(RFQ_EVM_RECEIVE_V1), `${btc}->${evm}`, '10000')).toBeDefined()
    expect(await priced(without(RFQ_LIGHTNING_SEND_V2), `${btc}->${ln}`, '10000')).toBeUndefined()
    expect(await priced(without(RFQ_LIGHTNING_SEND_V2), `${ln}->${btc}`, '10000')).toBeDefined()
  })

  it('drops an EVM direction from the inline card when its contract version is disabled', () => {
    // A flat receive fee is unrepresentable in ERC20 input units, so the fixture's own
    // receive leg never publishes; zero it to isolate the contract-version filter.
    const representable = evmPolicies.map((policy) =>
      policy.direction === 'receive' ? { ...policy, fee: { bps: 30, flatSats: 0 } } : policy,
    )
    const marketsWith = (versions: readonly string[]) => {
      const services = source()
      services.bootPolicy = { ...services.bootPolicy, evmCorridors: representable, rfqContractVersions: [...versions] }
      services.policy = { ...services.policy, evmCorridors: representable }
      return evmCardMarketsOf(services as unknown as CardSource)
    }
    const all = marketsWith(RFQ_CONTRACT_VERSIONS)
    expect(all.publishable[0]?.send).toBeDefined()
    expect(all.publishable[0]?.receive).toBeDefined()

    const sendOnly = marketsWith(RFQ_CONTRACT_VERSIONS.filter((version) => version !== RFQ_EVM_RECEIVE_V1))
    expect(sendOnly.publishable[0]?.send).toBeDefined()
    expect(sendOnly.publishable[0]?.receive).toBeUndefined()
    expect(sendOnly.omitted.join(' ')).toContain(
      `contract version ${RFQ_EVM_RECEIVE_V1} is not in rfq.contractVersions`,
    )
  })

  it('leaves time to choose when collection uses the entire thirty-second window', async () => {
    const preview = openRfqPreview(source() as unknown as Services, { now: () => 1800000000 })
    expect(
      await preview({ ...open(`${btc}->bolt11:bitcoin/slip44:0`, '10000'), bids_until: 1800000030 }),
    ).toMatchObject({ valid_until: 1800000060 })
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
      `${btc}->eip155:1/erc20:${token.address}`,
      `eip155:1/erc20:${token.address}->${btc}`,
    ])
  })

  it('keeps an executable send direction when the receive flat fee cannot be represented', () => {
    const result = publishableEvmMarkets([{ ...evm, receive: { limits: bounds, fee } }], 'bitcoin')
    expect(result.omitted).toHaveLength(1)
    expect(openRfqPairs(card(result.publishable))).toEqual([`${btc}->eip155:1/erc20:${token.address}`])
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
        corridorEnabled: { 'arkade:BTC->lightning:BTC': true, 'lightning:BTC->arkade:BTC': true },
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
    expect(openRfqPairs(published)).toEqual([`${btc}->bolt11:bitcoin/slip44:0`, `bolt11:bitcoin/slip44:0->${btc}`])
    expect(inline.version).toBe(1)
    expect(inline.markets).toHaveLength(2)
    expect(cardErrors(inline, 'bitcoin')).toEqual([])
    expect(openRfqPairs(inline)).toEqual([
      `${btc}->bolt11:bitcoin/slip44:0`,
      `bolt11:bitcoin/slip44:0->${btc}`,
      `${btc}->eip155:1/erc20:${token.address}`,
    ])
  })

  it('reports precision the card feed cannot express', () => {
    const result = publishableEvmMarkets([{ ...evm, token: { ...token, decimals: 18 } }], 'bitcoin')
    expect(result.publishable).toEqual([])
    expect(result.omitted[0]).toContain('decimals above 8')
  })

  it.each(['auth', 'password', 'AUTH', 'PASSWORD', 'Auth', 'Password'])(
    'omits EVM card markets whose feed URL contains a %s credential',
    (parameter) => {
      const priceFeed = `https://prices.example/btc?${parameter}=secret`
      const market = { ...evm, priceFeed }
      const result = publishableEvmMarkets([market], 'bitcoin')
      expect(result.publishable).toEqual([])
      expect(result.omitted.length).toBeGreaterThan(0)
      expect(result.omitted.every((reason) => reason.includes('private price-feed credential'))).toBe(true)
      expect(market.priceFeed).toBe(priceFeed)
    },
  )
})
