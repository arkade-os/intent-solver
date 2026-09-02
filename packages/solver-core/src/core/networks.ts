/**
 * One table of network facts.
 *
 * Every attribute that varies by network lives here, keyed by network, so
 * adding one is a single edit that the compiler forces you to complete. The
 * previous shape spread these across four parallel maps in two modules, where
 * the network key was typed loosely enough that a new member was not a compile
 * error — it just failed to parse at runtime.
 */

import type { Limits } from './limits.js'

const TESTNET_LIMITS: Limits = { minSats: 1_000, maxSats: 1_000_000 }

/**
 * Mainnet is capped below the test networks on purpose: this service moves real value
 * there. `MAX_SWAP_SATS` / `LN_SEND_MAX_SATS` can narrow a deployment below this,
 * never widen past it.
 */
const BITCOIN_LIMITS: Limits = { minSats: 500, maxSats: 50_000 }

export interface NetworkProfile {
  /** Amount range this network permits. */
  limits: Limits
  /**
   * This network's name in the uppercase spelling a backend SDK may ask for.
   *
   * The same network as the key it sits under, respelled: read only where a
   * backend is constructed, never by the swap logic above the port, since which
   * casing a vendor wants is an adapter's business. Present on every network
   * rather than nullable, so a backend reading it never has to handle a hole;
   * whether a given backend can actually serve a network is the backend's own
   * question, answered where it is constructed rather than by a null here.
   */
  backendNetwork: 'MAINNET' | 'SIGNET' | 'REGTEST'
  /** bech32 prefix a BOLT11 carries here. */
  invoicePrefix: string
  /** bech32 prefix for Arkade addresses here. */
  arkadeHrp: string
  /**
   * The network name the Arkade server must report at `/v1/info` (arkd's
   * arklib `Network.Name`). Checked at startup: the invoice prefix, address HRP
   * and key derivation all come from this profile, so a server on a different
   * network means paying real invoices to claim vtxos on the wrong chain.
   */
  arkdNetwork: string
  /**
   * Emulator service that co-signs covenant (ArkadeScript) spends, or undefined
   * where none is known — EMULATOR_URL must then be configured explicitly.
   */
  emulatorUrl: string | undefined
  /**
   * Whether BIP32 derivation should use the mainnet coin type.
   *
   * Genuinely a boolean — the derivation path is binary — but it belongs to the
   * profile rather than being the only network fact that crosses a boundary.
   */
  isMainnet: boolean
  /**
   * Lowers the SDK's minimum accepted checkpoint exit delay, in seconds, or
   * undefined to keep the SDK's own floor (86400 off regtest, 1200 on it).
   *
   * A network fact rather than an env knob: it relaxes a fund-safety bound — how
   * long our recourse takes when the Arkade Service stops cooperating — so the one
   * deployment that must never carry it is mainnet, and living here means a testnet
   * env file copied toward mainnet has nothing to carry. `undefined` is spelled out
   * per network so adding a network forces the decision rather than defaulting it.
   */
  minCheckpointExitDelaySeconds: number | undefined
  /**
   * Where a human goes to look at what this service moved.
   *
   * TWO, because the corridors span two chains and neither explorer can show the
   * other's data. Pointing an L1 txid at the Arkade explorer produces a "not found"
   * that reads exactly like lost funds.
   *
   * No trailing slash: the builders in `./explorers.ts` join a path onto these.
   */
  explorers: {
    arkade: string
    onchain: string
  }
}

export const NETWORKS = {
  bitcoin: {
    limits: BITCOIN_LIMITS,
    backendNetwork: 'MAINNET',
    invoicePrefix: 'bc',
    arkadeHrp: 'ark',
    arkdNetwork: 'bitcoin',
    emulatorUrl: '<emulator-url>',
    isMainnet: true,
    minCheckpointExitDelaySeconds: undefined,
    explorers: { arkade: 'https://arkade.space', onchain: 'https://mempool.arkade.sh' },
  },
  // Mutinynet is a signet: the Lightning side cannot tell the two apart, so they
  // share an invoice prefix.
  mutinynet: {
    limits: TESTNET_LIMITS,
    backendNetwork: 'SIGNET',
    invoicePrefix: 'tbs',
    arkadeHrp: 'tark',
    arkdNetwork: 'mutinynet',
    emulatorUrl: undefined,
    isMainnet: false,
    // The hosted Service advertises 4096s, and the SDK cannot tell mutinynet from
    // signet — both are byte-identical `Network` structs — so it applies the 86400s
    // mainnet-grade floor and `Wallet.create` refuses to connect. Upstream rejected
    // keying the floor off the server's own `info.network` because that would make
    // the relaxed bound operator-selectable (arkade-os/ts-sdk#706); the same
    // objection rules out reading the advertised `checkpointTapscript`, which is the
    // value being validated. So the number is pinned here, on the client.
    //
    // Exact, not lower: the SDK compares with a strict `<`, so 4096 accepts this
    // Service and refuses one that later shortens its delay. arkade-os/wallet#891
    // pins the identical constant.
    minCheckpointExitDelaySeconds: 4096,
    explorers: { arkade: 'https://explorer.mutinynet.arkade.sh', onchain: 'https://mempool.mutinynet.arkade.sh' },
  },
  signet: {
    limits: TESTNET_LIMITS,
    backendNetwork: 'SIGNET',
    invoicePrefix: 'tbs',
    arkadeHrp: 'tark',
    arkdNetwork: 'signet',
    emulatorUrl: undefined,
    isMainnet: false,
    minCheckpointExitDelaySeconds: undefined,
    explorers: { arkade: 'https://explorer.signet.arkade.sh', onchain: 'https://mempool.signet.arkade.sh' },
  },
  regtest: {
    limits: TESTNET_LIMITS,
    backendNetwork: 'REGTEST',
    invoicePrefix: 'bcrt',
    arkadeHrp: 'tark',
    arkdNetwork: 'regtest',
    emulatorUrl: undefined,
    isMainnet: false,
    // The SDK's regtest floor is already 1200, and the stack's own
    // ARKD_CHECKPOINT_EXIT_DELAY=1536 clears it. Nothing to relax.
    minCheckpointExitDelaySeconds: undefined,
    explorers: { arkade: 'http://localhost:7080', onchain: 'http://localhost:3000' },
  },
} as const satisfies Record<string, NetworkProfile>

export type SwapNetwork = keyof typeof NETWORKS

export const isSwapNetwork = (value: string): value is SwapNetwork => value in NETWORKS
