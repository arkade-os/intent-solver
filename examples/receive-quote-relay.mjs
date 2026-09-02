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
import { createCipheriv, randomBytes } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { base64, hex } from '@scure/base'
import { createArkadeContext, deriveNostrIdentity, loadConfig } from '../packages/solver-app/dist/index.js'
import { newRfqId, nostrRelayTransport } from './lib/swap-client.mjs'

const [relayUrl, solverPubkey, amountArg] = process.argv.slice(2)
if (!relayUrl || !solverPubkey) {
  console.error('usage: receive-quote-relay.mjs <relayUrl> <solverPubkey> [amountSats]')
  process.exit(1)
}
const amountSats = Number(amountArg ?? 5000)

/**
 * ECIES-seal `P` to covclaimd: `ephPub(33) || nonce(12) || ciphertext`, base64.
 *
 * Carried here rather than imported because this is CLIENT code — a real
 * integration seals in its own wallet, and this file is the reference for how.
 * The one mistake covclaimd rejects and nothing local can detect: the shared
 * secret is the X coordinate ONLY (RFC 5903 §9), so the compressed point's
 * leading parity byte is dropped.
 */
const sealToCovclaimd = (preimage, covclaimdPubKeyHex) => {
  const ephemeralPriv = secp256k1.utils.randomSecretKey()
  const ephemeralPub = secp256k1.getPublicKey(ephemeralPriv, true)
  const shared = secp256k1.getSharedSecret(ephemeralPriv, hex.decode(covclaimdPubKeyHex), true).slice(1)
  const key = hkdf(sha256, shared, ephemeralPub, utf8ToBytes('covclaimd/preimage/v1'), 32)

  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(ephemeralPub)
  const sealed = Buffer.concat([cipher.update(preimage), cipher.final(), cipher.getAuthTag()])

  const wire = new Uint8Array(ephemeralPub.length + nonce.length + sealed.length)
  wire.set(ephemeralPub, 0)
  wire.set(nonce, ephemeralPub.length)
  wire.set(sealed, ephemeralPub.length + nonce.length)
  return base64.encode(wire)
}

const config = loadConfig()
const arkade = await createArkadeContext(config.arkade)

// covclaimd's key is read LIVE, never hardcoded: it generates its own.
const covclaimdUrl = process.env.COVCLAIMD_URL ?? 'http://localhost:7271'
const covclaimdPubKey = await fetch(`${covclaimdUrl}/v1/preimage/covclaimd-pubkey`)
  .then((r) => r.json())
  .then((body) => body.covclaimd_pub_key)

const preimage = randomBytes(32)
const paymentHash = hex.encode(sha256(preimage))
const claimPacket = sealToCovclaimd(preimage, covclaimdPubKey)

const transport = nostrRelayTransport(relayUrl, {
  solverPubkey,
  secretKey: deriveNostrIdentity(config.arkade.mnemonic, config.arkade.isMainnet).secretKey,
})

try {
  const rfqId = newRfqId()
  console.log(`asking for ${amountSats} sats over ${relayUrl}, payment hash ${paymentHash}`)
  const quote = await transport.requestQuote({
    v: 1,
    type: 'rfq_request',
    rfq_id: rfqId,
    pair: 'lightning:BTC->arkade:BTC',
    amount_side: 'to',
    amount: amountSats,
    profile: {
      payment_hash: paymentHash,
      payout_address: await arkade.wallet.getAddress(),
      payout_pubkey: hex.encode(await arkade.identity.xOnlyPublicKey()),
      claim_packet: claimPacket,
    },
  })

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
  await transport.close()
  arkade.close()
}

// The SDK's ContractWatcher owns a poll interval that `arkade.close()` does not
// stop, so an otherwise-finished process sits there forever — every tick then
// querying the handle we just released ("database connection is not open").
// send-client-relay.mjs ends the same way. Order matters: close() first,
// because process.exit() skips the WAL checkpoint (packages/solver-arkade/src/arkade/wallet.ts:51).
process.exit(process.exitCode ?? 0)
