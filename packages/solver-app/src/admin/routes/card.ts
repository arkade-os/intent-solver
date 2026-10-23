/** Discovery on one route: the signed card, and the state of its kind-38859 copy on Nostr. */
import type { Hono } from 'hono'
import {
  buildSolverCard,
  publishableAssetMarkets,
  signSolverCard,
  unpublishableCorridors,
  type SolverCard,
} from '@arkade-os/solver-core/core/registryCard.js'
import { CORRIDORS } from '@arkade-os/solver-core/core/corridorPolicy.js'
import { messageOf } from '@arkade-os/solver-core/util/poll.js'
import type { Services } from '../../ops/services.js'
import { publishStateOf } from '../publishState.js'
import type { AdminDeps } from '../server.js'
import { assetCardMarketsFromPolicy } from '../../ops/assetRfqMarkets.js'

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

/** ENABLED already — `assetMarketPolicy` drops a pause. */
const assetMarketsOf = (source: CardSource) =>
  publishableAssetMarkets(
    assetCardMarketsFromPolicy({
      pricing: source.assetMarkets,
      offerMarkets: source.liveOfferMarkets,
      // BOOT: `AssetOfferService` reads these off constructor deps. `rfqMarkets` below is LIVE by contrast.
      offerBounds: { min: source.bootPolicy.offerMinFillAmount, max: source.bootPolicy.offerMaxFillAmount },
      rfqMarkets: source.assetRfqMarkets,
      chargesDeliveredCarrier: source.bootPolicy.offerChargesDeliveredCarrier,
    }),
    source.config.network,
  )

export const cardOmissions = (source: CardSource): string[] => [
  // LIVE unlike the corridor map: `rebuild` builds the corridor set from `livePolicy.evmCorridors`.
  ...unpublishableCorridors(
    source.policy.evmCorridors.filter((corridor) => corridor.enabled).map((corridor) => corridor.corridor),
  ),
  ...assetMarketsOf(source).omitted,
]

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
): Promise<SolverCard> => {
  const { config, bootPolicy } = source
  const trimmed = name?.trim()
  // Guarded here rather than left to `buildSolverCard`: an absent variable
  // reaches its name rule as the string "undefined", which matches
  // /^[a-z0-9-]+$/ perfectly and would file a card called `undefined`.
  if (!trimmed) {
    throw new Error('SOLVER_NAME is not set — it becomes the registry filename solvers/<network>/<name>.json')
  }

  // BOOT, not live: the card is SIGNED, none of these three is in `LIVE_KEYS`, and each is snapshotted into a
  // `private readonly` deps at construction — so boot is what the corridor will honour.
  const served = Object.fromEntries(
    CORRIDORS.filter((corridor) => bootPolicy.corridorEnabled[corridor]).map((corridor) => [
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
      const detail = 'NOSTR_AD_PUBLISH is off: this solver is configured not to publish to Nostr'
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
