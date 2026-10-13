/**
 * The periodic "what do we hold" message: every fund source's own figures, the
 * float's assets and the committed total, side by side and never summed — two
 * sources' figures can be the same sats seen twice. @see fundSources.ts
 */

import { formatSats } from '@arkade-os/solver-core/core/businessEvent.js'
import { attempt } from './attempt.js'
import type { FundBalance, FundFigure, FundSource } from './fundSources.js'
import type { ConsoleAsset } from '../admin/assets.js'

type Read<T> = Awaited<ReturnType<typeof attempt<T>>>

export interface BalanceReport {
  network: string
  sources: Array<{ label: string; balance: Read<FundBalance> }>
  assets: Read<ConsoleAsset[]>
  committedSats: Read<number>
}

export interface BalanceReportInput {
  network: string
  sources: readonly FundSource[]
  readAssets(): Promise<ConsoleAsset[]>
  readCommittedSats(): Promise<number>
}

export const readBalanceReport = async (input: BalanceReportInput): Promise<BalanceReport> => {
  const [sources, assets, committedSats] = await Promise.all([
    Promise.all(input.sources.map(async (s) => ({ label: s.label, balance: await attempt(() => s.readBalance()) }))),
    attempt(input.readAssets),
    attempt(input.readCommittedSats),
  ])
  return { network: input.network, sources, assets, committedSats }
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
  return lines.join('\n')
}
