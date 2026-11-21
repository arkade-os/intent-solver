import { OPEN_RFQ_ATOMIC, type RfqOpenPayload } from './rfqProtocol.js'

export const OPEN_RFQ_MAX_AGE_MS = 60_000
/** The client's clock, not ours: the SDK allows bid stamps the same 30 s each way. */
export const OPEN_RFQ_MAX_FUTURE_MS = 30_000

export type OpenRfq = RfqOpenPayload
export interface OpenRfqPrice {
  from_amount: string
  to_amount: string
  valid_until: number
}

export const validOpenRfqPrice = (open: OpenRfq, price: OpenRfqPrice, nowSeconds: number): boolean =>
  OPEN_RFQ_ATOMIC.safeParse(price.from_amount).success &&
  OPEN_RFQ_ATOMIC.safeParse(price.to_amount).success &&
  Number.isSafeInteger(price.valid_until) &&
  price.valid_until > Math.max(nowSeconds, open.bids_until) &&
  (open.amount_side === 'from' ? price.from_amount : price.to_amount) === open.amount

export interface TokenBucket {
  take(nowMs: number): boolean
}

export const tokenBucket = (perMinute: number, startMs: number): TokenBucket => {
  if (!Number.isInteger(perMinute) || perMinute <= 0) {
    throw new Error(`token bucket rate must be a positive integer, got ${perMinute}`)
  }
  let tokens = perMinute
  let lastMs = startMs
  return {
    take(nowMs: number): boolean {
      const elapsed = Math.max(0, nowMs - lastMs)
      lastMs = nowMs
      tokens = Math.min(perMinute, tokens + (elapsed * perMinute) / 60_000)
      if (tokens < 1) return false
      tokens -= 1
      return true
    },
  }
}
