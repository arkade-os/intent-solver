/**
 * One answer to "is this solver advertising?", for every view that asks.
 *
 * TWO FACTS, TWO FIELDS. `mode` is what the OPERATOR configured; `publisher` is
 * whether anything is wired to publish. Collapsing them makes both unreportable — an
 * operator who set `auto` would read `off` and conclude the setting had not taken,
 * which looks like a bug in the thing they just configured. Reported separately, both
 * are true at once: "you asked for auto, and nothing can publish yet."
 *
 * Shared rather than duplicated per route, unlike the generic helpers `diagnostics.ts`
 * copies: the whole requirement is that `/api/card` and `/api/diagnostics` cannot
 * disagree, and a console reading `auto` on one panel and `off` on another is worse
 * than either answer alone.
 */
import type { AdPublishMode } from '@arkade-os/solver-transport/relay/adPublisher.js'
import type { AdminDeps } from './server.js'

export interface ConsolePublishState {
  /** What `NOSTR_AD_PUBLISH` says, whether or not anything can act on it. */
  mode: AdPublishMode
  /**
   * Whether a publisher exists at all. False means `POST /api/actions/post-ad`
   * answers 409 `no_publisher` regardless of {@link ConsolePublishState.mode} —
   * the two are the same fact and must never disagree.
   */
  publisher: boolean
  /** Null when nothing has ever published — including after a FAILED publish. */
  lastPublishedAt: number | null
  lastError: string | null
}

export const publishStateOf = (deps: AdminDeps): ConsolePublishState => {
  const state = deps.adPublisher?.state()
  return {
    // From config, never from the publisher, so this answers identically on
    // every route and answers at all when no publisher exists.
    mode: deps.services.config.nostrAdPublish,
    publisher: deps.adPublisher !== undefined,
    lastPublishedAt: state?.lastPublishedAt ?? null,
    lastError: state?.lastError ?? null,
  }
}
