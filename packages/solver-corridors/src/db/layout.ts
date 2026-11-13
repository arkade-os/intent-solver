import { existsSync } from 'node:fs'

/** A fresh deployment uses one file; an existing split one keeps its suffixed files, since nothing copies rows between them. */
export interface DbLayout {
  readonly consolidated: boolean
  readonly send: string
  readonly onchainSend: string
  readonly receive: string
  readonly admin: string
  /** Always `swapDbPath`: no earlier release wrote split files for it, so there is nothing to strand. */
  readonly evmSend: string
  readonly evmReceive: string
  /** Always `swapDbPath`, for the same reason. */
  readonly assetRfq: string
}

export const suffixed = (swapDbPath: string, suffix: string): string =>
  swapDbPath.endsWith('.sqlite') ? swapDbPath.replace(/\.sqlite$/, `-${suffix}.sqlite`) : `${swapDbPath}-${suffix}`

/** ANY suffixed file means split: reading three files while writing the fourth somewhere new would lose rows. */
export const resolveDbLayout = (swapDbPath: string, exists: (path: string) => boolean = existsSync): DbLayout => {
  const legacy = {
    send: swapDbPath,
    onchainSend: suffixed(swapDbPath, 'onchain'),
    receive: suffixed(swapDbPath, 'receive'),
    admin: suffixed(swapDbPath, 'admin'),
  }
  // Not `send`: it is the consolidated file too, so it proves nothing.
  const split = [legacy.onchainSend, legacy.receive, legacy.admin].some(exists)
  const noLegacyFile = { evmSend: swapDbPath, evmReceive: swapDbPath, assetRfq: swapDbPath }
  if (split) return { consolidated: false, ...legacy, ...noLegacyFile }
  return {
    consolidated: true,
    send: swapDbPath,
    onchainSend: swapDbPath,
    receive: swapDbPath,
    admin: swapDbPath,
    ...noLegacyFile,
  }
}
