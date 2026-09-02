# JavaScript integration — the trader / intent-submitter library

A small JS library for submitting swap intents against an RFQ solver, living
in [`examples/lib/`](../examples/lib/). It is the working reference for
[`rfq-protocol.md`](./rfq-protocol.md) § `arkade:BTC->lightning:BTC`, proven
in `test/examples/rfqCore.test.ts` against the real service over both
transports. (This library is being ported into the ts-sdk Intent package;
this copy remains the provider-repo reference wired to its tests.)

Two layers, split on purpose:

| module | depends on | role |
|---|---|---|
| [`rfq-core.mjs`](../examples/lib/rfq-core.mjs) | nothing but web APIs (`fetch`, `WebSocket`, `crypto`) | the portable protocol core: messages, transports, time gates, the compare-only address check. Lift as-is into any JS runtime; translate first when porting to another language |
| [`swap-client.mjs`](../examples/lib/swap-client.mjs) | `rfq-core` + this repo's build (`pnpm build`) + `@arkade-os/sdk` | the Arkade side: local script derivation, funding, on-chain settlement watching, and the one-call `sendToLightning` |

## The model: RFQ negotiation, then non-interactive filling

The only interactive part of a swap is the quote. After that, for every
HTLC-class pair, filling is **non-interactive**:

- the **client** (trader / intent submitter) accepts a quote by *funding its
  own locally-derived contract* — there is no accept message — and may then
  go offline;
- the **solver** observes the funding on-chain and fills; the
  preimage appears publicly in its claim witness as the receipt;
- failure has two paths: cooperatively, after `refund_locktime` the covenant
  refund pays the client's address, pushable by anyone, no client key needed;
  or, if the Arkade server and the emulator are ever both unavailable, the
  client can push its own unilateral refund with the key it supplied as
  `client_refund_pubkey` at quote time (§ below).

(The atomic `arkade:X->arkade:Y` class reaches the same shape by another
route rather than being an exception: the client funds an offer covenant
instead of sending a message, and a solver fills it by spending that output.
There is no `rfq_fill` — see `rfq-protocol.md` § 7.2.)

## Quickstart

```js
import { createArkadeContext, loadConfig } from 'intent-solver' // this repo's dist
import {
  httpTransport, relayTransport, sendToLightning, pollStatus, lockupSpent,
} from './examples/lib/swap-client.mjs'

const config = loadConfig()
const arkade = await createArkadeContext(config.arkade)

// The transport is the ONLY line that differs between HTTP and the relay:
const transport = httpTransport('http://localhost:8787')
// const transport = relayTransport('ws://localhost:7447', {
//   solverPubkey: '<solver x-only hex>',
//   clientPubkey: '<your x-only hex>',
// })

const swap = await sendToLightning({
  transport,
  arkade,                          // YOUR Arkade connection
  emulatorUrl: config.emulatorUrl, // YOUR emulator endpoint — never the solver's word
  bolt11,
  onEvent: (name, data) => console.log(name, data),
})
// The client's work is DONE — filling is non-interactive from here.

// Optional: watch status by your rfq_id…
const status = await pollStatus(transport, swap.rfqId)
if (status?.state === 'settled') console.log('receipt:', status.profile.preimage)
// …or watch the chain, which nobody can withhold:
const done = await lockupSpent(arkade, swap.pkScript)
```

`relayTransport` speaks the dev broker framing, not NIP-01; a Nostr client
transport (kinds 24859/24860 + NIP-44) is not in `examples/lib/`.

`sendToLightning` performs the six protocol steps and **refuses to fund**
unless every check passes: it decodes the invoice itself, requests the quote
under a fresh `rfq_id`, derives BOTH candidate covenant shapes from the
quote's binding fields plus the trader's own data — eight leaves and nine,
since nothing on the wire says which one a given solver quotes (§ 7.1.1.1) —
compares the solver's `lockup_address` against both (throwing
`AddressMismatch` only if NEITHER matches), gates on invoice liveness,
`valid_until` and the 90-minute refund headroom, and only then funds
whichever derivation matched.

