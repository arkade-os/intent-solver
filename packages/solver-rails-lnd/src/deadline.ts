/**
 * A deadline for the LND READS, and only the reads. `lightning` sets no gRPC
 * keepalive and no per-call deadline, so a half-open connection stays pending
 * until the OS TCP keepalive fires.
 *
 * WRITES ARE DELIBERATELY EXCLUDED: aborting a submit does not mean it failed,
 * it means the outcome is UNKNOWN — calling it failed abandons a payment that
 * landed, and retrying it sends a second one.
 */

import type { AuthenticatedLightningMethod, AuthenticatedLnd } from 'lightning'

export const LND_READ_TIMEOUT_MS = 30_000
const MAX_IN_FLIGHT_READS = 8
const inFlight = new WeakMap<AuthenticatedLnd, number>()

export class LndReadCapacityError extends Error {
  constructor(readonly call: string) {
    super(`LND read ${call} refused: ${MAX_IN_FLIGHT_READS} earlier reads are still running`)
    this.name = 'LndReadCapacityError'
  }
}

export class LndReadTimeoutError extends Error {
  constructor(
    readonly call: string,
    readonly timeoutMs: number,
  ) {
    super(`LND read ${call} did not answer within ${timeoutMs}ms`)
    this.name = 'LndReadTimeoutError'
  }
}

/**
 * Typed against the vendor's own method type, not `(args) => Promise<R>`: each
 * is an overload PAIR (promise, callback), and inferring from a plain function
 * type picks the `void` callback form, silently widening results to `unknown`.
 */
export const deadlined =
  <A extends { lnd: AuthenticatedLnd }, R>(call: string, read: AuthenticatedLightningMethod<A, R>) =>
  async (args: A, timeoutMs: number = LND_READ_TIMEOUT_MS): Promise<R> => {
    const count = inFlight.get(args.lnd) ?? 0
    if (count >= MAX_IN_FLIGHT_READS) throw new LndReadCapacityError(call)
    inFlight.set(args.lnd, count + 1)
    const release = () => {
      const remaining = (inFlight.get(args.lnd) ?? 1) - 1
      if (remaining === 0) inFlight.delete(args.lnd)
      else inFlight.set(args.lnd, remaining)
    }
    const pending = Promise.resolve().then(() => read(args))
    // The vendor exposes no cancellation handle; a caller timeout does not release its read slot.
    void pending.then(release, release)
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LndReadTimeoutError(call, timeoutMs)), timeoutMs)
      timer.unref()
    })
    try {
      return await Promise.race([pending, deadline])
    } finally {
      // Also covers a vendor that throws synchronously: an uncleared timer would
      // reject `deadline` with nothing attached to it.
      clearTimeout(timer)
    }
  }
