/**
 * The `pnl` command's output.
 *
 * No command body in this tree is unit-tested, and for a shell that only wires
 * I/O together that is a fine convention — but this one FORMATS MONEY, and a
 * report that prints a gross figure under a `net` heading is the same defect
 * the screen spends three paragraphs guarding against. The rendering was split
 * into a pure function so these assertions are possible at all.
 */
import { describe, it, expect } from 'vitest'
import { pnlReportLines, PNL_WINDOWS } from '@arkade-os/solver-app/ops/pnlReport.js'
import { economicsOf } from '@arkade-os/solver-core/analytics/economics.js'

const T0 = 1_000 * 3_600
const sats = (amount: number) => ({ assetId: null, amount: String(amount), decimals: 8 })

const swap = (over: { id: string; give: number; spread: number; cost?: number; corridor?: string }) =>
  economicsOf({
    id: over.id,
    corridor: over.corridor ?? 'arkade:BTC->lightning:BTC',
    state: 'claimed',
    phase: 'done',
    quotedAt: T0 - 30,
    settledAt: T0,
    inbound: sats(over.give),
    outbound: sats(over.give - over.spread),
    ...(over.cost === undefined ? {} : { realizedCostSats: over.cost }),
  })

const report = (records: ReturnType<typeof swap>[], over: Partial<Parameters<typeof pnlReportLines>[0]> = {}) =>
  pnlReportLines({
    records,
    label: '7d',
    since: T0 - 604_800,
    until: T0 + 60,
    unmeasured: [],
    failed: [],
    truncated: [],
    ...over,
  }).join('\n')

describe('the headline', () => {
  it('prints gross with its sign and the count it covers', () => {
    expect(report([swap({ id: 'a', give: 100_300, spread: 300 })])).toMatch(/gross\s+\+300 sats over 1 priced/)
  })

  it('prints a LOSS with a minus rather than as a bare number', () => {
    expect(report([swap({ id: 'a', give: 99_000, spread: -1_000 })])).toMatch(/gross\s+-1,000 sats/)
  })

  /**
   * The misreading this report must not produce. With no cost reported there is
   * no net, and printing the gross under a `net` heading would be exactly the
   * gross-read-as-net confusion the whole feature is built to prevent.
   */
  it('says net is UNKNOWN when no rail reported a cost, rather than repeating the gross', () => {
    const out = report([swap({ id: 'a', give: 100_300, spread: 300 })])
    expect(out).toMatch(/net\s+unknown - no rail in this window reported an execution cost/)
    expect(out).not.toMatch(/net\s+\+300/)
  })

  it('dashes the gross on an empty book rather than reporting a zero it did not measure', () => {
    expect(report([])).toMatch(/gross\s+- nothing in this window carried a price/)
  })

  /**
   * The net margin was computed and rendered nowhere, so the only bp on screen
   * was the GROSS one — sitting beside a net figure it does not describe.
   */
  it('prints the net margin beside the net figure', () => {
    const out = report([swap({ id: 'a', give: 100_300, spread: 300, cost: 100 })])
    expect(out).toMatch(/net\s+\+200 sats after 100 cost, over 1 of 1 priced, [+-]\d+bp/)
  })

  it('nets once a cost exists, and says over how much of the book', () => {
    const out = report([
      swap({ id: 'a', give: 100_300, spread: 300, cost: 100 }),
      swap({ id: 'b', give: 100_600, spread: 600, corridor: 'arkade:BTC->onchain:BTC' }),
    ])
    expect(out).toMatch(/net\s+\+200 sats after 100 cost, over 1 of 2 priced/)
  })
})

describe('coverage is stated, never assumed', () => {
  it('names an unmeasured corridor rather than averaging it in at nothing', () => {
    expect(report([], { unmeasured: ['arkade:BTC->mute:BTC'] })).toContain('unmeasured arkade:BTC->mute:BTC')
  })

  /**
   * A corridor that claimed to answer and threw is an incident, not a gap — and
   * it must not take the rest of the book down with it, which is what an
   * uncaught `economics()` did to the whole command.
   */
  it('names a broken corridor as a fault and still prints every other corridor', () => {
    const out = report([swap({ id: 'a', give: 100_300, spread: 300 })], {
      failed: [{ corridor: 'arkade:BTC->onchain:BTC', reason: 'database is locked' }],
    })
    expect(out).toContain('! arkade:BTC->onchain:BTC: FAILED to report - database is locked')
    expect(out).toMatch(/gross\s+\+300 sats/)
    expect(out).not.toContain('unmeasured arkade:BTC->onchain:BTC')
  })

  it('warns when a corridor had more rows than were read', () => {
    expect(report([], { truncated: ['arkade:BTC->lightning:BTC'] })).toContain(
      '! arkade:BTC->lightning:BTC: more rows in this window than were read',
    )
  })

  it('closes with the basis, so the last thing read is what the numbers mean', () => {
    const lines = report([swap({ id: 'a', give: 100_300, spread: 300 })]).split('\n')
    expect(lines[lines.length - 1]).toBe(
      'Execution cost is deducted only where a rail reported one; everything else is gross.',
    )
  })
})

describe('the corridor table', () => {
  it('dashes a corridor that cannot be netted rather than printing its gross again', () => {
    const line = report([swap({ id: 'a', give: 100_600, spread: 600, corridor: 'arkade:BTC->onchain:BTC' })])
      .split('\n')
      .find((l) => l.includes('arkade:BTC->onchain:BTC'))!
    // Gross, then its OWN margin, then the two net columns with nothing to show.
    expect(line).toMatch(/\+600\s+[+-]\d+bp\s+-\s+-\s/)
  })

  it('prints both figures where the corridor reported a cost', () => {
    const line = report([swap({ id: 'a', give: 100_300, spread: 300, cost: 100 })])
      .split('\n')
      .find((l) => l.includes('arkade:BTC->lightning:BTC'))!
    expect(line).toMatch(/\+300/)
    expect(line).toMatch(/\+200/)
  })
})

describe('the duration bands', () => {
  it('always prints every band, so the shape does not move between runs', () => {
    const out = report([swap({ id: 'a', give: 100_300, spread: 300 })])
    for (const band of ['<1m', '1–5m', '5–30m', '30m–2h', '>2h']) expect(out).toContain(band)
  })
})

describe('the accepted windows', () => {
  it('offers the same presets the screen does', () => {
    expect(Object.keys(PNL_WINDOWS)).toEqual(['1h', '24h', '7d', '30d', '90d'])
  })
})
