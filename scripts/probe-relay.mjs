#!/usr/bin/env node
/**
 * Is our solver actually reachable on the relay right now?
 *
 *   node scripts/probe-relay.mjs wss://nostr.arkade.sh <solver-pubkey-hex>
 *   node scripts/probe-relay.mjs                       # reads RELAY_URL + SOLVER_PUBKEY
 *
 * A Lightning send that goes nowhere has several very different causes and
 * they are indistinguishable from the outside: the relay could be refusing our
 * event kinds, the solver could be pointed at a different relay, it could be
 * running under a different identity key, or it could simply be down. This
 * answers all of them in one shot, without spending an invoice.
 *
 * Raw NIP-01 on purpose, and every frame is printed. A pooled client dedups,
 * reconnects and swallows OK/CLOSED/NOTICE — precisely the frames that carry
 * the diagnosis. The production codec used to swallow them too, which is how a
 * relay refusing every publish and an idle market became the same observation.
 *
 * Exit code 0 when the solver answered, 1 otherwise.
 */
import { WebSocket } from 'ws'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { getConversationKey, encrypt, decrypt } from 'nostr-tools/nip44'
// From the built output, not a local copy: the kind numbers are provisional
// (docs/rfq-protocol.md § 12) and moving them is the next planned change. A
// hardcoded 4859 here would survive that migration and report a perfectly
// healthy solver as "never published" — the exact false diagnosis this script
// exists to prevent. Needs `pnpm build` first, as scripts/regtest-fund.mjs does.
import { NOSTR_KIND_DIRECTED as KIND_DIRECTED } from '@arkade-os/solver-transport/relay/nostr.js'

const WAIT_MS = Number(process.env.PROBE_WAIT_MS ?? 20_000)

const relay = process.argv[2] ?? process.env.RELAY_URL
const solver = process.argv[3] ?? process.env.SOLVER_PUBKEY

if (!relay || !solver) {
  console.error('usage: probe-relay.mjs <wss://relay> <solver-pubkey-hex>')
  console.error('   or: RELAY_URL=… SOLVER_PUBKEY=… node scripts/probe-relay.mjs')
  process.exit(2)
}
if (!/^[0-9a-f]{64}$/.test(solver)) {
  console.error(`solver pubkey must be 64 lowercase hex chars (x-only), got ${JSON.stringify(solver)}`)
  process.exit(2)
}

const sk = generateSecretKey()
const pk = getPublicKey(sk)
const ck = getConversationKey(sk, solver)
const rfqId = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')

// A deliberately undecodable invoice: the ingress answers every well-formed
// request, so a structured refusal coming back proves the whole path — relay,
// kind, p tag, NIP-44 sealing, request schema — without touching real funds.
const request = {
  v: 1,
  type: 'rfq_request',
  rfq_id: rfqId,
  pair: 'arkade:BTC->lightning:BTC',
  amount_side: 'to',
  profile: { invoice: 'lnbc-probe-not-a-real-invoice', refund_address: 'ark1probe' },
}

console.log(`relay   ${relay}`)
console.log(`solver  ${solver}`)
console.log(`probing as ${pk}\n`)

const t0 = Date.now()
const at = () => String(Date.now() - t0).padStart(5)

let acceptedByRelay
let reachedSolverFilter = false
let solverAnswered = false
let solverEverPublished = 0

const ws = new WebSocket(relay)

ws.on('open', () => {
  console.log(`[${at()}ms] connected`)
  // 1. Does an event addressed to the solver reach a subscriber shaped exactly
  //    like the solver's own filter? Separates "relay drops it" from "solver
  //    is not listening".
  ws.send(JSON.stringify(['REQ', 'solver-filter', { kinds: [KIND_DIRECTED], '#p': [solver] }]))
  // 2. Anything addressed back to us.
  ws.send(JSON.stringify(['REQ', 'reply', { kinds: [KIND_DIRECTED], '#p': [pk] }]))
  // 3. Has the solver EVER published here? Zero means it has never been
  //    connected under this key — a config or deployment fault, not a bug.
  ws.send(JSON.stringify(['REQ', 'solver-history', { authors: [solver], limit: 10 }]))

  setTimeout(() => {
    const event = finalizeEvent(
      {
        kind: KIND_DIRECTED,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', solver]],
        content: encrypt(JSON.stringify(request), ck),
      },
      sk,
    )
    ws.send(JSON.stringify(['EVENT', event]))
    console.log(`[${at()}ms] published rfq_request`)
  }, 1500)
})

