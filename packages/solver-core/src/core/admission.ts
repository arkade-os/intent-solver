/**
 * Admission control for the exposure cap.
 *
 * Every corridor's `quote()` reads the committed total, compares it to
 * `maxExposedSats`, and only LATER inserts the row. In that window the swap is
 * invisible to `committedSats()`, so two concurrent quotes both see headroom and both
 * take it (#105). A reservation makes headroom *reserved* rather than merely observed.
 *
 * Not a lock across check→insert: the Lightning-receive leg mints a hold invoice in
 * that region, and holding a lock across a network round-trip would serialise every
 * receive quote behind the backend's latency.
 *
 * SCOPE: per-process, in memory — right for one wallet, one process, and it does NOT
 * bound two processes sharing one database. Crash safety needs nothing: reservations
 * describe quotes in flight, and a process that dies has none.
 */

/** A claim on headroom, held until the row that supersedes it is durable. */
import type { AdmissionRequest, AdmissionStrategy } from './admissionStrategy.js'

export interface Reservation {
  /**
   * Give the headroom back. Idempotent, because the two callers overlap: a `finally`
   * release must not double-refund one already released on success.
   */
  release(): void
}

export class AdmissionControl implements AdmissionStrategy {
  /** Sats claimed by quotes that have passed the cap check but not yet landed. */
  private reserved = 0

  /**
   * Serialises read-modify-write on `reserved`. A promise chain rather than a lock
   * library: the critical section is one `await` on SQLite.
   */
  private tail: Promise<unknown> = Promise.resolve()

  /**
   * Claim `sats` if the cap allows, counting both what is durable and what other
   * in-flight quotes have claimed. Null means the caller refuses `provider_at_capacity`.
   */
  async reserve(sats: number, committedSats: () => Promise<number>, capSats: number): Promise<Reservation | null> {
    const run = async (): Promise<Reservation | null> => {
      // Unreachable from the corridors, but guarded because the failure is silent and
      // asymmetric: `release()` subtracts whatever was added, so a NEGATIVE claim hands
      // out headroom that does not exist and every later quote sees a grown cap.
      if (!(sats > 0)) throw new RangeError(`reserve() needs a positive size, got ${sats}`)
      const committed = await committedSats()
      if (committed + this.reserved + sats > capSats) return null
      this.reserved += sats
      let released = false
      return {
        release: () => {
          if (released) return
          released = true
          this.reserved -= sats
        },
      }
    }
    // `then(run, run)` so one caller's rejection never wedges the queue for the next.
    const result = this.tail.then(run, run)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** In-flight sats. For assertions and diagnostics; not part of admission. */
  /**
   * {@link AdmissionStrategy}'s shape over {@link reserve}.
   *
   * Present so the exposure cap IS a strategy rather than needing a wrapper: a
   * deployment that wants the default wires this object straight in, and one
   * that wants something else supplies its own `admit` without this class being
   * involved at all.
   */
  async admit(request: AdmissionRequest): Promise<Reservation | null> {
    return this.reserve(request.giveSats, request.committedSats, request.capSats)
  }

  get outstandingSats(): number {
    return this.reserved
  }
}
