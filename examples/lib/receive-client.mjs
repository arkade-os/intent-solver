// The RECEIVE-side reference client for `lightning:BTC->arkade:BTC`: it keeps
// P, sends H = sha256(P) with P sealed to covclaimd, and claims the lockup.
//
// That claim spends the COLLABORATIVE leaf — no CSV, no recovery — so the
// ordering is the contract: VERIFY SCRIPT -> VERIFY AMOUNT -> SIGN. An address
// the client did not derive says nothing about who may spend it, and
// `findLockups` returns EVERY output at a script public since quote time, so
// only `quote.to_amount` says what was promised.

import { createCipheriv, randomBytes } from 'node:crypto'
import { ArkAddress } from '@arkade-os/sdk'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { base64, hex } from '@scure/base'
import {
  CovenantSwapScript,
  claimSwapScript,
  findLockups,
  scriptHashFromPaymentHash,
} from '../../packages/solver-app/dist/index.js'
import { verifyLockupAddress } from './rfq-core.mjs'
import { fetchEmulatorPubkey } from './swap-client.mjs'

export const RFQ_PAIR_RECEIVE = 'lightning:BTC->arkade:BTC'

export const POLL_ATTEMPTS = 30
export const POLL_INTERVAL_MS = 2000

/** Nothing at the script: indexer lag or an unfunded swap, both still live. */
export class LockupNotFunded extends Error {
  constructor(pkScript) {
    super(`nothing funded at ${pkScript} yet`)
    this.name = 'LockupNotFunded'
    this.pkScript = pkScript
  }
}

/** Outputs ARE there and none is worth what the quote promised: a refusal. */
export class LockupAmountMismatch extends Error {
  constructor(expectedSats, foundSats) {
    super(`lockup holds ${foundSats.join(', ')} sats, quote promised ${expectedSats} — refusing to claim`)
    this.name = 'LockupAmountMismatch'
    this.expected = expectedSats
    this.found = foundSats
  }
}

// Seal `P` to covclaimd, `ephPub(33) || nonce(12) || ciphertext` base64. The
// mistake nothing local detects: the shared secret is the X coordinate ONLY
// (RFC 5903 §9) — the compressed point's parity byte is dropped.
export const sealToCovclaimd = (preimage, covclaimdPubKeyHex) => {
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

export const buildReceiveRequest = ({ rfqId, amountSats, paymentHash, payoutAddress, payoutPubkey, claimPacket }) => ({
  v: 1,
  type: 'rfq_request',
  rfq_id: rfqId,
  pair: RFQ_PAIR_RECEIVE,
  amount_side: 'to',
  amount: amountSats,
  profile: {
    payment_hash: paymentHash,
    payout_address: payoutAddress,
    payout_pubkey: payoutPubkey,
    claim_packet: claimPacket,
  },
})

// Derive the lockup from the quote's binding fields and the client's own data.
// Role-inverted: the client is `receiver` here. Two candidates, § 7.1.1.1.
export const deriveReceiveLockup = ({ quote, arkade, paymentHash, payoutAddress, payoutPubkey, emulatorPubkey }) => {
  const serverKey = arkade.wallet.arkServerPublicKey
  const build = (legacy) => {
    const script = new CovenantSwapScript({
      receiver: hex.decode(payoutPubkey),
      server: serverKey,
      preimageHash: scriptHashFromPaymentHash(paymentHash),
      refundLocktime: quote.refund_locktime, //   binding field #1
      claimDelay: arkade.unilateralDelays.unilateralClaimDelay,
      client: hex.decode(quote.solver_pubkey), // binding field #2
      clientRefundDelay: arkade.unilateralDelays.unilateralRefundWithoutReceiverDelay,
      refundWithoutServerDelay: arkade.unilateralDelays.unilateralRefundDelay,
      nonInteractiveParameters: {
        emulatorPubkey: hex.decode(emulatorPubkey),
        receiverPkScript: ArkAddress.decode(payoutAddress).pkScript,
        // Compare-only: the SOLVER's own refund, so a lie here robs itself.
        senderPkScript: hex.decode(quote.profile.solver_refund_pk_script),
        ...(legacy ? { legacy: 'preTimelockedRefund' } : {}),
      },
    })
    return { script, address: script.address(arkade.hrp, serverKey).encode(), pkScript: hex.encode(script.pkScript) }
  }
  return { candidates: [build(false), build(true)] }
}

// What the quote entitles the client to claim: EXACT value, the filter the
// solver's own `receive/orchestrator.ts` applies. A sat short is not a smaller
// swap, and a stray payment to a public script is nobody's promise.
export const claimableForQuote = (outputs, expectedSats) => outputs.filter((output) => output.value === expectedSats)

// Wait for the quoted amount, returning ONLY those outputs. Polled: the indexer
// shows a new VTXO to funder and claimant at different instants.
export const awaitQuotedLockup = async ({
  arkade,
  pkScript,
  expectedSats,
  attempts = POLL_ATTEMPTS,
  intervalMs = POLL_INTERVAL_MS,
  read = findLockups,
}) => {
  let seen = []
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    seen = await read(arkade, pkScript)
    const claimable = claimableForQuote(seen, expectedSats)
    if (claimable.length > 0) return claimable
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  // Two exhaustion reasons, two errors: an empty script is a wait that ran out.
  if (seen.length === 0) throw new LockupNotFunded(pkScript)
  throw new LockupAmountMismatch(
    expectedSats,
    seen.map((output) => output.value),
  )
}

/** Verify script, verify amount, sign. `arkade.identity` holds `payoutPubkey`. */
export const claimReceived = async ({
  arkade,
  quote,
  preimage,
  payoutAddress,
  payoutPubkey,
  emulatorPubkey = undefined,
  emulatorUrl,
  // Real defaults: under `checkJs` a bare parameter is a REQUIRED property.
  onEvent = (name, data) => {},
  attempts = POLL_ATTEMPTS,
  intervalMs = POLL_INTERVAL_MS,
  read = findLockups,
  claim = claimSwapScript,
}) => {
  if (emulatorPubkey === undefined && emulatorUrl === undefined) {
    throw new Error('claimReceived needs an emulatorPubkey or an emulatorUrl, read from YOUR OWN endpoint')
  }
  const emulatorKey = emulatorPubkey ?? (await fetchEmulatorPubkey(emulatorUrl))
  const paymentHash = hex.encode(sha256(preimage))
  const { candidates } = deriveReceiveLockup({
    quote,
    arkade,
    paymentHash,
    payoutAddress,
    payoutPubkey,
    emulatorPubkey: emulatorKey,
  })

  const matchedAddress = verifyLockupAddress(
    quote,
    candidates.map((candidate) => candidate.address),
  )
  const matched = candidates.find((candidate) => candidate.address === matchedAddress)
  if (!matched) throw new Error(`no derived candidate matches the verified address ${matchedAddress}`)
  onEvent('verified', { address: matched.address })

  const outputs = await awaitQuotedLockup({
    arkade,
    pkScript: matched.pkScript,
    expectedSats: quote.to_amount,
    attempts,
    intervalMs,
    read,
  })
  onEvent('funded', { sats: quote.to_amount, outputs: outputs.length })

  const txid = await claim(arkade, matched.script, outputs, preimage, payoutAddress)
  onEvent('claimed', { txid })
  return { txid, paymentHash, ...matched }
}
