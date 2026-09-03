/**
 * Configuration, read once from the environment.
 *
 * Secrets are only ever read from the environment. They are never written to the
 * repository, never logged, and never included in an error message — a mnemonic
 * that reaches a log is a mnemonic that has to be rotated.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { base64 } from '@scure/base'
import { narrow, resolveLimits, type Limits } from '@arkade-os/solver-core/core/limits.js'
import { DEFAULT_LOCKUP_TIMEOUT, MAX_LOCKUP_TIMEOUT } from '@arkade-os/solver-core/core/send.js'
import { MAX_BIP68_BLOCKS, MAX_BIP68_SECONDS, relativeDelayFrom } from '@arkade-os/solver-core/core/timelocks.js'
import { FREE, type Corridor, type Fee } from '@arkade-os/solver-core/core/corridorPolicy.js'
import { ALL_DESCRIPTORS } from '@arkade-os/solver-corridors/corridors/index.js'
import {
  evmCorridorPolicies,
  evmMarkets,
  parseEvmTokens,
  type EvmCorridorPolicy,
  type EvmMarket,
} from '@arkade-os/solver-core/core/evmCorridorConfig.js'
import { isSwapNetwork, NETWORKS, type NetworkProfile, type SwapNetwork } from '@arkade-os/solver-core/core/networks.js'
import { lightningRailNames } from './ops/rails.js'
import type { ArkadeWalletConfig } from '@arkade-os/solver-arkade/arkade/wallet.js'
import type { AdPublishMode } from '@arkade-os/solver-transport/relay/adPublisher.js'

const required = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

/**
 * Integer env knob with the empty-string discipline: `Number('') === 0`, so a
 * set-but-empty variable would otherwise silently become 0 while logs claim
 * the default. Empty/whitespace counts as unset.
 */
const intFromEnv = (name: string, fallback: number, min: number, max = Infinity): number => {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    const range = max === Infinity ? `an integer >= ${min}` : `an integer between ${min} and ${max}`
    throw new Error(`${name} must be ${range}, got ${process.env[name]}`)
  }
  return value
}

export interface LndConfig {
  /** `host:port` of the LND node's gRPC listener. */
  socket: string
  /** Base64-serialized `tls.cert`. */
  cert: string
  /** Base64-serialized macaroon. */
  macaroon: string
  /**
   * Esplora base URL, for the ONCHAIN RECEIVE corridor only. LND's own chain
   * view is wallet-scoped and carries no per-output values, so it cannot see a
   * client's funding transaction — see `onchain/lnd/adapter.ts`'s `findOutputs`.
   * Optional: unset is fine for a send-only deployment, and the receive path
   * fails loudly rather than under-reporting.
   */
  esploraUrl?: string
}

/**
 * The ceiling and floor a corridor's live execution charge is held between —
 * `networkFeePricing`'s `capSats` and `minSats`, read from the environment.
 *
 * A PAIR rather than two independent knobs because the cap is what turns
 * dynamic pricing on: a corridor with no ceiling has no number it can promise a
 * taker in a signed card, and no bound on what a misreported fee rate could
 * quote. Absent means the corridor keeps its fixed flat.
 */
export interface NetworkFeeBounds {
  capSats: number
  minSats: number
}

