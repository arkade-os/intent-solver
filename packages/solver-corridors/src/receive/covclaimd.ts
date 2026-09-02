/**
 * The one and only place covclaimd (the non-interactive-claim daemon) is
 * imported. Same rule as `src/onchain/esplora.ts`: a plain `fetch`-based
 * client, no vendor SDK, so the receive leg can run on Cloudflare Workers
 * same as everything else in this repo.
 *
 * Wire protocol recovered from a live instance and cross-checked against
 * `docs/environment.md` (traced from a vendored SDK build, not invented):
 * covclaimd holds the private half of a keypair whose public half it serves
 * over HTTP; a client ECIES-seals the preimage to that key and hands the
 * ciphertext to the solver as an opaque `claim_packet` the solver can never
 * decrypt. `reveal()` is the solver handing that packet onward once the
 * Arkade side is funded — covclaimd verifies `taptree` hashes to
 * `swapAddress` itself (it does not trust the caller's `arkade_script`
 * blindly) before decrypting and pushing the claim autonomously.
 */

export interface CovclaimdPubKeys {
  /** covclaimd's own pubkey, compressed secp256k1, hex — what a client ECIES-seals a preimage to. */
  covclaimdPubKey: string
  /** The emulator's pubkey, compressed hex — same key `RestEmulatorProvider(emulatorUrl).getInfo()` reports. */
  emulatorPubKey: string
}

export interface RevealParams {
  /** The funded VHTLC's Arkade address, bech32m. */
  swapAddress: string
  /** The client's ECIES-sealed preimage: base64 of `ephPub(33) || nonce(12) || ciphertext`. */
  ciphertext: string
  /** Base64-encoded `enforcePayTo` ArkadeScript covclaimd's claim co-signs against. */
  arkadeScript: string
  /** Hex-encoded, serialized VtxoScript (the funded VHTLC's full taproot leaf set). */
  taptree: string
}

export class CovclaimdError extends Error {}

export interface CovclaimdClient {
  getPubKeys(): Promise<CovclaimdPubKeys>
  reveal(params: RevealParams): Promise<void>
}

/**
 * `timeoutMs` bounds every request — covclaimd is external-to-this-repo
 * infrastructure the same way the emulator is (`docs/runbook.md`'s "Gate the
 * emulator at the network level" note applies here too); a hung connection
 * must not hang the swap that's waiting on it.
 */
export const createCovclaimdClient = (baseUrl: string, timeoutMs = 30_000): CovclaimdClient => {
  const url = baseUrl.replace(/\/$/, '')

  return {
    async getPubKeys() {
      const response = await fetch(`${url}/v1/preimage/covclaimd-pubkey`, { signal: AbortSignal.timeout(timeoutMs) })
      if (!response.ok) throw new CovclaimdError(`covclaimd getPubKeys failed: ${response.status}`)
      const body = (await response.json()) as { covclaimd_pub_key: string; emulator_pub_key: string }
      return { covclaimdPubKey: body.covclaimd_pub_key, emulatorPubKey: body.emulator_pub_key }
    },

    async reveal(params) {
      const response = await fetch(`${url}/v1/reveal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          swap_address: params.swapAddress,
          packet: { ciphertext: params.ciphertext, arkade_script: params.arkadeScript },
          taptree: params.taptree,
        }),
      })
      if (!response.ok) {
        const detail = await response.text()
        throw new CovclaimdError(`covclaimd reveal failed: ${response.status} ${detail}`)
      }
    },
  }
}
