/**
 * Which phase of a swap is slow, read from swaps that already happened.
 *
 * Every state transition is written to a `*_swap_event` row with a timestamp,
 * so the duration of each phase of every swap this deployment has served is
 * already on disk. This is the arithmetic that reads it as durations. There is
 * no new instrumentation behind it and none is needed to use it.
 *
 * That ordering is the point. Instrumenting first needs a code change, a
 * deploy, and then a wait for traffic — and it measures only the spans someone
 * guessed at in advance. This covers every phase at once, retroactively, and
 * its job is to say which one is worth instrumenting properly.
 *
 * RESOLUTION IS ONE SECOND. Event timestamps come from `nowSeconds`, so a phase
 * taking 40ms and one taking 900ms both read as `0`. This localises a slow
 * phase; it cannot profile a fast one. Every phase reading zero on a swap that
 * still feels slow is itself the finding — the time is going INSIDE a phase
 * rather than between them, which is where millisecond timing earns its cost.
 */

/** One row of a corridor's event table. */
export interface SwapEvent {
  swapId: string
  at: number
  from: string | null
  to: string
  /**
   * Non-null only on a NOTE — something that happened to a swap without moving
   * it, which shares `from` and `to`. Notes are excluded from every figure
   * here: counted as transitions they invent a zero-length `funded -> funded`
   * phase and split the real one either side of it, which hides the slow phase
   * behind two fast ones.
   */
  detail: string | null
}

export interface StepStats {
  label: string
  n: number
  p50: number
  p95: number
  max: number
}

export interface LatencySummary {
  swaps: number
  /** Slowest first by p50 — the report exists to name one phase. */
  steps: StepStats[]
  /** First transition to last, per swap. Null when nothing completed a step. */
  endToEnd: StepStats | null
}

/**
 * Nearest rank, never interpolated.
 *
 * An interpolated p50 of `[10, 20, 30, 40]` is 25 — a duration no swap took.
 * Every figure here stays something that actually happened, because the next
 * question after reading a p95 is always "which swap was that", and a number no
 * swap produced cannot be looked up.
 */
const quantile = (sorted: number[], q: number): number =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0

const statsOf = (label: string, durations: number[]): StepStats => {
  const sorted = [...durations].sort((a, b) => a - b)
  return {
    label,
    n: sorted.length,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? 0,
  }
}

/**
 * Summarise phase durations across many swaps.
 *
 * Events must arrive in the order the database assigned them — by rowid, not by
 * `at`. Timestamps are whole seconds and a second holds several transitions, so
 * insertion order is the only faithful record of which came first. Nothing here
 * re-sorts them: doing so would reorder same-second events arbitrarily and
 * report phases that never existed.
 */
export const summariseLatency = (events: SwapEvent[]): LatencySummary => {
  const bySwap = new Map<string, SwapEvent[]>()
  for (const event of events) {
    if (event.detail !== null && event.from === event.to) continue
    const seen = bySwap.get(event.swapId)
    if (seen) seen.push(event)
    else bySwap.set(event.swapId, [event])
  }

  const steps = new Map<string, number[]>()
  const totals: number[] = []
  for (const track of bySwap.values()) {
    for (let i = 1; i < track.length; i++) {
      const prev = track[i - 1]
      const next = track[i]
      if (!prev || !next) continue
      const label = `${prev.to} -> ${next.to}`
      const durations = steps.get(label)
      const delta = next.at - prev.at
      if (durations) durations.push(delta)
      else steps.set(label, [delta])
    }
    // A swap with one event is a quote nobody took: a start and no phases.
    // Counted as a zero it drags every p50 down and hides a slow phase behind
    // swaps that never ran.
    const first = track[0]
    const last = track[track.length - 1]
    if (first && last && track.length > 1) totals.push(last.at - first.at)
  }

  return {
    swaps: bySwap.size,
    steps: [...steps.entries()]
      .map(([label, durations]) => statsOf(label, durations))
      // Slowest first, then by the worst case — reading order should not be
      // state order when the answer is one row.
      .sort((a, b) => b.p50 - a.p50 || b.max - a.max || a.label.localeCompare(b.label)),
    endToEnd: totals.length > 0 ? statsOf('END TO END', totals) : null,
  }
}
