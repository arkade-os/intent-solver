/**
 * Threshold, record and notify in ONE factory, so "held it" and "someone was
 * told" cannot drift apart — `assetOffers.ts`'s `onRefused` shape.
 * SEND LEGS ONLY: on a receive leg the client has already committed, and once a
 * Lightning HTLC is armed the port cannot release it early at all
 * (`ports/lightning.ts`: "the only two outcomes remain settle, or wait for E").
 */

import { evaluateApproval, type ApprovalCheck } from '@arkade-os/solver-core/core/approvalGate.js'
import type { SwapApprovalRequest } from '../admin/db.js'

export interface ApprovalRecordStore {
  isSwapApproved(swapId: string): Promise<boolean>
  recordApprovalRequest(request: SwapApprovalRequest): Promise<boolean>
}

export interface ApprovalGateDeps {
  thresholdSats: number | null
  corridor: string
  store: ApprovalRecordStore
  onHeld?: (request: SwapApprovalRequest) => void
}

/**
 * UNDEFINED rather than a permissive check when off: an unconfigured deployment
 * carries no gate object at all, so off-by-default is structural.
 */
export const approvalGateFor = (deps: ApprovalGateDeps): ApprovalCheck | undefined => {
  const { thresholdSats, corridor, store, onHeld } = deps
  if (thresholdSats === null) return undefined

  return async ({ swapId, amountSats }) => {
    // Before the store, so an ordinary swap costs no query and leaves no row.
    if (evaluateApproval({ amountSats, thresholdSats, approval: 'none' }).proceed) return { proceed: true }

    // A throw is `unreadable`, which holds. `none` reaches the same verdict
    // today and would fail OPEN the day it gets its own branch.
    let approval: 'approved' | 'unreadable' | 'none'
    try {
      approval = (await store.isSwapApproved(swapId)) ? 'approved' : 'none'
    } catch {
      approval = 'unreadable'
    }

    const verdict = evaluateApproval({ amountSats, thresholdSats, approval })
    if (verdict.proceed) return verdict

    // After the verdict: neither the record nor the message may turn a hold
    // into a spend. An unrecordable swap is still held.
    try {
      const request = { swapId, corridor, amountSats }
      if (await store.recordApprovalRequest(request)) onHeld?.(request)
    } catch {
      // Intentionally ignored — see above.
    }
    return verdict
  }
}
