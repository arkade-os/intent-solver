/**
 * Threshold, record and notify in ONE factory. SEND LEGS ONLY: on a receive leg
 * the client has already committed, and once a Lightning HTLC is armed the port
 * cannot release it early ("the only two outcomes remain settle, or wait for E").
 *
 * THAT RULE EXCLUDES `onchain:BTC->arkade:<asset>`: its client's L1 BTC confirms
 * BEFORE the solver funds the asset lockup, so a hold would charge them a
 * locktime wait on money already sent; the exposure cap bounds it instead. Offer
 * fills and asset RFQ ARE gated — their counterparty can still reclaim.
 */

import { evaluateApproval, type ApprovalCheck } from '@arkade-os/solver-core/core/approvalGate.js'
import type { SwapApprovalRequest } from '../admin/db.js'

export interface ApprovalRecordStore {
  isSwapApproved(swapId: string): Promise<boolean>
  recordApprovalRequest(request: SwapApprovalRequest): Promise<boolean>
}

export interface ApprovalGateDeps {
  thresholdSats: number | null
  assetThresholds?: ReadonlyMap<string, bigint>
  corridor: string
  store: ApprovalRecordStore
  onHeld?: (request: SwapApprovalRequest) => void
}

/**
 * UNDEFINED rather than a permissive check when off: an unconfigured deployment
 * carries no gate object at all, so off-by-default is structural.
 *
 * PER ASSET it lives one level down — one gate object pays several assets, so an
 * unconfigured one resolves to a null threshold. `createServices` logs those.
 */
export const approvalGateFor = (deps: ApprovalGateDeps): ApprovalCheck | undefined => {
  const { thresholdSats, assetThresholds, corridor, store, onHeld } = deps
  if (thresholdSats === null && !(assetThresholds && assetThresholds.size > 0)) return undefined

  const thresholdFor = (assetId: string | null): bigint | null =>
    assetId === null ? (thresholdSats === null ? null : BigInt(thresholdSats)) : (assetThresholds?.get(assetId) ?? null)

  return async ({ swapId, assetId, amount }) => {
    const threshold = thresholdFor(assetId)
    // Before the store, so an ordinary swap costs no query and leaves no row.
    if (evaluateApproval({ amount, threshold, approval: 'none' }).proceed) return { proceed: true }

    // A throw is `unreadable`, which holds. `none` reaches the same verdict
    // today and would fail OPEN the day it gets its own branch.
    let approval: 'approved' | 'unreadable' | 'none'
    try {
      approval = (await store.isSwapApproved(swapId)) ? 'approved' : 'none'
    } catch {
      approval = 'unreadable'
    }

    const verdict = evaluateApproval({ amount, threshold, approval })
    if (verdict.proceed) return verdict

    // After the verdict: neither the record nor the message may turn a hold
    // into a spend. An unrecordable swap is still held.
    try {
      const request = { swapId, corridor, assetId, amount }
      if (await store.recordApprovalRequest(request)) onHeld?.(request)
    } catch {
      // Intentionally ignored — see above.
    }
    return verdict
  }
}
