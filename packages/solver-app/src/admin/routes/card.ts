/** Discovery on one route: the signed card, and the state of its kind-38859 copy on Nostr. */
import type { Hono } from 'hono'
import {
  buildSolverCard,
  publishableAssetMarkets,
  signSolverCard,
  publishableEvmMarkets,
  type EvmCardMarket,
  type SolverCard,
} from '@arkade-os/solver-core/core/registryCard.js'
import { CORRIDORS } from '@arkade-os/solver-core/core/corridorPolicy.js'
import { messageOf } from '@arkade-os/solver-core/util/poll.js'
import type { Services } from '../../ops/services.js'
import { publishStateOf } from '../publishState.js'
import type { AdminDeps } from '../server.js'
import { assetCardMarketsFromPolicy } from '../../ops/assetRfqMarkets.js'
import { descriptorFor } from '@arkade-os/solver-corridors/corridors/index.js'
import {
  ASSET_RFQ_CONTRACT_VERSIONS,
  assetRfqContractVersionsFor,
  RFQ_EVM_RECEIVE_V1,
  RFQ_EVM_SEND_V1,
  rfqContractEnabled,
} from '@arkade-os/solver-core/core/rfqContract.js'

/** `RELAY_URL` then `SOLVER_CARD_RELAYS`. */
export const advertisedRelays = (relayUrl: string | null, extra: readonly string[]): string[] =>
  [...(relayUrl ? [relayUrl] : []), ...extra].map(withoutCredentials)

/** The card goes out with no human reading it, so a `?token=` or `user:pass@` in a relay URL must not ride along. */
const withoutCredentials = (relay: string): string => {
  try {
    const url = new URL(relay)
    return url.username || url.password || url.search || url.hash
      ? `${url.protocol}//${url.host}${url.pathname}`
      : relay
  } catch {
    return relay
  }
}

/** `Services` satisfies it whole; `cli card`, which builds no stack, assembles one. */
export type CardSource = Pick<
  Services,
  'config' | 'policy' | 'bootPolicy' | 'assetMarkets' | 'liveOfferMarkets' | 'assetRfqMarkets' | 'providerPubkey'
> & { arkade: { identity: Pick<Services['arkade']['identity'], 'signMessage'> } }

type AssetRfqMarket = CardSource['assetRfqMarkets'][number]

const isTwoAssetMarket = (market: AssetRfqMarket): boolean => market.base !== null && market.quote !== null

const assetRfqVersions = (market: AssetRfqMarket) =>
  assetRfqContractVersionsFor({ from: market.base, to: market.quote })

const assetRfqServed = (source: CardSource, market: AssetRfqMarket): boolean =>
  assetRfqVersions(market).some((version) => rfqContractEnabled(source.bootPolicy.rfqContractVersions, version))

/** ENABLED already — `assetMarketPolicy` drops a pause. */
const assetMarketsOf = (source: CardSource, ignoreRfqAvailability = false) =>
  publishableAssetMarkets(
    assetCardMarketsFromPolicy({
      pricing: source.assetMarkets,
      offerMarkets: source.liveOfferMarkets,
      // BOOT: `AssetOfferService` reads these off constructor deps. `rfqMarkets` below is LIVE by contrast.
      offerBounds: { min: source.bootPolicy.offerMinFillAmount, max: source.bootPolicy.offerMaxFillAmount },
      rfqMarkets: source.assetRfqMarkets.filter(
        (market) =>
          ignoreRfqAvailability ||
          (assetRfqServed(source, market) && (!isTwoAssetMarket(market) || source.config.relayUrl !== null)),
      ),
      chargesDeliveredCarrier: source.bootPolicy.offerChargesDeliveredCarrier,
      rfqCarrierPricedByDefault: source.policy.assetCarrierPricing,
    }),
    source.config.network,
  )

const evmContractVersionOf = (direction: 'send' | 'receive'): string =>
  direction === 'send' ? RFQ_EVM_SEND_V1 : RFQ_EVM_RECEIVE_V1

