import type { SwapId } from '../shared/ids.js'
import type { Approval } from './approval.js'

export interface ApprovalRepository {
  // Keeps the first request: asking again does not move `requestedAt`.
  request(approval: Approval): Promise<void>
  update(swapId: SwapId, change: (approval: Approval) => void): Promise<Approval>
  get(swapId: SwapId): Promise<Approval | null>
  listPending(): Promise<readonly Approval[]>
}
