/**
 * Timing collection and the table the benchmark prints.
 *
 * The unit of measurement is a MARK — a named instant on one swap's timeline —
 * and never a duration. Durations are derived from adjacent marks at report
 * time, which is what lets four corridors with four different shapes share one
 * recorder: `arkade:BTC->onchain:BTC` has a client-broadcast phase that
 * `lightning:BTC->arkade:BTC` does not, and neither has to know about the
 * other's stages.
 *
 * WHY A SINGLE NUMBER PER SWAP WOULD BE A LIE. "Sub-2s per swap" is only
 * meaningful once it says what is inside the two seconds. A swap on the onchain
 * receive corridor waits for a real block confirmation; no amount of solver
 * optimisation moves that number, and reporting it next to a Lightning swap's
 * as though they measured the same thing would make both useless. So every
 * corridor's total is reported ALONGSIDE its phases, and the phases name which
 * party the wait belongs to: the solver, the client, or the outside world.
 *
 * MEDIAN AND p95, NOT MEAN. A load test's mean is dominated by its worst
 * sample, and on a stack sharing one regtest chain the worst sample is
 * routinely something with nothing to do with the code — one slow docker exec,
 * one indexer hiccup. The median says what a swap usually costs; the p95 says
 * how bad the tail is. Both are computed from real samples by nearest rank
 * (`sorted[ceil(p * n) - 1]`), never interpolated, so every number printed is a
 * value some swap actually took.
 */

/** A named instant on one swap's timeline, in milliseconds since the process started. */
export interface Mark {
  name: string
  at: number
}

/** One swap's whole timeline, successful or not. */
export interface SwapTiming {
  corridor: string
  /** Which wallet in the fleet drove it — the handle for chasing one failure down. */
  wallet: number
  ok: boolean
  /** Populated only on failure; the first line is enough to group failures by cause. */
  error?: string
  marks: Mark[]
}

/**
 * A swap's timeline as it is being built.
 *
 * `mark` is called at the boundaries the TEST controls, never inside the
 * service: a benchmark that instrumented the code under test would measure an
 * instrumented build. Everything here is observable from the outside.
 */
export class Timeline {
  readonly marks: Mark[] = []

  constructor(
    readonly corridor: string,
    readonly wallet: number,
  ) {
    this.mark('start')
  }

  mark(name: string): void {
    this.marks.push({ name, at: performance.now() })
  }

  /** Time `work`, marking the instant it finished under `name`. */
  async phase<T>(name: string, work: () => Promise<T>): Promise<T> {
    const result = await work()
    this.mark(name)
    return result
  }

  succeeded(): SwapTiming {
    return { corridor: this.corridor, wallet: this.wallet, ok: true, marks: this.marks }
  }

  failed(error: unknown): SwapTiming {
    const message = error instanceof Error ? error.message : String(error)
    return {
      corridor: this.corridor,
      wallet: this.wallet,
      ok: false,
      error: message.split('\n')[0],
      marks: this.marks,
    }
  }
}

/** Nearest-rank percentile over `values`. Returns 0 for an empty sample rather than NaN. */
export const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil(p * sorted.length))
  return sorted[rank - 1] ?? 0
}

const round = (value: number): number => Math.round(value)

/** Durations between adjacent marks, plus the whole swap as `TOTAL`. */
const durations = (timing: SwapTiming): { name: string; ms: number }[] => {
  const spans: { name: string; ms: number }[] = []
  for (let i = 1; i < timing.marks.length; i += 1) {
    const from = timing.marks[i - 1]
    const to = timing.marks[i]
    if (!from || !to) continue
    spans.push({ name: to.name, ms: to.at - from.at })
  }
  const first = timing.marks[0]
  const last = timing.marks[timing.marks.length - 1]
  if (first && last && timing.marks.length > 1) spans.push({ name: 'TOTAL', ms: last.at - first.at })
  return spans
}