## The client-unilateral refund key

Every `rfq_request` now requires `client_refund_pubkey` in `profile` — the
client's own key for three additional covenant leaves the solver's quote
`profile.receiver_pk_script` and the operator's own `/v1/info` delays
complete (see `docs/rfq-protocol.md` § 7.1.1.1 for the full picture — eight
leaves, nine once the solver has deployed the timelocked non-interactive
refund leaf). The one that matters most for the client's own recourse is the
fully unilateral one: needs nobody, not the Arkade server, not the emulator,
not the solver, once its own CSV delay
(`unilateral_refund_without_receiver_delay`, from the same Arkade operator
`/v1/info` `unilateral_claim_delay` already comes from — no wire echo
needed) has passed since funding. The other two (`refund_collaborative`,
`refund_without_server`) are faster, more-cooperative fallbacks that resolve
before that one becomes necessary — `deriveLockup` derives all of them
locally alongside the rest of the script; there is nothing further to call.

`sendToLightning` uses **the wallet's own key** — `arkade.identity`, the
same one that signs the funding — and returns it as `clientRefundPubkey`.
There is nothing extra to persist: the recourse belongs to the mnemonic
that funded the swap, which you necessarily still hold.

This is worth stating because it did not always work that way. An earlier
version generated a throwaway key per swap and handed the private half back
once, so a caller that logged the result and moved on had silently traded
away its last-resort refund and could not tell afterwards. If you are
driving the lower-level API directly, pass a key **your wallet can sign
with** as `clientRefundPubkey`; anything else recreates that trap.

## Errors to branch on

| error | meaning | action |
|---|---|---|
| `SwapRefusal` (`.reason` from the closed set, § 10 of the spec) | the solver declined | show reason; retry later or elsewhere |
| `AddressMismatch` (`.derived`, `.quoted`) | the solver's address ≠ your derivation | **never fund**; drop this solver |
| plain `Error` with `.reason` `'invoice_expired' \| 'quote_expired' \| 'insufficient_headroom'` | a funding gate failed | request a fresh quote / fresh invoice |

Unknown refusal reasons are a generic decline — do not infer retry semantics.

> **An `AddressMismatch` against a current solver is more likely your derivation
> than a hostile solver.** A solver running the timelocked non-interactive refund
> leaf commits to a NINE-leaf taptree, so a client deriving only the eight-leaf
> shape mismatches on every quote. The published `@arkade-os/swap` (0.0.9) is
> affected: it pins `@arkade-os/sdk` 0.4.66, which has no `preTimelockedRefund`
> option and builds the eight-leaf tree. § 7.1.1.1 of the RFQ spec is normative —
> derive BOTH candidates and accept either, as
> [`swap-client.mjs`](../examples/lib/swap-client.mjs) now does. Update the
> derivation before concluding a solver is misbehaving, and still never fund on a
> mismatch.

## Lower-level API (rfq-core)

For a POC that wants the steps individually, or its own derivation stack:

```js
import {
  newRfqId, buildSendRequest, requestQuote,     // messages
  httpTransport, relayTransport,                // transports (fetch/WebSocket injectable)
  verifyLockupAddress, assertFundable,          // guardrails
  pollStatus, TERMINAL_STATES,                  // observation
  SwapRefusal, AddressMismatch,                 // typed failures
} from './examples/lib/rfq-core.mjs'
```

Every function is documented in the source and typed in
[`rfq-core.d.mts`](../examples/lib/rfq-core.d.mts). The reference clients —
[`send-client.mjs`](../examples/send-client.mjs) (HTTP) and
[`send-client-relay.mjs`](../examples/send-client-relay.mjs) (relay) — are
thin consumers of this library and double as end-to-end usage examples;
`scripts/e2e-relay.sh` drives the relay one against a live regtest stack.

## What the library will never do

- fund a solver-supplied address (compare-only, always);
- trust an amount, key or deadline it can derive or fetch itself;
- transport a preimage (receipts are read from `settled` status or the claim
  witness — they never travel client→solver).