ws.on('message', (data) => {
  let msg
  try {
    msg = JSON.parse(data.toString())
  } catch {
    return console.log(`[${at()}ms] unparseable frame`)
  }
  const [type, a, b, c] = msg
  if (type === 'OK') {
    acceptedByRelay = b
    console.log(`[${at()}ms] OK accepted=${b}${c ? ` — ${c}` : ''}`)
  } else if (type === 'CLOSED') {
    console.log(`[${at()}ms] CLOSED sub=${a} — ${b}`)
  } else if (type === 'NOTICE') {
    console.log(`[${at()}ms] NOTICE ${a}`)
  } else if (type === 'EOSE') {
    console.log(`[${at()}ms] EOSE sub=${a}`)
  } else if (type === 'EVENT' && a === 'solver-filter' && b.pubkey === pk) {
    reachedSolverFilter = true
    console.log(`[${at()}ms] our request reached the solver's own filter shape`)
  } else if (type === 'EVENT' && a === 'solver-history') {
    solverEverPublished += 1
    console.log(`[${at()}ms] solver has published here: kind=${b.kind}, ${Math.round((Date.now() / 1000 - b.created_at) / 60)} min ago`)
  } else if (type === 'EVENT' && a === 'reply') {
    // Every check below has to pass before this counts as an answer. A
    // diagnostic that reports success for an event it could not verify or
    // decrypt is worse than no diagnostic: anyone can publish to our temporary
    // key, and "the RFQ path is live" is the one conclusion that stops the
    // investigation.
    if (b.pubkey !== solver) {
      console.log(`[${at()}ms] ignoring an event from ${b.pubkey.slice(0, 12)}… — not the solver`)
      return
    }
    if (!verifyEvent(b)) {
      console.log(`[${at()}ms] reply FAILED signature verification — discarded`)
      return
    }
    let payload
    try {
      payload = JSON.parse(decrypt(b.content, ck))
    } catch (error) {
      // Sealed to a key other than the one it was addressed to, or malformed.
      console.log(`[${at()}ms] reply could not be decrypted: ${error.message}`)
      return
    }
    if (payload?.rfq_id !== rfqId) {
      console.log(`[${at()}ms] reply is for a different negotiation (${payload?.rfq_id}) — ignored`)
      return
    }
    solverAnswered = true
    console.log(`[${at()}ms] SOLVER REPLIED: ${JSON.stringify(payload)}`)
  }
})

ws.on('error', (error) => console.log(`[${at()}ms] websocket error: ${error.message}`))

setTimeout(() => {
  console.log(`\nrelay accepted our request:           ${acceptedByRelay === undefined ? 'no answer' : acceptedByRelay ? 'yes' : 'NO'}`)
  console.log(`delivered to the solver's filter:     ${reachedSolverFilter ? 'yes' : 'no'}`)
  console.log(`solver has ever published here:       ${solverEverPublished > 0 ? `yes (${solverEverPublished})` : 'NEVER'}`)
  console.log(`solver answered:                      ${solverAnswered ? 'yes' : 'no'}`)

  if (solverAnswered) console.log('\n=> the RFQ path is live end to end.')
  else if (reachedSolverFilter && solverEverPublished === 0) {
    console.log('\n=> the relay works and our framing is right, but the solver has NEVER')
    console.log('   published here. It is not connected to this relay, or it is running')
    console.log('   under a different identity than the card advertises. Check RELAY_URL')
    console.log('   and that ARK_MNEMONIC derives the pubkey above.')
  } else if (reachedSolverFilter) {
    console.log('\n=> our side is fine; the solver has been here before but is not answering now.')
  } else if (acceptedByRelay) {
    console.log('\n=> the relay took the event but does not deliver it — check the relay.')
  } else {
    console.log('\n=> the relay did not accept the event. The OK/NOTICE lines above say why.')
  }
  process.exit(solverAnswered ? 0 : 1)
}, WAIT_MS)
