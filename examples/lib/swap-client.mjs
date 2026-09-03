// The trader / intent-submitter client: rfq-core plus the Arkade-side pieces —
// local script derivation, funding, and on-chain settlement watching.
//
// This layer is where the trust model becomes code. From a quote it uses ONLY
// the binding fields (solver_pubkey, refund_locktime, valid_until, amounts);
// every other script parameter is the trader's own data: preimage hash from
// its own invoice, server key from its own Arkade connection, emulator key
// from its own fetch, refund destination from its own wallet. The solver's
// lockup_address is compared, never used.
//
// Imports the repo's built output (`pnpm build` first). A team on another
// stack reimplements exactly this file against docs/rfq-protocol.md; rfq-core
// they can lift as-is.

import { ArkAddress, RestEmulatorProvider } from '@arkade-os/sdk'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { finalizeEvent } from 'nostr-tools/pure'
import { getConversationKey, encrypt, decrypt } from 'nostr-tools/nip44'
import { CovenantSwapScript, decodeInvoice, findLockups, scriptHashFromPaymentHash } from '../../packages/solver-app/dist/index.js'
import { assertFundable, expectQuote, newRfqId, requestQuote, verifyLockupAddress } from './rfq-core.mjs'

export * from './rfq-core.mjs'

/**
 * The event kind this protocol uses; mirrors
 * `packages/solver-transport/src/relay/nostr.ts`, and MUST equal it.
 *
 * EPHEMERAL (20000–29999), which is why it is 24859 and not the 4859 this
 * file used to carry. The solver moved for privacy and replay correctness —
 * a stored kind leaves a permanent public record of who negotiated with whom
 * and re-delivers a stale backlog on every reconnect — and this client was
 * left behind.
 *
 * The failure that causes has no error in it. Two disjoint `kinds` filters
 * do not fail to match, they simply never match: the request is published,
 * the relay accepts it, the solver is subscribed to a different kind and
 * never sees it, and the client times out with `no reply within 30000ms` as
 * though nobody were listening. Confirmed against a solver with its ingress
 * demonstrably open, which is what makes it worth this many lines: nothing
 * anywhere reports the mismatch.
 */
const NOSTR_KIND_DIRECTED = 24859

/**
 * `rfq-core.mjs`'s `relayTransport`, but over REAL NOSTR.
 *
 * It lives HERE rather than there because `rfq-core.mjs` is dependency-free on
 * purpose — web APIs only, so it ports to any runtime and is the file a team
 * translates first. NIP-44 needs secp256k1 ECDH and ChaCha20 and WebCrypto
 * provides neither, so a Nostr transport cannot be written under that rule.
 * This file already depends on the repo's stack, so it is where the dependency
 * belongs.
 *
 * The wire format is `packages/solver-transport/src/relay/nostr.ts`'s, which is the thing this has to
 * match exactly: kind 24859 addressed with a `p` tag, the RFQ payload sealed to
 * the recipient with NIP-44, and a subscription of
 * `{kinds:[24859], '#p':[me]}`.
 *
 * `scripts/mock-relay.mjs` could never have caught the difference: both halves
 * spoke its `{op:'sub'}` framing, so the flow passed while being unable to
 * talk to any real relay. Pointed at strfry, the dev-framing client earns
 * `bad msg: unparseable message` twice per run and the provider never sees a
 * request.
 */
