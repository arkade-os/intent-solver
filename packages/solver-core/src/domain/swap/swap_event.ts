import type { RfqId, SwapId } from '../shared/ids.js'
import type { UnixSeconds } from '../shared/time.js'
import type { Hashlock, Preimage } from './hashlock.js'
import type { LegReferences, LegState, LegTerms, Side } from './leg.js'
import type { AmountMode, Quote } from './quote.js'
import type { SwapOutcome } from './swap_state.js'

export const SWAP_TOPIC = 'swap'

interface SwapEventBase {
  readonly topic: typeof SWAP_TOPIC
  readonly id: SwapId
  readonly at: UnixSeconds
}

export interface SwapQuoted extends SwapEventBase {
  readonly type: 'SwapQuoted'
  /** Null for a standing offer, which answers no request. */
  readonly rfqId: RfqId | null
  readonly amountMode: AmountMode
  readonly quote: Quote
  readonly hashlock: Hashlock | null
  readonly from: LegTerms
  readonly to: LegTerms
}

export interface LegAdvanced extends SwapEventBase {
  readonly type: 'LegAdvanced'
  readonly side: Side
  readonly state: LegState
  readonly references: LegReferences
  readonly preimage: Preimage | null
}

export interface LegReferenced extends SwapEventBase {
  readonly type: 'LegReferenced'
  readonly side: Side
  readonly references: LegReferences
}

/** One transaction took the client's offer and paid them: both legs end together. */
export interface OfferFilled extends SwapEventBase {
  readonly type: 'OfferFilled'
  readonly fill: string | null
}

export interface SwapFailed extends SwapEventBase {
  readonly type: 'SwapFailed'
  readonly outcome: SwapOutcome
  readonly reason: string
}

export interface SwapResumed extends SwapEventBase {
  readonly type: 'SwapResumed'
}

export type SwapEvent = SwapQuoted | LegAdvanced | LegReferenced | OfferFilled | SwapFailed | SwapResumed
