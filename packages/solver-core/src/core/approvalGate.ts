/**
 * The large-swap approval gate. Pure: the orchestrators decide WHERE to ask.
 * `>=` so the boundary errs toward more gating; a null threshold is off; and
 * `unreadable` HOLDS, because a gate that fails open provides nothing.
 *
 * Quantities are `bigint` and carry an asset identity: asset payouts outrun
 * `number`. `null` is the BTC leg throughout, as in the offer packet.
 */

export type ApprovalRecord = 'approved' | 'none' | 'unreadable'

/** `null` is BTC and `amount` is sats; otherwise an asset id, in atomic units. */
export interface ApprovalQuantity {
  assetId: string | null
  amount: bigint
}

export interface ApprovalGateInput {
  amount: bigint
  threshold: bigint | null
  approval: ApprovalRecord
}

export type ApprovalVerdict = { proceed: true } | { proceed: false; reason: string }

/** One phrasing for every corridor, so a test can pin it. */
export const APPROVAL_REFUSAL = 'awaiting operator approval: this swap is at or above the approval threshold'

/**
 * A function, so a corridor cannot reach past it to the threshold, the store or
 * the notifier. MUST NOT REJECT: the host turns failures into `proceed: false`.
 */
export type ApprovalCheck = (swap: { swapId: string } & ApprovalQuantity) => Promise<ApprovalVerdict>

/** A rejection is NOT swallowed: a silent `true` would fail the gate open. */
export const askApprovalFor = async (
  gate: ApprovalCheck | undefined,
  swapId: string,
  quantity: ApprovalQuantity,
): Promise<boolean> => (gate === undefined ? true : (await gate({ swapId, ...quantity })).proceed)

/** The BTC legs' form, unchanged so their three call sites are untouched. */
export const askApproval = (gate: ApprovalCheck | undefined, swapId: string, amountSats: number): Promise<boolean> =>
  askApprovalFor(gate, swapId, { assetId: null, amount: BigInt(amountSats) })

export const evaluateApproval = ({ amount, threshold, approval }: ApprovalGateInput): ApprovalVerdict => {
  if (threshold === null) return { proceed: true }
  if (threshold < 0n) {
    throw new Error(`approval threshold ${threshold} is negative; use null to disable the gate, never a negative`)
  }
  if (amount < threshold) return { proceed: true }
  return approval === 'approved' ? { proceed: true } : { proceed: false, reason: APPROVAL_REFUSAL }
}
