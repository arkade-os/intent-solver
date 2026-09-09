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
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LndReadTimeoutError(call, timeoutMs)), timeoutMs)
      timer.unref()
    })
    try {
      return await Promise.race([read(args), deadline])
    } finally {
      // Also covers a vendor that throws synchronously: an uncleared timer would
      // reject `deadline` with nothing attached to it.
      clearTimeout(timer)
    }
  }
