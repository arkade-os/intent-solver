/**
 * Turning a swap's event log into "which phase is slow".
 *
 * Every state transition is already written to a `*_swap_event` row with a
 * timestamp, so the duration of every phase of every swap this deployment has
 * served is on disk. This is the arithmetic that reads it as durations — which
 * is worth testing precisely because it is arithmetic nobody eyeballs: a
 * quantile off by one, or a note counted as a transition, produces a number
 * that looks plausible and sends someone to instrument the wrong thing.
 */

import { describe, it, expect } from 'vitest'
import { summariseLatency, type SwapEvent } from '../../src/ops/latency.js'

/** Terse builder: `at` and `to`, with `from` inferred as the previous `to`. */
const track = (swapId: string, ...steps: [number, string][]): SwapEvent[] =>
  steps.map(([at, to], i) => ({ swapId, at, from: steps[i - 1]?.[1] ?? null, to, detail: null }))

describe('summariseLatency', () => {
  it('measures each phase as the gap between consecutive transitions', () => {
    const summary = summariseLatency(track('a', [100, 'quoted'], [110, 'armed'], [140, 'funded']))
    expect(summary.steps.map((s) => [s.label, s.p50])).toEqual([
      ['armed -> funded', 30],
      ['quoted -> armed', 10],
    ])
  })

  it('puts the slowest phase first, because the report exists to name one', () => {
    const summary = summariseLatency(track('a', [0, 'quoted'], [1, 'armed'], [61, 'funded'], [63, 'claimed']))
    expect(summary.steps[0]?.label).toBe('armed -> funded')
  })

  it('aggregates the same phase across swaps', () => {
    const summary = summariseLatency([
      ...track('a', [0, 'quoted'], [10, 'armed']),
      ...track('b', [0, 'quoted'], [20, 'armed']),
      ...track('c', [0, 'quoted'], [30, 'armed']),
    ])
    expect(summary.swaps).toBe(3)
    expect(summary.steps[0]).toMatchObject({ label: 'quoted -> armed', n: 3, max: 30 })
  })

  it('reports quantiles as real observations, never interpolated', () => {
    // An interpolating p50 of [10,20,30,40] is 25 — a duration no swap took.
    // Nearest-rank keeps every figure something that actually happened, which
    // matters when the next step is "go find the swap that took p95".
    const summary = summariseLatency([10, 20, 30, 40].map((d, i) => track(`s${i}`, [0, 'quoted'], [d, 'armed'])).flat())
    expect([10, 20, 30, 40]).toContain(summary.steps[0]?.p50)
    expect(summary.steps[0]?.p95).toBe(40)
  })

  it('ignores notes, which are things that happened TO a swap', () => {
    // A note shares `from` and `to` and carries `detail`. Counted as a
    // transition it invents a `funded -> funded` phase and splits the real
    // `funded -> claimed` into two shorter ones, hiding the slow phase.
    const events: SwapEvent[] = [
      ...track('a', [0, 'quoted'], [10, 'funded']),
      { swapId: 'a', at: 15, from: 'funded', to: 'funded', detail: 'lockup seen' },
      { swapId: 'a', at: 40, from: 'funded', to: 'claimed', detail: null },
    ]
    const summary = summariseLatency(events)
    expect(summary.steps.map((s) => s.label)).toEqual(['funded -> claimed', 'quoted -> funded'])
    expect(summary.steps[0]?.p50).toBe(30)
  })

  it('keeps the caller ordering, so two events in one second do not flip', () => {
    // Timestamps are whole seconds and a second holds several transitions. The
    // caller orders by rowid, which is the only faithful record of what came
    // first; re-sorting by `at` here would reorder them arbitrarily and produce
    // phases that never existed.
    const summary = summariseLatency(track('a', [5, 'quoted'], [5, 'armed'], [5, 'funded']))
    expect(summary.steps.map((s) => s.label).sort()).toEqual(['armed -> funded', 'quoted -> armed'])
    expect(summary.steps.every((s) => s.p50 === 0)).toBe(true)
  })

  it('measures end to end as first transition to last, per swap', () => {
    const summary = summariseLatency([
      ...track('a', [0, 'quoted'], [10, 'armed'], [90, 'funded']),
      ...track('b', [0, 'quoted'], [50, 'armed']),
    ])
    expect(summary.endToEnd).toMatchObject({ n: 2, max: 90 })
  })

  it('contributes nothing from a swap with a single event', () => {
    // A quote nobody took has a start and no phases. Counted as a zero it drags
    // every p50 toward zero and hides a slow phase behind swaps that never ran.
    const summary = summariseLatency([...track('a', [0, 'quoted']), ...track('b', [0, 'quoted'], [30, 'armed'])])
    expect(summary.swaps).toBe(2)
    expect(summary.steps[0]).toMatchObject({ n: 1, p50: 30 })
    expect(summary.endToEnd?.n).toBe(1)
  })

  it('answers empty input without inventing a summary', () => {
    expect(summariseLatency([])).toEqual({ swaps: 0, steps: [], endToEnd: null })
  })
})