export interface Config {
  network: SwapNetwork
  profile: NetworkProfile
  limits: Limits
  /** Shaped for createArkadeContext so callers do not each rename the same fields. */
  arkade: ArkadeWalletConfig
  /** Durable swap state. Separate file from the wallet's own database. */
  swapDbPath: string
  /**
   * Per-corridor amount range, each already narrowed by `limits`.
   *
   * A corridor's costs are its own: an onchain leg pays miner fees a Lightning
   * leg does not, and an operator with thin onchain liquidity wants that
   * corridor capped tighter without shrinking the other three. Every entry is
   * `limits` or narrower — see {@link narrow}.
   */
  corridorLimits: Record<Corridor, Limits>
  /**
   * What each corridor charges. Zero everywhere by default, which is what the
   * solver charged before this existed.
   */
  corridorFees: Record<Corridor, Fee>
  /**
   * The bounds a corridor prices its own EXECUTION COST inside, or null to keep
   * charging {@link Config.corridorFees}' flat and nothing else.
   *
   * Null everywhere by default, and that default is the whole safety of this:
   * a deployment that sets none of these quotes exactly the numbers it quoted
   * before dynamic pricing existed, because the corridor is handed no pricing
   * strategy at all and falls back to the same `fixedFeePricing(fee)` it always
   * used. @see core/pricing.ts
   */
  corridorNetworkFees: Record<Corridor, NetworkFeeBounds | null>
  /**
   * How old a sampled onchain fee rate may get before a refresh STARTS, and
   * before the sample stops being believed at all. Milliseconds.
   *
   * Deployment-wide rather than per corridor, unlike the bounds above: the two
   * onchain corridors read ONE backend's ONE estimate, so a per-corridor
   * cadence would buy two sampling schedules over the same upstream call and
   * let the two directions price the same instant differently.
   *
   * @see util/freshness.ts for what the two ages do and why there are two.
   */
  onchainFeeRateRefreshMs: number
  onchainFeeRateStaleMs: number
  /**
   * Which corridors this deployment quotes. All four by default.
   *
   * A disabled corridor is never constructed in `createServices`, so its pair
   * is refused as unsupported at the ingress by name — the answer a solver
   * that does not serve a corridor should give — rather than quoted and then
   * failed per swap. It does NOT stop the sweep driving swaps already in
   * flight: quoting reads a `CorridorSet` and status reads the wider
   * `CorridorReaderSet`, which is built from the stores and so still answers
   * for a corridor an operator switched off.
   */
  corridorEnabled: Record<Corridor, boolean>
  /**
   * Whether the daemon may SPLIT the float on its own, without an operator.
   *
   * Off by default, and not for symmetry with renewal. Renewal preserves what
   * the solver already has; a mint SPENDS, on a timer, with nobody watching —
   * that is a different thing for an operator to have agreed to by omission.
   * The manual `pool-mint` action stays available either way.
   */
  poolAutoMint: boolean
  /**
   * The EVM corridors this deployment serves, both directions per token.
   *
   * EMPTY unless `EVM_TOKENS` names at least one, and empty is the whole of
   * the default: a deployment that sets nothing gets an empty list, no EVM
   * store is opened and no EVM corridor is constructed, so its behaviour is
   * byte-for-byte what it was before this field existed.
   *
   * A LIST rather than a `Record<Corridor, …>` because the corridors name
   * their tokens and so cannot be compile-time keys — @see core/corridorPolicy.
   */
  evmCorridors: readonly EvmCorridorPolicy[]
  /**
   * Where each served token's price comes from. Empty exactly when
   * {@link Config.evmCorridors} is.
   *
   * One entry per TOKEN, not per corridor: a market is the pair, and the two
   * directions of a token share it. @see core/evmCorridorConfig
   */
  evmMarkets: readonly EvmMarket[]
  /**
   * Whether `lightning:BTC->arkade:BTC` may be served when the solver's own
   * solo recourse opens AFTER the incoming htlc's `E` — the #69 window.
   *
   * Off by default, and the default is the safe one.
   *
   * It exists because on mainnet the strict rule makes the corridor unservable
   * outright: `deriveUnilateralDelays` reads the server's `unilateralExitDelay`
   * (605184s, 7 days), so the solo leaf opens at 7.05 days and gate (d) demands 4074
   * blocks of final CLTV — ~28 days of a payer's funds, which nothing routes, so every
   * quote is refused `recourse_window_unservable`. Raising `MAX_FINAL_CLTV_BLOCKS`
   * does not help (2016 reports the wall, it is not the wall), and finishing
   * `TODO(unilateral-exit)` does not either, since the 7-day CSV is unchanged.
   *
   * WHAT TURNING IT ON ACCEPTS: with the Arkade server gone or censoring past the exit
   * delay AND `E` passed, a trader can let the htlc fail back for free and only then
   * claim the Arkade payout, taking both sides. Bounded by the corridor's own cap,
   * which is why mainnet requires `LN_RECEIVE_MAX_SATS` set explicitly — the operator
   * states the number they are risking rather than inheriting it.
   *
   * Defensible because the solver cannot execute that recourse today anyway
   * (`TODO(unilateral-exit)`), so the reserved window protects an action nothing in
   * `src/` can take, and a same-sized loss on the other side is already accepted in
   * `src/arkade/covenant.ts` for the same missing implementation.
   *
   * Lightning leg only. `onchain:BTC->arkade:BTC` carries the same gate and is
   * deliberately NOT covered: there `E` is the client's own onchain locktime with no
   * routing ceiling above it, so a long delay makes that corridor expensive rather
   * than impossible.
   */
  lnReceiveAcceptUnilateralGap: boolean
  /** Cap on the summed amount across all concurrently-exposed swaps. */
  maxExposedSats: number
  /**
   * How long a disabled contract is kept before its row is deleted, ms.
   *
   * Two-stage retirement: a contract whose swap is over and whose script holds
   * nothing is first DISABLED (`watch: 'retained'`), which is reversible and
   * keeps it annotating its own outputs, and only later DELETED. Deleting is
   * what actually bounds cost — `getContractsWithVtxos` hands `syncContracts`
   * an unfiltered contract list, so a retained row is still fetched from the
   * indexer on every snapshot (arkade-os/ts-sdk#787).
   *
   * Operator policy, not a constant: it is "how far back would I want to find a
   * closed swap's contract in the wallet's own views", which only a deployment
   * can answer. @see arkade/contractLifecycle.ts
   */
  contractRetentionMs: number
  /** How many swaps one Lightning-leg sweep drives at once; bounded by what the indexer/LN backend can sustain. */
  sweepConcurrency: number
  /**
   * Esplora base URL used only to read the chain tip height.
   *
   * Needed by a deployment whose arkd advertises BLOCK-typed delays: its covenant
   * timelocks — the CSV ladder and the absolute refund locktime alike — mature on
   * height, so the service needs somewhere to read one. A seconds-typed deployment never
   * reads it and may leave this unset.
   *
   * Falls back to `LND_ESPLORA_URL`, which points at the same indexer on every deployment
   * that has one, so block mode usually needs no new variable at all.
   */
  chainTipEsploraUrl?: string
  /**
   * Funding window a Lightning-send quote grants, seconds — an UPPER bound on
   * it, not the window itself. `lockupDeadlineFor` (`src/core/send.ts`) clips it
   * to the invoice when the invoice expires first, so this does NOT decide the
   * shortest-lived BOLT11 the corridor will quote: a short invoice is quoted
   * with a short window rather than refused.
   */
  lockupTimeoutSeconds: number
  /**
   * Route-hint channels the Lightning-send leg declines to price, as lowercase
   * hex scids (`LN_SEND_HINT_SCID_DENYLIST`). Empty by default, which prices
   * every hint — exactly what the corridor did before the knob existed.
   */
  sendHintScidDenylist: ReadonlySet<string>
  /** Emulator service co-signing covenant refunds. */
  emulatorUrl: string
  /**
   * Which BTC rail this deployment moves money on — the Lightning AND the
   * onchain leg, since both come out of one wallet (@see ops/rails.ts).
   *
   * 'lnd' talks to a real node's gRPC and can be pointed at a local regtest
   * chain. 'fake' forges its own invoices for regtest end-to-end runs, where no
   * Lightning network exists; everything Arkade-side stays real. Any other value
   * names a rail a consumer registered with `registerLightningRail`, which is
   * why this is a `string` rather than a closed union — the set is not knowable
   * at compile time in a repo whose whole point is that someone else can add
   * one.
   *
   * NULL exactly when no BTC corridor is enabled. All four take both their legs
   * from this one value, so a deployment serving only EVM or asset flow has
   * nothing to name — and demanding a Lightning node from it would be demanding
   * infrastructure for corridors it does not run. Any other combination is
   * refused at startup; @see lnBackendFromEnv.
   */
  lnBackend: string | null
  /** Preimage map for the fake backend. */
  fakeLnStatePath: string
  /** Set if and only if lnBackend === 'lnd'. */
  lnd: LndConfig | null
  /** HTTP binding for `serve`. */
  port: number
  host: string
  /**
   * Admin console port, or null when the console is off.
   *
   * Opt-in rather than defaulted: a deployment that sets nothing opens no new
   * socket and behaves exactly as it did. The console shares the provider's
   * process — and therefore its wallet and its process-local coin reservations
   * (`src/arkade/reservations.ts`) — so it can only exist where that process
   * does, which is why this is a knob on the provider rather than a separate
   * command.
   */
  adminPort: number | null
  /**
   * Admin console binding. Loopback by default, like {@link host}.
   *
   * Unlike every other ambiguous knob in this file, a non-loopback value is
   * NOT refused. Access control for this port is a reverse proxy's job by
   * deployment decision, and the container case requires the wider bind: the
   * Dockerfile's default command is `relay`, which opens no port of its own,
   * so in Docker this is the only listening socket and loopback would be
   * unreachable from outside the container.
   *
   * The consequence belongs in docs/runbook.md rather than in a refusal here:
   * anything that can reach this port can move money.
   */
  adminHost: string
  /** Outbound relay URL for `relay` mode; null when not configured. */
  relayUrl: string | null
  /**
   * Wire dialect for `relay` mode. 'nostr' (default) speaks NIP-01 to a real
   * relay; 'dev' speaks the broker framing of `scripts/mock-relay.mjs`.
   */
  relayProtocol: 'nostr' | 'dev'
  /**
   * Open-RFQ bidding rate cap (docs/rfq-protocol.md § 4.6). 0 disables
   * bidding entirely — the market-key subscription is never opened.
   */
  openRfqMaxBidsPerMinute: number
  /**
   * Where `relay` writes its liveness heartbeat. Its mtime is the health
   * signal for a container with no port to probe; the Dockerfile's
   * HEALTHCHECK reads exactly this path.
   */
  relayHealthPath: string
  /**
   * Whether this solver advertises itself on Nostr (kind 38859).
   *
   * `off` (the default) means the solver touches no relay for discovery, and
   * the console's "post now" action is REFUSED rather than honoured — a policy
   * an action can override is advisory, and an operator who set it would have
   * no guarantee. `manual` publishes only when asked; `auto` also republishes
   * when the ad changes or the heartbeat falls due.
   *
   * Read once, here, like every other knob in this file: the console reports
   * the mode, it does not change it.
   */
  nostrAdPublish: AdPublishMode
}

