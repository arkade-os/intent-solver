/**
 * Whether to serve this quote at all, and what that costs the next one.
 *
 * The default is the exposure cap — reserve headroom at quote time, release it
 * when the row lands or the quote dies. `admission.ts`'s header states that
 * scope plainly: per-process and in-memory, right for one-wallet-one-process,
 * and NOT a bound across two processes sharing a database. A replacement is
 * free to be narrower or wider.
 *
 * What a replacement may NOT drop is the reserve/release PAIRING. A strategy
 * that admits without reserving reintroduces issue #105: two concurrent quotes
 * both read the same committed total, both see headroom, and both take it — the
 * solver ends up committed past a bound an operator set deliberately. That
 * window exists because a quote is invisible to `committedSats()` between the
 * check and the insert, and nothing about being a strategy closes it.
 */
import type { Reservation } from './admission.js'

export interface AdmissionRequest {
  /** Which corridor is asking. The default ignores it; a per-corridor policy would not. */
  pair: string
  /** What this quote would commit. */
  giveSats: number
  /**
   * The deployment's exposure ceiling, and how to read what is already
   * committed against it.
   *
   * Passed per request rather than captured at construction because BOTH are
   * the host's facts, not the strategy's: the cap is the EFFECTIVE policy
   * (config narrowed by the console's stored overrides) and the committed total
   * spans every registered corridor. A strategy is free to ignore both — that
   * is the point of it being a strategy — but it must not have to reconstruct
   * them to honour the default behaviour.
   */
  capSats: number
  committedSats: () => Promise<number>
}

export interface AdmissionStrategy {
  /**
   * Claim headroom for a quote, or refuse it.
   *
   * Returns null to refuse — the corridors turn that into `exposure_cap`.
   * A returned {@link Reservation} MUST be released on every exit path after
   * this point, including failures: `release()` is idempotent precisely so a
   * caller can release in a `finally` without double-refunding one already
   * released on success.
   */
  admit(request: AdmissionRequest): Promise<Reservation | null>
}
