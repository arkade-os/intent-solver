// RFQ v1 protocol core for the trader / intent-submitter side.
//
// Dependency-free on purpose: nothing here but web APIs (fetch, WebSocket,
// crypto), so this file is portable to any JS runtime — Node, browser,
// Workers — and is the piece a team porting to another language translates
// first. Protocol spec: docs/rfq-protocol.md.
//
// What this module deliberately does NOT do: derive or verify the lockup
// script. Derivation needs the trader's own Arkade stack and lives in
// swap-client.mjs; the core only carries the messages, enforces the closed
// refusal set, and applies the time gates. The one guardrail it does own is
// `verifyLockupAddress` — the compare-only rule that makes a wrong or
// malicious solver produce an address you refuse, never one that traps funds.

/** The one pair the reference solver serves today. */
export const RFQ_PAIR_SEND = 'arkade:BTC->lightning:BTC'

/** Client-side funding gate: refuse unless ≥90 min remain before the refund path opens. */
export const MIN_HEADROOM_SECONDS = 90 * 60

/** Lifecycle states after which nothing more will happen (docs/rfq-protocol.md § 8). */
export const TERMINAL_STATES = ['settled', 'refused', 'expired', 'refunded', 'stuck']

/** A refusal from the solver, carrying a reason from the CLOSED set (§ 10). */
export class SwapRefusal extends Error {
  constructor(reason, rfqId) {
    super(`solver refused: ${reason}`)
    this.name = 'SwapRefusal'
    this.reason = reason
    this.rfqId = rfqId
  }
}

/**
 * The solver's address does not match the local derivation. NEVER fund past this.
 * `derived` is every candidate address tried — see {@link verifyLockupAddress}.
 */
export class AddressMismatch extends Error {
  constructor(derived, quoted) {
    super('solver lockup address does not match local derivation — refusing to fund')
    this.name = 'AddressMismatch'
    this.derived = derived
    this.quoted = quoted
  }
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

/** A fresh client-chosen negotiation id: 32 random bytes, lowercase hex. */
export const newRfqId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let out = ''
  for (const b of bytes) out += HEX[b]
  return out
}

/**
 * The rfq_request payload for the send profile. A BOLT11 profile is always
 * exact-out. `clientRefundPubkey` is the maker's own key for the covenant's
 * client-unilateral refund leaf — required on every request; it is never
 * sent anywhere else, and its only use is the maker's own future unilateral
 * refund broadcast if both the Arkade server and the emulator are ever
 * unavailable past the quote's `refund_locktime`.
 */
export const buildSendRequest = ({ rfqId, invoice, refundAddress, clientRefundPubkey }) => ({
  v: 1,
  type: 'rfq_request',
  rfq_id: rfqId,
  pair: RFQ_PAIR_SEND,
  amount_side: 'to',
  profile: { invoice, refund_address: refundAddress, client_refund_pubkey: clientRefundPubkey },
})

/**
 * Compare-only verification of the solver's address against YOUR OWN
 * derivation(s) — never extends trust, only narrows it.
 *
 * `derivedAddress` may be a single address or an array of candidates. Pass
 * an array when your own derivation is ambiguous — as it now is for the
 * `arkade:*` covenant, § 7.1.1.1: nothing on the wire says whether a given
 * quote's covenant carries the timelocked non-interactive refund leaf, since
 * it is fixed by the solver's own build rather than negotiated per quote. The
 * only safe move is to derive BOTH the eight- and nine-leaf shapes and accept
 * whichever one the quote's own address matches — this loses no security
 * because every candidate shape still pins the refund to YOUR OWN
 * `refund_address`, so a solver gains nothing by choosing which one to quote.
 *
 * Throws {@link AddressMismatch} only when NONE of the candidates match.
 * Returns the address that matched, so calls chain exactly as before.
 *
 * Typed in `rfq-core.d.mts`, not here — keep the two in sync.
 */
