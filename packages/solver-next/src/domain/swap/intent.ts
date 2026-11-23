import type { Amount } from '../shared/amount.js'
import type { Endpoint } from '../shared/endpoint.js'
import type { RfqId } from '../shared/ids.js'
import type { AmountMode } from './quote.js'

export interface Intent<RailTerms = unknown> {
  readonly rfqId: RfqId | null
  readonly from: Endpoint
  readonly to: Endpoint
  readonly amount: Amount
  readonly amountMode: AmountMode
  readonly railTerms: RailTerms
}
