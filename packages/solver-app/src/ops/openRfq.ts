import { resolveAssetQuote } from '@arkade-os/solver-core/core/assetRfq.js'
import { giveSatsFor, payoutSatsFor, isCorridor } from '@arkade-os/solver-core/core/corridorPolicy.js'
import { convertAmount, convertQuoteToBase, type Price } from '@arkade-os/solver-core/core/priceFeed.js'
import type { OpenRfqV2, OpenRfqV2Price } from '@arkade-os/solver-core/core/openRfqV2.js'
import type { SolverCard } from '@arkade-os/solver-core/core/registryCard.js'
import { createPriceFeed } from '@arkade-os/solver-core/price/feed.js'
import type { Services } from './services.js'

export const openRfqPairs = (card: SolverCard): string[] =>
  card.markets.flatMap((market) => {
    const base = (market.base_asset as { id: string }).id
    const quote = (market.quote_asset as { id: string }).id
    return [
      ...(BigInt(String(market.max_quote_amount ?? 0)) > 0n ? [`${base}~${quote}`] : []),
      ...(BigInt(String(market.max_base_amount ?? 0)) > 0n ? [`${quote}~${base}`] : []),
    ]
  })

const legacyLeg = (id: string, source: Services): string | undefined => {
  const btc = /^(arkade|bolt11|bitcoin):([^/]+)\/slip44:([01])$/.exec(id)
  if (btc && btc[2] === source.config.network && btc[3] === (source.config.network === 'bitcoin' ? '0' : '1')) {
    return `${btc[1] === 'bolt11' ? 'lightning' : btc[1] === 'bitcoin' ? 'onchain' : 'arkade'}:BTC`
  }
  const asset = /^arkade:([^/]+)\/asset:([0-9a-f]{68})$/.exec(id)
  if (asset && asset[1] === source.config.network) return `arkade:${asset[2]}`
  const evm = /^eip155:([0-9]+)\/erc20:(0x[0-9a-f]{40})$/.exec(id)
  if (evm && Number(evm[1]) === source.config.evmChain?.chainId) return `ethereum:${evm[2]}`
  return undefined
}

export const openRfqPreview = (
  source: Services,
  options: {
    fetchPrice?: (url: string, path: string) => Promise<Price>
    now?: () => number
  } = {},
) => {
  const fetchPrice = options.fetchPrice ?? createPriceFeed()
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  return async (open: OpenRfqV2): Promise<OpenRfqV2Price | undefined> => {
    const [fromId, toId] = open.pair.split('~')
    const from = fromId ? legacyLeg(fromId, source) : undefined
    const to = toId ? legacyLeg(toId, source) : undefined
    if (!from || !to) return undefined
    const pair = `${from}->${to}`
    if (!source.corridors.get(pair)) return undefined
    const amount = BigInt(open.amount)
    let fromAmount: bigint
    let toAmount: bigint
    if (from.startsWith('arkade:') && to.startsWith('arkade:')) {
      const legs = { from: from === 'arkade:BTC' ? null : from.slice(7), to: to === 'arkade:BTC' ? null : to.slice(7) }
      const market = source.assetRfqMarkets.find(
        (market) =>
          (market.base === legs.from && market.quote === legs.to) ||
          (market.base === legs.to && market.quote === legs.from),
      )
      if (!market) return undefined
      const bounds = legs.from === market.base ? market.sellBase : market.buyBase
      if (bounds.max === 0n) return undefined
      const result = resolveAssetQuote({
        pair: legs,
        amount,
        amountSide: open.amount_side,
        market: { ...market, minPayout: bounds.min, maxPayout: bounds.max },
        feed: await fetchPrice(market.feedUrl, market.pricePath),
        carrierSats: market.carrierSats,
        dustSats: source.arkade.dustSats,
      })
      if (!result.ok) return undefined
      fromAmount = result.fromAmount
      toAmount = result.toAmount
    } else if (isCorridor(pair)) {
      if (amount > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
      const fee = source.bootPolicy.corridorFees[pair]
      const limits = source.bootPolicy.corridorLimits[pair]
      const onchain =
        pair === 'arkade:BTC->onchain:BTC'
          ? source.onchainService?.previewAmounts(Number(amount), open.amount_side)
          : undefined
      if (pair === 'arkade:BTC->onchain:BTC' && !onchain) return undefined
      const give =
        onchain?.fromAmount ?? (open.amount_side === 'from' ? Number(amount) : giveSatsFor(Number(amount), fee))
      const take = onchain?.toAmount ?? (open.amount_side === 'to' ? Number(amount) : payoutSatsFor(give, fee))
      const bounded = pair === 'arkade:BTC->lightning:BTC' ? take : give
      if (
        !Number.isSafeInteger(give) ||
        !Number.isSafeInteger(take) ||
        give <= 0 ||
        take <= 0 ||
        bounded < limits.minSats ||
        bounded > limits.maxSats
      )
        return undefined
      fromAmount = BigInt(give)
      toAmount = BigInt(take)
    } else {
      if (open.amount_side !== 'from') return undefined
      const policy = source.bootPolicy.evmCorridors.find((policy) => policy.enabled && policy.corridor === pair)
      if (!policy || !source.policy.evmCorridors.some((live) => live.corridor === pair && live.enabled))
        return undefined
      if (policy.direction === 'receive' && amount >= 1n << 256n) return undefined
      const market = source.config.evmMarkets.find((market) => market.token.address === policy.token.address)
      if (!market) return undefined
      const feed = await fetchPrice(market.priceFeed, market.pricePath)
      if (policy.direction === 'send') {
        if (amount > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
        const sats = Number(amount)
        if (sats < policy.limits.minSats || sats > policy.limits.maxSats) return undefined
        const payout = payoutSatsFor(sats, policy.fee)
        if (payout <= 0) return undefined
        fromAmount = amount
        toAmount = convertAmount({
          baseAmount: BigInt(payout),
          price: feed,
          baseDecimals: 8,
          quoteDecimals: policy.token.decimals,
          rounding: 'down',
        })
      } else {
        if (policy.tokenLimits && (amount < policy.tokenLimits.minUnits || amount > policy.tokenLimits.maxUnits))
          return undefined
        const sats = convertQuoteToBase({
          quoteAmount: amount,
          price: feed,
          baseDecimals: 8,
          quoteDecimals: policy.token.decimals,
          rounding: 'down',
        })
        if (
          sats > BigInt(Number.MAX_SAFE_INTEGER) ||
          sats < BigInt(policy.limits.minSats) ||
          sats > BigInt(policy.limits.maxSats)
        )
          return undefined
        fromAmount = amount
        const payout = payoutSatsFor(Number(sats), policy.fee)
        if (payout < Number(source.arkade.dustSats)) return undefined
        toAmount = BigInt(payout)
      }
      const tokenAmount = policy.direction === 'send' ? toAmount : fromAmount
      if (tokenAmount <= 0n || tokenAmount >= 1n << 256n) return undefined
      if (
        policy.tokenLimits &&
        (tokenAmount < policy.tokenLimits.minUnits || tokenAmount > policy.tokenLimits.maxUnits)
      )
        return undefined
    }
    if (fromAmount <= 0n || toAmount <= 0n || !source.corridors.get(pair)) return undefined
    return {
      from_amount: fromAmount.toString(),
      to_amount: toAmount.toString(),
      valid_until: Math.max(now() + 30, open.bids_until + 30),
    }
  }
}