/**
 * Exactly one of the inline (base64) or path (file) forms of an LND secret
 * must be set. Silently preferring one over an accidental other is how a
 * stale file value or a copy-pasted-twice env block ships the wrong
 * macaroon, so both-set and neither-set are equally errors.
 */
const resolveLndSecret = (varName: string): string => {
  const inline = process.env[varName]?.trim()
  const path = process.env[`${varName}_PATH`]?.trim()
  if (inline && path) throw new Error(`set only one of ${varName} or ${varName}_PATH, not both`)
  if (inline) return inline
  if (path) return base64.encode(readFileSync(path))
  throw new Error(`one of ${varName} or ${varName}_PATH must be set`)
}

const loadLndConfig = (): LndConfig => ({
  socket: required('LND_SOCKET'),
  cert: resolveLndSecret('LND_CERT'),
  macaroon: resolveLndSecret('LND_MACAROON'),
  esploraUrl: process.env.LND_ESPLORA_URL,
})

/**
 * One directory for every database this service opens.
 *
 * Six files — the swap store, its three corridor siblings, the admin store suffixed
 * off the same stem, and the Arkade wallet. Point `DB_DIR` at the volume and every
 * file lands there.
 *
 * Strictly a DEFAULT, never an override: `SWAP_DB_PATH` and `ARK_DB_PATH` still win
 * where set, so an existing deployment keeps opening the exact files it did before.
 *
 * Set-but-empty is unset, and it matters most on the path knobs: better-sqlite3 reads
 * `''` as "give me a private temporary database", so a blank `SWAP_DB_PATH` would
 * start a solver writing every swap row to a file it deletes on exit, reporting
 * nothing wrong.
 */
const dbDir = (): string => process.env.DB_DIR?.trim() || '.data'

/**
 * The swap database path, and nothing else.
 *
 * Read-only inspection (`status`, `list`, `timeline`) needs this string and no key
 * material, but {@link loadConfig} validates the whole deployment up front and would
 * demand ARK_MNEMONIC first — putting a seed phrase into the environment, shell
 * history and crash dumps of a process that never signs anything.
 *
 * `loadConfig` calls this too, so the default cannot drift between them.
 */
export const swapDbPath = (): string => process.env.SWAP_DB_PATH?.trim() || join(dbDir(), 'swaps.sqlite')

/**
 * The Arkade wallet's own database. Separate file, same directory rule.
 *
 * Exported for the same reason {@link swapDbPath} is: the e2e harness builds an
 * Arkade context without going through `loadConfig`, and a second copy of this
 * default there would mean the suite opening a different — empty, unfunded —
 * wallet than the service under test, on any deployment that moved the
 * directory.
 */
