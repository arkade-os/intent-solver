/**
 * The swap list and one swap's detail, across all four corridors.
 *
 * Merging four stores into one stream is the whole difficulty. Each has its
 * own row shape and its own state vocabulary, so everything client-facing goes
 * through `projection.ts` — which carries each corridor's real `state` word
 * through verbatim and adds the `phase` that is safe to compare across them.
 *
 * Read-only. Nothing here can change a swap.
 */

import type { Hono } from 'hono'

import { type AdminPhase } from '../projection.js'
import type { CorridorSwapView } from '@arkade-os/solver-core/core/corridor.js'
import type { AdminDeps } from '../server.js'
import type { PageOptions } from '@arkade-os/solver-core/core/page.js'

const PHASES: readonly AdminPhase[] = ['open', 'exposed', 'done', 'failed']

/**
 * One page from each corridor, projected. Returns the corridor's own cursor
 * alongside, because the four stores page independently.
 */
const pageOf = async (
  deps: AdminDeps,
  // `string`, not `Corridor`: the caller has already checked registry
  // membership, which is a wider and more honest gate than the closed union.
  corridor: string,
  options: PageOptions,
): Promise<{ swaps: CorridorSwapView[]; nextCursor: string | null }> =>
  (await readers(deps).get(corridor)?.page(options)) ?? { swaps: [], nextCursor: null }

/**
 * The reader set for this request.
 *
 * Rebuilt per call rather than cached on `deps`: the readers are stateless
 * wrappers over stores the services already hold, and `AdminDeps` is shaped by
 * the console's own composition — threading a set through it would change every
 * caller for no behavioural gain.
 */
const readers = (deps: AdminDeps) => deps.services.readers

/**
 * Full row plus timeline for one swap, or null when that corridor has no such id.
 *
 * Reads the READER set rather than the serving one: a corridor an operator
 * switched off still has a store, and its in-flight swaps must stay inspectable
 * — that is when an operator most needs to look at them.
 *
 * The `get()`-throws-on-miss handling now lives in the corridor's own `detail`,
 * which answers null for the same reason it did here: a miss is a 404, not a
 * 500, because the caller asked a reasonable question about an id that does not
 * exist.
 */
const detailOf = async (
  deps: AdminDeps,
  corridor: string,
  id: string,
): Promise<{
  raw: unknown
  swap: CorridorSwapView
  history: { at: number; from: string | null; to: string; detail: string | null }[]
} | null> => (await readers(deps).get(corridor)?.detail(id)) ?? null

export const registerSwapRoutes = (app: Hono, deps: AdminDeps): void => {
  app.get('/api/swaps', async (c) => {
    const query = c.req.query()
    const corridorParam = query.corridor
    // Membership in the REGISTRY, not in the closed `CORRIDORS` array: a
    // corridor this build was never compiled against is still readable, and
    // answering 400 for one would hide its swaps from the only screen that
    // lists them. Operator ACTIONS stay closed — see `actions.ts`, which
    // reaches per-corridor orchestrator methods a registry cannot generalise.
    if (corridorParam !== undefined && !readers(deps).get(corridorParam)) {
      return c.json({ error: 'unknown_corridor', corridor: corridorParam }, 400)
    }
    const phase = query.phase
    if (phase !== undefined && !PHASES.includes(phase as AdminPhase)) {
      return c.json({ error: 'unknown_phase', phase }, 400)
    }

    const options: PageOptions = {
      states: query.state ? [query.state] : undefined,
      limit: query.limit === undefined ? undefined : Number(query.limit),
      cursor: query.cursor ?? null,
      // `q` is whatever the user was given — a txid fragment, a payment hash, an
      // address, an rfq id. Each store matches it against its own identifier
      // columns; nothing here names one, because the four corridors spell the
      // same identifier differently. A term too short to be a search throws
      // from `pageQuery` and lands in the 400 below with the reason.
      searchTerm: query.q?.trim() || undefined,
    }

    // Asking only the named corridor is the point of the filter: querying every
    // store to discard all but one is work an operator watching one corridor
    // should not pay for.
    //
    // Unfiltered means every REGISTERED corridor, not the four this build was
    // compiled with. Listing `CORRIDORS` here would have made a plugged-in
    // corridor's swaps visible only to someone who already knew to ask for it
    // by name — readable in principle and invisible in practice.
    const wanted = corridorParam ? [corridorParam] : [...readers(deps)].map((r) => r.descriptor.pair)
    let pages
    try {
      pages = await Promise.all(
        wanted.map(async (corridor) => ({ corridor, ...(await pageOf(deps, corridor, options)) })),
      )
    } catch (error) {
      // A malformed limit or cursor reaches us as a thrown validation error
      // from `src/core/page.ts`. That is the caller's mistake, so 400 rather
      // than letting onError render it as an internal fault.
      return c.json({ error: 'bad_request', message: error instanceof Error ? error.message : String(error) }, 400)
    }

    const swaps = pages
      .flatMap((page) => page.swaps)
      .filter((swap) => phase === undefined || swap.phase === phase)
      .sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt)

    // Per-corridor cursors rather than one merged token: the stores page
    // independently, and a single opaque cursor would have to encode four
    // positions anyway. Null everywhere means the client has seen everything.
    const cursors = Object.fromEntries(pages.map((page) => [page.corridor, page.nextCursor]))
    return c.json({ swaps, cursors, phases: PHASES })
  })

  app.get('/api/swaps/:corridor/:id', async (c) => {
    const corridor = decodeURIComponent(c.req.param('corridor'))
    if (!readers(deps).get(corridor)) return c.json({ error: 'unknown_corridor', corridor }, 400)
    const detail = await detailOf(deps, corridor, c.req.param('id'))
    if (!detail) return c.json({ error: 'not_found' }, 404)
    return c.json(detail)
  })
}
