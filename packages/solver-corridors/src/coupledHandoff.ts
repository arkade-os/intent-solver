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
}): void => {
  const drive = (peer: Promise<{ id: string } | null>, tick: (id: string) => Promise<unknown>): void => {
    void peer.then((row) => (row ? tick(row.id) : undefined)).catch(legs.onError)
  }
  const priorSend = legs.send.onStateChange
  legs.send.onStateChange = (row, from) => {
    priorSend?.(row, from)
    if (row.state !== 'funded') return
    drive(legs.receiveStore.findLiveByPaymentHash(row.paymentHash), (id) => legs.receive.tick(id))
  }
  const priorReceive = legs.receive.onStateChange
  legs.receive.onStateChange = (row, from) => {
    priorReceive?.(row, from)
    // Not only `claimed`: a coupled receive crosses claimed -> settled in one tick and reports once.
    if (row.state !== 'claimed' && row.state !== 'settled' && row.state !== 'refused') return
    drive(legs.sendStore.findLiveByPaymentHash(row.paymentHash), (id) => legs.send.tick(id))
  }
}
