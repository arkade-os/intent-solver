import { describe, it, expect } from 'vitest'
import { OpenRfqBidder } from '@arkade-os/solver-transport/ingress/relay.js'
import type { RelayConnection, RelayEvent } from '@arkade-os/solver-transport/relay/connection.js'
import { BID_VALIDITY } from '@arkade-os/solver-core/core/openRfq.js'
import { RFQ_PAIR_SEND } from '@arkade-os/solver-corridors/wire/payloads.js'
import { createBidTail, recordBidsIn } from '@arkade-os/solver-app/admin/bids.js'

const NOW = 1_800_000_000

describe('open-RFQ bid tail', () => {
  it('records each bid the bidder publishes', async () => {
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
      pair: RFQ_PAIR_SEND,
      limits: { minSats: 500, maxSats: 10_000 },
      fee: { bps: 25, flatSats: 0 },
      maxBidsPerMinute: 30,
      onBid: recordBidsIn(tail, () => NOW),
      now: () => NOW * 1000,
    })
    await bidder.start()
    const open = { v: 1, type: 'rfq_open', open_id: 'ab'.repeat(32), pair: RFQ_PAIR_SEND, amount_side: 'to' }
    await deliver({ id: 'e1', author: 'bb'.repeat(32), createdAtMs: NOW * 1000, payload: { ...open, amount: 5000 } })
    await deliver({
      id: 'e2',
      author: 'bb'.repeat(32),
      createdAtMs: NOW * 1000,
      payload: { ...open, open_id: 'cd'.repeat(32), size_bucket: { min: 1000, max: 2000 } },
    })

    const bid = { at: NOW, pair: RFQ_PAIR_SEND, feeBps: 25, validUntil: NOW + BID_VALIDITY }
    expect(tail.recent().entries).toEqual([
      { ...bid, amountSats: null },
      { ...bid, amountSats: 5000 },
    ])
  })
})
