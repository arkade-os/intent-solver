import type { ReceiveReads } from '@arkade-os/solver-core/core/receivePlan.js'

type Recorded =
  'hold' | 'coupledSend' | 'earlierFunding' | 'refundDeadline' | 'spendable' | 'refundOpen' | 'claim' | 'ownRefund'

/** What the planner read while deciding one tick, under the name of each read. A read it did not make is absent. */
export type ReceiveReadsSeen = { [K in Recorded]?: Awaited<ReturnType<ReceiveReads[K]>> } & {
  /** Everything the lockup script ever held, when a read fetched it. */
  history?: readonly { txid: string; vout: number; value: number; spent: boolean; unrolled: boolean }[]
}

/** The same reads, each keeping a copy of its answer. Nothing is read that the planner does not ask for. */
export const recordingReads = (reads: ReceiveReads): { reads: ReceiveReads; seen: ReceiveReadsSeen } => {
  const seen: ReceiveReadsSeen = {}
  return {
    seen,
    reads: {
      ...reads,
      hold: async () => (seen.hold = await reads.hold()),
      coupledSend: async () => (seen.coupledSend = await reads.coupledSend()),
      earlierFunding: async () => (seen.earlierFunding = await reads.earlierFunding()),
      refundDeadline: async () => (seen.refundDeadline = await reads.refundDeadline()),
      spendable: async () => (seen.spendable = await reads.spendable()),
      refundOpen: async () => (seen.refundOpen = await reads.refundOpen()),
      claim: async () => (seen.claim = await reads.claim()),
      ownRefund: async () => (seen.ownRefund = await reads.ownRefund()),
    },
  }
}
