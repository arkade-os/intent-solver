import {
  defaultEmulatorPubkey,
  networkFromArkadeInfo,
  signerSetFromInfo,
  toXOnlySignerHex,
  type ArkadeInfo,
} from '@arkade-os/sdk'

/** Whether arkd co-signs for `key` itself: its current signer or a deprecated one, compared x-only. */
export const operatorHolds = (key: string, info: ArkadeInfo): boolean => {
  const signers = signerSetFromInfo(info)
  const xOnly = toXOnlySignerHex(key)
  return signers.active === xOnly || signers.deprecated.has(xOnly)
}

/** arkd's current signer, when `requested` names it while arkd also holds this network's pinned co-signer. */
export const operatorCosignerKey = (requested: string, info: ArkadeInfo): string | null => {
  let pin: string
  try {
    pin = defaultEmulatorPubkey(networkFromArkadeInfo(info))
  } catch {
    return null
  }
  return requested === toXOnlySignerHex(info.signerPubkey) && operatorHolds(pin, info) ? info.signerPubkey : null
}

/** The key a quote builds on for a client's requested x-only key; absent or the default is the default. Null refuses. */
export const quoteCosignerKey = async (
  ops: { emulatorPubkey: string; cosignerKeyFor?(requested: string): Promise<string | null> },
  requested: string | undefined,
): Promise<string | null> =>
  requested === undefined || requested === toXOnlySignerHex(ops.emulatorPubkey)
    ? ops.emulatorPubkey
    : ((await ops.cosignerKeyFor?.(requested)) ?? null)
