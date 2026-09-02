/**
 * The onchain (Bitcoin L1) HTLC lockup script: a Taproot address with two
 * script-path leaves, script-path only — no key-path spend.
 *
 * Same hash convention as the Arkade-side covenant script
 * (`arkade/covenant.ts`'s `preimageCondition`): HASH160 = ripemd160(sha256(P)).
 * One preimage hash gates both legs of a swap, so both scripts must agree on
 * how it is computed — never introduce a second hash function here.
 *
 * The internal key is the standard NUMS point (`TAPROOT_UNSPENDABLE_KEY`), so
 * there is no key-path spend to reason about: every spend goes through
 * `claimScript` or `refundScript`.
 */

import { hex } from '@scure/base'
import { Script, p2tr, TaprootControlBlock, TAPROOT_UNSPENDABLE_KEY } from '@scure/btc-signer'
import { assertAbsoluteLocktime } from '@arkade-os/solver-core/core/timelocks.js'
import type { SwapNetwork } from '@arkade-os/solver-core/core/networks.js'
import { scriptHashFromPaymentHash } from '@arkade-os/solver-core/core/preimage.js'

/**
 * Same shape as `@scure/btc-signer`'s own (unexported-from-index) `BTC_NETWORK`
 * type — declared locally so this module doesn't depend on a subpath import.
 */
export interface OnchainNetworkProfile {
  bech32: string
  pubKeyHash: number
  scriptHash: number
  wif: number
}

/**
 * bech32 HRP and legacy version bytes per network. `@scure/btc-signer` ships
 * `NETWORK` (mainnet) and `TEST_NETWORK` (testnet, hrp `tb`), but regtest's
 * hrp (`bcrt`) has no built-in constant, so all four networks are declared
 * explicitly here — one table, like `core/networks.ts`.
 */
export const ONCHAIN_NETWORKS: Record<SwapNetwork, OnchainNetworkProfile> = {
  bitcoin: { bech32: 'bc', pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 },
  mutinynet: { bech32: 'tb', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef },
  signet: { bech32: 'tb', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef },
  regtest: { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef },
}

export interface OnchainHtlcParams {
  network: OnchainNetworkProfile
  /** `sha256(P)`, hex (64 chars) — the WIRE form; the script's HASH160 commitment is derived internally. */
  paymentHash: string
  /** x-only pubkey (32 bytes) of whoever claims this HTLC by revealing P. */
  claimPubkey: Uint8Array
  /** x-only pubkey (32 bytes) of whoever reclaims it after `refundLocktime`. */
  refundPubkey: Uint8Array
  /** Absolute unix-seconds CLTV (BIP65) after which the refund leaf opens. */
  refundLocktime: number
}

export interface OnchainHtlc {
  address: string
  pkScript: Uint8Array
  claimScript: Uint8Array
  refundScript: Uint8Array
  claimControlBlock: Uint8Array
  refundControlBlock: Uint8Array
  paymentHash: string
  refundLocktime: number
}

const assertXOnlyKey = (key: Uint8Array, label: string): void => {
  if (key.length !== 32) throw new Error(`${label} must be a 32-byte x-only pubkey, got ${key.length}`)
}

/**
 * `SIZE 32 EQUALVERIFY HASH160 <hash20> EQUALVERIFY <claimPubkey> CHECKSIG`.
 *
 * The opening SIZE gate pins the witness preimage to 32 bytes before it is
 * hashed, the same way BOLT3's HTLC scripts do. The wire `payment_hash` is
 * `sha256(P)` and sha256 takes any-length input, so the hash check on its own
 * would just as happily admit a P of some other length; pinning it keeps the
 * value that opens this leaf the same fixed-width preimage the rest of the
 * swap passes around.
 *
 * The tail is the Arkade-side claim leaf's preimage condition
 * (`arkade/covenant.ts`'s `preimageConditionAsm`) terminated with a plain
 * CHECKSIG instead of the Arkade program's multi-signer form — this script
 * has exactly one signer.
 */
const claimLeafScript = (hash160: Uint8Array, claimPubkey: Uint8Array): Uint8Array =>
  Script.encode(['SIZE', 32, 'EQUALVERIFY', 'HASH160', hash160, 'EQUALVERIFY', claimPubkey, 'CHECKSIG'])

/** `<refundLocktime> CHECKLOCKTIMEVERIFY DROP <refundPubkey> CHECKSIG`. */
const refundLeafScript = (refundLocktime: number, refundPubkey: Uint8Array): Uint8Array =>
  Script.encode([refundLocktime, 'CHECKLOCKTIMEVERIFY', 'DROP', refundPubkey, 'CHECKSIG'])

export const buildOnchainHtlc = (params: OnchainHtlcParams): OnchainHtlc => {
  // scriptHashFromPaymentHash (src/core/preimage.ts) already asserts the
  // 32-byte length and throws "payment hash must be 32 bytes, got N" —
  // reused rather than re-checked here, same as the Arkade-side script does.
  const hash160 = scriptHashFromPaymentHash(params.paymentHash)
  assertXOnlyKey(params.claimPubkey, 'claimPubkey')
  assertXOnlyKey(params.refundPubkey, 'refundPubkey')
  assertAbsoluteLocktime(params.refundLocktime)

  const claimScript = claimLeafScript(hash160, params.claimPubkey)
  const refundScript = refundLeafScript(params.refundLocktime, params.refundPubkey)

  // allowUnknownOutputs: true — these are custom leaves, not one of the
  // library's recognised standard patterns, and that is intentional.
  const payment = p2tr(
    TAPROOT_UNSPENDABLE_KEY,
    [{ script: claimScript }, { script: refundScript }],
    params.network,
    true,
  )

  // `payment.leaves[i].controlBlock` exists at runtime but is missing from
  // this package's own type declarations (a real gap in its .d.ts, not a
  // mistake here) — so control blocks are read the same way
  // `arkade-os/ts-sdk`'s `@arkade-os/swap` package does (`onchainHtlc.ts`'s
  // `controlBlockFor`): scan `tapLeafScript`'s `[block, script]` tuples
  // (`script` is the leaf script plus one trailing leaf-version byte) for
  // the one matching each leaf, and encode its control block.
  const controlBlockFor = (leaf: Uint8Array): Uint8Array => {
    for (const [block, script] of payment.tapLeafScript ?? []) {
      if (script.length - 1 === leaf.length && hex.encode(script.subarray(0, leaf.length)) === hex.encode(leaf)) {
        return TaprootControlBlock.encode(block)
      }
    }
    throw new Error('leaf missing from compiled taproot tree') // unreachable: we just built it
  }

  return {
    address: payment.address!,
    pkScript: payment.script,
    claimScript,
    refundScript,
    claimControlBlock: controlBlockFor(claimScript),
    refundControlBlock: controlBlockFor(refundScript),
    paymentHash: params.paymentHash,
    refundLocktime: params.refundLocktime,
  }
}
