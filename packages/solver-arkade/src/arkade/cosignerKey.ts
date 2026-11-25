import { signerSetFromInfo, toXOnlySignerHex, type ArkadeInfo } from '@arkade-os/sdk'

/** Whether arkd co-signs for `key` itself: its current signer or a deprecated one, compared x-only. */
export const operatorHolds = (key: string, info: ArkadeInfo): boolean => {
  const signers = signerSetFromInfo(info)
  const xOnly = toXOnlySignerHex(key)
  return signers.active === xOnly || signers.deprecated.has(xOnly)
}

/**
 * arkd's own form of a client-named x-only key it signs for: its current signer, or a deprecated one
 * with no cutoff (0), since arkd refuses a key's inputs past its cutoff, which can precede a refund. Null refuses.
 */
export const operatorCosignerKey = (requested: string, info: ArkadeInfo): string | null => {
  if (requested === toXOnlySignerHex(info.signerPubkey)) return info.signerPubkey
  const deprecated = info.deprecatedSigners.find(
    (signer) => signer.pubkey && signer.cutoffDate === 0n && toXOnlySignerHex(signer.pubkey) === requested,
  )
  return deprecated?.pubkey ?? null
}

/** The key a quote builds on for a client's requested x-only key; absent or the default is the default. Null refuses. */
export const quoteCosignerKey = async (
  ops: { emulatorPubkey: string; cosignerKeyFor?(requested: string): Promise<string | null> },
  requested: string | undefined,
): Promise<string | null> =>
  requested === undefined || requested === toXOnlySignerHex(ops.emulatorPubkey)
    ? ops.emulatorPubkey
    : ((await ops.cosignerKeyFor?.(requested)) ?? null)