export interface PhaseStats {
  name: string
  samples: number
  medianMs: number
  p95Ms: number
  minMs: number
  maxMs: number
}

/**
 * Per-phase statistics for one corridor, from its SUCCESSFUL swaps only.
 *
 * Failures are excluded from the timings and counted separately. A swap that
 * died halfway through contributes a truncated timeline, and folding those into
 * a median would drag it downward — a benchmark that got faster the more it
 * broke. The failure count is reported next to the numbers so nobody reads a
 * fast median off a run that mostly failed.
 */
export const phaseStats = (timings: readonly SwapTiming[]): PhaseStats[] => {
  const byPhase = new Map<string, number[]>()
  const order: string[] = []
  for (const timing of timings) {
    if (!timing.ok) continue
    for (const span of durations(timing)) {
      let samples = byPhase.get(span.name)
      if (!samples) {
        samples = []
        byPhase.set(span.name, samples)
        order.push(span.name)
      }
      samples.push(span.ms)
    }
  }
  return order.map((name) => {
    const samples = byPhase.get(name) ?? []
    return {
      name,
      samples: samples.length,
      medianMs: round(percentile(samples, 0.5)),
      p95Ms: round(percentile(samples, 0.95)),
      minMs: round(Math.min(...samples)),
      maxMs: round(Math.max(...samples)),
    }
  })
}

/** Every distinct corridor in `timings`, in first-seen order. */
const corridorsIn = (timings: readonly SwapTiming[]): string[] => [...new Set(timings.map((t) => t.corridor))]

const pad = (value: string | number, width: number): string => String(value).padStart(width)

/**
 * The whole run as text, one block per corridor.
 *
 * Printed rather than asserted on: a threshold assertion over a wall-clock
 * measurement taken against a shared regtest stack is a test that fails for
 * reasons nobody can act on. What IS asserted is correctness — that every swap
 * reached its terminal good state — which is a property of the code and not of
 * the machine it ran on.
 */
export const formatReport = (
  timings: readonly SwapTiming[],
  context: { concurrency: number; wallClockMs: number },
): string => {
  const lines: string[] = []
  const ok = timings.filter((t) => t.ok).length
  lines.push('')
  lines.push('='.repeat(78))
  lines.push(
    `swap benchmark — ${timings.length} swaps, ${ok} succeeded, ${timings.length - ok} failed, ` +
      `launched ${context.concurrency} at a time, ${(context.wallClockMs / 1000).toFixed(1)}s wall`,
  )
  lines.push('='.repeat(78))

  for (const corridor of corridorsIn(timings)) {
    const mine = timings.filter((t) => t.corridor === corridor)
    const succeeded = mine.filter((t) => t.ok)
    lines.push('')
    lines.push(`${corridor}  —  ${succeeded.length}/${mine.length} ok`)
    lines.push(
      `  ${'phase'.padEnd(24)}${pad('n', 5)}${pad('median', 10)}${pad('p95', 10)}${pad('min', 10)}${pad('max', 10)}`,
    )
    for (const stat of phaseStats(mine)) {
      lines.push(
        `  ${stat.name.padEnd(24)}${pad(stat.samples, 5)}${pad(`${stat.medianMs}ms`, 10)}` +
          `${pad(`${stat.p95Ms}ms`, 10)}${pad(`${stat.minMs}ms`, 10)}${pad(`${stat.maxMs}ms`, 10)}`,
      )
    }
    // Failures are grouped by their first line: a hundred swaps failing one way
    // is one finding, and printing it a hundred times buries the other three.
    const failures = new Map<string, number>()
    for (const failed of mine.filter((t) => !t.ok)) {
      const reason = failed.error ?? 'unknown'
      failures.set(reason, (failures.get(reason) ?? 0) + 1)
    }
    for (const [reason, count] of failures) lines.push(`  FAILED x${count}: ${reason.slice(0, 160)}`)
  }
  lines.push('')
  return lines.join('\n')
}
