import type { Amount } from '../shared/amount.js'
import type { ValueOf } from '../shared/brand.js'
import type { RouteId, SwapId } from '../shared/ids.js'
import type { UnixSeconds } from '../shared/time.js'

export const ApprovalState = {
  Pending: 'pending',
  Approved: 'approved',
} as const

export type ApprovalState = ValueOf<typeof ApprovalState>

/** What the store says about a swap. `unreadable` holds the swap, exactly like `none`. */
export const ApprovalRecord = {
  Approved: 'approved',
  None: 'none',
  Unreadable: 'unreadable',
} as const

export type ApprovalRecord = ValueOf<typeof ApprovalRecord>

export type ApprovalDecision = { readonly proceed: true } | { readonly proceed: false; readonly reason: string }

export interface ApprovalProps {
  readonly swapId: SwapId
  readonly route: RouteId
  readonly quantity: Amount
  readonly requestedAt: UnixSeconds
  readonly approvedAt: UnixSeconds | null
}

// There is no rejected state. An operator who will not approve parks the swap instead.
export class Approval {
  static readonly REFUSAL = 'awaiting operator approval: this swap is at or above the approval threshold'

  private constructor(private props: ApprovalProps) {}

  /** Only a held swap can be approved, so an approval always starts as a request. */
  static request(swapId: SwapId, route: RouteId, quantity: Amount, at: UnixSeconds): Approval {
    return new Approval({ swapId, route, quantity, requestedAt: at, approvedAt: null })
  }

  static restore(props: ApprovalProps): Approval {
    return new Approval(props)
  }

  /** `threshold` null means the asset is not gated. Measured on the payout. */
  static decide(quantity: Amount, threshold: Amount | null, record: ApprovalRecord): ApprovalDecision {
    if (threshold === null) return { proceed: true }
    if (threshold.gt(quantity) || record === ApprovalRecord.Approved) return { proceed: true }
    return { proceed: false, reason: Approval.REFUSAL }
  }

  get swapId(): SwapId {
    return this.props.swapId
  }
  get snapshot(): ApprovalProps {
    return this.props
  }
  get state(): ApprovalState {
    return this.props.approvedAt === null ? ApprovalState.Pending : ApprovalState.Approved
  }

  /** Approving again moves the timestamp: the record says when it was last confirmed. */
  approve(at: UnixSeconds): void {
    this.props = { ...this.props, approvedAt: at }
  }
}
