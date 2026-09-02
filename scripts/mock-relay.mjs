// Mock relay: a tiny in-memory pub/sub broker speaking the provider's frame
// protocol (packages/solver-transport/src/relay/connection.ts). Dev tool only — a real deployment points
// the frame codec at a production relay instead. Run: node scripts/mock-relay.mjs
import { WebSocketServer } from 'ws'

const port = Number(process.env.MOCK_RELAY_PORT ?? 7447)
const server = new WebSocketServer({ port })

/** socket -> Map(subId -> filter) */
const subscribers = new Map()

// A relay is untyped infrastructure, so this dev broker hand-rolls the frame
// handling rather than importing the codec from packages/solver-transport/src/relay/connection.ts (which
// is the ONE place the client speaks the protocol). Keep the two in step: `sub`
// carries { id, filter }, `event` carries { event }, and this filter mirrors
// `matchesFilter`.
const matches = (event, filter) => {
  if (filter.recipient !== undefined && event.recipient !== filter.recipient) return false
  if (filter.topic !== undefined && event.topic !== filter.topic) return false
  if (filter.sinceMs !== undefined && event.createdAtMs < filter.sinceMs) return false
  return true
}

server.on('connection', (socket) => {
  subscribers.set(socket, new Map())
  socket.on('close', () => subscribers.delete(socket))
  socket.on('message', (raw) => {
    let frame
    try {
      frame = JSON.parse(String(raw))
    } catch {
      return
    }
    if (frame.op === 'sub') subscribers.get(socket)?.set(frame.id, frame.filter ?? {})
    if (frame.op === 'unsub') subscribers.get(socket)?.delete(frame.id)
    if (frame.op === 'event') {
      for (const [peer, subs] of subscribers) {
        for (const filter of subs.values()) {
          if (matches(frame.event, filter)) {
            peer.send(JSON.stringify({ op: 'event', event: frame.event }))
            break // one delivery per peer, however many filters match
          }
        }
      }
    }
  })
})

console.log(`mock relay listening on ws://localhost:${port}`)
