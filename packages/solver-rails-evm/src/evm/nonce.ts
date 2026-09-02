/**
 * Choosing the nonce for the solver's next EVM transaction.
 *
 * A nonce is not bookkeeping here — it is the thing that decides whether two
 * operations the solver starts close together both land. The corridor issues
 * transactions from one address on a tick loop (fund a lock, claim a revealed
 * one, refund an expired one), so "close together" is the normal case rather
 * than an edge one.
 *
 * THE TWO COUNTERS, AND WHY NEITHER IS RIGHT ALONE.
 *
 * `eth_getTransactionCount(addr, 'latest')` counts only MINED transactions.
 * Ask it twice before the first has been mined and it answers the same number
 * twice, so the second transaction reuses the first's nonce. On a chain that
 * accepts replacement-by-fee that silently REPLACES the first — the solver
 * believes it has funded a lock and claimed a swap, and only one happened.
 *
 * `eth_getTransactionCount(addr, 'pending')` counts the mempool too, which
 * fixes that — but a node's pending view is not authoritative and not shared.
 * After a restart, a mempool eviction, or a switch to a different RPC endpoint,
 * `pending` can come back BELOW what we already broadcast, and the same reuse
 * happens with the same consequence.
 *
 * So this takes `pending` as the floor and keeps its own high-water mark above
 * it. The chain's answer can only ever move the mark forwards; nothing this
 * process has already handed out is reissued, whatever a node later claims.
 *
 * WHAT THIS DELIBERATELY IS NOT. It is not durable. A process restart forgets
 * the mark and falls back to `pending`, which is correct as long as the
 * mempool still holds what we sent, and wrong if it does not — a case that
 * needs the corridor's own row state to resolve, not a counter. That is
 * recorded rather than hidden, because a durable nonce store implies a
 * crash-recovery story this module cannot supply on its own.
 */

/** Reads the chain's view of an account's nonce. */
export type NonceReader = (address: Uint8Array, block: 'latest' | 'pending') => Promise<bigint>

export interface NonceSource {
  /** The nonce to use next, reserving it so no later call returns it again. */
  next(address: Uint8Array): Promise<bigint>
  /**
   * Give a reserved nonce back after a send that never reached the mempool.
   *
   * Only safe when the transaction was NOT broadcast — a rejected signature, a
   * transport error before submission. Returning one that did reach a node
   * makes the next transaction a replacement of it.
   */
  release(address: Uint8Array, nonce: bigint): void
}

const key = (address: Uint8Array): string => Array.from(address, (b) => b.toString(16).padStart(2, '0')).join('')

/**
 * Caught here rather than at signing.
 *
 * `key()` accepts any length, so a 19-byte slice yields a plausible-looking map
 * key and a zero-length one yields `''` — both valid keys tracking a nonce
 * series for an address that does not exist. The error would surface much later
 * as a rejected transaction, pointing at the signer instead of the caller.
 */
const assertEvmAddress = (address: Uint8Array): void => {
  if (address.length !== 20) throw new Error(`address must be 20 bytes, got ${address.length}`)
}

export const createNonceSource = (read: NonceReader): NonceSource => {
  /** Highest nonce handed out per address, plus one — our own view of `pending`. */
  const marks = new Map<string, bigint>()

  return {
    async next(address) {
      assertEvmAddress(address)
      const chain = await read(address, 'pending')
      const id = key(address)
      const mark = marks.get(id)
      // The chain can push the mark FORWARD (someone else spent from this
      // address, or our mempool entry got mined) but never backwards. A node
      // that has forgotten our pending transactions must not be able to talk us
      // into reissuing their nonces.
      const nonce = mark === undefined || chain > mark ? chain : mark
      marks.set(id, nonce + 1n)
      return nonce
    },

    release(address, nonce) {
      assertEvmAddress(address)
      const id = key(address)
      const mark = marks.get(id)
      // Only the most recently issued nonce can be returned, and only if it is
      // still the top. Anything else would leave a gap that stalls every later
      // transaction from this address until it is filled.
      if (mark !== undefined && mark === nonce + 1n) marks.set(id, nonce)
    },
  }
}
