export interface RfqRefusalMetadata {
  transport: 'http' | 'relay'
  requestType: 'rfq_request' | 'rfq_status_request'
  rfqId: string | null
  reason: string
}

export type RfqRefusalObserver = (context: string, detail: string, metadata: RfqRefusalMetadata) => void

export const reportRfqRefusal = (
  observer: RfqRefusalObserver | undefined,
  transport: RfqRefusalMetadata['transport'],
  requestType: RfqRefusalMetadata['requestType'],
  outcome: { kind: string; detail?: string; payload?: Record<string, unknown> },
): void => {
  if (
    !observer ||
    (outcome.kind !== 'invalid' && outcome.kind !== 'refused' && !(transport === 'relay' && outcome.kind === 'unknown'))
  )
    return
  const payload = outcome.payload ?? {}
  const rfqId = typeof payload.rfq_id === 'string' && /^[0-9a-f]{64}$/.test(payload.rfq_id) ? payload.rfq_id : null
  const reason = typeof payload.reason === 'string' ? payload.reason : 'unsupported_payload'
  try {
    observer(`${transport} refused`, `${outcome.kind}: ${outcome.detail ?? reason}`, {
      transport,
      requestType,
      rfqId,
      reason,
    })
  } catch {
    // Observability must not prevent the refusal from reaching the client.
  }
}
