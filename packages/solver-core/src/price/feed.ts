/**
 * Fetching a price from an operator-configured HTTP feed.
 *
 * The I/O half of `core/priceFeed.ts`, which holds the pure parts: the RFC 6901
 * pointer, the provider defaults, and the exact-integer conversion. Split the
 * way `packages/solver-rails-evm/src/evm/` splits `rpc.ts` from `backend.ts`, and for the same reason -
 * everything that decides anything stays testable without a network.
 *
 * FETCHED PER QUOTE, NOT CACHED, matching `arkade-os/solver`'s
 * `pkg/swap/pricefeed/pricefeed.go` exactly. That puts a network call on the
 * money path, which is a real cost and a deliberate one for now: a cache needs a
 * staleness bound, and "quote against a price up to N seconds old" is a risk
 * decision an operator should make rather than something this module should pick.
 * The seam is here when that is decided - one memo around `fetchPrice` and
 * nothing above it changes.
 *
 * It refuses rather than guesses, like `evm/rpc.ts`. A feed that answers 500, or
 * HTML from a proxy, or a body missing the pointer, must not become a price:
 * every one of those would price a swap against a number nobody chose.
 */

import { defaultPricePath, resolvePrice, validatePricePath, type Price } from '../core/priceFeed.js'

export interface PriceFeedDeps {
  /**
   * How long one fetch may take, milliseconds.
   *
   * Ten seconds, the same figure the Go solver uses, and for the same reason a
   * timeout exists in `evm/rpc.ts`: this is awaited on the quote path, so a feed
   * that accepts the connection and never answers would otherwise hold a client
   * waiting with no refusal and no log line.
   */
  timeoutMs?: number
  /** Injected so tests need no network. Defaults to the global. */
  fetch?: typeof globalThis.fetch
}

const DEFAULT_TIMEOUT_MS = 10_000

/** Reads the price at `pricePath` in the response from `feedUrl`. */
export type FetchPrice = (feedUrl: string, pricePath: string) => Promise<Price>

export const createPriceFeed = (deps: PriceFeedDeps = {}): FetchPrice => {
  const { timeoutMs = DEFAULT_TIMEOUT_MS } = deps
  // Checked HERE rather than at the first request, which is where
  // `AbortSignal.timeout` would otherwise raise it. A misconfigured timeout is
  // a startup fault: letting it through means the process comes up healthy,
  // serves nothing, and dies on the first quote a client asks for — with a
  // `RangeError` from deep in a fetch rather than a message naming the setting.
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error(`price feed timeoutMs must be a non-negative finite number, got ${timeoutMs}`)
  }
  const call = deps.fetch ?? globalThis.fetch

  return async (feedUrl, pricePath) => {
    // Validated BEFORE the request, so a malformed pointer costs no network call
    // and reports the pointer rather than whatever the feed happened to answer.
    validatePricePath(pricePath)

    const response = await call(feedUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })

    // Body first, then status - the same order `evm/rpc.ts` reads them, because
    // a rate-limited or unauthorised feed puts the actionable part in the body
    // and "429" alone turns a one-line fix into an investigation.
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`price feed ${feedUrl}: HTTP ${response.status} ${response.statusText} - ${text.slice(0, 200)}`)
    }

    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      // An HTML error page from a proxy in front of the feed lands here.
      throw new Error(`price feed ${feedUrl}: response was not JSON - ${text.slice(0, 200)}`)
    }

    // Derived only when the operator left it empty, and only for the providers
    // whose shape is known. A feed we cannot derive is REFUSED rather than
    // guessed at: guessing would price the swap against whatever number happened
    // to sit at the guessed pointer.
    const pointer = pricePath === '' ? defaultPricePath(feedUrl) : pricePath
    if (pointer === null) {
      throw new Error(`price feed ${feedUrl}: price_path is required, it cannot be derived from this URL`)
    }
    return resolvePrice(body, pointer)
  }
}
