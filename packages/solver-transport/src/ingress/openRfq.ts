import { RfqOpen, rfqBidPayload, type RfqBid } from '@arkade-os/solver-core/core/rfqProtocol.js'
import {
  validOpenRfqPrice,
  tokenBucket,
  OPEN_RFQ_MAX_AGE_MS,
  type TokenBucket,
  type OpenRfq,
  type OpenRfqPrice,
} from '@arkade-os/solver-core/core/openRfq.js'
import type { SolverCard } from '@arkade-os/solver-core/core/registryCard.js'
import { eventId, type RelayConnection, type RelayEvent, type RelaySubscription } from '../relay/connection.js'

export interface OpenRfqBidderDeps {
  connection: RelayConnection
  providerPubkey: string
  pairs(): Promise<readonly string[]>
  card(): Promise<SolverCard>
  preview(open: OpenRfq): Promise<OpenRfqPrice | undefined>
  maxBidsPerMinute: number
  bidBucket?: TokenBucket
  onBid?: (open: OpenRfq, bid: RfqBid) => void
  onError?: (context: string, error: unknown) => void
  now?: () => number
}

export class OpenRfqBidder {
  private readonly now: () => number
  private readonly bucket
  private readonly seen = new Map<string, number>()
  private readonly subscriptions = new Map<string, RelaySubscription>()
  private stopped = true
  private refreshTimer?: ReturnType<typeof setInterval>
  private refreshing?: Promise<void>

  constructor(private readonly deps: OpenRfqBidderDeps) {
    this.now = deps.now ?? Date.now
    this.bucket = deps.bidBucket ?? tokenBucket(deps.maxBidsPerMinute, this.now())
  }

  async start(): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    this.refreshTimer = setInterval(
      () => void this.refresh().catch((error) => this.deps.onError?.('open-rfq refresh', error)),
      30_000,
    )
    this.refreshTimer.unref?.()
    try {
      await this.refresh()
    } catch (error) {
      this.deps.onError?.('open-rfq refresh', error)
    }
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.refreshSubscriptions().finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async refreshSubscriptions(): Promise<void> {
    const pairs = new Set(await this.deps.pairs())
    if (this.stopped) return
    for (const [pair, subscription] of this.subscriptions) {
      if (pairs.has(pair)) continue
      this.subscriptions.delete(pair)
      await subscription.close()
    }
    for (const pair of pairs) {
      if (this.stopped || this.subscriptions.has(pair)) continue
      const subscription = await this.deps.connection.subscribe({ topic: pair, sinceMs: this.now() }, (event) =>
        this.handle(event),
      )
      if (this.stopped) await subscription.close()
      else this.subscriptions.set(pair, subscription)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.refreshTimer)
    const subscriptions = [...this.subscriptions.values()]
    this.subscriptions.clear()
    await Promise.all(subscriptions.map((subscription) => subscription.close()))
  }

  private async handle(event: RelayEvent): Promise<void> {
    try {
      const parsed = RfqOpen.safeParse(event.payload)
      const now = this.now()
      if (this.stopped || !parsed.success || event.recipient !== undefined) return
      const open = parsed.data
      if (event.topic !== open.pair || !this.subscriptions.has(open.pair)) return
      if (
        !Number.isSafeInteger(event.createdAtMs) ||
        event.createdAtMs > now + 5000 ||
        now - event.createdAtMs > OPEN_RFQ_MAX_AGE_MS
      )
        return
      if (open.bids_until <= Math.floor(now / 1000) || open.bids_until > Math.floor(now / 1000) + 60) return
      for (const [id, expiry] of this.seen) if (expiry <= now) this.seen.delete(id)
      const id = `${event.author}:${open.open_id}`
      // Charge before fetching a price so unquotable opens cannot bypass the work budget.
      if (this.seen.has(id) || !this.bucket.take(now)) return
      if (this.seen.size >= 1024) this.seen.delete(this.seen.keys().next().value!)
      this.seen.set(id, open.bids_until * 1000)
      const price = await this.deps.preview(open)
      if (!price || this.stopped || Math.floor(this.now() / 1000) >= open.bids_until) return
      if (!validOpenRfqPrice(open, price, Math.floor(this.now() / 1000))) return
      const card = await this.deps.card()
      if (
        card.discovery_pubkey !== this.deps.providerPubkey ||
        !card.sig ||
        this.stopped ||
        Math.floor(this.now() / 1000) >= open.bids_until
      )
        return
      if (!(await this.deps.pairs()).includes(open.pair)) return
      if (this.stopped || Math.floor(this.now() / 1000) >= open.bids_until) return
      const bid = rfqBidPayload(open, { ...price, card })
      await this.deps.connection.publish({
        id: eventId(this.deps.providerPubkey, this.now()),
        author: this.deps.providerPubkey,
        recipient: event.author,
        replyTo: event.id,
        createdAtMs: this.now(),
        payload: bid,
      })
      this.deps.onBid?.(open, bid)
    } catch (error) {
      this.deps.onError?.('open-rfq handle', error)
    }
  }
}
