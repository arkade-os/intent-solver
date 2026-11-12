// Pure rules about an Arkade lockup leg, shared by every corridor that has one. No I/O.

export interface LockupOutpoint {
  readonly txid: string
  readonly vout: number
  readonly value: number
  readonly spent: boolean
}

/**
 * The solver's own earlier funding of this lockup, if any. Spent outputs count: a funding the
 * client already claimed is still ours to adopt, and a spendable-only read would hide it.
 * Exact value, because the lockup address is public and dust paid to it is not our funding.
 * An unspent match wins, being the one a refund must target.
 */
export const adoptFunding = <O extends LockupOutpoint>(outpoints: readonly O[], payoutSats: number): O | null => {
  const ours = outpoints.filter((o) => o.value === payoutSats)
  return ours.find((o) => !o.spent) ?? ours[0] ?? null
}

/** The covenant's claim leaf commits to the key live at quote time; a rotated key can never claim it. */
export const providerKeyCurrent = (quotedPubkey: string, livePubkey: string): boolean => quotedPubkey === livePubkey

export interface AdoptedOutput {
  readonly txid: string
  readonly vout: number
  readonly value: number
}

export interface CollectionEvidence {
  /** Every outpoint the script has held, as read after this tick's claim. */
  readonly outpoints: readonly { txid: string; vout: number; spent: boolean; unrolled: boolean }[]
  /** Offchain outputs a claim accepted this tick: spent by us, whatever the read still says. */
  readonly claimedOffchain: ReadonlySet<string>
  /** Unrolled outputs whose L1 claim has confirmed. */
  readonly claimedOnL1: ReadonlySet<string>
  /** Offchain outputs the read shows spent whose spend reveals OUR preimage, i.e. an earlier claim of ours. */
  readonly spentByUs: ReadonlySet<string>
}

export const outpointKey = (o: { txid: string; vout: number }): string => `${o.txid}:${o.vout}`

/** What a claim may spend: the outputs adopted at funding. A later payment to the public lockup is the client's to refund. */
export const adoptedOnly = <O extends { txid: string; vout: number }>(
  outputs: readonly O[],
  lockupOutpoints: string | null,
): O[] => {
  if (lockupOutpoints === null) return [...outputs]
  const adopted = new Set((JSON.parse(lockupOutpoints) as AdoptedOutput[]).map(outpointKey))
  return outputs.filter((output) => adopted.has(outpointKey(output)))
}

/** The rest of the lockup: the client's, returned at claim time rather than left to its refund deadline. */
export const unadopted = <O extends { txid: string; vout: number }>(
  outputs: readonly O[],
  lockupOutpoints: string | null,
): O[] => {
  if (lockupOutpoints === null) return []
  const adopted = new Set(adoptedOnly(outputs, lockupOutpoints).map(outpointKey))
  return outputs.filter((output) => !adopted.has(outpointKey(output)))
}

/** Adopted outputs not yet collected on either rail. One the read does not show is unknown, never collected. */
export const uncollected = (adopted: readonly AdoptedOutput[], evidence: CollectionEvidence): AdoptedOutput[] =>
  adopted.filter((output) => {
    const key = outpointKey(output)
    if (evidence.claimedOffchain.has(key)) return false
    const seen = evidence.outpoints.find((o) => outpointKey(o) === key)
    if (seen === undefined) return true
    if (seen.unrolled) return !evidence.claimedOnL1.has(key)
    // A spend counts as collected only if it was ours: a client refund of a dropped output reads spent too.
    return seen.spent ? !evidence.spentByUs.has(key) : true
  })
