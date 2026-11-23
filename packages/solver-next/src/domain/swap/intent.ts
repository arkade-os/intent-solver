import type { Amount } from '../shared/amount.js'
import type { Endpoint } from '../shared/endpoint.js'
import type { RfqId } from '../shared/ids.js'
import type { AmountMode } from './quote.js'

export interface Intent<Terms = unknown> {
  readonly rfqId: RfqId | null
  readonly from: Endpoint
  readonly to: Endpoint
  /** In the asset of the side `amountMode` fixes. */
  readonly amount: Amount
  readonly amountMode: AmountMode
  // rail specific
  readonly terms: Terms
}
