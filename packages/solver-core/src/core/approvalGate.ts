/**
 * The large-swap approval gate. Pure: the orchestrators decide WHERE to ask.
 * `>=` so the boundary errs toward more gating; a null threshold is off; and
 * `unreadable` HOLDS, because a gate that fails open provides nothing.
 */

export type ApprovalRecord = 'approved' | 'none' | 'unreadable'

export interface ApprovalGateInput {
  amountSats: number
  thresholdSats: number | null
  approval: ApprovalRecord
}

export type ApprovalVerdict = { proceed: true } | { proceed: false; reason: string }

/** One phrasing for every corridor, so a test can pin it. */
export const APPROVAL_REFUSAL = 'awaiting operator approval: this swap is at or above the approval threshold'

/**
 * A function, so a corridor cannot reach past it to the threshold, the store or
 * the notifier. MUST NOT REJECT: the host turns failures into `proceed: false`.
 */
export type ApprovalCheck = (swap: { swapId: string; amountSats: number }) => Promise<ApprovalVerdict>

/** A rejection is NOT swallowed: a silent `true` would fail the gate open. */
export const askApproval = async (
  gate: ApprovalCheck | undefined,
  swapId: string,
  amountSats: number,
): Promise<boolean> => (gate === undefined ? true : (await gate({ swapId, amountSats })).proceed)

export const evaluateApproval = ({ amountSats, thresholdSats, approval }: ApprovalGateInput): ApprovalVerdict => {
  if (thresholdSats === null) return { proceed: true }
  if (thresholdSats < 0) {
    throw new Error(`approval threshold ${thresholdSats} is negative; use null to disable the gate, never a negative`)
  }
  if (amountSats < thresholdSats) return { proceed: true }
  return approval === 'approved' ? { proceed: true } : { proceed: false, reason: APPROVAL_REFUSAL }
}
