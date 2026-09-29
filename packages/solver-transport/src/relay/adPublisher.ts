/**
 * Keeps the relay's copy of this solver's kind-38859 ad current.
 *
 * Change detection is a digest of the ad payload, not a hand-rolled comparison
 * of fees, limits and relays: there is then no way for the comparison and the
 * document to drift apart. `cardDigest` takes `object`, so the ad reuses it.
 *
 * A failure never advances the published digest — believing a failed publish
 * succeeded is how a solver goes quietly undiscoverable.
 */
import { hex } from '@scure/base'
import { cardDigest } from '@arkade-os/solver-core/core/registryCard.js'
import type { SolverAd } from '@arkade-os/solver-core/core/solverAd.js'
import { messageOf } from '@arkade-os/solver-core/util/poll.js'
import { eventId, type RelayConnection } from './connection.js'

export type AdPublishMode = 'off' | 'manual' | 'auto'

/** docs/rfq-protocol.md § 3: kind 38859, `d` tag `"rfq1"`. */
export const SOLVER_AD_KEY = { kind: 38859, d: 'rfq1' } as const
export const AD_HEARTBEAT_SECONDS = 1800
const AD_TICK_MS = 30_000

export interface AdPublishState {
  mode: AdPublishMode
  lastPublishedAt: number | null
  lastError: string | null
}

export interface AdPublisherOptions {
  mode: AdPublishMode
  buildAd: () => SolverAd
  publish: (ad: SolverAd) => Promise<void>
  now: () => number
  heartbeatSeconds: number
}

export class AdPublisher {
  private publishedDigest: string | null = null
  private lastPublishedAt: number | null = null
  private lastError: string | null = null

  constructor(private readonly opts: AdPublisherOptions) {}

  state(): AdPublishState {
    return { mode: this.opts.mode, lastPublishedAt: this.lastPublishedAt, lastError: this.lastError }
  }

  /** The ad as it would be published right now. */
  currentAd(): SolverAd {
    return this.opts.buildAd()
  }

  heartbeatSeconds(): number {
    return this.opts.heartbeatSeconds
  }

  /** Publish if the ad changed, or if the heartbeat is due. `auto` only. */
  async publishIfDue(): Promise<void> {
    if (this.opts.mode !== 'auto') return
    const ad = this.opts.buildAd()
    const digest = hex.encode(cardDigest(ad))
    const due = this.lastPublishedAt !== null && this.opts.now() - this.lastPublishedAt >= this.opts.heartbeatSeconds
    if (digest === this.publishedDigest && !due) return
    await this.send(ad, digest)
  }

  /** Publish regardless of change. Refused when `off`. */
  async publishNow(): Promise<void> {
    if (this.opts.mode === 'off') {
      throw new Error('NOSTR_AD_PUBLISH is off: this solver is configured not to publish to Nostr')
    }
    const ad = this.opts.buildAd()
    await this.send(ad, hex.encode(cardDigest(ad)))
  }

  private async send(ad: SolverAd, digest: string): Promise<void> {
    try {
      await this.opts.publish(ad)
      this.publishedDigest = digest
      this.lastPublishedAt = this.opts.now()
      this.lastError = null
    } catch (error) {
      this.lastError = messageOf(error)
      throw error
    }
  }
}

export interface AdPublishing {
  publisher: AdPublisher
  stop(): void
}

/**
 * The publisher `NOSTR_AD_PUBLISH` asks for, or none under `off`. `auto` also
 * ticks {@link AdPublisher.publishIfDue}, skipping while disconnected.
 */
export const startAdPublishing = (opts: {
  mode: AdPublishMode
  connection: Pick<RelayConnection, 'publish' | 'isConnected'>
  /** The wallet identity; the codec refuses to sign as anyone else. */
  author: string
  buildAd: () => SolverAd
  onError: (error: unknown) => void
  nowMs?: () => number
}): AdPublishing | undefined => {
  if (opts.mode === 'off') return undefined
  const nowMs = opts.nowMs ?? Date.now
  const { connection, author } = opts
  const publisher = new AdPublisher({
    mode: opts.mode,
    buildAd: opts.buildAd,
    publish: async (ad) => {
      // `publish` resolves on QUEUEING, so a disconnected publish would be
      // recorded as a success the relay never saw.
      if (!connection.isConnected()) throw new Error('relay is not connected; the ad was not published')
      const at = nowMs()
      await connection.publish({
        id: eventId(author, at),
        author,
        createdAtMs: at,
        payload: ad,
        replaceable: SOLVER_AD_KEY,
      })
    },
    now: () => Math.floor(nowMs() / 1000),
    heartbeatSeconds: AD_HEARTBEAT_SECONDS,
  })
  if (opts.mode !== 'auto') return { publisher, stop: () => {} }
  const tick = (): void => {
    if (connection.isConnected()) publisher.publishIfDue().catch(opts.onError)
  }
  const timer = setInterval(tick, AD_TICK_MS)
  timer.unref?.()
  tick()
  return { publisher, stop: () => clearInterval(timer) }
}
