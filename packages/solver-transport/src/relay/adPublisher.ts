/**
 * Keeps the relay's copy of this solver's signed card current, as kind 38859.
 *
 * Change detection is `cardDigest`, which excludes `sig`: every build re-signs
 * with a fresh BIP340 nonce, and that must not read as a change.
 *
 * A failure never advances the published digest — believing a failed publish
 * succeeded is how a solver goes quietly undiscoverable.
 */
import { hex } from '@scure/base'
import { cardDigest, type SolverCard } from '@arkade-os/solver-core/core/registryCard.js'
import type { SwapNetwork } from '@arkade-os/solver-core/core/networks.js'
import { messageOf } from '@arkade-os/solver-core/util/poll.js'
import { eventId, type RelayConnection } from './connection.js'

export type AdPublishMode = 'off' | 'manual' | 'auto'

/** docs/rfq-protocol.md § 3.1: the `d` tag is the card's network, so one key holds one card per network. */
export const SOLVER_CARD_KIND = 38859
export const AD_HEARTBEAT_SECONDS = 1800
const AD_TICK_MS = 30_000

export interface AdPublishState {
  mode: AdPublishMode
  lastPublishedAt: number | null
  lastError: string | null
}

export interface AdPublisherOptions {
  mode: AdPublishMode
  buildAd: () => Promise<SolverCard>
  publish: (card: SolverCard) => Promise<void>
  now: () => number
  heartbeatSeconds: number
}

export class AdPublisher {
  private published: { card: SolverCard; digest: string } | null = null
  private lastPublishedAt: number | null = null
  private lastError: string | null = null

  constructor(private readonly opts: AdPublisherOptions) {}

  state(): AdPublishState {
    return { mode: this.opts.mode, lastPublishedAt: this.lastPublishedAt, lastError: this.lastError }
  }

  heartbeatSeconds(): number {
    return this.opts.heartbeatSeconds
  }

  /** Publish if the card changed, or if the heartbeat is due. */
  async publishIfDue(): Promise<void> {
    if (this.opts.mode === 'off') return
    const due = this.lastPublishedAt !== null && this.opts.now() - this.lastPublishedAt >= this.opts.heartbeatSeconds
    if (this.opts.mode === 'manual') {
      // Clients drop a card older than two hours, so manual re-sends too — but only the card the operator
      // published, byte for byte: a rebuilt one could carry terms they have not seen.
      if (due && this.published) await this.send(this.published.card, this.published.digest)
      return
    }
    const card = await this.build()
    const digest = hex.encode(cardDigest(card))
    if (digest === this.published?.digest && !due) return
    await this.send(card, digest)
  }

  /** Publish regardless of change. Refused when `off`. */
  async publishNow(): Promise<void> {
    if (this.opts.mode === 'off') {
      throw new Error('NOSTR_AD_PUBLISH is off: this solver is configured not to publish to Nostr')
    }
    const card = await this.build()
    await this.send(card, hex.encode(cardDigest(card)))
  }

  /** A card that cannot be built (`SOLVER_NAME` unset, nothing served) is a failed publish, reported as one. */
  private async build(): Promise<SolverCard> {
    try {
      return await this.opts.buildAd()
    } catch (error) {
      this.lastError = messageOf(error)
      throw error
    }
  }

  private async send(card: SolverCard, digest: string): Promise<void> {
    try {
      await this.opts.publish(card)
      this.published = { card, digest }
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
 * The publisher `NOSTR_AD_PUBLISH` asks for, or none under `off`. Either mode
 * ticks {@link AdPublisher.publishIfDue}, skipping while disconnected.
 */
export const startAdPublishing = (opts: {
  mode: AdPublishMode
  connection: Pick<RelayConnection, 'publish' | 'isConnected'>
  /** The wallet identity; the codec refuses to sign as anyone else. */
  author: string
  network: SwapNetwork
  buildAd: () => Promise<SolverCard>
  onError: (error: unknown) => void
  nowMs?: () => number
}): AdPublishing | undefined => {
  if (opts.mode === 'off') return undefined
  const nowMs = opts.nowMs ?? Date.now
  const { connection, author } = opts
  const publisher = new AdPublisher({
    mode: opts.mode,
    buildAd: opts.buildAd,
    publish: async (card) => {
      // `publish` resolves on QUEUEING, so a disconnected publish would be
      // recorded as a success the relay never saw.
      if (!connection.isConnected()) throw new Error('relay is not connected; the card was not published')
      const at = nowMs()
      await connection.publish({
        id: eventId(author, at),
        author,
        createdAtMs: at,
        payload: card,
        replaceable: { kind: SOLVER_CARD_KIND, d: opts.network },
      })
    },
    now: () => Math.floor(nowMs() / 1000),
    heartbeatSeconds: AD_HEARTBEAT_SECONDS,
  })
  // One misconfiguration would otherwise log every tick; `lastError` keeps it on the console meanwhile.
  let reported: string | null = null
  const tick = (): void => {
    if (!connection.isConnected()) return
    publisher.publishIfDue().then(
      () => {
        reported = null
      },
      (error: unknown) => {
        if (messageOf(error) === reported) return
        reported = messageOf(error)
        opts.onError(error)
      },
    )
  }
  const timer = setInterval(tick, AD_TICK_MS)
  timer.unref?.()
  tick()
  return { publisher, stop: () => clearInterval(timer) }
}
