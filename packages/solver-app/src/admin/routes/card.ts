/**
 * Discovery, both halves, on one route.
 *
 * An operator asking "am I discoverable?" does not care that discovery has two
 * mechanisms — the git-reviewed registry card and the kind-38859 ad. They care
 * whether each is current, so both are reported together.
 */
import type { Hono } from 'hono'
import {
  assetCardMarkets,
  buildSolverCard,
  signSolverCard,
  unpublishableCorridors,
  type SolverCard,
} from '@arkade-os/solver-core/core/registryCard.js'
import { CORRIDORS } from '@arkade-os/solver-core/core/corridorPolicy.js'
import type { SolverAd } from '@arkade-os/solver-core/core/solverAd.js'
import type { Services } from '../../ops/services.js'
import { publishStateOf } from '../publishState.js'
import type { AdminDeps } from '../server.js'

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * This deployment's signed registry card, built exactly as `cli card` builds it.
 *
 * `Services` carries no card — `createServices` builds none — so the console
 * assembles one here from the live stack rather than shelling out to the CLI,
 * which would need the mnemonic in a second process's environment for a value
 * this process can already sign.
 *
 * Deliberately ONE function, and the only place in the console that names a
 * card field. The card's shape is moving (`emulator_pubkey` is being retired as
 * a property of the network rather than of a solver), and a card assembled in
 * one place is one edit when it does.
 *
 * Throws rather than returning a partial card: every refusal below is a card
 * that would LIE about the deployment it names, and the route reports the
 * reason instead of publishing it.
 */
const deploymentCard = async (services: Services): Promise<SolverCard> => {
  const { config, policy } = services
  const name = process.env.SOLVER_NAME?.trim()
  // Guarded here rather than left to `buildSolverCard`: an absent variable
  // reaches its name rule as the string "undefined", which matches
  // /^[a-z0-9-]+$/ perfectly and would file a card called `undefined`.
  if (!name) {
    throw new Error('SOLVER_NAME is not set — it becomes the registry filename solvers/<network>/<name>.json')
  }
  // Extra relays beyond RELAY_URL, for a deployment listening on several — the
  // same two sources `cli card` reads, so the two cannot print different cards.
  const extra = (process.env.SOLVER_CARD_RELAYS ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
  const relays = [...(config.relayUrl ? [config.relayUrl] : []), ...extra]

  // Effective policy, not the raw environment: the card states terms, and a
  // card quoting a corridor this process has overridden into silence is a
  // listing that lies. Both the toggles AND the bounds come from `policy` now
  // that the card publishes per-corridor limits — an override that narrows a
  // corridor has to reach the listing, which reading `config.limits` would
  // have hidden.
  //
  // The old hard refusal for a disabled LN_SEND is gone with the hardcoded
  // market it protected: an onchain-only deployment now has an honest card to
  // publish rather than none. `buildSolverCard` still refuses when NOTHING is
  // served.
  const served = Object.fromEntries(
    CORRIDORS.filter((corridor) => policy.corridorEnabled[corridor]).map((corridor) => [
      corridor,
      { limits: policy.corridorLimits[corridor], fee: policy.corridorFees[corridor] },
    ]),
  )

  return signSolverCard(
    buildSolverCard({
      name,
      // The wallet identity — the same x-only key makers already address RFQs
      // to, which is what makes the card's rendezvous data self-attesting.
      discoveryPubkey: services.providerPubkey,
      relays,
      corridors: served,
      // Already the ENABLED markets: `assetMarketPolicy` drops a paused pair.
      assetMarkets: assetCardMarkets(services.assetMarkets, {
        min: policy.offerMinFillAmount,
        max: policy.offerMaxFillAmount,
      }),
    }),
    (digest) => services.arkade.identity.signMessage(digest, 'schnorr'),
  )
}

export const registerCardRoutes = (app: Hono, deps: AdminDeps): void => {
  app.get('/api/card', async (c) => {
    // An unbuildable card degrades to a reported reason, never a 500: the ad
    // half of this answer is still worth showing, and a console that goes dark
    // because SOLVER_NAME is unset is the failure the console exists to end.
    let card: SolverCard | null = null
    let cardError: string | null = null
    try {
      card = await deploymentCard(deps.services)
    } catch (error) {
      cardError = messageOf(error)
    }
    // The ad gets the SAME treatment, because it can fail the same way:
    // `currentAd()` calls `buildAd()`, which in any real wiring closes over
    // live policy and corridor limits. Left unwrapped it would reach
    // `app.onError` as a 500 and take down the CARD, which built perfectly —
    // "one dead backend must not blank the page" inverted, the failing half
    // silencing the working one.
    let ad: SolverAd | null = null
    let adError: string | null = null
    try {
      ad = deps.adPublisher ? deps.adPublisher.currentAd() : null
    } catch (error) {
      adError = messageOf(error)
    }
    return c.json({
      card,
      // Named like `overridesError` on /api/diagnostics rather than a bare
      // `error`, which on this port means "the request failed".
      cardError,
      // Reported even when the card failed: it describes the deployment, not the card.
      cardOmitted: unpublishableCorridors(
        deps.services.policy.evmCorridors.filter((corridor) => corridor.enabled).map((corridor) => corridor.corridor),
      ),
      ad,
      adError,
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
      const detail = 'this mode has no relay connection'
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
