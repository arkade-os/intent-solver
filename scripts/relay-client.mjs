// Play a wallet client over the relay: send one rfq_request to a provider
// and print every reply addressed back to us. This plus `cli relay` is the full
// outbound-only quote flow with no HTTP anywhere.
//
//   node scripts/relay-client.mjs <providerPubkey> <bolt11> <refundAddress>
//
// RELAY_URL defaults to the mock relay.
import { randomBytes } from 'node:crypto'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'

const [provider, invoice, refundAddress] = process.argv.slice(2)
if (!provider || !invoice || !refundAddress) {
  console.error('usage: relay-client.mjs <providerPubkey> <bolt11> <refundAddress>')
  process.exit(1)
}

// The covenant's client-side refund leaf needs a real x-only key. This script
// never spends that leaf — a fresh throwaway key is exactly what a client that
// keeps no state would use.
const clientRefundPubkey = hex.encode(schnorr.getPublicKey(randomBytes(32)))

const url = process.env.RELAY_URL ?? 'ws://localhost:7447'
const me = `client-${Math.random().toString(36).slice(2, 10)}`
const ws = new WebSocket(url)

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ op: 'sub', id: 's1', filter: { recipient: me } }))
  ws.send(
    JSON.stringify({
      op: 'event',
      event: {
        id: `${me}:req`,
        author: me,
        recipient: provider,
        createdAtMs: Date.now(),
        payload: {
          v: 1,
          type: 'rfq_request',
          rfq_id: hex.encode(randomBytes(32)),
          pair: 'arkade:BTC->lightning:BTC',
          amount_side: 'to',
          profile: { invoice, refund_address: refundAddress, client_refund_pubkey: clientRefundPubkey },
        },
      },
    }),
  )
  console.error('request published; waiting for the provider reply...')
})

ws.addEventListener('message', (ev) => {
  const frame = JSON.parse(String(ev.data))
  if (frame.op !== 'event') return
  console.log(JSON.stringify(frame.event.payload, null, 2))
  const type = frame.event.payload?.type
  if (type === 'rfq_quote' || type === 'rfq_refusal') process.exit(type === 'rfq_quote' ? 0 : 2)
})

setTimeout(() => {
  console.error('no reply within 30s')
  process.exit(1)
}, 30_000)
