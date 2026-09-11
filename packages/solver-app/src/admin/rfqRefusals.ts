import {
  sanitizeRfqRefusalText,
  type RfqRefusalMetadata,
  type RfqRefusalObserver,
} from '@arkade-os/solver-transport/ingress/refusals.js'

export interface RecordedRfqRefusal extends RfqRefusalMetadata {
  at: number
  detail: string
}

export const createRfqRefusalTail = (capacity = 200) => {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('refusal capacity must be positive')
  const entries: RecordedRfqRefusal[] = []
  return {
    record: (refusal: RecordedRfqRefusal): void => {
      entries.unshift({
        at: refusal.at,
        transport: refusal.transport,
        requestType: refusal.requestType,
        rfqId: refusal.rfqId,
        reason: sanitizeRfqRefusalText(refusal.reason, 100),
        detail: sanitizeRfqRefusalText(refusal.detail, 1024),
      })
      if (entries.length > capacity) entries.length = capacity
    },
    recent: () => ({ entries: entries.map((entry) => ({ ...entry })), ephemeral: true as const, capacity }),
  }
}

export type RfqRefusalRecorder = ReturnType<typeof createRfqRefusalTail>

export const recordRfqRefusals =
  (
    recorder: RfqRefusalRecorder,
    log: (context: string, detail: string) => void,
    now: () => number = () => Math.floor(Date.now() / 1000),
  ): RfqRefusalObserver =>
  (context, detail, metadata) => {
    const safeDetail = sanitizeRfqRefusalText(detail, 1024)
    recorder.record({
      ...metadata,
      reason: sanitizeRfqRefusalText(metadata.reason, 100),
      at: now(),
      detail: safeDetail,
    })
    log(`${context}:`, safeDetail)
  }
