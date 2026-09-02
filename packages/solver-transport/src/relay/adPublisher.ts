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

export type AdPublishMode = 'off' | 'manual' | 'auto'

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

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

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
