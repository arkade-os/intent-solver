import { existsSync } from 'node:fs'

/**
 * Where each corridor's tables live.
 *
 * A FRESH deployment puts every table in the single `SWAP_DB_PATH` file: one file
 * to back up, and one transaction that could span every corridor's table. An
 * EXISTING split deployment keeps its suffixed files: nothing copies rows between
 * databases, so upgrading cannot strand, duplicate or half-move a funded swap.
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
