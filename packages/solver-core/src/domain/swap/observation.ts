import type { ValueOf } from '../shared/brand.js'
import type { UnixSeconds } from '../shared/time.js'
import type { Preimage } from './hashlock.js'
import type { SwapState } from './swap_state.js'

export const FundingSeen = {
  None: 'none',
  Short: 'short',
  Exact: 'exact',
  Over: 'over',
  Unusable: 'unusable',
} as const

export type FundingSeen = ValueOf<typeof FundingSeen>

export const TxSeen = {
  None: 'none',
  Pending: 'pending',
  Landed: 'landed',
  Failed: 'failed',
} as const

export type TxSeen = ValueOf<typeof TxSeen>

export const Spender = {
  Nobody: 'nobody',
  Claim: 'claim',
  Refund: 'refund',
  Unknown: 'unknown',
} as const

export type Spender = ValueOf<typeof Spender>

export type SpentSeen =
  { readonly by: Exclude<Spender, 'claim'> } | { readonly by: typeof Spender.Claim; readonly preimage: Preimage | null }

/** Facts from the rail about one leg. No decisions. */
export interface LegSeen {
  readonly funding: FundingSeen
  readonly matured: boolean
  readonly spent: SpentSeen
  readonly refundOpen: boolean
  readonly lock: TxSeen
  readonly claim: TxSeen
  readonly refund: TxSeen
}

export const ApprovalSeen = {
  NotRequired: 'not_required',
  Pending: 'pending',
  Approved: 'approved',
} as const

export type ApprovalSeen = ValueOf<typeof ApprovalSeen>

/** The other swap on the same hash, when both clients are ours. Looked up every tick, never stored. */
export interface PeerSeen {
  readonly state: SwapState
  readonly preimage: Preimage | null
}

export interface Observation {
  readonly now: UnixSeconds
  readonly from: LegSeen
  readonly to: LegSeen
  readonly peer: PeerSeen | null
  /** The key the contract was quoted with is still the live one. */
  readonly keyCurrent: boolean
  readonly approval: ApprovalSeen
  /** The invoice being paid is our own: there is a peer swap and no Lightning payment. */
  readonly ownInvoice: boolean
}