export const nostrRelayTransport = (
  relayUrl,
  { solverPubkey, secretKey, WebSocketCtor = WebSocket, timeoutMs = 30_000 },
) => {
  /** @type {Map<string, (payload: any) => void>} */
  const pending = new Map()
  const myPubkey = hex.encode(schnorr.getPublicKey(secretKey))
  const conversationKey = getConversationKey(secretKey, solverPubkey)

  const socketReady = new Promise((resolve, reject) => {
    const ws = new WebSocketCtor(relayUrl)
    ws.addEventListener('open', () => {
      // Addressed-to-me only. An unfiltered REQ on a public relay is a
      // firehose, and the provider's own encoder refuses to send one either.
      ws.send(JSON.stringify(['REQ', 'rfq', { kinds: [NOSTR_KIND_DIRECTED], '#p': [myPubkey] }]))
      resolve(ws)
    })
    ws.addEventListener('error', () => reject(new Error('relay connection failed')))
    ws.addEventListener('message', (ev) => {
      let message
      try {
        message = JSON.parse(String(ev.data))
      } catch {
        return
      }
      // ["EVENT", subId, event] — NIP-01 puts the event strictly at index 2.
      if (!Array.isArray(message) || message[0] !== 'EVENT') return
      const event = message[2]
      if (!event || event.kind !== NOSTR_KIND_DIRECTED || event.pubkey !== solverPubkey) return
      let payload
      try {
        payload = JSON.parse(decrypt(event.content, conversationKey))
      } catch {
        // Not ours to read. Not an error: a relay may deliver anything that
        // matched the filter, and something sealed to another key is normal.
        return
      }
      const settle = payload?.rfq_id !== undefined && pending.get(payload.rfq_id)
      if (settle) {
        pending.delete(payload.rfq_id)
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
      pending.set(rfqId, (settled) => {
        clearTimeout(timer)
        resolve(settled)
      })
    })
    ws.send(
      JSON.stringify([
        'EVENT',
        finalizeEvent(
          {
            kind: NOSTR_KIND_DIRECTED,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['p', solverPubkey]],
            content: encrypt(JSON.stringify(payload), conversationKey),
          },
          secretKey,
        ),
      ]),
    )
    return reply
  }

  return {
    // `expectQuote`, same as the HTTP and dev transports. Without it a refusal
    // is returned as if it were a quote and dies further down in script
    // derivation, losing the reason the solver actually gave.
    requestQuote: async (payload) => expectQuote(await roundTrip(payload, payload.rfq_id), payload.rfq_id),
    requestStatus: (payload) => roundTrip(payload, payload.rfq_id),
    async close() {
      const ws = await socketReady.catch(() => null)
      ws?.close()
    },
  }
}

/** The emulator's signer key, from the trader's OWN endpoint — never the solver's word. */
export const fetchEmulatorPubkey = async (emulatorUrl) =>
  (await new RestEmulatorProvider(emulatorUrl).getInfo()).signerPubkey

/**
 * Derive the covenant lockup script from the quote's binding fields and the
 * trader's own data. Pure derivation — comparison is the caller's next line
 * (`verifyLockupAddress`), kept separate so the refusal is explicit.
 *
 * Returns BOTH candidate shapes, not one: nothing on the wire says whether
 * this quote's covenant carries the timelocked non-interactive refund leaf
 * (docs/rfq-protocol.md § 7.1.1.1) — it is fixed by the solver's own build,
 * not negotiated per quote or discoverable from the response. Trying both is
 * free of any added trust, since every candidate still pins the refund to
 * THIS trader's own `refundAddress`; `verifyLockupAddress` picks whichever
 * one the quote's own `lockup_address` matches.
 *
 * The two candidates are the CURRENT suite and the pre-timelocked-refund one,
 * selected by `legacy` — which moves `pkScript`, hence two addresses to try.
 * A solver on today's build always produces the first.
 */
export const deriveLockup = ({ quote, invoice, refundAddress, arkade, emulatorPubkey, clientRefundPubkey }) => {
  const decoded = typeof invoice === 'string' ? decodeInvoice(invoice) : invoice
  const serverKey = arkade.wallet.arkServerPublicKey
  const build = (legacy) => {
    const script = new CovenantSwapScript({
      receiver: hex.decode(quote.solver_pubkey), //  binding field #1
      refundLocktime: quote.refund_locktime, //      binding field #2
      server: serverKey,
      preimageHash: scriptHashFromPaymentHash(decoded.paymentHash),
      claimDelay: arkade.unilateralDelays.unilateralClaimDelay,
      // The leaves no participant has to be online for. Grouped rather than
      // flat because they are one unit: a row rebuilt from stored state has to
      // reproduce the shape it was funded with, and `legacy` is what moves it.
      nonInteractiveParameters: {
        emulatorPubkey: hex.decode(emulatorPubkey),
        // Compare-only, from the quote: the solver's own claim destination —
        // it binds ONLY where the solver may pay itself on nonInteractiveClaim,
        // so a solver lying here would be robbing itself. None of this
        // trader's refund leaves depend on it. See docs/rfq-protocol.md
        // § 7.1.1.1 for why the trader cannot derive it itself.
        receiverPkScript: hex.decode(quote.profile.receiver_pk_script),
        // Where a refund lands: THIS trader's own address, never the quote's.
        senderPkScript: ArkAddress.decode(refundAddress).pkScript,
        ...(legacy ? { legacy: 'preTimelockedRefund' } : {}),
      },
      // Same key the request already carried as client_refund_pubkey — the
      // solver bakes it into the same covenant this derivation re-derives.
      client: hex.decode(clientRefundPubkey),
      clientRefundDelay: arkade.unilateralDelays.unilateralRefundWithoutReceiverDelay,
      refundWithoutServerDelay: arkade.unilateralDelays.unilateralRefundDelay,
    })
    return {
      script,
      address: script.address(arkade.hrp, serverKey).encode(),
      pkScript: hex.encode(script.pkScript),
    }
  }
  return { decoded, candidates: [build(false), build(true)] }
}

/** True once the lockup vtxo is spent — the solver claimed; the swap is complete. */
export const lockupSpent = async (arkade, pkScript) => (await findLockups(arkade, pkScript)).length === 0

/**
 * The whole maker flow, one call: quote → derive locally → verify → gate →
 * fund own derivation. Returns everything a POC needs to watch and account.
 *
 * After this resolves the maker may go OFFLINE: filling is non-interactive.
 * The solver observes the funding on-chain and fills; success reveals the
 * preimage in the claim witness; failure refunds by covenant to
 * `refundAddress` — cooperatively (server + emulator) with no maker key
 * needed, or, if both are ever unavailable, unilaterally by the maker with
 * THE WALLET'S OWN KEY. Nothing extra to persist: the recourse is available
 * to anyone holding the mnemonic that funded the swap, which is the same
 * thing the maker already had to keep.
 *
 * `onEvent(name, data)` narrates each step for logging; never load-bearing.
 */
// `emulatorPubkey = undefined` is not decoration: it is optional — the body
// falls back to `fetchEmulatorPubkey(emulatorUrl)` — and a bare destructure
// makes that indistinguishable from required to anything reading the shape.
export const sendToLightning = async ({
  transport,
  arkade,
  emulatorPubkey = undefined,
  emulatorUrl,
  bolt11,
  onEvent,
}) => {
  const emit = (name, data) => onEvent?.(name, data)
  const rfqId = newRfqId()
  const decoded = decodeInvoice(bolt11)
  emit('decoded', { rfqId, amountSats: decoded.amountSats, paymentHash: decoded.paymentHash })

  // The maker's key for the covenant's client-unilateral refund leaf: THE
  // WALLET'S OWN, the same key that signs everything else here.
  //
  // This used to generate a fresh key per swap and hand it back once, which
  // made the maker's last-resort refund depend on the caller noticing it had
  // to be saved. A caller that logged the return value and moved on — the
  // obvious thing to do — silently threw away its only recourse for when both
  // the Arkade server and the emulator are unavailable, and could not tell
  // afterwards that it had. The recourse now belongs to the mnemonic that
  // funded the swap, which the maker necessarily still holds.
  //
  // Same shape as boltz-swap, which takes `refundPublicKey` from the wallet's
  // signer rather than inventing one (packages/boltz-swap/src/arkade-swaps.ts).
  const clientRefundPubkey = hex.encode(await arkade.identity.xOnlyPublicKey())

  const refundAddress = await arkade.wallet.getAddress()
  const quote = await requestQuote(transport, { invoice: bolt11, refundAddress, clientRefundPubkey, rfqId })
  emit('quoted', quote)

  const emulatorKey = emulatorPubkey ?? (await fetchEmulatorPubkey(emulatorUrl))
  const lockup = deriveLockup({ quote, invoice: decoded, refundAddress, arkade, emulatorPubkey: emulatorKey, clientRefundPubkey })
  // Two candidates in, one match out — see deriveLockup's own doc comment for
  // why there are two. `matchedAddress` is one of `lockup.candidates`, by
  // construction: verifyLockupAddress only ever returns a candidate it was
  // given or throws.
  const matchedAddress = verifyLockupAddress(
    quote,
    lockup.candidates.map((candidate) => candidate.address),
  )
  const matched = lockup.candidates.find((candidate) => candidate.address === matchedAddress)
  // `verifyLockupAddress` returns one of the addresses it was handed, so this
  // find cannot miss today. Checked anyway because of where the value goes:
  // four lines down it is the `address` of a real `wallet.send`. If the two
  // ever disagree, the failure without this is
  // `Cannot read properties of undefined` at the funding call — money moving
  // against an address nothing verified is the one outcome worth an explicit
  // refusal rather than a TypeError.
  if (!matched) throw new Error(`no derived candidate matches the verified address ${matchedAddress}`)
  emit('verified', { address: matched.address })

  assertFundable({ quote, invoiceExpiresAt: decoded.expiresAt, now: Math.floor(Date.now() / 1000) })
  // `from_amount`, NOT the invoice amount. They are equal only when the solver
  // charges nothing; with a spread the lockup carries the invoice plus the fee,
  // and funding the invoice amount underfunds by exactly the fee and is refused.
  // The quote is the authority on what to lock — that is what `from_amount` is.
  const fundSats = quote.from_amount
  const fundTxid = await arkade.wallet.send({ address: matched.address, amount: fundSats })
  emit('funded', { fundTxid, amountSats: fundSats })

  return {
    rfqId,
    quote,
    refundAddress,
    fundTxid,
    clientRefundPubkey,
    decoded: lockup.decoded,
    ...matched,
  }
}
