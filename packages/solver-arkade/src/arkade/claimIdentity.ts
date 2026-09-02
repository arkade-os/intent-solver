/**
 * A signer that reveals a preimage when spending a condition leaf.
 *
 * The ordering encoded here is the whole point, and it is not guessable from the
 * types: the condition witness is **not** part of what is signed, so attaching it
 * before signing leaves a signature over a PSBT that no longer matches once the
 * field is present. The Arkade server rejects that as `INVALID_SIGNATURE`, naming
 * the checkpoint transaction rather than the ordering that caused it.
 *
 * This is a property of signing a condition leaf, not of any one spend, so it
 * lives as a decorator every condition-leaf call site can reuse — the send leg's
 * claim today, the receive leg's non-interactive claim later. Copy-pasting the
 * rule instead is how it comes back.
 *
 * Decorate per claim, never wallet-wide: attaching a condition witness to an
 * ordinary send would be wrong.
 */

import { ConditionWitness, setArkPsbtField, Transaction, type Identity } from '@arkade-os/sdk'

export const claimIdentity = (identity: Identity, preimage: Uint8Array): Identity => ({
  ...identity,
  sign: async (tx: Transaction, inputIndexes?: number[]): Promise<Transaction> => {
    // Clone so a caller's transaction is never mutated out from under it, and
    // round-trip through the PSBT so the signed result is a fresh object we can
    // safely add a field to.
    const signed = Transaction.fromPSBT((await identity.sign(tx.clone(), inputIndexes)).toPSBT())
    const indexes = inputIndexes ?? Array.from({ length: signed.inputsLength }, (_, i) => i)
    for (const index of indexes) {
      setArkPsbtField(signed, index, ConditionWitness, [preimage])
    }
    return signed
  },
})
