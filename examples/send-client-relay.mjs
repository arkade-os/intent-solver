// Reference client for the OUTBOUND transport: "send to Lightning" with no
// HTTP anywhere — trader and solver only ever speak to a relay, both
// outbound. Same library, same six steps as send-client.mjs; the transport is
// the ONLY line that changes (docs/rfq-protocol.md § 3, docs/integration-js.md).
//
//   node --experimental-eventsource examples/send-client-relay.mjs \
//        <relayUrl> <solverPubkey> <bolt11>
//
// After funding, filling is NON-INTERACTIVE: the solver observes the lockup
// on-chain and claims; this client watches the vtxo disappear as its
// completion signal (an rfq_status_request over the relay also works).
//
// Env: this client's own ARK_MNEMONIC / ARK_SERVER_URL / EMULATOR_URL /
// SWAP_NETWORK — its own view of every service, never taken from the solver.

import { hex } from '@scure/base'
import { createArkadeContext, deriveNostrIdentity, loadConfig } from '../dist/index.js'
import { lockupSpent, nostrRelayTransport, relayTransport, sendToLightning } from './lib/swap-client.mjs'

const [relayUrl, solverPubkey, bolt11] = process.argv.slice(2)
if (!relayUrl || !solverPubkey || !bolt11) {
  console.error('usage: send-client-relay.mjs <relayUrl> <solverPubkey> <bolt11>')
  process.exit(1)
}

const config = loadConfig()
const arkade = await createArkadeContext(config.arkade)
const me = hex.encode(await arkade.identity.xOnlyPublicKey())
// Which framing to speak. `dev` is scripts/mock-relay.mjs's broker shape, and
// is the default only because it needs no relay to be running. A REAL relay
// speaks Nostr, and the two are not interchangeable: pointed at strfry, the
// dev framing earns `bad msg: unparseable message` and the request never
// reaches the solver.
//
//   RELAY_PROTOCOL=nostr node examples/send-client-relay.mjs ws://localhost:7777 <solver> <bolt11>
//
// The signing key is the wallet's own Nostr identity — the same BIP86
// derivation the solver uses, so the client's Nostr pubkey IS its Arkade
// x-only pubkey. The solver replies to whoever authored the request, so this
// is what the reply comes back to.
const transport =
  (process.env.RELAY_PROTOCOL ?? 'dev') === 'nostr'
    ? nostrRelayTransport(relayUrl, {
        solverPubkey,
        secretKey: deriveNostrIdentity(config.arkade.mnemonic, config.arkade.isMainnet).secretKey,
      })
    : relayTransport(relayUrl, { solverPubkey, clientPubkey: me })

let swap
try {
  swap = await sendToLightning({
    transport,
    arkade,
    emulatorUrl: config.emulatorUrl,
    bolt11,
    onEvent: (name, data) => {
      if (name === 'decoded') console.log(`sending ${data.amountSats} sats, payment hash ${data.paymentHash}`)
      if (name === 'funded') console.log(`funded ${data.amountSats} sats at own derivation, arkTxid ${data.fundTxid}`)
    },
  })
} catch (error) {
  if (error.name === 'AddressMismatch') {
    console.error('REFUSING TO FUND: solver address does not match local derivation')
    process.exit(3)
  }
  if (error.name === 'SwapRefusal') {
    console.error('solver refused:', error.reason)
    process.exit(2)
  }
  throw error
}
await transport.close()

// Watch on-chain: the solver claiming spends the lockup vtxo.
for (let i = 0; i < 60; i++) {
  if (await lockupSpent(arkade, swap.pkScript)) {
    console.log('lockup spent — the solver claimed it. Swap complete.')
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 2000))
}

arkade.close()
process.exit(0)
