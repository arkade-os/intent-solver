// Reference client for `lightning:BTC->arkade:BTC` over a REAL Nostr relay:
// quote, then claim. The half receive-quote-relay.mjs stops short of.
//
//   RELAY_PROTOCOL=nostr node --experimental-eventsource --env-file=.env.regtest.client \
//     examples/receive-client-relay.mjs ws://localhost:7777 <solverPubkey> [amountSats]
//
// Paying the hold invoice is NOT this script's job: it is printed, and any
// Lightning wallet pays it (check its amount against `from_amount` first).

import { randomBytes } from 'node:crypto'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { createArkadeContext, deriveNostrIdentity, loadConfig } from '../packages/solver-app/dist/index.js'
import { buildReceiveRequest, claimReceived, sealToCovclaimd } from './lib/receive-client.mjs'
import { newRfqId, nostrRelayTransport } from './lib/swap-client.mjs'

const [relayUrl, solverPubkey, amountArg] = process.argv.slice(2)
if (!relayUrl || !solverPubkey) {
  console.error('usage: receive-client-relay.mjs <relayUrl> <solverPubkey> [amountSats]')
  process.exit(1)
}
const amountSats = Number(amountArg ?? 5000)

const config = loadConfig()
const arkade = await createArkadeContext(config.arkade)

const covclaimdUrl = process.env.COVCLAIMD_URL ?? 'http://localhost:7271'
const covclaimdPubKey = await fetch(`${covclaimdUrl}/v1/preimage/covclaimd-pubkey`)
  .then((r) => /** @type {Promise<{ covclaimd_pub_key: string }>} */ (r.json()))
  .then((body) => body.covclaimd_pub_key)

const preimage = randomBytes(32)
const paymentHash = hex.encode(sha256(preimage))
const payoutAddress = await arkade.wallet.getAddress()
const payoutPubkey = hex.encode(await arkade.identity.xOnlyPublicKey())

const transport = nostrRelayTransport(relayUrl, {
  solverPubkey,
  secretKey: deriveNostrIdentity(config.arkade.mnemonic, config.arkade.isMainnet).secretKey,
})

let quote
try {
  quote = await transport.requestQuote(
    buildReceiveRequest({
      rfqId: newRfqId(),
      amountSats,
      paymentHash,
      payoutAddress,
      payoutPubkey,
      claimPacket: sealToCovclaimd(preimage, covclaimdPubKey),
    }),
  )
  console.log(`quote: pay ${quote.from_amount} sats, receive ${quote.to_amount} on Arkade`)
  console.log(`  invoice ${quote.profile.invoice}`)
} catch (error) {
  if (error.name === 'SwapRefusal') {
    console.error('solver refused:', error.reason)
    process.exit(2)
  }
  throw error
} finally {
  await transport.close()
}

try {
  const claimed = await claimReceived({
    arkade,
    quote,
    preimage,
    payoutAddress,
    payoutPubkey,
    emulatorUrl: config.emulatorUrl,
    attempts: Number(process.env.CLAIM_ATTEMPTS ?? 90),
    onEvent: (name, data) => {
      if (name === 'verified') console.log(`lockup matches own derivation: ${data.address}`)
      if (name === 'funded') console.log(`solver funded the quoted ${data.sats} sats — claiming`)
    },
  })
  console.log(`claimed to ${payoutAddress}, arkTxid ${claimed.txid}`)
} catch (error) {
  if (error.name === 'AddressMismatch') {
    console.error('REFUSING TO CLAIM: solver lockup address does not match local derivation')
    process.exit(3)
  }
  if (error.name === 'LockupAmountMismatch') {
    console.error(`REFUSING TO CLAIM: ${error.message}`)
    console.error('the covenant refunds the solver after refund_locktime; nothing to sign here')
    process.exit(4)
  }
  if (error.name === 'LockupNotFunded') {
    console.error('the solver never funded the lockup; the hold invoice fails back on its own')
    process.exit(5)
  }
  throw error
}

arkade.close()
process.exit(0)
