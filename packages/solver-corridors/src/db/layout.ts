import { existsSync } from 'node:fs'

/**
 * Where each corridor's tables live.
 *
 * Historically every store opened its own SQLite file, derived from
 * `SWAP_DB_PATH` by suffix — `-onchain`, `-receive`, `-onchain-receive`,
 * `-admin`. Nothing forced that: each store's `open()` already takes a driver
 * rather than a path, and no two stores name the same table or index. It was
 * just what the call site did, and it cost operators real money — the runbook
 * and the compose file's litestream sidecar both named one file, so a backup
 * taken by the book covered one corridor of four.
 *
 * A FRESH deployment now puts every table in the single `SWAP_DB_PATH` file:
 * one file to back up, one connection, and — the reason this matters beyond
 * tidiness — one transaction that could span every corridor's table, which is
 * what a durable cross-corridor exposure reserve would need (#105 fixes the
 * in-process half; the multi-process half needs this).
 *
 * An EXISTING deployment keeps the files it already has. Nothing copies rows
 * between databases, so upgrading cannot strand, duplicate or half-move a
 * funded swap — the failure mode that makes automatic data migration a poor
 * trade on a money path. Those deployments keep today's behaviour exactly,
 * including #105's multi-process gap.
 */
export interface DbLayout {
  /** True when every table shares `swapDbPath`. */
  readonly consolidated: boolean
  /** Where each store's tables live. Every entry equals `swapDbPath` when consolidated. */
  readonly send: string
  readonly onchainSend: string
  readonly receive: string
  readonly onchainReceive: string
  readonly admin: string
  /**
   * The EVM corridor's tables — ALWAYS `swapDbPath`, in both layouts.
   *
   * The split layout exists to avoid moving rows that a previous release
   * already wrote somewhere. This corridor has no previous release, so there is
   * no file it "already has" and nothing to strand: a suffixed path here would
   * invent a fifth and sixth file for an operator to discover, back up, and
   * eventually consolidate, in service of a history it does not have.
   *
   * Safe because no two stores name the same table — `send_evm_swap` and
   * `receive_evm_swap` collide with nothing in the swap file — and it is also
   * the layout the consolidated case would have chosen anyway.
   */
  readonly evmSend: string
  readonly evmReceive: string
  /** The atomic class's negotiations — ALWAYS `swapDbPath`, for the same reason. */
  readonly assetRfq: string
}

/** Splice a suffix in before `.sqlite`, or append it when the path has no such extension. */
export const suffixed = (swapDbPath: string, suffix: string): string =>
  swapDbPath.endsWith('.sqlite') ? swapDbPath.replace(/\.sqlite$/, `-${suffix}.sqlite`) : `${swapDbPath}-${suffix}`

/**
 * Decide the layout from what is already on disk.
 *
 * `exists` is injectable so a test can describe a filesystem without building
 * one. The rule is deliberately conservative: ANY legacy file present means
 * legacy, even if the others are missing. A half-populated directory is a
 * deployment whose corridors were enabled at different times, not a fresh
 * install, and reading four of its files while writing the fifth somewhere new
 * would lose rows silently.
 */
export const resolveDbLayout = (swapDbPath: string, exists: (path: string) => boolean = existsSync): DbLayout => {
  const legacy = {
    send: swapDbPath,
    onchainSend: suffixed(swapDbPath, 'onchain'),
    receive: suffixed(swapDbPath, 'receive'),
    onchainReceive: suffixed(swapDbPath, 'onchain-receive'),
    admin: suffixed(swapDbPath, 'admin'),
  }
  // `send` is deliberately NOT part of this test: it is the consolidated file
  // too, so its presence says nothing about which layout wrote it. Only a
  // SUFFIXED file is evidence of the split layout.
  const split = [legacy.onchainSend, legacy.receive, legacy.onchainReceive, legacy.admin].some(exists)
  // These are outside `legacy` deliberately: they are the same path in both
  // branches, so a suffixed file is never named and never looked for for any of
  // them. See {@link DbLayout.evmSend}.
  const noLegacyFile = { evmSend: swapDbPath, evmReceive: swapDbPath, assetRfq: swapDbPath }
  if (split) return { consolidated: false, ...legacy, ...noLegacyFile }
  return {
    consolidated: true,
    send: swapDbPath,
    onchainSend: swapDbPath,
    receive: swapDbPath,
    onchainReceive: swapDbPath,
    admin: swapDbPath,
    ...noLegacyFile,
  }
}
