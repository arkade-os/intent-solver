/**
 * The realized execution cost, end to end through the analytics layer.
 *
 * This is the field the P&L screen was built without, and the reason it had to
 * shout GROSS in three places. The property under test everywhere below is that
 * a MISSING cost and a ZERO cost stay distinguishable: the first must leave
 * `netSats` null, and the second must net to the gross. Collapsing them is how
 * a gross figure comes to be read as a net one, which is the single most
 * expensive misreading this screen can produce.
 */
import { describe, it, expect } from 'vitest'
import { economicsOf } from '@arkade-os/solver-core/analytics/economics.js'
import { byCorridor, series, summarise } from '@arkade-os/solver-core/analytics/aggregate.js'

const sats = (amount: number | null) => ({
  assetId: null,
  amount: amount === null ? null : String(amount),
  decimals: 8,
})

const HOUR = 3_600
const T0 = 1_000 * HOUR

/** A delivered sats-to-sats swap, optionally with a cost the rail reported. */
const swap = (over: {
  id: string
  give: number
  spread: number
  cost?: number | null
  at?: number
  corridor?: string
  phase?: 'done' | 'failed'
}) =>
  economicsOf({
    id: over.id,
    corridor: over.corridor ?? 'arkade:BTC->lightning:BTC',
    state: over.phase === 'failed' ? 'stuck' : 'claimed',
    phase: over.phase ?? 'done',
    quotedAt: (over.at ?? T0) - 30,
    settledAt: over.at ?? T0,
    inbound: sats(over.give),
    outbound: sats(over.give - over.spread),
    realizedCostSats: over.cost ?? null,
  })

describe('a swap that reported what it cost', () => {
  it('nets the cost out of the spread', () => {
    const record = swap({ id: 'a', give: 100_300, spread: 300, cost: 120 })
    expect(record.grossSats).toBe(300)
    expect(record.realizedCostSats).toBe(120)
    expect(record.netSats).toBe(180)
  })

  it('nets to a LOSS when routing cost more than the spread', () => {
    // The case the whole feature exists to make visible: textbook spread,
    // negative trade.
    const record = swap({ id: 'a', give: 100_300, spread: 300, cost: 400 })
    expect(record.grossSats).toBe(300)
    expect(record.netSats).toBe(-100)
  })

  it('nets to the gross when the rail reported a genuinely free route', () => {
    const record = swap({ id: 'a', give: 100_300, spread: 300, cost: 0 })
    expect(record.netSats).toBe(300)
  })
})

describe('a swap whose cost nobody recorded', () => {
  it('leaves net null rather than falling back to the gross', () => {
    const record = swap({ id: 'a', give: 100_300, spread: 300 })
    expect(record.grossSats).toBe(300)
    expect(record.realizedCostSats).toBeNull()
    expect(record.netSats).toBeNull()
  })

  it('is distinguishable from a swap that cost zero', () => {
    expect(swap({ id: 'a', give: 100_300, spread: 300, cost: 0 }).netSats).toBe(300)
    expect(swap({ id: 'b', give: 100_300, spread: 300 }).netSats).toBeNull()
  })
})

describe('a cost is only meaningful on a swap that delivered', () => {
  /**
   * A cost recorded against a failed payment would be netted out of a spread
   * that was never earned — turning a refund into a loss on the screen.
   */
  it('ignores a cost on a row that did not deliver', () => {
    const record = swap({ id: 'a', give: 100_300, spread: 300, cost: 120, phase: 'failed' })
    expect(record.realizedCostSats).toBeNull()
    expect(record.netSats).toBeNull()
  })
})

