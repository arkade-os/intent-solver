// Ask a solver for a `lightning:BTC->arkade:BTC` quote over a REAL Nostr relay.
//
//   RELAY_PROTOCOL=nostr node --experimental-eventsource --env-file=.env.regtest.client \
//     examples/receive-quote-relay.mjs ws://localhost:7777 <solverPubkey> [amountSats]

import { randomBytes } from 'node:crypto'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { createArkadeContext, deriveNostrIdentity } from '../packages/solver-app/dist/index.js'
import { configFromKnobs } from '../packages/solver-app/dist/config.js'
import { buildReceiveRequest } from './lib/receive-client.mjs'
import { newRfqId, nostrRelayTransport } from './lib/swap-client.mjs'

const [relayUrl, solverPubkey, amountArg] = process.argv.slice(2)
if (!relayUrl || !solverPubkey) {
  console.error('usage: receive-quote-relay.mjs <relayUrl> <solverPubkey> [amountSats]')
  process.exit(1)
}
const amountSats = Number(amountArg ?? 5000)
const claimPacket = process.env.CLAIM_PACKET
const paymentHash = process.env.PAYMENT_HASH
if (claimPacket !== undefined && !paymentHash) {
  console.error('CLAIM_PACKET requires its matching PAYMENT_HASH')
  process.exit(1)
}
const requestHash = paymentHash ?? hex.encode(sha256(randomBytes(32)))

const config = configFromKnobs(process.env)
const arkade = await createArkadeContext(config.arkade)

let transport

try {
  transport = nostrRelayTransport(relayUrl, {
    solverPubkey,
    secretKey: deriveNostrIdentity(config.arkade.mnemonic, config.arkade.isMainnet).secretKey,
  })

  const rfqId = newRfqId()
  console.log(`asking for ${amountSats} sats over ${relayUrl}, payment hash ${requestHash}`)
  const quote = await transport.requestQuote(
    buildReceiveRequest({
      rfqId,
      amountSats,
      paymentHash: requestHash,
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
  await arkade.close()
}

process.exit(process.exitCode ?? 0)