export const evmCardMarketsOf = (source: CardSource) => {
  const markets: EvmCardMarket[] = []
  const unavailable: string[] = []
  const chainId = source.config.evmChain?.chainId
  const served = (policy: { direction: 'send' | 'receive' }): boolean =>
    rfqContractEnabled(source.bootPolicy.rfqContractVersions, evmContractVersionOf(policy.direction))
  if (chainId !== undefined) {
    for (const market of source.config.evmMarkets ?? []) {
      const policies = source.bootPolicy.evmCorridors.filter(
        (policy) =>
          policy.enabled &&
          served(policy) &&
          policy.token.address === market.token.address &&
          source.policy.evmCorridors.some((live) => live.corridor === policy.corridor && live.enabled),
      )
      if (!policies.length) continue
      const send = policies.find((policy) => policy.direction === 'send')
      const receive = policies.find((policy) => policy.direction === 'receive')
      markets.push({ ...market, chainId, ...(send ? { send } : {}), ...(receive ? { receive } : {}) })
    }
  }
  for (const policy of source.policy.evmCorridors) {
    // Per DIRECTION, not per token: one direction surviving used to silence the
    // other's reason, which a contract version disabling exactly one makes routine.
    if (
      policy.enabled &&
      !markets.some((market) => market.token.address === policy.token?.address && Boolean(market[policy.direction]))
    ) {
      const boot = source.bootPolicy.evmCorridors.find((entry) => entry.corridor === policy.corridor && entry.enabled)
      unavailable.push(
        !served(policy)
          ? `${policy.corridor} is enabled but omitted: contract version ${evmContractVersionOf(policy.direction)} is not in rfq.contractVersions`
          : `${policy.corridor} cannot be advertised: ${boot ? 'its EVM chain or price-feed metadata is missing' : 'enabling this EVM direction is pending restart'}`,
      )
    }
  }
  const result = publishableEvmMarkets(markets, source.config.network)
  return { publishable: result.publishable, omitted: [...unavailable, ...result.omitted] }
}

export const cardOmissions = (source: CardSource): string[] => {
  const evm = evmCardMarketsOf(source)
  const unavailableRfq = source.assetRfqMarkets.filter((market) => !assetRfqServed(source, market))
  const inlineOnly = source.policy.evmCorridors
    .filter(
      (policy) =>
        policy.enabled &&
        evm.publishable.some(
          (market) => market.token.address === policy.token?.address && Boolean(market[policy.direction]),
        ),
    )
    .map((policy) => `${policy.corridor} requires the open-RFQ inline card; the legacy published card stays version 0`)
  return [
    ...CORRIDORS.filter(
      (corridor) =>
        source.bootPolicy.corridorEnabled[corridor] &&
        !rfqContractEnabled(source.bootPolicy.rfqContractVersions, descriptorFor(corridor).contractVersion),
    ).map(
      (corridor) =>
        `${corridor} is enabled but omitted: contract version ${descriptorFor(corridor).contractVersion} is not in rfq.contractVersions`,
    ),
    ...(unavailableRfq.some((market) => !isTwoAssetMarket(market))
      ? [`asset RFQ markets are omitted: none of ${ASSET_RFQ_CONTRACT_VERSIONS.join(', ')} is in rfq.contractVersions`]
      : []),
    ...unavailableRfq
      .filter(isTwoAssetMarket)
      .map(
        (market) =>
          `${market.symbol} RFQ market is omitted: ${assetRfqVersions(market).join(', ')} is not in rfq.contractVersions`,
      ),
    ...(source.config.relayUrl === null
      ? source.assetRfqMarkets
          .filter((market) => isTwoAssetMarket(market) && assetRfqServed(source, market))
          .map((market) => `${market.symbol} RFQ market is omitted: relay.url is not set`)
      : []),
    ...evm.omitted,
    ...inlineOnly,
    // Keep a market's own card errors visible alongside RFQ availability.
    ...assetMarketsOf(source, true).omitted,
  ]
}

/**
 * One builder for `/api/card`, `cli card` and the kind-38859 publisher.
 *
 * Throws rather than returning a partial card: every refusal below is a card
 * that would LIE about the deployment it names, and the route reports the
 * reason instead of publishing it.
 */
