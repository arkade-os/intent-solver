import type { ValueOf } from '../shared/brand.js'
import type { UnixSeconds } from '../shared/time.js'
import type { Preimage } from './hashlock.js'
import type { SwapState } from './swap_state.js'

export const FundingStatus = {
  None: 'none',
  Short: 'short',
  Exact: 'exact',
  Over: 'over',
  Unusable: 'unusable',
} as const

export type FundingStatus = ValueOf<typeof FundingStatus>

export const TxStatus = {
  None: 'none',
  Pending: 'pending',
  Landed: 'landed',
  Failed: 'failed',
} as const

export type TxStatus = ValueOf<typeof TxStatus>

export const SpentBy = {
  Nobody: 'nobody',
  Claim: 'claim',
  Refund: 'refund',
  Unknown: 'unknown',
} as const

export type SpentBy = ValueOf<typeof SpentBy>

export type SpendStatus =
  { readonly by: Exclude<SpentBy, 'claim'> } | { readonly by: typeof SpentBy.Claim; readonly preimage: Preimage | null }

/** What the rail shows for one leg. */
export interface LegStatus {
  readonly funding: FundingStatus
  readonly matured: boolean
  readonly spent: SpendStatus
  /** What the rail says right now; it can trail `refundOpensAt`, which is measured on the wall clock. */
  readonly refundOpen: boolean
  /** When the contract can no longer be claimed, e.g. a held HTLC's expiry. Null while unknown, or where it has none. */
  readonly expiresAt: UnixSeconds | null
  /** When our own way back opens. Null where the contract gives us none. */
  readonly refundOpensAt: UnixSeconds | null
  /** Seconds after funding until we can refund with no help from the server or the client. Null where there is no such path. */
  readonly refundAloneDelay: number | null
  readonly lock: TxStatus
  readonly claim: TxStatus
  readonly refund: TxStatus
}

export const ApprovalStatus = {
  NotRequired: 'not_required',
  Pending: 'pending',
  Approved: 'approved',
} as const

export type ApprovalStatus = ValueOf<typeof ApprovalStatus>

/** The other swap on the same hash, when both clients are ours. Looked up every tick, never stored. */
export interface PeerSwap {
  readonly state: SwapState
  readonly preimage: Preimage | null
}

export interface Observation {
  readonly now: UnixSeconds
  readonly from: LegStatus
  readonly to: LegStatus
  readonly peer: PeerSwap | null
  /** The key the contract was quoted with is still the live one. */
  readonly keyCurrent: boolean
  readonly approval: ApprovalStatus
  /** The invoice being paid is our own: there is a peer swap and no Lightning payment. */
  readonly ownInvoice: boolean
}
