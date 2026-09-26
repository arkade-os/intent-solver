import { describe, it, expect, vi } from 'vitest'
import type { SendSwapService } from '@arkade-os/solver-corridors/send/orchestrator.js'
import type { ReceiveSwapService } from '@arkade-os/solver-corridors/receive/orchestrator.js'
import { driveCoupledPeers } from '@arkade-os/solver-corridors/coupledHandoff.js'

describe('driveCoupledPeers', () => {
  it('keeps a state-change handler installed before it, and still drives the peer', async () => {
    const priorSend = vi.fn()
    const priorReceive = vi.fn()
    const onTiming = vi.fn()
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
      onTiming,
    })

    send.onStateChange({ state: 'funded', paymentHash: 'h' }, 'quoted')
    receive.onStateChange({ state: 'settled', paymentHash: 'h' }, 'funded')

    expect(priorSend).toHaveBeenCalledWith({ state: 'funded', paymentHash: 'h' }, 'quoted')
    expect(priorReceive).toHaveBeenCalledWith({ state: 'settled', paymentHash: 'h' }, 'funded')
    await vi.waitFor(() => {
      expect(receive.tick).toHaveBeenCalledWith('peer')
      expect(send.tick).toHaveBeenCalledWith('peer')
      expect(onTiming).toHaveBeenCalledWith(
        expect.objectContaining({ direction: 'send_to_receive', peerSwapId: 'peer', outcome: 'ok' }),
      )
    })

    receive.onStateChange({ state: 'refused', paymentHash: 'h' }, 'armed')
    await vi.waitFor(() => expect(send.tick).toHaveBeenCalledTimes(2))
  })

  it('keeps driving the peer when diagnostics throw', async () => {
    const send = { onStateChange: undefined as SendSwapService['onStateChange'], tick: vi.fn(async () => ({})) }
    const receive = { tick: vi.fn(async () => ({})) }
    const onError = vi.fn()
    const onTiming = vi.fn(() => {
      throw new Error('diagnostics failed')
    })
    const peers = { findLiveByPaymentHash: async () => ({ id: 'peer' }) }
    driveCoupledPeers({
      send: send as unknown as SendSwapService,
      receive: receive as unknown as ReceiveSwapService,
      sendStore: peers,
      receiveStore: peers,
      onError,
      onTiming,
    })

    send.onStateChange?.({ id: 'send', state: 'funded', paymentHash: 'h' } as never, 'quoted')
    await vi.waitFor(() => expect(onTiming).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ok' })))
    expect(receive.tick).toHaveBeenCalledWith('peer')
    expect(onError).not.toHaveBeenCalled()
  })
})
