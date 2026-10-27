/**
 * The periodic "what do we hold" message: every fund source's own figures, the
 * float's assets and the committed total, side by side and never summed — two
 * sources' figures can be the same sats seen twice. @see fundSources.ts
 */

import { formatSats } from '@arkade-os/solver-core/core/businessEvent.js'
import { attempt } from './attempt.js'
import type { FundBalance, FundFigure, FundSource } from './fundSources.js'
import type { ConsoleAsset } from '../admin/assets.js'
import { formatSwapSummary, type SwapSummary } from './swapSummary.js'
import { createJoin, within } from './guardedRead.js'
import { checkpointChanges, formatBalanceChange, type BalanceCheckpointReport } from './balanceCheckpoints.js'
import { limitNotification } from './notify.js'

type Read<T> = Awaited<ReturnType<typeof attempt<T>>>

export interface BalanceReport {
  network: string
  sources: Array<{ label: string; balance: Read<FundBalance> }>
  assets: Read<ConsoleAsset[]>
  committedSats: Read<number>
  swaps?: Read<SwapSummary>
  checkpoint?: Read<BalanceCheckpointReport>
}

export interface BalanceReportInput {
  network: string
  sources: readonly FundSource[]
  readAssets(): Promise<ConsoleAsset[]>
  readCommittedSats(): Promise<number>
  readSwaps?(): Promise<SwapSummary>
  readCheckpoint?(): Promise<BalanceCheckpointReport>
  deadlineMs?: number
}

// Above the LND adapter's own 30s read deadline, so its more specific error wins where it has one.
const READ_DEADLINE_MS = 60_000

/** The deadline ends a report, not its reads: one still running is joined by the next report, never repeated. */
export const createBalanceReportReader = (): ((input: BalanceReportInput) => Promise<BalanceReport>) => {
  const joined = createJoin()
  return async (input) => {
    const ms = input.deadlineMs ?? READ_DEADLINE_MS
    const guarded = <T>(key: string, read: () => Promise<T>) => attempt(within(joined(key, read), ms))
    const { readSwaps, readCheckpoint } = input
    const [sources, assets, committedSats, swaps, checkpoint] = await Promise.all([
      Promise.all(
        input.sources.map(async (s) => ({
          label: s.label,
          balance: await guarded(`source:${s.id}`, () => s.readBalance()),
        })),
      ),
      guarded('assets', () => input.readAssets()),
      guarded('committed', () => input.readCommittedSats()),
      readSwaps ? guarded('swaps', () => readSwaps()) : undefined,
      readCheckpoint ? guarded('checkpoint', readCheckpoint) : undefined,
    ])
    return {
      network: input.network,
      sources,
      assets,
      committedSats,
      ...(swaps ? { swaps } : {}),
      ...(checkpoint ? { checkpoint } : {}),
    }
  }
}

const amountOf = (unit: string, amount: string): string => {
  const sats = Number(amount)
  return unit === 'sats' && Number.isSafeInteger(sats) ? formatSats(sats) : amount
}

// A null amount is a failed read or a caveat like a shared pool, so its note IS the content.
const figure = (unit: string, f: FundFigure): string =>
  f.amount === null ? `${f.label}: ${f.note ?? 'unread'}` : `${f.label} ${amountOf(unit, f.amount)}`

const unreadable = (label: string, error: string): string => `${label}: unreadable (${error})`

export const formatBalanceReport = (report: BalanceReport): string => {
  const lines = [`Balance report — ${report.network}`]
  const { checkpoint } = report
  if (checkpoint) {
    if (checkpoint.error !== null) lines.push(unreadable('balance change', checkpoint.error))
    else {
      const { current, previous } = checkpoint.value
      if (!current) lines.push('Balance change: awaiting the first checkpoint.')
      else if (current.totalSats === null)
        lines.push('Balance change: latest checkpoint incomplete; previous report baseline retained.')
      else if (!previous) lines.push('Balance change: first complete report; baseline established.')
      else if (current.id <= previous.id)
        lines.push('Balance change: no newer checkpoint; previous report baseline retained.')
      else {
        const changes = checkpointChanges(previous, current)
        if (changes === null) lines.push('Balance change: no comparable report baseline.')
        else {
          lines.push(
            `Balance change since ${new Date(previous.finishedAt * 1000).toISOString()} (checkpoint at ${new Date(current.finishedAt * 1000).toISOString()}):`,
          )
          lines.push(...changes.filter(({ asset, delta }) => asset === 'BTC' || delta !== '0').map(formatBalanceChange))
        }
      }
    }
  }
  for (const { label, balance } of report.sources) {
    lines.push(
      balance.error !== null
        ? unreadable(label, balance.error)
        : `${label} (${balance.value.unit}): ${balance.value.figures.map((f) => figure(balance.value.unit, f)).join(' · ')}`,
    )
  }
  const { assets, committedSats } = report
  if (assets.error !== null) lines.push(unreadable('arkade assets', assets.error))
  else if (assets.value.length > 0) {
    lines.push(
      `arkade assets (base units): ${assets.value.map((a) => `${a.ticker ?? a.shortId} ${a.amount}`).join(' · ')}`,
    )
  }
  lines.push(
    committedSats.error !== null
      ? unreadable('committed to live swaps', committedSats.error)
      : `committed to live swaps: ${formatSats(committedSats.value)} sats`,
  )
  const { swaps } = report
  if (swaps) lines.push(...(swaps.error !== null ? [unreadable('swaps', swaps.error)] : formatSwapSummary(swaps.value)))
  return limitNotification(lines.join('\n'))
}
