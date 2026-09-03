/**
 * Where the chain tip is, for the deployments whose timelocks count blocks.
 *
 * A seconds-typed deployment never calls this: its deadlines are answered by the clock
 * it already has. Block mode is the only thing that needs a height, so the provider is
 * optional everywhere it is threaded, and its absence is a configuration error only when
 * a block-typed locktime actually has to be read.
 *
 * CACHED, and not as an optimisation. The orchestrators ask "has this opened yet" once
 * per swap per tick, which against a hundred in-flight swaps is a hundred identical HTTP
 * round-trips a few milliseconds apart, all of which must answer the same thing to be
 * self-consistent — two swaps in one tick deciding against different heights is how one
 * refund gets pushed and its neighbour does not, for no reason either could report. One
 * read per tick, shared.
 */

import type { EsploraClient } from '@arkade-os/solver-rails-esplora/esplora.js'

export interface ChainTipProvider {
  /** The current tip height. */
  height(): Promise<number>
}

/**
 * How long a tip reading stays good, milliseconds.
 *
 * Comfortably under a block at any real cadence, and comfortably over one orchestrator
 * tick — the window that matters, since the point is that every swap in a tick sees one
 * height.
 *
 * On regtest, where blocks arrive on demand rather than on a cadence, this is the lag
 * between mining and the service noticing. A test that mines to maturity and immediately
 * asserts must either wait it out or use its own provider; both are cheaper than making
 * every production tick pay for a fresh read.
 */
export const TIP_CACHE_MS = 15_000

/** Read the tip from an Esplora-compatible indexer. */
export const esploraChainTip = (
  client: EsploraClient,
  opts: { cacheMs?: number; now?: () => number } = {},
): ChainTipProvider => {
  const cacheMs = opts.cacheMs ?? TIP_CACHE_MS
  const now = opts.now ?? Date.now
  let cached: { height: number; readAt: number } | undefined
  // Shared so concurrent callers await ONE request rather than starting a stampede
  // against a cold cache — the exact moment a tick begins.
  let inFlight: Promise<number> | undefined

  return {
    async height(): Promise<number> {
      if (cached && now() - cached.readAt < cacheMs) return cached.height
      inFlight ??= (async () => {
        try {
          const raw = (await client.getText('/blocks/tip/height')).trim()
          const height = Number(raw)
          // Throwing beats returning a plausible wrong number: a NaN height silently
          // makes every `tipHeight >= locktime` comparison false, so every refund looks
          // permanently unripe and nothing is ever pushed. A down indexer must look like
          // a down indexer.
          if (!Number.isInteger(height) || height <= 0) {
            throw new Error(`chain tip height must be a positive integer, got ${JSON.stringify(raw)}`)
          }
          cached = { height, readAt: now() }
          return height
        } finally {
          inFlight = undefined
        }
      })()
      return inFlight
    },
  }
}

/** A fixed tip, for tests and for driving a scenario to a chosen height. */
export const staticChainTip = (height: number): ChainTipProvider => ({
  height: async () => height,
})
