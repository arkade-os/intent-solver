import { describe, it, expect, vi } from 'vitest'
import type { SendSwapService } from '@arkade-os/solver-corridors/send/orchestrator.js'
import type { ReceiveSwapService } from '@arkade-os/solver-corridors/receive/orchestrator.js'
import { driveCoupledPeers } from '@arkade-os/solver-corridors/coupledHandoff.js'

describe('driveCoupledPeers', () => {
  it('keeps a state-change handler installed before it, and still drives the peer', async () => {
    const priorSend = vi.fn()
    const priorReceive = vi.fn()
    const send = { onStateChange: priorSend, tick: vi.fn(async () => ({})) }
    const receive = { onStateChange: priorReceive, tick: vi.fn(async () => ({})) }
    const peers = { findLiveByPaymentHash: async () => ({ id: 'peer' }) }
    driveCoupledPeers({
      send: send as unknown as SendSwapService,
      receive: receive as unknown as ReceiveSwapService,
      sendStore: peers,
      receiveStore: peers,
      onError: (error) => {
        throw error
      },
    })

    send.onStateChange({ state: 'funded', paymentHash: 'h' }, 'quoted')
    receive.onStateChange({ state: 'settled', paymentHash: 'h' }, 'funded')

    expect(priorSend).toHaveBeenCalledWith({ state: 'funded', paymentHash: 'h' }, 'quoted')
    expect(priorReceive).toHaveBeenCalledWith({ state: 'settled', paymentHash: 'h' }, 'funded')
    await vi.waitFor(() => {
      expect(receive.tick).toHaveBeenCalledWith('peer')
      expect(send.tick).toHaveBeenCalledWith('peer')
    })
  })
})