export const arkDbPath = (): string => process.env.ARK_DB_PATH?.trim() || join(dbDir(), 'ark.sqlite')

/** The fake backend's preimage map — regtest's database, in every sense. */
const fakeLnStatePath = (): string => process.env.FAKE_LN_STATE_PATH?.trim() || join(dbDir(), 'fake-ln.json')

/** The rails this repo ships. Everything else `LN_BACKEND` accepts was registered. */
const BUILT_IN_LN_BACKENDS = ['lnd', 'fake'] as const

/**
 * Which BTC rail to talk to, or null on a deployment that needs none.
 *
 * REQUIRED whenever any BTC corridor is enabled, which is the default — all four
 * take their Lightning and their onchain leg from this one value, so `servesBtc`
 * is the whole exemption: a solver serving only EVM or asset flow states that by
 * disabling the four, and is not then asked for a Lightning node it has no use
 * for. There is deliberately no default rail. One would mean a deployment that
 * forgot the variable silently coming up on whichever vendor this file happened
 * to name, holding the operator's money.
 *
 * An unrecognised value THROWS rather than falling through to anything: a typo
 * that resolved to a working backend is the failure this function exists to
 * prevent, since every component would then behave correctly and simply be the
 * wrong components. Retired names throw for the same reason — a deprecation that
 * keeps working by accident is the least discoverable kind.
 *
 * The error names the accepted set, registry included, so an operator who
 * mistyped a consumer rail's name is told what this build actually has.
 */
const lnBackendFromEnv = (servesBtc: boolean): string | null => {
  const accepted = [...BUILT_IN_LN_BACKENDS, ...lightningRailNames()]
  const raw = process.env.LN_BACKEND?.trim()
  if (!raw) {
    if (!servesBtc) return null
    throw new Error(
      `LN_BACKEND must be set to one of ${accepted.join(', ')}: every BTC corridor takes both its legs from ` +
        `it. Only a deployment with all four disabled (<STEM>_ENABLED=false) may leave it unset.`,
    )
  }
  const match = accepted.find((backend) => backend === raw)
  if (!match) {
    throw new Error(`LN_BACKEND must be one of ${accepted.join(', ')}, got ${process.env.LN_BACKEND}`)
  }
  return match
}

/**
 * A per-corridor amount range for each of the four corridors.
 *
 * Layered rather than independent: each corridor narrows the range `limits`
 * already produced, so a corridor knob can only ever reduce what
 * `MAX_SWAP_SATS` and the network default already allowed. An operator cannot
 * widen one corridor past the deployment-wide cap by reaching for a
 * more-specific knob, which is the failure this ordering exists to prevent.
 *
 * Absent knobs mean "same as everything else", so a deployment that never sets
 * one behaves exactly as it did before per-corridor ranges existed.
 */