export const verifyLockupAddress = (quote, derivedAddress) => {
  const quoted = quote?.profile?.lockup_address
  const candidates = Array.isArray(derivedAddress) ? derivedAddress : [derivedAddress]
  const matched = candidates.find((address) => address === quoted)
  if (matched === undefined) throw new AddressMismatch(candidates, quoted)
  return matched
}

/**
 * The maker's gates, checked immediately before funding — not at quote time.
 * Throws with a stable `reason` property; returns void when funding is safe.
 */
export const assertFundable = ({ quote, invoiceExpiresAt, now, maxFee }) => {
  const fail = (reason, message) => {
    const error = new Error(message)
    error.reason = reason
    throw error
  }
  if (now >= invoiceExpiresAt) fail('invoice_expired', 'invoice expired')
  if (now >= quote.valid_until) fail('quote_expired', 'quote expired — request a fresh one')
  if (quote.refund_locktime - now < MIN_HEADROOM_SECONDS) {
    fail('insufficient_headroom', 'refund deadline headroom below 90 minutes')
  }
  // A MIRROR of `@arkade-os/swap`'s gate of the same name, reason codes
  // included. The two must not disagree about a money gate — that drift is what
  // `test/interop/clientGates.test.ts` was written to catch, one repository out.
  if (maxFee) {
    const { bps, sats } = maxFee
    if (bps === undefined && sats === undefined) fail('max_fee_unbounded', 'maxFee names neither bps nor sats')
    if (bps !== undefined && (!Number.isInteger(bps) || bps < 0 || bps > 10_000)) {
      fail('max_fee_out_of_range', `maxFee.bps must be an integer in 0..10000, got ${bps}`)
    }
    if (sats !== undefined && (!Number.isInteger(sats) || sats < 0)) {
      fail('max_fee_out_of_range', `maxFee.sats must be a non-negative integer, got ${sats}`)
    }
    // Loud on a cross-asset pair. `from_amount - to_amount` is a fee only while
    // both legs name the same asset; elsewhere it subtracts one asset from
    // another. Skipping quietly would leave a caller believing a ceiling applied.
    const legs = quote.pair.split('->')
    const assetOf = (leg) => leg.slice(leg.indexOf(':') + 1)
    if (legs.length !== 2 || assetOf(legs[0]) !== assetOf(legs[1])) {
      fail('fee_gate_unavailable', `maxFee cannot gate ${quote.pair}: its legs name different assets`)
    }
    const fee = quote.from_amount - quote.to_amount
    // The GREATER of the two, because a flat charge is a large proportion of a
    // small swap. @see the swap package for the full reasoning.
    const allowed = Math.max(sats ?? 0, Math.floor((quote.from_amount * (bps ?? 0)) / 10_000))
    if (fee > allowed) fail('fee_too_high', `fee ${fee} exceeds the ${allowed} this client allows`)
  }
}

/**
 * A reply is OUR quote, or it throws.
 *
 * Exported because every transport has to apply it and one did not: the Nostr
 * transport returned the raw payload, so a refusal flowed on into script
 * derivation and surfaced as `hex.decode: expected string, got undefined` —
 * the solver's stated reason lost, and `SwapRefusal` (which the reference
 * clients already catch) never thrown.
 */
export const expectQuote = (payload, rfqId) => {
  if (payload?.type === 'rfq_refusal') throw new SwapRefusal(payload.reason, payload.rfq_id ?? rfqId)
  if (payload?.type !== 'rfq_quote' || payload.rfq_id !== rfqId) {
    throw new Error(`unexpected reply: ${payload?.type ?? 'no payload'}`)
  }
  return payload
}

/**
 * HTTP transport: POST /v1/swap for quotes, GET /v1/rfq/<rfq_id> for status.
 * `fetchImpl` is injectable for tests and non-global-fetch runtimes.
 */
