/**
 * The CLIENT's half of the receive legs: sealing `P` to covclaimd.
 *
 * This exists nowhere in `src/` and never should — the whole point of the
 * claim packet is that the SOLVER cannot decrypt it (`src/receive/covclaimd.ts`:
 * "the client encrypts to covclaimd directly, and the provider only ever sees
 * the preimage once it appears in a claim witness"). A real integration seals
 * this in the client wallet. An e2e that plays both roles has to do it here,
 * the same way `src/cli.ts`'s `send-onchain` command carries the client's own
 * claim-transaction signing for the send leg.
 *
 * The scheme is transcribed from `docs/environment.md` § "covclaimd wire
 * protocol", which recovered it from a vendored SDK build:
 *
 *   ephemeral secp256k1 key, ECDH, HKDF-SHA256 with info
 *   `covclaimd/preimage/v1` and the ephemeral public key as salt, then
 *   AES-GCM with that same key as additional data.
 *   Wire layout is `ephPub(33) || nonce(12) || ciphertext`.
 *
 * The prose above underdetermines exactly one detail, and it is the detail
 * that matters:
 *
 *   **The ECDH shared secret is the 32-byte X COORDINATE, not the 33-byte
 *   compressed point.**
 *
 * Confirmed three independent ways, after a first attempt using the
 * compressed point was rejected by a live daemon:
 *
 *  1. covclaimd's own source — `pkg/preimage/crypto.go`'s `ecdhX()` returns
 *     `result.X` as 32 big-endian bytes, then `deriveSymKey` runs
 *     `hkdf.New(sha256, shared, salt=ephPub, info)` and `aead.Seal(nil,
 *     nonce, plaintext, ephPub)` — so ephPub is BOTH the HKDF salt and the
 *     GCM additional data, and Go's GCM appends the 16-byte tag.
 *  2. `arkade-os/ts-sdk`'s `@arkade-os/swap` reference client, which takes
 *     `.subarray(1)` off the shared point for the same reason.
 *  3. A live `ghcr.io/arkade-os/covclaimd:v0.0.1-rc.1` on 2026-08-07:
 *     `POST /v1/reveal` returns 200 for this construction and 400 `decrypt
 *     preimage: aead open: cipher: message authentication failed` for every
 *     neighbouring one (4 secret encodings x salt present/absent x AAD
 *     present/absent).
 *
 * `@noble/curves`' `getSharedSecret` returns the compressed point by default,
 * so the natural transcription is wrong in a way nothing local can catch:
 * both sides derive a well-formed 32-byte key, and only the remote AEAD tag
 * check ever disagrees. That matrix is not kept as a test — it needs a live
 * covclaimd and asserts a fact about a third-party service, not about this
 * repo — but the 400/200 split is an unambiguous oracle to re-derive from if
 * covclaimd's scheme ever changes.
 */

import { createCipheriv, randomBytes } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { base64, hex } from '@scure/base'

/** HKDF `info`, verbatim from docs/environment.md. */
const HKDF_INFO = utf8ToBytes('covclaimd/preimage/v1')
/** AES-256-GCM: 32-byte key, 12-byte nonce — the sizes the wire layout's `nonce(12)` implies. */
const KEY_BYTES = 32
const NONCE_BYTES = 12

export interface SealedClaimPacket {
  /** What goes on the wire as `claim_packet` / `RevealParams.ciphertext`: base64 of `ephPub || nonce || ciphertext`. */
  packet: string
  /** `P` itself — the client keeps this; it is never sent. */
  preimage: Uint8Array
  /** `sha256(P)`, hex — the `payment_hash` the quote is requested against. */
  paymentHash: string
}

/**
 * Seal `preimage` to covclaimd's public key.
 *
 * `covclaimdPubKeyHex` is the `covclaimd_pub_key` from
 * `GET /v1/preimage/covclaimd-pubkey` (compressed secp256k1, hex) — read it
 * live rather than hardcoding it; covclaimd generates its own key.
 */
export const sealClaimPacket = (preimage: Uint8Array, covclaimdPubKeyHex: string): SealedClaimPacket => {
  const ephemeralPriv = secp256k1.utils.randomSecretKey()
  const ephemeralPub = secp256k1.getPublicKey(ephemeralPriv, true)
  // X coordinate only (RFC 5903 §9). `getSharedSecret` hands back the 33-byte
  // compressed point, so the leading parity byte is dropped — see this file's
  // header: keeping it is the one mistake covclaimd rejects and nothing local
  // can detect.
  const shared = secp256k1.getSharedSecret(ephemeralPriv, hex.decode(covclaimdPubKeyHex), true).slice(1)
  const key = hkdf(sha256, shared, ephemeralPub, HKDF_INFO, KEY_BYTES)

  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(ephemeralPub)
  // GCM's authentication tag is appended to the ciphertext, the near-universal
  // ECIES convention and the only reading under which `ciphertext` is a single
  // trailing field in the documented `ephPub || nonce || ciphertext` layout.
  const sealed = Buffer.concat([cipher.update(preimage), cipher.final(), cipher.getAuthTag()])

  const wire = new Uint8Array(ephemeralPub.length + nonce.length + sealed.length)
  wire.set(ephemeralPub, 0)
  wire.set(nonce, ephemeralPub.length)
  wire.set(sealed, ephemeralPub.length + nonce.length)

  return { packet: base64.encode(wire), preimage, paymentHash: hex.encode(sha256(preimage)) }
}

/** A fresh 32-byte `P` and its sealed packet — what a client generates at the start of any receive swap. */
export const newSealedPreimage = (covclaimdPubKeyHex: string): SealedClaimPacket =>
  sealClaimPacket(randomBytes(32), covclaimdPubKeyHex)
