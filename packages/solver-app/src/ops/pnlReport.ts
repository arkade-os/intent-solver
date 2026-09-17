/**
 * The book as lines of text — the `pnl` command's whole output, as a pure
 * function.
 *
 * Split out from `cli.ts` so it can be asserted. The commands map is not
 * exported and no command body in this tree is unit-tested, which is a fine
 * convention for a shell that only wires I/O together — but this one FORMATS
 * money, and a report that silently prints a gross figure under a `net` heading
 * is the same defect the screen spends three paragraphs guarding against. The
 * command keeps the I/O; the judgement lives here where a test can reach it.
 *
 * Every rule the console follows holds here, for the same reasons: a missing
 * number prints as `-` and never as `0`, a net figure appears only over the rows
 * that actually reported a cost, and an unmeasured corridor is named rather than
 * averaged in at nothing.
 */
import { byCorridor, byDuration, byFxLeg, summarise } from '@arkade-os/solver-core/analytics/aggregate.js'
import type { SwapEconomics } from '@arkade-os/solver-core/analytics/economics.js'

/**
 * Windows the command accepts, mirroring the admin route's presets.
 *
 * A short closed list rather than a duration parser: this exists for a glance
 * from a terminal, and every preset is one the screen already offers, so the
 * two cannot end up answering different questions.
 */
export const PNL_WINDOWS: Record<string, number> = {
  '1h': 3_600,
  '24h': 86_400,
  '7d': 604_800,
  '30d': 2_592_000,
  '90d': 7_776_000,
}

/** A sats figure that always carries its sign, so a loss is never read as a gain. */
const signed = (value: number | null): string =>
  value === null ? '?' : `${value >= 0 ? '+' : '-'}${Math.abs(value).toLocaleString('en-US')}`

/** Basis points, or a dash where there was nothing to measure — never a zero. */
const bps = (value: number | null): string => (value === null ? '-' : `${value >= 0 ? '+' : '-'}${Math.abs(value)}bp`)

export interface PnlReportInput {
  records: readonly SwapEconomics[]
  /** The window's own name, as the caller asked for it. */
  label: string
  since: number
  until: number
  /** Corridors with no `economics` capability — named, never counted as zero. */
  unmeasured: readonly string[]
  /** Corridors whose window overflowed the row cap. */
  truncated: readonly string[]
}

export const pnlReportLines = (input: PnlReportInput): string[] => {
  const { records, label, since, until, unmeasured, truncated } = input
  const summary = summarise(records, since, until)
  const lines: string[] = []

  for (const corridor of truncated) lines.push(`! ${corridor}: more rows in this window than were read`)

  lines.push(`window   last ${label} (${summary.count} rows)`)
  lines.push(`settled  ${summary.realizedCount}, ${summary.failedCount} failed, ${summary.openCount} still open`)
  lines.push(`gross    ${signed(summary.grossSats)} sats over ${summary.pricedCount} priced, ${bps(summary.marginBps)}`)
  // Never a fallback to the gross. A net figure derived from a missing cost is
  // the gross wearing a different label, which is the one misreading this
  // report must not produce.
  lines.push(
    summary.costedCount === 0
      ? 'net      unknown - no rail in this window reported an execution cost'
      : `net      ${signed(summary.netSats)} sats after ${summary.realizedCostSats.toLocaleString('en-US')} cost, ` +
          `over ${summary.costedCount} of ${summary.pricedCount} priced`,
  )
  if (summary.atRiskSats > 0 || summary.atRiskUnknownCount > 0) {
    lines.push(
      `at risk  ${summary.atRiskUpperBound ? '<=' : ''}${summary.atRiskSats.toLocaleString('en-US')} sats` +
        (summary.atRiskUnknownCount > 0 ? `, ${summary.atRiskUnknownCount} more not priceable in sats` : ''),
    )
  }
  if (unmeasured.length > 0) lines.push(`unmeasured ${unmeasured.join(', ')}`)

  const corridors = byCorridor(records)
  if (corridors.length > 0) {
    lines.push('')
    lines.push(
      `  ${'corridor'.padEnd(34)}${'gross'.padStart(12)}${'net'.padStart(12)}` +
        `${'margin'.padStart(9)}${'settled'.padStart(9)}`,
    )
    for (const row of corridors) {
      lines.push(
        `  ${row.corridor.padEnd(34)}` +
          `${(row.pricedCount === 0 ? '-' : signed(row.grossSats)).padStart(12)}` +
          `${(row.costedCount === 0 ? '-' : signed(row.netSats)).padStart(12)}` +
          `${bps(row.marginBps).padStart(9)}${String(row.realizedCount).padStart(9)}`,
      )
    }
  }

  lines.push('')
  lines.push('  margin by time to fill - a quote holds a price while the market moves')
  for (const band of byDuration(records)) {
    lines.push(`  ${band.label.padEnd(10)}${String(band.count).padStart(6)} swaps${bps(band.marginBps).padStart(10)}`)
  }

  for (const leg of byFxLeg(records)) {
    lines.push('')
    lines.push(`  ${leg.leg} on ${leg.corridor} - ${leg.count} fill(s)`)
    lines.push(
      leg.medianMarketDriftBps === null
        ? '    no market mark: these fills carry no quote-time feed price'
        : `    median fill priced ${bps(leg.medianMarketDriftBps)} against the market feed at quote time`,
    )
  }

  lines.push('')
  lines.push('Execution cost is deducted only where a rail reported one; everything else is gross.')
  return lines
}
