import type { Endpoint } from '../shared/endpoint.js'
import type { RfqId } from '../shared/ids.js'
import type { AmountMode } from './quote.js'

export interface Intent<Terms = unknown> {
  readonly rfqId: RfqId | null
  readonly from: Endpoint
  readonly to: Endpoint
  readonly amount: bigint
  readonly amountMode: AmountMode
  // rail specific
  readonly terms: Terms
}
