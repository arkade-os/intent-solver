/**
 * The wallet's balance, fetched on a schedule and read synchronously — the join
 * `onchainFeeRateSampler` makes, for the reason it gives.
 *
 * NOT `freshly()`, which stops serving past `staleAfterMs`. Right for its caller
 * (a stale fee rate is wrong in both directions) and wrong here: a float falls
 * only through funding this solver performs, which the reservation counts, or an
 * operator withdrawal, which {@link FloatSampler.invalidate} clears. A stale
 * reading misses a DEPOSIT, so it errs toward refusing.
 */

export interface FloatReading {
  /** Confirmed sats only: unconfirmed ones can still be replaced. */
  sats: number
  ageMs: number
}

export interface FloatSampler {
  /** Null only until the first fetch lands — never because a reading grew old. */
  read(): FloatReading | null
  invalidate(): void
}

export const onchainFloatSampler = (input: {
  getBalance: () => Promise<{ confirmedSats: number; sharedWithLightning?: boolean }>
  refreshAfterMs: number
  /** Past this age a reading is still served, and said out loud once per episode. */
  staleAfterMs: number
  onStale?: (ageMs: number) => void
  /**
   * Fired once where the wallet is ALSO the Lightning pool, which spends it
   * through paths leaving no row: the gate is only advisory there.
   */
  onSharedPool?: () => void
  now?: () => number
}): FloatSampler => {
  const now = input.now ?? (() => Date.now())
  let held: number | null = null
  let heldAt = 0
  let generation = 0
  let inFlight: number | null = null
  let announced = false
  let sharedAnnounced = false

  const start = (): void => {
    // One at a time, or a burst of quotes past the refresh age each start their
    // own fetch — the amplification a synchronous read exists to prevent.
    if (inFlight === generation) return
    const started = generation
    inFlight = started
    void input
      .getBalance()
      .then((balance) => {
        // Begun before an invalidate: it may predate the withdrawal it would undo.
        if (started !== generation) return
        held = balance.confirmedSats
        heldAt = now()
        announced = false
        if (balance.sharedWithLightning === true && !sharedAnnounced) {
          sharedAnnounced = true
          input.onSharedPool?.()
        }
      })
      .catch(() => {
        // Leaves the previous reading in place, as `freshly` does: the last
        // known balance is better evidence than none.
      })
      .finally(() => {
        if (inFlight === started) inFlight = null
      })
  }

  // At construction, not first read: a lazy first fetch refused the first quote after every boot.
  start()

  return {
    read: () => {
      const age = held === null ? Infinity : now() - heldAt
      if (age >= input.refreshAfterMs) start()
      if (held === null) return null
      if (age >= input.staleAfterMs && !announced) {
        announced = true
        input.onStale?.(age)
      }
      return { sats: held, ageMs: age }
    },
    invalidate: () => {
      generation += 1
      held = null
      announced = false
      start()
    },
  }
}