describe('summarise', () => {
  it('totals the cost and nets it, over the costed rows alone', () => {
    const summary = summarise(
      [
        swap({ id: 'a', give: 100_300, spread: 300, cost: 100 }),
        swap({ id: 'b', give: 200_600, spread: 600, cost: 200 }),
      ],
      T0 - HOUR,
      T0 + HOUR,
    )
    expect(summary.grossSats).toBe(900)
    expect(summary.realizedCostSats).toBe(300)
    expect(summary.netSats).toBe(600)
    expect(summary.costedCount).toBe(2)
  })

  /**
   * THE MIXED-BOOK CASE, and the one worth getting right. Netting the whole
   * window's gross against a cost drawn from part of it overstates the margin by
   * exactly the uncosted share — here it would report 900 − 100 = 800 as though
   * it covered both swaps.
   */
  it('nets only the rows that reported a cost, never the whole window', () => {
    const summary = summarise(
      [
        swap({ id: 'costed', give: 100_300, spread: 300, cost: 100 }),
        swap({ id: 'uncosted', give: 200_600, spread: 600, corridor: 'arkade:BTC->onchain:BTC' }),
      ],
      T0 - HOUR,
      T0 + HOUR,
    )
    expect(summary.grossSats).toBe(900)
    expect(summary.netSats).toBe(200)
    expect(summary.costedCount).toBe(1)
    expect(summary.pricedCount).toBe(2)
  })

  it('answers null for net when nothing in the window reported a cost', () => {
    const summary = summarise([swap({ id: 'a', give: 100_300, spread: 300 })], T0 - HOUR, T0 + HOUR)
    expect(summary.netSats).toBeNull()
    expect(summary.realizedCostSats).toBe(0)
    expect(summary.costedCount).toBe(0)
  })

  it('weights the net margin on the costed volume, not the window volume', () => {
    const summary = summarise(
      [
        swap({ id: 'costed', give: 100_000, spread: 300, cost: 100 }),
        swap({ id: 'uncosted', give: 900_000, spread: 2_700, corridor: 'arkade:BTC->onchain:BTC' }),
      ],
      T0 - HOUR,
      T0 + HOUR,
    )
    // 200 net over the 100,000 that was costed — 20bps. Against the window's
    // whole 1,000,000 of volume it would read as 2.
    expect(summary.netMarginBps).toBe(20)
  })
})

describe('byCorridor', () => {
  it('nets each corridor against its own cost, and marks the ones that cannot', () => {
    const rows = [
      swap({ id: 'ln', give: 100_300, spread: 300, cost: 100, corridor: 'arkade:BTC->lightning:BTC' }),
      swap({ id: 'chain', give: 100_900, spread: 900, corridor: 'arkade:BTC->onchain:BTC' }),
    ]
    const breakdown = byCorridor(rows)
    const ln = breakdown.find((c) => c.corridor === 'arkade:BTC->lightning:BTC')!
    const chain = breakdown.find((c) => c.corridor === 'arkade:BTC->onchain:BTC')!
    expect(ln.netSats).toBe(200)
    expect(ln.costedCount).toBe(1)
    // No rail reported a cost here, so there is nothing to net — and reporting
    // the gross under a `net` heading is exactly the confusion to avoid.
    expect(chain.netSats).toBeNull()
    expect(chain.costedCount).toBe(0)
  })
})

describe('series', () => {
  it('carries a cumulative net that holds flat across uncosted buckets', () => {
    const points = series(
      [
        swap({ id: 'a', at: T0 + 10, give: 100_300, spread: 300, cost: 100 }),
        swap({ id: 'b', at: T0 + HOUR + 10, give: 100_200, spread: 200 }),
      ],
      { since: T0, until: T0 + 3 * HOUR, bucketSeconds: HOUR },
    )
    expect(points.map((p) => p.cumulativeGrossSats)).toEqual([300, 500, 500])
    // The second bucket reported no cost, so the net line holds rather than
    // breaking — and `costedCount` is what says the two lines are no longer
    // measuring the same set of swaps.
    expect(points.map((p) => p.cumulativeNetSats)).toEqual([200, 200, 200])
    expect(points.map((p) => p.costedCount)).toEqual([1, 0, 0])
    expect(points[1]!.netSats).toBeNull()
  })

  /**
   * An entirely uncosted window has no net result, and a flat zero line reads
   * as "we netted nothing" rather than "nobody knows" — the same collapse the
   * whole feature is built to avoid, on the one figure a reader is most likely
   * to trust at a glance.
   */
  it('keeps the cumulative net NULL until something is actually costed', () => {
    const points = series([swap({ id: 'a', at: T0 + 10, give: 100_300, spread: 300 })], {
      since: T0,
      until: T0 + 2 * HOUR,
      bucketSeconds: HOUR,
    })
    expect(points.map((p) => p.cumulativeNetSats)).toEqual([null, null])
    expect(points.map((p) => p.cumulativeGrossSats)).toEqual([300, 300])
  })

  it('stays null across the buckets BEFORE the first costed one, then carries forward', () => {
    const points = series(
      [
        swap({ id: 'early', at: T0 + 10, give: 100_300, spread: 300 }),
        swap({ id: 'costed', at: T0 + HOUR + 10, give: 100_400, spread: 400, cost: 150 }),
      ],
      { since: T0, until: T0 + 3 * HOUR, bucketSeconds: HOUR },
    )
    expect(points.map((p) => p.cumulativeNetSats)).toEqual([null, 250, 250])
  })
})
