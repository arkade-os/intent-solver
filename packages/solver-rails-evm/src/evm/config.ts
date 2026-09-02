/**
 * Loading an EVM chain's settings, and refusing the ones that are unsafe.
 *
 * The rest of this directory takes its chain facts as arguments precisely so
 * none of them is compiled in. This is where those arguments come from, and
 * where a misconfiguration is turned into a startup failure rather than a
 * surprise on the money path.
 *
 * EVERY VALUE IS REQUIRED WHEN THE CORRIDOR IS ENABLED. No defaults for block
 * cadence or acceptance policy, deliberately: a default is a guess about a
 * chain this service has never seen, and both knobs are wrong in a direction
 * that costs money. An operator enabling a new chain must state what it does.
 */

import { assertCadence, type EvmBlockCadence } from './blockTime.js'

/** What the adapter and the corridor need to know about one chain. */
export interface EvmChainConfig {
  /** `ERC20Swap` on this chain, 20 bytes. */
  contractAddress: Uint8Array
  /** JSON-RPC endpoint. */
  rpcUrl: string
  /** EIP-155 chain id, so a signer cannot replay a transaction onto another chain. */
  chainId: number
  cadence: EvmBlockCadence
  /**
   * Confirmations before a lock is treated as real — the depth half of the
   * acceptance policy.
   */
  minConfirmations: number
  /**
   * How long a lock must ALSO have been buried, in seconds — the time half.
   *
   * BOTH halves exist because depth alone is not finality, and on a rollup the
   * gap is the whole risk. Base, Arbitrum, Optimism and zkSync each run a
   * single sequencer that issues a receipt in 1–2 seconds; a lock can be many
   * "confirmations" deep in that sequence and still vanish, because safety
   * comes from the L1 posting finalising (~12 minutes), not from the count.
   *
   * A depth-only policy invites exactly the mistake: `minConfirmations: 5` on a
   * 250ms chain is a little over a second of protection while reading like a
   * conservative number. Requiring an age as well means the fast chain cannot
   * quietly buy less safety than the slow one.
   *
   * The observer takes the LATER of the two. Neither is a default, and neither
   * may be zero: `EVM_MIN_AGE_SECONDS=0` would satisfy the age check on every
   * block and collapse the policy back to depth-only, which is the precise
   * mistake this field exists to prevent. An operator who wants a short age
   * must say a short age, not none.
   */
  minAgeSeconds: number
  /**
   * The key that signs this corridor's transactions, 32 bytes.
   *
   * SEPARATE from `ARK_MNEMONIC` on purpose. An Arkade key and an EVM key protect
   * different money on different chains, and deriving one from the other would
   * mean an operator rotating either had silently rotated both — including the
   * one holding funds mid-swap.
   */
  privateKey: Uint8Array
  /**
   * Gas ceiling for one call.
   *
   * A CEILING rather than an estimate: `eth_estimateGas` cannot be trusted for a
   * call that reverts under conditions the estimate does not reproduce, and a
   * claim that fails for want of gas past the timeout is a total loss rather than
   * a retry.
   */
  gasLimit: bigint
  /**
   * The fee-per-gas this deployment refuses to price above.
   *
   * Bounds what one transaction may cost, and the pricing reports when it BOUND
   * the answer rather than silently underpricing — @see fees.ts on why a capped
   * claim is a reason to act.
   */
  maxFeeCeilingPerGas: bigint
  /** How long a transaction must stay viable unmined, seconds. */
  headroomSeconds: number
  /**
   * How long a quote binds the solver to the quoted rate, seconds.
   *
   * POLICY rather than chain fact, so this one HAS a default: rfq-protocol.md
   * §5 puts cross-asset windows "on the order of ~30 seconds", and the window
   * is the tolerance parameter of the whole protocol — every second of it is an
   * unhedged option on a live pair that the spread does not price. Bounded
   * below by what a client needs to fund a lockup after seeing the quote, and
   * above by what the solver can carry: at the 900s ceiling and 50% annualized
   * vol the embedded option is ~20 bps of notional before any spread.
   */
  quoteValiditySeconds: number
}

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is not set`)
  return value
}

/**
 * A number knob with the same empty-string discipline as `packages/solver-app/src/config.ts`'s
 * `intFromEnv`: `Number('')` is 0, so a set-but-empty variable would otherwise
 * become zero while the logs claim otherwise.
 *
 * Allows non-integers, because a sub-second block cadence is a real value on
 * chains this must support.
 */
const numberFrom = (env: NodeJS.ProcessEnv, name: string, min: number): number => {
  const raw = required(env, name)
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${name} must be a finite number >= ${min}, got ${JSON.stringify(raw)}`)
  }
  return value
}

