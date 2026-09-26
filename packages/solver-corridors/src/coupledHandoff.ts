import type { SendSwapService } from './send/orchestrator.js'
import type { ReceiveSwapService } from './receive/orchestrator.js'

interface PeerLookup {
  findLiveByPaymentHash(paymentHash: string): Promise<{ id: string } | null>
}

/**
 * Tick each self-payment leg the moment the other reaches the state it waits on,
 * rather than on the next full sweep. A tick is an idempotent re-read, and the
 * sweep still drives any peer this misses.
 */
export const driveCoupledPeers = (legs: {
  send: SendSwapService
  receive: ReceiveSwapService
  sendStore: PeerLookup
  receiveStore: PeerLookup
  onError: (error: unknown) => void
  onTiming?: (sample: {
    direction: 'send_to_receive' | 'receive_to_send'
    sourceSwapId: string
    peerSwapId?: string
    lookupMs: number
    tickMs?: number
    outcome: 'ok' | 'peer_missing' | 'failed'
  }) => void
}): void => {
  const emitTiming = (sample: Parameters<NonNullable<typeof legs.onTiming>>[0]): void => {
    try {
      legs.onTiming?.(sample)
    } catch {
      // Diagnostics cannot alter the coupled swap outcome.
    }
  }
  const drive = (
    peer: Promise<{ id: string } | null>,
    tick: (id: string) => Promise<unknown>,
    direction: 'send_to_receive' | 'receive_to_send',
    sourceSwapId: string,
  ): void => {
    const started = performance.now()
    void peer
      .then(async (row) => {
        const lookupMs = Math.round(performance.now() - started)
        if (!row) {
          emitTiming({ direction, sourceSwapId, lookupMs, outcome: 'peer_missing' })
          return
        }
        const tickStarted = performance.now()
        try {
          await tick(row.id)
          emitTiming({
            direction,
            sourceSwapId,
            peerSwapId: row.id,
            lookupMs,
            tickMs: Math.round(performance.now() - tickStarted),
            outcome: 'ok',
          })
        } catch (error) {
          emitTiming({
            direction,
            sourceSwapId,
            peerSwapId: row.id,
            lookupMs,
            tickMs: Math.round(performance.now() - tickStarted),
            outcome: 'failed',
          })
          throw error
        }
      })
      .catch(legs.onError)
  }
  const priorSend = legs.send.onStateChange
  legs.send.onStateChange = (row, from) => {
    priorSend?.(row, from)
    if (row.state !== 'funded') return
    drive(
      legs.receiveStore.findLiveByPaymentHash(row.paymentHash),
      (id) => legs.receive.tick(id),
      'send_to_receive',
      row.id,
    )
  }
  const priorReceive = legs.receive.onStateChange
  legs.receive.onStateChange = (row, from) => {
    priorReceive?.(row, from)
    // Not only `claimed`: a coupled receive crosses claimed -> settled in one tick and reports once.
    if (row.state !== 'claimed' && row.state !== 'settled' && row.state !== 'refused') return
    drive(legs.sendStore.findLiveByPaymentHash(row.paymentHash), (id) => legs.send.tick(id), 'receive_to_send', row.id)
  }
}
