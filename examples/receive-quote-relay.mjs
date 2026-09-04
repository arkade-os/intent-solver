// Ask a solver for a `lightning:BTC->arkade:BTC` quote over a REAL Nostr relay.
//
//   RELAY_PROTOCOL=nostr node --experimental-eventsource --env-file=.env.regtest.client \
//     examples/receive-quote-relay.mjs ws://localhost:7777 <solverPubkey> [amountSats]
//
// QUOTE ONLY, and the name says so. What happens after — paying the hold
// invoice, the solver funding the lockup, the client claiming with `P` — is
// covered end to end by `test/e2e/receiveLightning*.e2e.test.ts`, which drives
// the orchestrator directly. The one thing those cannot cover is the thing this
// does: that a receive `rfq_request` reaches the corridor THROUGH A RELAY and
// comes back as a real quote. Both receive pairs got their ingress arm in the
// four-corridor wiring; before this, nothing exercised it over the wire.
//
// The client generates `P`, keeps it, and sends only `H = sha256(P)` plus `P`
// sealed to covclaimd. The solver never sees `P` until it appears in a claim
// witness, which is the whole point of the corridor — see the README's "The
// preimage is not ours to hold".
import { randomBytes } from 'node:crypto'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { createArkadeContext, deriveNostrIdentity, loadConfig } from '../packages/solver-app/dist/index.js'
// Sealing and the request shape live in the library, so the two cannot drift.
import { buildReceiveRequest, sealToCovclaimd } from './lib/receive-client.mjs'
import { newRfqId, nostrRelayTransport } from './lib/swap-client.mjs'

const [relayUrl, solverPubkey, amountArg] = process.argv.slice(2)
if (!relayUrl || !solverPubkey) {
  console.error('usage: receive-quote-relay.mjs <relayUrl> <solverPubkey> [amountSats]')
  process.exit(1)
}
const amountSats = Number(amountArg ?? 5000)

const config = loadConfig()
const arkade = await createArkadeContext(config.arkade)

let transport

// Everything after the wallet is open belongs inside the try: a throw in the
// covclaimd fetch or in the sealing left `arkade` open, which is the whole
// point of the finally below.
try {
  // covclaimd's key is read LIVE, never hardcoded: it generates its own.
  const covclaimdUrl = process.env.COVCLAIMD_URL ?? 'http://localhost:7271'
  const covclaimdPubKey = await fetch(`${covclaimdUrl}/v1/preimage/covclaimd-pubkey`)
    .then((r) => /** @type {Promise<{ covclaimd_pub_key: string }>} */ (r.json()))
    .then((body) => body.covclaimd_pub_key)

  const preimage = randomBytes(32)
  const paymentHash = hex.encode(sha256(preimage))
  const claimPacket = sealToCovclaimd(preimage, covclaimdPubKey)

  transport = nostrRelayTransport(relayUrl, {
    solverPubkey,
    secretKey: deriveNostrIdentity(config.arkade.mnemonic, config.arkade.isMainnet).secretKey,
  })

  const rfqId = newRfqId()
  console.log(`asking for ${amountSats} sats over ${relayUrl}, payment hash ${paymentHash}`)
  const quote = await transport.requestQuote(
    buildReceiveRequest({
      rfqId,
      amountSats,
      paymentHash,
      payoutAddress: await arkade.wallet.getAddress(),
      payoutPubkey: hex.encode(await arkade.identity.xOnlyPublicKey()),
      claimPacket,
    }),
  )

  if (quote.type !== 'rfq_quote') {
    console.error(`refused: ${quote.reason ?? JSON.stringify(quote)}`)
    process.exitCode = 1
  } else {
    // The invoice is the solver's HOLD invoice on our own `H` — paying it is
    // what arms the swap. Printed, not paid: see this file's header.
    console.log('quote over the relay:')
    console.log(`  invoice        ${quote.profile.invoice}`)
    console.log(`  lockup address ${quote.profile.lockup_address}`)
    console.log(`  refund locktime ${quote.refund_locktime}`)
    console.log('Receive quote received over a real Nostr relay.')
  }
} finally {
  await transport?.close()
  arkade.close()
}

// The SDK's ContractWatcher owns a poll interval that `arkade.close()` does not
// stop, so an otherwise-finished process sits there forever — every tick then
// querying the handle we just released ("database connection is not open").
// send-client-relay.mjs ends the same way. Order matters: close() first,
// because process.exit() skips the WAL checkpoint (packages/solver-arkade/src/arkade/wallet.ts:51).
process.exit(process.exitCode ?? 0)
