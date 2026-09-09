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

const releasing = (undo: readonly (() => void)[]): Reservation => {
  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      for (const one of undo) one()
    },
  }
}

export class AdmissionControl implements AdmissionStrategy {
  /** Sats claimed by quotes that have passed the cap check but not yet landed. */
  private reserved = 0

  /** The same against the WALLET, apart from `reserved` because it is a different ceiling. */
  private reservedFloat = 0

  /**
   * The same claim, per non-sats cap dimension. Apart from `reserved` rather than
   * summed into it: different units against a different ceiling, so one shared
   * total would let a token claim consume the sats cap.
   */
  private reservedUnits = new Map<string, bigint>()

  /**
   * Serialises read-modify-write on both counters. A promise chain rather than a lock
   * library: the critical section is one `await` on SQLite.
   */
  private tail: Promise<unknown> = Promise.resolve()

  private serialise<T>(job: () => Promise<T>): Promise<T> {
    // `then(job, job)` so one caller's rejection never wedges the queue for the next.
    const result = this.tail.then(job, job)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /**
   * Claim `sats` if the cap allows, counting both what is durable and what other
   * in-flight quotes have claimed. Null means the caller refuses `provider_at_capacity`.
   */
  async reserve(sats: number, committedSats: () => Promise<number>, capSats: number): Promise<Reservation | null> {
    return this.serialise(async (): Promise<Reservation | null> => {
      // Unreachable from the corridors, but guarded because the failure is silent and
      // asymmetric: `release()` subtracts whatever was added, so a NEGATIVE claim hands
      // out headroom that does not exist and every later quote sees a grown cap.
      if (!(sats > 0)) throw new RangeError(`reserve() needs a positive size, got ${sats}`)
      const claimed = this.claimExposure(sats, capSats, await committedSats())
      return claimed === null ? null : releasing([claimed])
    })
  }

  /**
   * The exposure half, for a caller already holding {@link serialise}. Split so
   * {@link admit} decides BOTH ceilings in one critical section.
   */
  private claimExposure(sats: number, capSats: number, committed: number): (() => void) | null {
    if (committed + this.reserved + sats > capSats) return null
    this.reserved += sats
    return () => {
      this.reserved -= sats
    }
  }

  private claimFloat(required: number, availableSats: number, owed: number): (() => void) | null {
    if (owed + this.reservedFloat + required > availableSats) return null
    this.reservedFloat += required
    return () => {
      this.reservedFloat -= required
    }
  }

  /**
   * {@link reserve} for a quantity no `number` holds exactly: one whole ERC-20 token
   * is 10^18 atomic units, ~111x `Number.MAX_SAFE_INTEGER`, and rounding an exposure
   * cap admits past what the operator set. `dimension` names the ceiling claimed
   * against — one asset, one market — so a claim in one never bounds another.
   */
  async reserveUnits(
    dimension: string,
    units: bigint,
    committedUnits: () => Promise<bigint>,
    capUnits: bigint,
  ): Promise<Reservation | null> {
    return this.serialise(async (): Promise<Reservation | null> => {
      if (!(units > 0n)) throw new RangeError(`reserveUnits() needs a positive size, got ${units}`)
      const committed = await committedUnits()
      const held = this.reservedUnits.get(dimension) ?? 0n
      if (committed + held + units > capUnits) return null
      this.reservedUnits.set(dimension, held + units)
      let released = false
      return {
        release: () => {
          if (released) return
          released = true
          const next = (this.reservedUnits.get(dimension) ?? 0n) - units
          // Dropped at zero, not left at 0n: dimensions are caller-supplied, and a
          // map that only ever grows is a leak keyed by whatever it was handed.
          if (next === 0n) this.reservedUnits.delete(dimension)
          else this.reservedUnits.set(dimension, next)
        },
      }
    })
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
    return this.serialise(async (): Promise<Reservation | null> => {
      if (!(request.giveSats > 0)) throw new RangeError(`admit() needs a positive size, got ${request.giveSats}`)
      const exposure = this.claimExposure(request.giveSats, request.capSats, await request.committedSats())
      if (exposure === null) {
        request.onRefused?.('exposure')
        return null
      }
      const float = request.float
      if (float === undefined) return releasing([exposure])
      // Missing includes the window after a withdrawal invalidates the held
      // balance. Treating it as unlimited could quote against already-spent sats.
      if (float.available === null) {
        exposure()
        request.onRefused?.('float')
        return null
      }
      const claimed = this.claimFloat(float.requiredSats, float.available.sats, await float.owedSats())
      if (claimed === null) {
        exposure()
        request.onRefused?.('float')
        return null
      }
      return releasing([exposure, claimed])
    })
  }

  get outstandingSats(): number {
    return this.reserved
  }

  get outstandingFloatSats(): number {
    return this.reservedFloat
  }

  /** In-flight units in `dimension`. For assertions and diagnostics; not part of admission. */
  outstandingUnits(dimension: string): bigint {
    return this.reservedUnits.get(dimension) ?? 0n
  }
}
