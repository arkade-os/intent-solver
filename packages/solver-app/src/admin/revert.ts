/**
 * Putting the console's own state back to what the config file implies.
 *
 * The config is the one this process booted with, never a re-read of the file:
 * a file edited since boot would otherwise be half applied, its market serving
 * live and its corridor terms waiting for a restart.
 */
import { createHash } from 'node:crypto'
import type { Config } from '../config.js'
import { servingFor, type ServingFields } from '../ops/assetRfqMarkets.js'
import type { AdminStore, AssetMarketRow } from './db.js'
import { editableKeys, editableKnobValues, LIVE_KEYS } from './settings.js'

export type RevertScope = { scope: 'all' } | { scope: 'market'; marketKey: string }

export interface RevertChange {
  target: string
  field: string
  current: string
  config: string
  applies: 'now' | 'restart'
}

export interface RevertPlan {
  changes: RevertChange[]
  /** A digest of the state the plan was made from; an apply must present the one its preview returned. */
  basis: string
  serving: { marketKey: string; fields: ServingFields }[]
  overrideKeys: string[]
}

const SERVING_FIELDS = ['symbol', 'servesOffer', 'servesRfq', 'rfqSellBase', 'rfqBuyBase'] as const

const shown = (value: unknown): string => (value === null || value === undefined ? '(none)' : String(value))

/** Null when the scope names a market that does not exist. */
export const planRevert = async (
  scope: RevertScope,
  { config, store }: { config: Config; store: AdminStore },
): Promise<RevertPlan | null> => {
  const rows = await store.listMarkets()
  const inScope = scope.scope === 'all' ? rows : rows.filter((row) => row.marketKey === scope.marketKey)
  if (inScope.length === 0 && scope.scope === 'market') return null

  const seed = { offerMarkets: config.offerMarkets, tokens: config.assetRfqTokens }
  // One market keeps clear of the symbols every other row holds; all of them are re-derived together.
  const taken = new Set(
    scope.scope === 'all'
      ? []
      : rows.flatMap((row) => (row.marketKey !== scope.marketKey && row.symbol !== null ? [row.symbol] : [])),
  )
  const changes: RevertChange[] = []
  const serving: RevertPlan['serving'] = []
  for (const row of inScope) {
    const fields = servingFor(row, seed, taken)
    if (fields.symbol !== null) taken.add(fields.symbol)
    const moved = SERVING_FIELDS.filter((field) => row[field] !== fields[field])
    if (moved.length === 0) continue
    serving.push({ marketKey: row.marketKey, fields })
    for (const field of moved) {
      changes.push({
        target: row.symbol ?? row.marketKey,
        field,
        current: shown(row[field]),
        config: shown(fields[field]),
        applies: 'now',
      })
    }
  }

  // Only overrides of a setting the config holds: a console-only one (the rebalance policy) has nothing to revert to.
  const overrides = scope.scope === 'all' ? await store.getOverrides() : {}
  const booted = editableKnobValues(config)
  const overrideKeys = editableKeys().filter((key) => overrides[key] !== undefined)
  for (const key of overrideKeys) {
    changes.push({
      target: config.configPaths?.get(key) ?? key,
      field: 'value',
      current: overrides[key]!,
      config: shown(booted[key]),
      applies: LIVE_KEYS.has(key) ? 'now' : 'restart',
    })
  }

  const state = {
    rows: rows.map((row: AssetMarketRow) => [row.marketKey, ...SERVING_FIELDS.map((field) => row[field])]),
    overrides: overrideKeys.map((key) => [key, overrides[key]]),
  }
  const basis = createHash('sha256').update(JSON.stringify(state)).digest('hex')
  return { changes, basis, serving, overrideKeys }
}
