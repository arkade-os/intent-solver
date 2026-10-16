import type { UnrolledRefundStep } from '@arkade-os/solver-arkade/arkade/unrolledRefund.js'
import type { BaseSwapStore } from '../db/baseSwapStore.js'

/**
 * Both receive legs' handling of one co-signed L1 refund step. `spent` and `closed`
 * escalate only once `P` is worth nothing: until then the leg's claim recheck runs
 * every tick, and `stuck` would end it.
 */
export const applyUnrolledRefundStep = async <S extends string>(
  store: Pick<BaseSwapStore<unknown, S>, 'patch' | 'transition' | 'fail'>,
  row: { id: string; unrolledRefund: string | null },
  edge: { from: S; to: S },
  step: UnrolledRefundStep,
  preimageStillUseful: boolean,
  recourse: () => string,
): Promise<boolean> => {
  if (step.kind === 'waiting') return false
  if (step.kind === 'pending' || step.kind === 'confirmed') {
    const record = JSON.stringify(step.record)
    if (record !== row.unrolledRefund) await store.patch(row.id, { unrolled_refund: record })
    return step.kind === 'confirmed' ? store.transition(row.id, edge.from, edge.to, {}) : false
  }
  if (preimageStillUseful) return false
  await store.fail(
    row.id,
    edge.from,
    step.kind === 'spent'
      ? 'unrolled lockup spent on L1 with no matching claim found; needs review'
      : `L1 refund of the unrolled lockup refused: ${step.reason} — ${recourse()}`,
  )
  return false
}
