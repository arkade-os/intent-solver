/**
 * Strict where `applyOverrides` is forgiving: that boot path skips an invalid
 * override and reverts a crossed range to the environment's, so a preview built
 * on it could show a price for a value the draft never set.
 */
import type { Config } from '../config.js'
import { CORRIDORS } from '@arkade-os/solver-core/core/corridorPolicy.js'
import { descriptorFor } from '@arkade-os/solver-corridors/corridors/index.js'
import { applyOverrides, validateOverride } from './settings.js'

export interface DraftRefusal {
  key: string
  reason: string
}

export type DraftPolicy = { ok: true; config: Config } | { ok: false; invalid: readonly DraftRefusal[] }

export const resolveDraftPolicy = (config: Config, draft: Record<string, string>): DraftPolicy => {
  const invalid: DraftRefusal[] = []
  for (const [key, value] of Object.entries(draft)) {
    try {
      validateOverride(config, key, value)
    } catch (error) {
      invalid.push({ key, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  for (const corridor of CORRIDORS) {
    const stem = descriptorFor(corridor).envStem
    const minKey = `${stem}_MIN_SATS`
    const maxKey = `${stem}_MAX_SATS`
    if (draft[minKey] === undefined && draft[maxKey] === undefined) continue
    // The draft's own numbers, not `applyOverrides`' output — that reverts a
    // crossed pair to the environment's, hiding the range being edited.
    const minSats = draft[minKey] === undefined ? config.corridorLimits[corridor].minSats : Number(draft[minKey])
    const maxSats = draft[maxKey] === undefined ? config.corridorLimits[corridor].maxSats : Number(draft[maxKey])
    if (Number.isFinite(minSats) && Number.isFinite(maxSats) && minSats > maxSats) {
      const reason = `${minKey} ${minSats} exceeds ${maxKey} ${maxSats}; this corridor would admit no amount`
      invalid.push({ key: minKey, reason }, { key: maxKey, reason })
    }
  }

  if (invalid.length > 0) return { ok: false, invalid }
  return { ok: true, config: applyOverrides(config, draft) }
}