const intFrom = (env: NodeJS.ProcessEnv, name: string, min: number): number => {
  const raw = required(env, name)
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}, got ${JSON.stringify(raw)}`)
  }
  return value
}

/**
 * An integer knob WITH a default, and a ceiling as well as a floor. Set-but-empty
 * reads as unset, matching `packages/solver-app/src/config.ts`'s `intFromEnv`: `Number('')` is 0, and
 * a set-but-empty variable would otherwise become the floor while the logs claim
 * otherwise.
 */
const intFromOptional = (env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number => {
  const raw = env[name]?.trim()
  if (raw === undefined || raw === '') return def
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}], got ${JSON.stringify(raw)}`)
  }
  return value
}

/** `0x`-prefixed 20-byte address to bytes. Case-insensitive; checksum is not verified. */
export const addressFromHex = (value: string, name: string): Uint8Array => {
  if (!HEX_ADDRESS.test(value)) throw new Error(`${name} must be a 0x-prefixed 20-byte address, got ${value}`)
  const body = value.slice(2)
  const out = new Uint8Array(20)
  for (let i = 0; i < 20; i++) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * Read one chain's configuration, or null when the corridor is not enabled.
 *
 * Absent `EVM_RPC_URL` means "not serving this corridor" and is not an error.
 * Anything else missing IS an error: a half-configured chain must not start,
 * because the missing half is always a safety knob.
 */
/**
 * A 32-byte signing key from hex.
 *
 * REQUIRED, with no default. A generated-on-startup key would sign transactions
 * from an account holding nothing, so every call would fail for want of gas — and
 * it would look like a chain problem rather than a missing setting.
 */
const privateKeyFrom = (env: NodeJS.ProcessEnv, name: string): Uint8Array => {
  const raw = required(env, name).trim()
  const body = raw.startsWith('0x') ? raw.slice(2) : raw
  if (body.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(body)) {
    throw new Error(name + ' must be 32 bytes of hex')
  }
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * A positive bigint knob. REQUIRED, like every other knob in this module.
 *
 * No default even where an obvious one exists — the same call
 * `EVM_MIN_CONFIRMATIONS` makes. Opting into a chain at all is the opt-in; once
 * taken, the numbers that bound what a transaction may cost are the operator's to
 * state rather than this module's to guess. Zero is rejected because neither knob
 * means anything at zero: no gas executes nothing, and a zero ceiling refuses
 * every price.
 */
const bigintFrom = (env: NodeJS.ProcessEnv, name: string): bigint => {
  const raw = required(env, name).trim()
  if (!/^[0-9]+$/.test(raw)) throw new Error(name + ' must be a decimal integer, got ' + raw)
  const value = BigInt(raw)
  if (value <= 0n) throw new Error(name + ' must be positive, got ' + raw)
  return value
}

export const loadEvmChainConfig = (env: NodeJS.ProcessEnv = process.env): EvmChainConfig | null => {
  if (!env.EVM_RPC_URL?.trim()) return null

  // `Number.MIN_VALUE` is the SENTINEL FOR "POSITIVE", not a plausible bound:
  // it is the smallest number above zero a double can hold (5e-324), so
  // `>= MIN_VALUE` is exactly `> 0` for a finite value. A block cadence of zero
  // is the thing being rejected — it makes every duration convert to infinite
  // blocks. `Number.EPSILON` would read more clearly and be wrong: at 2.22e-16
  // it is a real threshold, so it rejects positive values rather than only
  // zero and negatives.
  const cadence: EvmBlockCadence = {
    fastestSecondsPerBlock: numberFrom(env, 'EVM_FASTEST_SECONDS_PER_BLOCK', Number.MIN_VALUE),
    slowestSecondsPerBlock: numberFrom(env, 'EVM_SLOWEST_SECONDS_PER_BLOCK', Number.MIN_VALUE),
  }
  // Rejected HERE rather than at first use. Swapped bounds do not throw
  // downstream — both conversions keep working and silently return the unsafe
  // answer on every swap — so startup is the only place this is catchable.
  assertCadence(cadence)

  return {
    contractAddress: addressFromHex(required(env, 'EVM_HTLC_ADDRESS'), 'EVM_HTLC_ADDRESS'),
    rpcUrl: required(env, 'EVM_RPC_URL'),
    chainId: intFrom(env, 'EVM_CHAIN_ID', 1),
    cadence,
    minConfirmations: intFrom(env, 'EVM_MIN_CONFIRMATIONS', 1),
    // Positive, not non-negative — same sentinel as the cadence knobs. Zero
    // is depth-only wearing a two-knob disguise.
    minAgeSeconds: numberFrom(env, 'EVM_MIN_AGE_SECONDS', Number.MIN_VALUE),
    privateKey: privateKeyFrom(env, 'EVM_PRIVATE_KEY'),
    gasLimit: bigintFrom(env, 'EVM_GAS_LIMIT'),
    maxFeeCeilingPerGas: bigintFrom(env, 'EVM_MAX_FEE_PER_GAS_CEILING'),
    headroomSeconds: numberFrom(env, 'EVM_FEE_HEADROOM_SECONDS', Number.MIN_VALUE),
    quoteValiditySeconds: intFromOptional(env, 'EVM_QUOTE_VALIDITY_SECONDS', 60, 10, 900),
  }
}
