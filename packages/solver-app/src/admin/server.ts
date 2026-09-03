/**
 * The operator console's HTTP host — a SEPARATE app on a SEPARATE port.
 *
 * Deliberately not mounted onto `src/http/server.ts`, whose bodies are the future bus
 * payloads byte for byte and must not leak HTTP concerns. Keeping them apart also
 * means the public RFQ port never grows a route that can move money.
 *
 * NO authentication here, by deployment decision: a reverse proxy adds it in front, so
 * every route assumes its caller is authorised and the only thing between the network
 * and a refund is `adminHost`. Stated in docs/runbook.md too, because it must not live
 * only in a comment.
 *
 * A STRICT READER of the money layer — it polls stores and derives, with no
 * orchestrator instrumented for it. The one exception is the actions route, which
 * calls the same `src/ops/` functions the CLI does.
 */

import { Hono } from 'hono'
import type { Services } from '../ops/services.js'
import type { RelayProbeTarget } from './probes.js'
import type { BidRecorder } from './bids.js'
import { registerSwapRoutes } from './routes/swaps.js'
import { registerStatusRoutes } from './routes/status.js'
import { registerDiagnosticsRoutes } from './routes/diagnostics.js'
import { registerSettingsRoutes } from './routes/settings.js'
import { registerMarketRoutes } from './routes/markets.js'
import { registerActionRoutes } from './routes/actions.js'
import { registerCardRoutes } from './routes/card.js'
import { registerEventRoutes } from './routes/events.js'
import type { ChangeFeed } from './events.js'
import type { AdPublisher } from '@arkade-os/solver-transport/relay/adPublisher.js'
import type { FetchPrice } from '@arkade-os/solver-core/price/feed.js'
import { readStaticFile } from './static.js'

/** Which long-lived command the console is running inside. */
export type AdminMode = 'serve' | 'relay' | 'watch'

export interface AdminDeps {
  services: Services
  /** Unix seconds the host process started, for uptime. */
  startedAt: number
  mode: AdminMode
  /** Injectable clock, so uptime is assertable. Defaults to the wall clock. */
  now?: () => number
  /**
   * The outbound relay connection, in `relay` mode only. Absent in
   * `serve`/`watch`, where no such connection exists and reporting one as
   * "down" would read as a fault rather than an absence.
   */
  relay?: RelayProbeTarget
  /** Recent open-RFQ bids. Absent when bidding is off (`OPEN_RFQ_MAX_BIDS_PER_MIN=0`). */
  bids?: BidRecorder
  /**
   * The kind-38859 ad publisher. Absent in a mode with no relay connection —
   * exactly the treatment {@link AdminDeps.relay} and {@link AdminDeps.bids}
   * get, and for the same reason: reporting a publisher as `off` where none
   * could exist reads as a policy an operator chose rather than an absence.
   *
   * Absent means `POST /api/actions/post-ad` answers 409 rather than 500.
   */
  adPublisher?: AdPublisher
  /** Drives `/api/events`. Absent means the stream answers 503 rather than hanging. */
  changes?: ChangeFeed
  /**
   * The price-feed read `PUT /api/markets` probes a new market's feed with.
   *
   * Injectable so a test can describe a feed without a network, and so the
   * timeout is one a deployment could set. Defaults to `createPriceFeed()` —
   * the same reader the offer path uses, deliberately, because a probe that
   * accepted a feed the real reader would refuse proves nothing.
   */
  fetchPrice?: FetchPrice
}

export const buildAdminApp = (deps: AdminDeps): Hono => {
  const app = new Hono()
  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000))

  app.get('/api/healthz', (c) =>
    c.json({ ok: true, mode: deps.mode, uptimeSeconds: Math.max(0, now() - deps.startedAt) }),
  )

  registerStatusRoutes(app, deps)
  registerDiagnosticsRoutes(app, deps)
  registerSwapRoutes(app, deps)
  registerSettingsRoutes(app, deps)
  registerMarketRoutes(app, deps)
  // BEFORE the actions route, and it must stay there: that route claims
  // `/api/actions/:name`, which matches `/api/actions/post-ad` too, and Hono runs
  // handlers in registration order — so registering afterwards yields a 404
  // `unknown_action` for a route that exists. `test/admin/card.test.ts` pins this
  // through the assembled app, since a bare `Hono` cannot see the collision.
  registerCardRoutes(app, deps)
  registerActionRoutes(app, deps)
  registerEventRoutes(app, deps)

  // Last, so it can never shadow an /api route: this handler answers almost
  // everything, falling back to index.html for the client's own routing.
  app.get('*', async (c) => {
    const path = new URL(c.req.url).pathname
    if (path.startsWith('/api/')) return c.json({ error: 'not_found', path }, 404)
    const file = await readStaticFile(path)
    if (!file) return c.json({ error: 'not_found', path }, 404)
    return new Response(new Uint8Array(file.body), {
      headers: {
        'content-type': file.contentType,
        // The assets are unversioned — no build step means no content hash in
        // the filename — so a cached copy would survive a solver upgrade and
        // leave an operator reading a console that no longer matches the API
        // behind it. Correctness beats the handful of bytes: revalidate every
        // time. These files are served from local disk over a LAN or a tunnel.
        'cache-control': 'no-cache',
      },
    })
  })

  // JSON rather than Hono's HTML default. Every consumer of /api is a fetch(),
  // and an HTML body on a 404 turns a typo'd route into a JSON parse error
  // that says nothing about what actually went wrong.
  app.notFound((c) => c.json({ error: 'not_found', path: new URL(c.req.url).pathname }, 404))

  // Likewise for thrown errors: the client renders `error` into a banner, so a
  // stack-trace HTML page would surface as an unreadable blob. The message is
  // included because this port is already operator-only — but never the error
  // object itself, which is the rule `cli.ts` states for the same reason:
  // config objects carry mnemonics.
  app.onError((error, c) =>
    c.json({ error: 'internal', message: error instanceof Error ? error.message : String(error) }, 500),
  )

  return app
}
