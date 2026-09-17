/**
 * Types for `charts.js`, which is browser JavaScript and stays that way — the
 * console has no build step, so its client cannot be TypeScript.
 *
 * This file exists because the chart module is IMPORTED BY A TEST, unlike
 * `app.js`, which is only ever read as source. `pnpm build` was happy without
 * it and `pnpm typecheck` was not, which is the split `AGENTS.md` § Gates
 * describes: an untyped import is invisible to one and an error to the other.
 *
 * It is also the module's stated contract. A chart takes the shape the admin
 * API already answers with — `SeriesPoint`, `FxPoint` — so a change to
 * `analytics/aggregate.ts` that these no longer match is a compile error rather
 * than an empty panel.
 */

/** Whatever the host document builds. Narrowed nowhere: nothing here reads it back. */
export interface ChartNode {
  appendChild(child: ChartNode): ChartNode
}

export interface SeriesPointLike {
  at: number
  count: number
  grossSats: number
  cumulativeGrossSats: number
  atRiskSats: number
}

export interface FxPointLike {
  id: string
  at: number
  durationSeconds: number
  rate: number
  driftBps: number | null
}

export interface ChartSize {
  width?: number
  height?: number
  /**
   * The chart's `aria-label`. Supplied by the caller because a chart does not
   * know what it is plotting — `categoryChart` serves both sats of gross and
   * basis points of margin, and a hardcoded label announces one of them wrongly.
   */
  title?: string
}

export declare const cumulativeChart: (
  points: readonly SeriesPointLike[],
  options?: ChartSize & { value?: (point: SeriesPointLike) => number },
) => ChartNode

export declare const barsChart: (points: readonly SeriesPointLike[], options?: ChartSize) => ChartNode

export declare const categoryChart: <Row>(
  rows: readonly Row[],
  options: {
    width?: number
    rowHeight?: number
    title?: string
    label: (row: Row) => string
    value: (row: Row) => number
    note?: (row: Row) => string
  },
) => ChartNode

export declare const decayChart: (points: readonly FxPointLike[], options?: ChartSize) => ChartNode
