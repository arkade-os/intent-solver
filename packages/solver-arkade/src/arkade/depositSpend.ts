/**
 * POSITIVE proof that a deposit is gone, for the one exit needing more than
 * "nothing was sent". EVERY uncertain answer is `null`, leaving the caller's
 * walk-back: a throw, an empty result, an unspent row, no indexer wired — and a
 * spend naming NO spender, which the wire contract permits and which cannot be
 * checked against our own txid.
 */
import { isVtxoSpent, type VirtualCoin } from '@arkade-os/sdk'

/** The slice of the indexer this read needs, so a test needs no provider. */
export interface DepositSpendProbe {
  getVtxos(opts: { outpoints: { txid: string; vout: number }[] }): Promise<{ vtxos: VirtualCoin[] }>
}

/** The txid that spent this outpoint, lowercased, or null while that is not certain. */
export const depositSpentBy = async (
  probe: DepositSpendProbe | undefined,
  outpoint: { txid: string; vout: number },
): Promise<string | null> => {
  if (probe === undefined) return null
  let found: VirtualCoin | undefined
  try {
    const { vtxos } = await probe.getVtxos({ outpoints: [{ txid: outpoint.txid, vout: outpoint.vout }] })
    const txid = outpoint.txid.toLowerCase()
    found = vtxos.find((vtxo) => vtxo.txid.toLowerCase() === txid && vtxo.vout === outpoint.vout)
  } catch {
    return null
  }
  // The SDK's own union of the three spend facts: swept and settled count too.
  if (!found || !isVtxoSpent(found)) return null
  const by = found.spentBy?.trim().toLowerCase()
  return by ? by : null
}
