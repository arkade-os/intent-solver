import { describe, it, expect } from 'vitest'
import { OpenRfqBidder } from '@arkade-os/solver-transport/ingress/openRfq.js'
import type { RelayConnection, RelayEvent } from '@arkade-os/solver-transport/relay/connection.js'
import { buildSolverCard } from '@arkade-os/solver-core/core/registryCard.js'
import type { OpenRfq } from '@arkade-os/solver-core/core/openRfq.js'
import { createBidTail, recordBidsIn } from '@arkade-os/solver-app/admin/bids.js'

const NOW = 1_800_000_000
const pair = 'arkade:bitcoin/slip44:0->bolt11:bitcoin/slip44:0'
const open: OpenRfq = {
  v: 1,
  type: 'rfq_open',
  open_id: 'ab'.repeat(32),
  pair,
  amount_side: 'from',
  amount: '5000',
  bids_until: NOW + 5,
}

describe('open-RFQ bid tail', () => {
  it('records the exact price pair of every published bid', async () => {
    let deliver: (event: RelayEvent) => void | Promise<void> = () => {}
    const connection: RelayConnection = {
      publish: async () => {},
      subscribe: async (_filter, onEvent) => {
        deliver = onEvent
        return { close: async () => {} }
      },
      isConnected: () => true,
      close: async () => {},
    }
    const tail = createBidTail()
    const bidder = new OpenRfqBidder({
      connection,
      providerPubkey: 'aa'.repeat(32),
      pairs: async () => [pair],
      card: async () => ({
        ...buildSolverCard({
          name: 'bidder',
          network: 'bitcoin',
          discoveryPubkey: 'aa'.repeat(32),
          relays: ['wss://relay.example'],
          corridors: {
            'arkade:BTC->lightning:BTC': { limits: { minSats: 1, maxSats: 10000 }, fee: { bps: 0, flatSats: 0 } },
          },
        }),
        sig: 'aa'.repeat(64),
      }),
      preview: async () => ({ from_amount: '5000', to_amount: '4950', valid_until: NOW + 30 }),
      maxBidsPerMinute: 30,
      onBid: recordBidsIn(tail, () => NOW),
      now: () => NOW * 1000,
    })
    await bidder.start()
    try {
      await deliver({ id: 'e1', author: 'bb'.repeat(32), topic: pair, createdAtMs: NOW * 1000, payload: open })
      await deliver({
        id: 'e2',
        author: 'bb'.repeat(32),
        topic: pair,
        createdAtMs: NOW * 1000,
        payload: { ...open, open_id: 'cd'.repeat(32), amount_side: 'to', amount: '4950' },
      })
      expect(tail.recent().entries).toEqual([
        { at: NOW, pair, amountSide: 'to', fromAmount: '5000', toAmount: '4950', validUntil: NOW + 30 },
        { at: NOW, pair, amountSide: 'from', fromAmount: '5000', toAmount: '4950', validUntil: NOW + 30 },
      ])
    } finally {
      await bidder.stop()
    }
  })

  it('preserves atomic values beyond number precision in the ephemeral tail', () => {
    const tail = createBidTail()
    const amount = '100000000000000000001'
    recordBidsIn(tail, () => NOW)(
      { ...open, amount },
      { from_amount: amount, to_amount: '99999999999999999999', valid_until: NOW + 30 },
    )
    expect(tail.recent().entries[0]?.fromAmount).toBe(amount)
    expect(tail.recent().ephemeral).toBe(true)
  })
})