const corridorLimitsFromEnv = (base: Limits): Record<Corridor, Limits> => {
  const entries = ALL_DESCRIPTORS.map(({ pair, envStem: stem }) => {
    const bound = (suffix: string): number | undefined => {
      const raw = process.env[`${stem}_${suffix}`]?.trim()
      if (!raw) return undefined
      const value = Number(raw)
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${stem}_${suffix} must be a positive integer, got ${process.env[`${stem}_${suffix}`]}`)
      }
      return value
    }
    return [pair, narrow(base, { minSats: bound('MIN_SATS'), maxSats: bound('MAX_SATS') }, stem)] as const
  })
  return Object.fromEntries(entries) as Record<Corridor, Limits>
}

/**
 * What each corridor charges, from `<STEM>_FEE_BPS` and `<STEM>_FEE_FLAT_SATS`.
 *
 * Zero for both on every corridor by default, which is exactly what the solver
 * charged before this existed — so a deployment that sets nothing keeps filling
 * a swap for precisely what the client locks up.
 *
 * Unset and zero are the same thing here, unlike the amount knobs, where unset
 * means "inherit" and zero is illegal. A fee genuinely can be zero.
 */
const corridorFeesFromEnv = (): Record<Corridor, Fee> => {
  const entries = ALL_DESCRIPTORS.map(({ pair, envStem: stem }) => {
    const component = (suffix: string, max: number): number => {
      const name = `${stem}_${suffix}`
      const raw = process.env[name]?.trim()
      if (!raw) return 0
      const value = Number(raw)
      if (!Number.isInteger(value) || value < 0 || value > max) {
        throw new Error(`${name} must be an integer between 0 and ${max}, got ${process.env[name]}`)
      }
      return value
    }
    // bps is capped at 10_000 (100%) because a spread at or above it leaves the
    // taker nothing; the flat cap is a sanity bound, not a policy — a flat fee
    // in the millions is a typo, and one that would quietly refuse every swap
    // as unquotable rather than fail loudly here.
    const fee: Fee = { bps: component('FEE_BPS', 9_999), flatSats: component('FEE_FLAT_SATS', 1_000_000) }
    return [pair, fee.bps === 0 && fee.flatSats === 0 ? FREE : fee] as const
  })
  return Object.fromEntries(entries) as Record<Corridor, Fee>
}

/**
 * The corridors that can answer "what will executing this swap cost me".
 *
 * The two onchain legs can: a chain cost is `vsize x sats/vbyte`, both halves of
 * which the solver knows before it quotes. The Lightning legs cannot yet — the
 * backend port has no "what would routing this cost" call, so a solver only
 * learns a routing fee by being refused for budgeting too little, which is
 * after the price is fixed. The EVM corridors price in token units and are not
 * `Corridor`-keyed at all.
 *
 * Named here so setting a cap on a corridor that cannot use one is REFUSED
 * rather than parsed and ignored. A knob that reads back fine and changes no
 * quote is how an operator comes to believe they are pricing dynamically while
 * still charging a flat they guessed at boot.
 */
const NETWORK_FEE_CAPABLE: readonly Corridor[] = ['arkade:BTC->onchain:BTC', 'onchain:BTC->arkade:BTC']

/**
 * What each corridor may charge for EXECUTION, from `<STEM>_FEE_CAP_SATS` and
 * `<STEM>_FEE_MIN_SATS`.
 *
 * Null for every corridor by default. Unset and zero are DIFFERENT here, unlike
 * `<STEM>_FEE_BPS` and unlike `<STEM>_FEE_FLAT_SATS`: an absent cap means "do
 * not price this corridor's cost live at all", which is the behaviour of every
 * deployment before this existed, so it cannot also be spelled `0`.
 *
 * The cap is the switch and the floor is optional, which is deliberate. The
 * cap is what a taker is actually promised — a signed registry card cannot
 * carry a live estimate — and it is what bounds a fee source that returns a
 * spike or the wrong units. There is no safe way to read an estimate without
 * one, so there is no way to ask for one.
 */
const corridorNetworkFeesFromEnv = (): Record<Corridor, NetworkFeeBounds | null> => {
  const entries = ALL_DESCRIPTORS.map(({ pair, envStem: stem }) => {
    // Same shape as `corridorLimitsFromEnv`'s `bound`, not `corridorFeesFromEnv`'s
    // `component`: absence has to survive as `undefined` here rather than
    // collapsing to 0, because absence is what keeps the old pricing.
    const sats = (suffix: string, min: number): number | undefined => {
      const name = `${stem}_${suffix}`
      const raw = process.env[name]?.trim()
      if (!raw) return undefined
      const value = Number(raw)
      // Same 1_000_000 sanity bound `<STEM>_FEE_FLAT_SATS` carries, and for the
      // same reason: an execution charge in the millions is a typo, and one
      // that would refuse every swap as unquotable rather than fail here.
      if (!Number.isInteger(value) || value < min || value > 1_000_000) {
        throw new Error(`${name} must be an integer between ${min} and 1000000, got ${process.env[name]}`)
      }
      return value
    }
    // A cap of 0 would mean "charge nothing for execution, ever", which is
    // `<STEM>_FEE_FLAT_SATS=0` written so that it looks like it does something.
    const capSats = sats('FEE_CAP_SATS', 1)
    const minSats = sats('FEE_MIN_SATS', 0)
    if (capSats === undefined) {
      // Refused rather than ignored: a floor with no ceiling is dynamic pricing
      // switched off, and the operator who set it believes otherwise.
      if (minSats !== undefined) {
        throw new Error(`${stem}_FEE_MIN_SATS is set without ${stem}_FEE_CAP_SATS, which is what enables live pricing`)
      }
      return [pair, null] as const
    }
    if (!NETWORK_FEE_CAPABLE.includes(pair as Corridor)) {
      throw new Error(`${stem}_FEE_CAP_SATS is set, but ${pair} cannot price its execution cost live`)
    }
    // `networkFeePricing` refuses this combination too, at construction.
    // Refused again here so the message names the two variables an operator can
    // edit rather than the two numbers they resolved to.
    if (minSats !== undefined && minSats > capSats) {
      throw new Error(
        `${stem}_FEE_MIN_SATS ${minSats} exceeds ${stem}_FEE_CAP_SATS ${capSats}, so the cap can never hold`,
      )
    }
    return [pair, { capSats, minSats: minSats ?? 0 }] as const
  })
  return Object.fromEntries(entries) as Record<Corridor, NetworkFeeBounds | null>
}

/**
 * Which corridors this deployment quotes, from `<STEM>_ENABLED`.
 *
 * All four on by default, so a deployment that sets nothing serves what it
 * always served. Only the exact strings `true` and `false` are accepted: a
 * typo'd `FALSE`, `0` or `no` silently meaning "on" would leave a corridor
 * quoting that an operator believes is dark, and this knob exists precisely
 * for the case where that corridor loses money on every swap.
 */
const corridorEnabledFromEnv = (): Record<Corridor, boolean> => {
  const entries = ALL_DESCRIPTORS.map(({ pair, envStem }) => {
    const name = `${envStem}_ENABLED`
    const raw = process.env[name]?.trim()
    if (!raw) return [pair, true] as const
    if (raw !== 'true' && raw !== 'false') {
      throw new Error(`${name} must be 'true' or 'false', got ${process.env[name]}`)
    }
    return [pair, raw === 'true'] as const
  })
  return Object.fromEntries(entries) as Record<Corridor, boolean>
}

/**
 * `ARK_UNILATERAL_EXIT_DELAY` — what to believe instead of the server's own
 * advertised unilateral exit delay.
 *
 * Seconds or blocks, told apart the way every other relative delay in this service is
 * (`relativeDelayFrom`). It must agree in UNIT with what the server advertises, which
 * `createArkadeContext` enforces once it has both numbers in hand.
 *
 * See `ArkadeWalletConfig.unilateralExitDelayOverride` for what this changes
 * (the CSV timelocks in every covenant, and the invoice delta the Lightning
 * receive corridor asks for) and which direction is dangerous (too low writes a
 * script the server rejects at SPEND, with money already in it).
 *
 * Validated only for what can be validated here: a positive integer inside BIP68's
 * range. The number itself is an assertion about a deployment this service cannot
 * check, since the server advertises the value being overridden. Deliberately NOT
 * constrained below the advertised delay either — raising it is the safe direction.
 */
const unilateralExitDelayOverride = (): number | undefined => {
  const raw = process.env.ARK_UNILATERAL_EXIT_DELAY?.trim()
  if (!raw) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`ARK_UNILATERAL_EXIT_DELAY must be a positive whole number, got ${raw}`)
  }
  // The SAME window `deriveUnilateralDelays` enforces, checked here so the error names
  // the variable the operator set. Downstream it is caught inside
  // `createArkadeContext` by a message beginning "server exit delay", which would send
  // an operator who typed their own value to arkd to debug it, at a moment that looks
  // like a connection problem.
  //
  // WHICH UNIT this is stays unasked here, because it is not this function's to decide:
  // the unit is a fact about the arkd being overridden, checked against that server's
  // own advertised delay in `createArkadeContext`. Asking the operator to declare it too
  // would create a second source of truth able to disagree with the first.
  if (relativeDelayFrom(value).unit === 'blocks') {
    if (value > MAX_BIP68_BLOCKS) {
      throw new Error(
        `ARK_UNILATERAL_EXIT_DELAY is ${value} blocks, beyond the ${MAX_BIP68_BLOCKS} a ladder can carry ` +
          'before its top rung re-types itself as seconds',
      )
    }
    return value
  }
  if (value > MAX_BIP68_SECONDS) {
    throw new Error(`ARK_UNILATERAL_EXIT_DELAY is ${value}s, beyond the ${MAX_BIP68_SECONDS}s BIP68 can encode`)
  }
  return value
}

/**
 * `LN_RECEIVE_ACCEPT_UNILATERAL_GAP`, strictly, plus the bound it requires.
 *
 * Same exact-`true`/`false` rule as the knobs beside it, sharper here because this one
 * accepts a loss: a typo'd `yes` must never read as agreement.
 *
 * The mainnet condition is the point of the knob. What is accepted is bounded by the
 * corridor's per-swap cap, so where the sats are real the operator must have SET that
 * cap — inheriting the profile default is not the same act as choosing the number you
 * are prepared to lose. Test networks are exempt.
 */
const lnReceiveAcceptUnilateralGapFromEnv = (network: SwapNetwork): boolean => {
  const raw = process.env.LN_RECEIVE_ACCEPT_UNILATERAL_GAP?.trim()
  if (!raw) return false
  if (raw !== 'true' && raw !== 'false') {
    throw new Error(
      `LN_RECEIVE_ACCEPT_UNILATERAL_GAP must be 'true' or 'false', got ${process.env.LN_RECEIVE_ACCEPT_UNILATERAL_GAP}`,
    )
  }
  if (raw === 'true' && network === 'bitcoin' && !process.env.LN_RECEIVE_MAX_SATS?.trim()) {
    throw new Error(
      'LN_RECEIVE_ACCEPT_UNILATERAL_GAP=true on bitcoin also needs LN_RECEIVE_MAX_SATS set explicitly: ' +
        'it accepts a bounded loss (#69), and the bound is that cap. Set it to the most you are prepared ' +
        'to lose on one swap if the Arkade server censors for longer than its exit delay.',
    )
  }
  return raw === 'true'
}

/**
 * `POOL_AUTO_MINT`, strictly.
 *
 * Exactly `'true'` or `'false'`, never a truthy coercion: `Boolean('false')` is
 * `true`, and an operator who typed the wrong word would get automated spending
 * they had explicitly tried to decline. Same rule `corridorEnabledFromEnv`
 * applies, for the same reason.
 */
const poolAutoMintFromEnv = (): boolean => {
  const raw = process.env.POOL_AUTO_MINT?.trim()
  if (!raw) return false
  if (raw !== 'true' && raw !== 'false') {
    throw new Error(`POOL_AUTO_MINT must be 'true' or 'false', got ${process.env.POOL_AUTO_MINT}`)
  }
  return raw === 'true'
}

/**
 * Route hints this deployment will not price, named by `short_channel_id`.
 *
 * The case it exists for: a Wallet of Satoshi invoice carries hints of `[40]`
 * and `[40000]`, and on a rail that cannot cap the route it picks the solver is
 * bound by the worst, so the invoice is refused. If the 40000 hint names a
 * channel that cannot route, pricing a refund deadline against it prices a
 * route nobody can take — and dropping it is not lifting a bound, it is
 * declining to bound against a fiction.
 *
 * A list rather than a CLTV threshold, because the tell is the channel and not
 * the number. "Refuse any hint over N blocks" cannot separate the 40000 from
 * the 40 on that same invoice, and has no ground truth to pick N from — low
 * enough to catch a bad hint refuses genuinely long private routes (a deep JIT
 * channel, an LSP path), high enough to admit those lets the bad one through.
 *
 * ## Every entry needs authoritative confirmation, and NOTHING here can check it
 *
 * The premise — "this scid cannot route" — is not a property of the string, and
 * in particular:
 *
 * - a scid in a hint may be an `option_scid_alias`. BOLT #2 requires an
 *   unannounced channel's alias to be "a value not related to the real
 *   `short_channel_id`", requires the node to "always recognize the `alias` as a
 *   `short_channel_id` for incoming HTLCs", and permits it in BOLT 11 `r`
 *   fields — where, for an `option_scid_alias` channel, it is the only thing
 *   permitted. So the block field of a hint's scid is not a confirmation height,
 *   and decoding one to a future block proves nothing;
 * - LND allocates its aliases from block heights 16000000-16250000
 *   (`aliasmgr.IsAlias`), so a value that looks like an impossible future height
 *   is evidence FOR a live private channel rather than against one;
 * - private channels are never gossiped, so absence from a public graph
 *   (`getchaninfo` "edge not found") is what a working private channel looks
 *   like.
 *
 * An entry is therefore only ever added on confirmation from someone who can
 * know — the wallet vendor, the node operator named by the hint, the recipient.
 * The service cannot tell a fictional channel from one it merely cannot see, so
 * docs/runbook.md is the only control there is.
 *
 * The cost of getting it wrong is asymmetric and runs the opposite way to
 * intuition: an INCOMPLETE list costs a refusal (today's behaviour), while a
 * WRONG entry prices a routable channel out of a deadline a route can still
 * take, which on a rail that caps nothing is the double-collect window.
 *
 * No boolean beside it: unset or empty is an empty set, which is today's
 * behaviour, and a non-empty list is its own opt-in.
 */
const sendHintScidDenylistFromEnv = (): ReadonlySet<string> => {
  const raw = process.env.LN_SEND_HINT_SCID_DENYLIST?.trim()
  if (!raw) return new Set()
  const entries = raw.split(',').map((entry) => entry.trim().toLowerCase())
  for (const entry of entries) {
    // Refused rather than skipped. A typo'd entry that silently matched nothing
    // would leave the operator with a knob that reads as set and does nothing —
    // and the symptom is an invoice still being refused, which looks exactly
    // like the denylist working on a different invoice.
    if (!/^[0-9a-f]{16}$/.test(entry)) {
      throw new Error(
        `LN_SEND_HINT_SCID_DENYLIST entries must be 16 hex chars (an 8-byte short_channel_id), got '${entry}'`,
      )
    }
  }
  return new Set(entries)
}

export const loadConfig = (): Config => {
  const raw = process.env.SWAP_NETWORK ?? 'regtest'
  if (!isSwapNetwork(raw)) {
    throw new Error(`SWAP_NETWORK must be one of ${Object.keys(NETWORKS).join(', ')}, got ${raw}`)
  }
  const profile = NETWORKS[raw]

  // Read BEFORE the rail, because it decides whether a rail is required at all.
  // Every one of the four takes both its legs from `LN_BACKEND`, so "does this
  // deployment need a Lightning node" is exactly "does it serve any of them".
  const corridorEnabled = corridorEnabledFromEnv()
  const lnBackend = lnBackendFromEnv(Object.values(corridorEnabled).some(Boolean))

  const override = process.env.MAX_SWAP_SATS !== undefined ? { maxSats: Number(process.env.MAX_SWAP_SATS) } : undefined
  const limits = resolveLimits(raw, override)

  // Default: three max-size swaps in flight. The same non-finite rule as the
  // per-swap limits — absorbing NaN here silently removes the cap.
  const maxExposedSats =
    process.env.MAX_EXPOSED_SATS !== undefined ? Number(process.env.MAX_EXPOSED_SATS) : limits.maxSats * 3
  if (!Number.isFinite(maxExposedSats) || maxExposedSats <= 0) {
    throw new Error(`MAX_EXPOSED_SATS must be a positive finite number, got ${process.env.MAX_EXPOSED_SATS}`)
  }

  // Default 30 days. Same non-finite rule as the caps above: absorbing NaN here
  // would silently retire contracts on whatever `now - NaN >= NaN` decides.
  const contractRetentionDays =
    process.env.CONTRACT_RETENTION_DAYS !== undefined ? Number(process.env.CONTRACT_RETENTION_DAYS) : 30
  if (!Number.isFinite(contractRetentionDays) || contractRetentionDays <= 0) {
    throw new Error(
      `CONTRACT_RETENTION_DAYS must be a positive finite number, got ${process.env.CONTRACT_RETENTION_DAYS}`,
    )
  }

  // The fake backend forges its own invoices and "pays" without moving sats.
  // On mainnet a stale forged entry would let the service claim a client's
  // lockup having paid nothing — a test tool must not be able to do that, so
  // it is refused where real money exists rather than trusted to be used right.
  if (lnBackend === 'fake' && profile.isMainnet) {
    throw new Error('LN_BACKEND=fake is a regtest tool and is refused on mainnet')
  }

  // Default matches orchestrator.ts's own prior hardcoded value. Overridable
  // because the ceiling that matters is the indexer's/LN backend's, not ours —
  // an operator on a backend with a lower connection limit has no other lever.
  const sweepConcurrency = process.env.SWEEP_CONCURRENCY !== undefined ? Number(process.env.SWEEP_CONCURRENCY) : 8
  if (!Number.isInteger(sweepConcurrency) || sweepConcurrency <= 0) {
    throw new Error(`SWEEP_CONCURRENCY must be a positive integer, got ${process.env.SWEEP_CONCURRENCY}`)
  }

  // A minute, because a mempool's fee estimate does not move meaningfully
  // faster than that and a read is what triggers the fetch — an idle solver
  // makes no requests at all, and a busy one makes at most one a minute.
  const onchainFeeRateRefreshMs = intFromEnv('ONCHAIN_FEE_RATE_REFRESH_MS', 60_000, 1)
  // Fifteen minutes: longer than a block interval plus slack, so a source that
  // is merely slow keeps its answer being served, while one that has been down
  // long enough for the mempool to have turned over stops being believed and
  // pricing falls back to the configured flat.
  const onchainFeeRateStaleMs = intFromEnv('ONCHAIN_FEE_RATE_STALE_MS', 900_000, 1)
  // `freshly` throws on this too, but from inside `createServices`, where the
  // message would name neither variable. Below or equal, every read past the
  // refresh age returns null and the sample degrades to "always null" —
  // quietly, and only once quotes are actually flowing.
  if (onchainFeeRateStaleMs <= onchainFeeRateRefreshMs) {
    throw new Error(
      `ONCHAIN_FEE_RATE_STALE_MS ${onchainFeeRateStaleMs} must exceed ONCHAIN_FEE_RATE_REFRESH_MS ${onchainFeeRateRefreshMs}`,
    )
  }

  return {
    network: raw,
    profile,
    // resolveLimits refuses to widen, so an override here can only ever make the
    // amount at risk smaller.
    limits,
    corridorLimits: corridorLimitsFromEnv(limits),
    corridorFees: corridorFeesFromEnv(),
    corridorNetworkFees: corridorNetworkFeesFromEnv(),
    onchainFeeRateRefreshMs,
    onchainFeeRateStaleMs,
    corridorEnabled,
    // Reads the ALREADY-NARROWED house limits, so a per-token knob inherits a
    // bound an override may have tightened rather than the raw environment's.
    evmCorridors: evmCorridorPolicies(parseEvmTokens(process.env.EVM_TOKENS), limits, (name) => process.env[name]),
    // Loaded here rather than at first quote so a token whose price cannot be
    // resolved stops the deployment instead of advertising a pair it will then
    // refuse every request against.
    evmMarkets: evmMarkets(parseEvmTokens(process.env.EVM_TOKENS), (name) => process.env[name]),
    swapDbPath: swapDbPath(),
    poolAutoMint: poolAutoMintFromEnv(),
    lnReceiveAcceptUnilateralGap: lnReceiveAcceptUnilateralGapFromEnv(raw),
    maxExposedSats,
    contractRetentionMs: contractRetentionDays * 86_400_000,
    sweepConcurrency,
    chainTipEsploraUrl: process.env.CHAIN_TIP_ESPLORA_URL?.trim() || process.env.LND_ESPLORA_URL?.trim(),
    // Ceiling is `MAX_LOCKUP_TIMEOUT` (= REFUND_SAFETY_MARGIN), DERIVED there and
    // imported rather than written as a number here, so it cannot drift from the
    // margin it is the same quantity as. This is NOT the 3480 that used to sit
    // here: that one was justified by an invoice-expiry floor which no longer
    // exists, and removing it for that reason was right — but it had also been
    // holding this window under the safety margin by accident, which is the bound
    // that actually matters. `payableCltvBlocks` enforces the invariant properly,
    // at payment time; this refuses at boot a window that could only ever produce
    // swaps refusing themselves. The 60s floor still rules out one nobody can fund.
    lockupTimeoutSeconds: intFromEnv('LOCKUP_TIMEOUT_SECONDS', DEFAULT_LOCKUP_TIMEOUT, 60, MAX_LOCKUP_TIMEOUT),
    sendHintScidDenylist: sendHintScidDenylistFromEnv(),
    lnBackend,
    fakeLnStatePath: fakeLnStatePath(),
    lnd: lnBackend === 'lnd' ? loadLndConfig() : null,
    port: intFromEnv('PORT', 8787, 1, 65535),
    host: process.env.HOST?.trim() || '127.0.0.1',
    // The fallback is never reached: it is only consulted when the variable is
    // absent, and absence is already answered with null on the line above.
    // A bad value still throws through intFromEnv rather than reading as "off".
    adminPort: process.env.ADMIN_PORT?.trim() ? intFromEnv('ADMIN_PORT', 8788, 1, 65535) : null,
    adminHost: process.env.ADMIN_HOST?.trim() || '127.0.0.1',
    /** Outbound relay URL for the `relay` command; unset = relay mode unavailable. */
    relayUrl: process.env.RELAY_URL?.trim() || null,
    // Defaults to the production dialect: a deployment pointed at a real
    // Nostr relay with the dev framing connects and then goes silently deaf —
    // the worst failure shape — so speaking Nostr must not need a knob.
    relayProtocol: (() => {
      const raw = process.env.RELAY_PROTOCOL?.trim()
      if (!raw || raw === 'nostr') return 'nostr' as const
      if (raw === 'dev') return 'dev' as const
      throw new Error(`RELAY_PROTOCOL must be 'nostr' or 'dev', got ${process.env.RELAY_PROTOCOL}`)
    })(),
    openRfqMaxBidsPerMinute: intFromEnv('OPEN_RFQ_MAX_BIDS_PER_MIN', 30, 0),
    // Relative like every other durable-file knob here; the Dockerfile's ENV
    // block supplies the container path, so /data lives in one place — beside
    // the VOLUME that declares it — rather than baked into an app default.
    relayHealthPath: process.env.RELAY_HEALTH_PATH?.trim() || '.data/relay-health',
    /** `off` (default) | `manual` | `auto`. See docs/rfq-protocol.md § 3. */
    nostrAdPublish: ((): AdPublishMode => {
      const raw = (process.env.NOSTR_AD_PUBLISH ?? 'off').trim().toLowerCase()
      // Set-but-empty is unset, the discipline `intFromEnv` states above.
      if (!raw) return 'off'
      if (raw === 'manual' || raw === 'auto' || raw === 'off') return raw
      throw new Error(`NOSTR_AD_PUBLISH must be off, manual or auto (got "${raw}")`)
    })(),
    // The operator's to supply, on every network, with no default shipped. The
    // emulator co-signs covenant spends, so a URL baked in here would point a
    // deployment's money path at whichever service this repository happened to
    // name — a choice that belongs to whoever runs the solver.
    emulatorUrl: required('EMULATOR_URL'),
    arkade: {
      mnemonic: required('ARK_MNEMONIC'),
      arkServerUrl: required('ARK_SERVER_URL'),
      databasePath: arkDbPath(),
      isMainnet: profile.isMainnet,
      arkadeHrp: profile.arkadeHrp,
      // A network fact, deliberately not an env knob: see NetworkProfile.
      minCheckpointExitDelaySeconds: profile.minCheckpointExitDelaySeconds,
      unilateralExitDelayOverride: unilateralExitDelayOverride(),
      // Separate from LND_ESPLORA_URL above on purpose. That one is the
      // Lightning side's explorer; this is the Arkade wallet's view of L1, and
      // a deployment can legitimately point them at different hosts. Unset
      // takes the SDK's per-network default, which on regtest is a localhost
      // URL that resolves to the container itself.
      esploraUrl: process.env.ARK_ESPLORA_URL,
      expectedArkdNetwork: profile.arkdNetwork,
    },
  }
}