export const deploymentCard = async (
  source: CardSource,
  name = source.config.solverName ?? undefined,
  options: { includeEvm?: boolean } = {},
): Promise<SolverCard> => {
  const { config, bootPolicy } = source
  const trimmed = name?.trim()
  // Guarded here rather than left to `buildSolverCard`: an absent variable
  // reaches its name rule as the string "undefined", which matches
  // /^[a-z0-9-]+$/ perfectly and would file a card called `undefined`.
  if (!trimmed) {
    throw new Error('name is not set in the config — it becomes the registry filename solvers/<network>/<name>.json')
  }

  // BOOT, not live: the card is SIGNED, none of these three is in `LIVE_KEYS`, and each is snapshotted into a
  // `private readonly` deps at construction — so boot is what the corridor will honour.
  const served = Object.fromEntries(
    CORRIDORS.filter(
      (corridor) =>
        bootPolicy.corridorEnabled[corridor] &&
        rfqContractEnabled(bootPolicy.rfqContractVersions, descriptorFor(corridor).contractVersion),
    ).map((corridor) => [
      corridor,
      { limits: bootPolicy.corridorLimits[corridor], fee: bootPolicy.corridorFees[corridor] },
    ]),
  )

  return signSolverCard(
    buildSolverCard({
      name: trimmed,
      network: config.network,
      // The wallet identity — the same x-only key makers already address RFQs
      // to, which is what makes the card's rendezvous data self-attesting.
      discoveryPubkey: source.providerPubkey,
      relays: advertisedRelays(config.relayUrl, config.cardRelays),
      corridors: served,
      assetMarkets: assetMarketsOf(source).publishable,
      ...(options.includeEvm ? { evmMarkets: evmCardMarketsOf(source).publishable } : {}),
    }),
    (digest) => source.arkade.identity.signMessage(digest, 'schnorr'),
  )
}

export const registerCardRoutes = (app: Hono, deps: AdminDeps): void => {
  app.get('/api/card', async (c) => {
    // An unbuildable card degrades to a reported reason, never a 500: the
    // publish state is still worth showing, and a console that goes dark
    // because SOLVER_NAME is unset is the failure the console exists to end.
    let card: SolverCard | null = null
    let cardError: string | null = null
    try {
      card = await deploymentCard(deps.services)
    } catch (error) {
      cardError = messageOf(error)
    }
    return c.json({
      card,
      // Named like `overridesError` on /api/diagnostics rather than a bare
      // `error`, which on this port means "the request failed".
      cardError,
      cardOmitted: cardOmissions(deps.services),
      publish: publishStateOf(deps),
    })
  })

  app.post('/api/actions/post-ad', async (c) => {
    // Audited on EVERY path, the rule `routes/actions.ts` states for the
    // actions beside this one. This is the only outward-facing,
    // network-touching action on this port, so an operator who was refused
    // needs to find that in the audit view every bit as much as one whose
    // publish succeeded — a log that remembers only successes lies by omission.
    const audit = (outcome: 'ok' | 'error', detail: string): Promise<void> =>
      deps.services.adminStore.recordAction({ action: 'post-ad', target: null, params: '{}', outcome, detail })

    // POLICY FIRST, wiring second.
    //
    // `off` is refused HERE, on the CONFIGURED value, rather than left to
    // `AdPublisher` — which refuses on the mode it was CONSTRUCTED with. Those
    // two agree only for as long as every future call site builds the publisher
    // from `config.nostrAdPublish`, and a setting whose guarantee rests on that
    // is advisory again. `off` must mean off whatever the wiring does.
    //
    // Answered before the missing-publisher case on purpose: an absence must
    // not mask a policy the operator actually set. "You configured off" is the
    // true answer to this request; "nothing is wired" is incidental.
    if (deps.services.config.nostrAdPublish === 'off') {
      const detail = 'relay.adPublish is off: this solver is configured not to publish to Nostr'
      await audit('error', detail)
      return c.json({ error: 'refused', detail }, 409)
    }
    if (!deps.adPublisher) {
      const detail =
        deps.mode === 'relay' ? 'no ad publisher is wired' : `${deps.mode} mode has no relay connection to publish on`
      await audit('error', detail)
      return c.json({ error: 'no_publisher', detail }, 409)
    }
    try {
      await deps.adPublisher.publishNow()
      const publish = deps.adPublisher.state()
      await audit('ok', JSON.stringify(publish).slice(0, 500))
      return c.json({ ok: true, publish })
    } catch (error) {
      // 409, not 500: a publisher refusing on its own policy, or a relay that
      // would not take the event, is a correct answer to a request that could
      // not be honoured — not a fault in this service. Advertising is not on
      // the money path and must never surface as one.
      await audit('error', messageOf(error))
      return c.json({ error: 'refused', detail: messageOf(error) }, 409)
    }
  })
}
