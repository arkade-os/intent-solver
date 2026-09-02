/**
 * The BTC rail — Lightning and onchain together — and how a consumer registers
 * its own.
 *
 * A PAIR rather than two independent choices, because that is what a backend
 * is here: one wallet answers both ports. An LND node holds channels and an
 * onchain wallet; the fake backend forges invoices and settles nothing. Two
 * knobs would let a deployment describe a combination no vendor implements —
 * Lightning out of one wallet, onchain out of another — and every corridor that
 * spans both legs would then have to say which half it meant. This replaced two
 * mirrored four-way switches over the same `LN_BACKEND` value that had to agree
 * case for case; they cannot disagree if there is only one.
 *
 * ALL FOUR BTC corridors need a rail, not only the two Lightning ones: the
 * onchain pair takes its backend from the same object. That is why `LN_BACKEND`
 * is required unless every one of them is switched off — see `lnBackendFromEnv`
 * in src/config.ts, and {@link requireLn} for what an accidental use gets.
 *
 * ## Why a registry and not an option on `createServices`
 *
 * `src/cli.ts` calls `createServices` at sixteen sites and runs `main()` at
 * module load, so a rail passed as an option could only reach the shipped
 * daemon through a FORK of that file — a consumer would be maintaining a copy
 * of every command to add one backend. Registering by name means importing this
 * module, calling {@link registerLightningRail} once, and then running the
 * shipped CLI with `LN_BACKEND=<that name>`; `loadConfig` accepts the name
 * because it asks {@link lightningRailNames} what exists.
 *
 * Module-level state, which is the cost of that: a rail registered after
 * `loadConfig` has already run is a rail `LN_BACKEND` will refuse. Register at
 * import time, above the entrypoint.
 */

import type { LightningBackend } from '@arkade-os/solver-core/ports/lightning.js'
import type { OnchainSendBackend } from '@arkade-os/solver-core/ports/onchain.js'
import type { Config } from '../config.js'

export interface LightningRail {
  /**
   * Both legs, not just `SendBackend`: the receive corridor needs the
   * hold-invoice half (`createHoldInvoice`/`getHoldState`/`settleHold`).
   */
  ln: LightningBackend
  /**
   * The same wallet's onchain half, funding `arkade:BTC->onchain:BTC` and
   * claiming `onchain:BTC->arkade:BTC`. A rail whose vendor has no onchain
   * facility still has to answer this port — with a backend that refuses — or
   * those two corridors cannot be served at all.
   */
  onchain: OnchainSendBackend
}

export interface LightningRailModule {
  /**
   * Open the wallet(s) and return both legs.
   *
   * Handed the WHOLE config rather than a vendor-shaped slice: a rail this repo
   * has never heard of reads its own environment variables, and a slice would
   * mean `Config` growing a field per consumer.
   *
   * Called at most once per process, from `createServices`. Two backend wallets
   * brought up concurrently tear each other down, which is why `createServices`
   * initialises every wallet sequentially — a `create` that opens more than one
   * should do the same.
   */
  create(config: Config): Promise<LightningRail>
  /**
   * Optional: mint an invoice from a SEPARATE payee wallet, for the `invoice`
   * command's self-test.
   *
   * Separate because the point of that command is a counterparty — the service
   * pays it like any other BOLT11 and has no relationship with it beyond that.
   * A rail whose vendor cannot open a second wallet from a second seed simply
   * omits this, and the command refuses by name rather than minting from the
   * solver's own wallet, which would be a swap with itself.
   *
   * Mint it with a LONG expiry (hours, not minutes). `lockupDeadlineFor` clips
   * the funding window to the invoice when the invoice expires first, so a
   * short-lived one silently makes the self-test exercise the boundary case
   * instead of the ordinary one it was reached for.
   *
   * @returns the BOLT11, and nothing else — the CLI puts it on stdout to be
   *   piped into `send`.
   */
  mintPayeeInvoice?(config: Config, amountSats: number): Promise<string>
}

/**
 * The rails this repo ships, which a consumer may not take.
 *
 * `createRail` answers these itself before consulting the registry, so a
 * duplicate could never win anyway — but a registration that silently did
 * nothing would leave `lightningRailNames()` reporting a rail that is not the
 * one running. Refused at registration, where the caller can see it.
 */
const BUILT_IN = ['lnd', 'fake']

const RAILS = new Map<string, LightningRailModule>()

/**
 * Make a rail selectable by `LN_BACKEND=<name>`.
 *
 * Refuses a name already taken, built-in or not. Shadowing is the failure worth
 * being loud about: `LN_BACKEND=lnd` silently resolving to consumer code would
 * move a deployment's real money onto a backend nobody chose, and the config
 * file would still read `lnd`.
 */
export const registerLightningRail = (name: string, rail: LightningRailModule): void => {
  if (BUILT_IN.includes(name)) throw new Error(`'${name}' is a built-in lightning rail and cannot be replaced`)
  if (RAILS.has(name)) throw new Error(`lightning rail '${name}' is already registered`)
  RAILS.set(name, rail)
}

/**
 * Every REGISTERED rail name — not the built-ins, which `config.ts` names
 * itself. Read when `LN_BACKEND` is validated, so a rail registered after that
 * is invisible.
 */
export const lightningRailNames = (): readonly string[] => [...RAILS.keys()]

export const lightningRailFor = (name: string): LightningRailModule | undefined => RAILS.get(name)

/**
 * What an accidental use of an absent rail gets.
 *
 * `Services.ln` and `Services.onchain` are null exactly when no BTC corridor is
 * enabled, so nothing that legitimately runs on such a deployment reaches them.
 * The point of throwing rather than returning a stub is that the reader — a
 * console panel, a CLI command — says which deployment it is looking at instead
 * of reporting a zero balance, which is what a solver with no float looks like.
 */
const NO_RAIL =
  'this deployment has no BTC rail: LN_BACKEND is unset, which is permitted only while all four BTC ' +
  'corridors are disabled. Set LN_BACKEND to serve them.'

export const requireLn = (ln: LightningBackend | null): LightningBackend => {
  // Truthiness rather than `=== null`, though the type says null: an absent
  // field on a hand-built `Services` is `undefined`, and a guard that let that
  // through would fail later as a bare TypeError naming no cause at all.
  if (!ln) throw new Error(NO_RAIL)
  return ln
}

export const requireOnchain = (onchain: OnchainSendBackend | null): OnchainSendBackend => {
  if (!onchain) throw new Error(NO_RAIL)
  return onchain
}
