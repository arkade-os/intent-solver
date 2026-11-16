/**
 * Admission control for the exposure cap.
 *
 * Every corridor's `quote()` reads the committed total, compares it to
 * `maxExposedSats`, and only LATER inserts the row. In that window the swap is
 * invisible to `committedSats()`, so two concurrent quotes both see headroom and both
 * take it. A reservation makes headroom *reserved* rather than merely observed.
 *
 * Not a lock across check→insert: the Lightning-receive leg mints a hold invoice in
 * that region, and holding a lock across a network round-trip would serialise every
 * receive quote behind the backend's latency.
 *
 * SCOPE: per-process, in memory — right for one wallet, one process, and it does NOT
 * bound two processes sharing one database. Crash safety needs nothing: reservations
 * describe quotes in flight, and a process that dies has none.
 */

import type { AdmissionRequest, AdmissionStrategy } from './admissionStrategy.js'
import { createSerialiser } from '../util/serialise.js'

/** A claim on headroom, held until the row that supersedes it is durable. */
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
  constructor(private readonly inventoryFor?: (request: AdmissionRequest) => Promise<AdmissionRequest['inventory']>) {}
  /** Sats claimed by quotes that have passed the cap check but not yet landed. */
  private reserved = 0

  /** The same against the WALLET, apart from `reserved` because it is a different ceiling. */
  private reservedFloat = 0
  private readonly inventory = new Map<string, number>()
  private inventoryGeneration = 0n

  /**
   * Serialises read-modify-write on both counters. A promise chain rather than a lock
   * library: the critical section is one `await` on SQLite.
   */
  private readonly serialise = createSerialiser()

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

  outstandingInventorySats(poolId: string): number {
    return this.inventory.get(poolId) ?? 0
  }

  restoreInventory(poolId: string, requiredSats: number): Reservation {
    if (!poolId || !Number.isSafeInteger(requiredSats) || requiredSats <= 0)
      throw new RangeError('invalid inventory reservation')
    const next = this.outstandingInventorySats(poolId) + requiredSats
    if (!Number.isSafeInteger(next)) throw new RangeError('inventory reservation exceeds safe integer range')
    this.inventory.set(poolId, next)
    // Release-only: a new hold is counted by outstandingInventorySats inside the queue.
    return releasing([
      () => {
        this.inventory.set(poolId, this.outstandingInventorySats(poolId) - requiredSats)
        this.inventoryGeneration++
      },
    ])
  }

  reserveInventory(
    poolId: string,
    requiredSats: number,
    available: number,
    owed: () => Promise<number>,
  ): Promise<Reservation | null> {
    return this.serialise(async () => {
      const obligations = await owed()
      if (!Number.isSafeInteger(available) || available < 0 || !Number.isSafeInteger(obligations) || obligations < 0)
        throw new RangeError('invalid inventory balance or obligations')
      if (obligations + this.outstandingInventorySats(poolId) + requiredSats > available) return null
      return this.restoreInventory(poolId, requiredSats)
    })
  }

  /**
   * {@link AdmissionStrategy}'s shape over {@link reserve}.
   *
   * Present so the exposure cap IS a strategy rather than needing a wrapper: a
   * deployment that wants the default wires this object straight in, and one
   * that wants something else supplies its own `admit` without this class being
   * involved at all.
   */
  async admit(request: AdmissionRequest): Promise<Reservation | null> {
    if (!(request.giveSats > 0)) throw new RangeError(`admit() needs a positive size, got ${request.giveSats}`)
    const generation = this.inventoryGeneration
    const guardedInventory = request.inventory ?? (await this.inventoryFor?.(request))
    return this.serialise(async (): Promise<Reservation | null> => {
      const exposure = this.claimExposure(request.giveSats, request.capSats, await request.committedSats())
      if (exposure === null) {
        request.onRefused?.('exposure')
        return null
      }
      const float = request.float
      const undo: Array<() => void> = [exposure]
      try {
        const inventory = guardedInventory
        if (inventory) {
          const owed = await inventory.owedSats()
          if (
            !Number.isSafeInteger(owed) ||
            owed < 0 ||
            !Number.isSafeInteger(inventory.requiredSats) ||
            inventory.requiredSats <= 0 ||
            (inventory.available !== null &&
              (!Number.isSafeInteger(inventory.available.sats) || inventory.available.sats < 0))
          ) {
            throw new RangeError('invalid inventory requirement')
          }
          if (
            // A released source hold may already have spent the balance read outside this queue.
            generation !== this.inventoryGeneration ||
            inventory.available === null ||
            owed + this.outstandingInventorySats(inventory.poolId) + inventory.requiredSats > inventory.available.sats
          ) {
            exposure()
            request.onRefused?.('float')
            return null
          }
          const held = this.restoreInventory(inventory.poolId, inventory.requiredSats)
          undo.push(() => held.release())
        }
        if (float === undefined) return releasing(undo)
        // Missing includes the window after a withdrawal invalidates the held
        // balance. Treating it as unlimited could quote against already-spent sats.
        if (float.available === null) {
          undo.forEach((release) => release())
          request.onRefused?.('float')
          return null
        }
        const claimed = this.claimFloat(float.requiredSats, float.available.sats, await float.owedSats())
        if (claimed === null) {
          undo.forEach((release) => release())
          request.onRefused?.('float')
          return null
        }
        return releasing([...undo, claimed])
      } catch (error) {
        undo.forEach((release) => release())
        throw error
      }
    })
  }

  /** In-flight sats. For assertions and diagnostics; not part of admission. */
  get outstandingSats(): number {
    return this.reserved
  }

  get outstandingFloatSats(): number {
    return this.reservedFloat
  }
}
