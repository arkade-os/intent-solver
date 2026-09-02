/**
 * Outpoints one operation has claimed, so another does not spend them under it.
 *
 * The solver has two independent spenders of its own float: lockup funding, on
 * demand, and the renewal settle on `VTXO_LIFECYCLE_MS`. Neither knows about
 * the other, and arkd resolves the collision by failing one of them —
 * `VTXO_ALREADY_SPENT` for whichever loses. When the loser is a funding, a swap
 * fails that had no reason to.
 *
 * Process-local and in-memory ON PURPOSE. A reservation is a statement about
 * work in flight in THIS process; it has no meaning after a restart, when
 * nothing is in flight, and persisting it would create a second failure mode —
 * a stale pin outliving the crash that stranded it, quietly shrinking the
 * spendable float with no operation to release it. The durable record of a
 * lockup is its swap row, not a reservation.
 *
 * This assumes a single solver process against one wallet. Two processes
 * sharing a wallet would need arkd to arbitrate, exactly as today.
 */

import { outpointKey } from './lockupFunding.js'

/** Releases the pin. Idempotent, so a caller may release in a `finally` and again on a later path. */
export type ReleaseReservation = () => void

export interface ReservationLedger {
  /**
   * Pin `outpoints` until the returned release is called. Re-pinning an
   * already-pinned outpoint is allowed and counted: two operations holding the
   * same coin is a caller bug this cannot fix, but silently dropping one of the
   * two releases would leak the pin forever, so each reserve owns its own.
   */
  reserve(outpoints: readonly { txid: string; vout: number }[]): ReleaseReservation
  /** Every currently pinned outpoint, as `txid:vout`. */
  reserved(): ReadonlySet<string>
}

export const createReservationLedger = (): ReservationLedger => {
  // Counted rather than a plain Set: releases can interleave, and a Set would
  // let the first release free a coin the second holder is still spending.
  const counts = new Map<string, number>()

  return {
    reserve(outpoints) {
      const keys = outpoints.map((o) => outpointKey(o.txid, o.vout))
      for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        for (const key of keys) {
          const next = (counts.get(key) ?? 1) - 1
          if (next <= 0) counts.delete(key)
          else counts.set(key, next)
        }
      }
    },
    reserved() {
      return new Set(counts.keys())
    },
  }
}