export const httpTransport = (baseUrl, { fetchImpl = fetch } = {}) => ({
  async requestQuote(payload) {
    const response = await fetchImpl(`${baseUrl}/v1/swap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return expectQuote(await response.json(), payload.rfq_id)
  },
  async status(rfqId) {
    const response = await fetchImpl(`${baseUrl}/v1/rfq/${rfqId}`, { method: 'GET' })
    if (response.status === 404) return null
    const payload = await response.json()
    return payload?.type === 'rfq_status' ? payload : null
  },
  async close() {},
})

/**
 * Relay transport: both parties outbound, addressed by pubkey, speaking the
 * dev broker framing ({op:'sub'|'event'}) that scripts/mock-relay.mjs serves.
 * Moving to Nostr changes only this file's frames (REQ/EVENT + NIP-44), per
 * the spec's § 3. One socket, replies correlated by rfq_id.
 */
export const relayTransport = (relayUrl, { solverPubkey, clientPubkey, WebSocketCtor = WebSocket, timeoutMs = 30_000 }) => {
  /** @type {Map<string, (payload: any) => void>} */
  const pending = new Map()
  let sequence = 0

  const socketReady = new Promise((resolve, reject) => {
    const ws = new WebSocketCtor(relayUrl)
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ op: 'sub', id: 's1', filter: { recipient: clientPubkey } }))
      resolve(ws)
    })
    ws.addEventListener('error', () => reject(new Error('relay connection failed')))
    ws.addEventListener('message', (ev) => {
      let frame
      try {
        frame = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (frame.op !== 'event') return
      const payload = frame.event?.payload
      const rfqId = payload?.rfq_id
      const settle = rfqId !== undefined && pending.get(rfqId)
      if (settle) {
        pending.delete(rfqId)
        settle(payload)
      }
    })
  })

  const roundTrip = async (payload, rfqId) => {
    const ws = await socketReady
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(rfqId)
        reject(new Error(`no reply within ${timeoutMs}ms`))
      }, timeoutMs)
      pending.set(rfqId, (p) => {
        clearTimeout(timer)
        resolve(p)
      })
    })
    ws.send(
      JSON.stringify({
        op: 'event',
        event: {
          id: `${clientPubkey}:${(sequence += 1)}`,
          author: clientPubkey,
          recipient: solverPubkey,
          createdAtMs: Date.now(),
          payload,
        },
      }),
    )
    return reply
  }

  return {
    async requestQuote(payload) {
      return expectQuote(await roundTrip(payload, payload.rfq_id), payload.rfq_id)
    },
    async status(rfqId) {
      const payload = await roundTrip({ v: 1, type: 'rfq_status_request', rfq_id: rfqId }, rfqId)
      return payload?.type === 'rfq_status' ? payload : null
    },
    async close() {
      try {
        ;(await socketReady).close()
      } catch {
        // Socket never opened; nothing to close.
      }
    },
  }
}

/**
 * Ask for a quote and validate the reply envelope. Refusals throw
 * {@link SwapRefusal}; anything that is not YOUR quote throws plainly.
 */
export const requestQuote = async (transport, { invoice, refundAddress, clientRefundPubkey, rfqId = newRfqId() }) =>
  transport.requestQuote(buildSendRequest({ rfqId, invoice, refundAddress, clientRefundPubkey }))

/**
 * Poll status until a terminal state (or `until` says stop). Returns the last
 * status seen; null if the transport never produced one. Optional — the
 * settlement is equally observable on-chain, which is the fallback that can
 * never be withheld.
 */
export const pollStatus = async (transport, rfqId, { pollMs = 2000, maxAttempts = 60, onStatus } = {}) => {
  let last = null
  for (let i = 0; i < maxAttempts; i += 1) {
    const status = await transport.status(rfqId)
    if (status) {
      last = status
      onStatus?.(status)
      if (TERMINAL_STATES.includes(status.state)) return status
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  return last
}
