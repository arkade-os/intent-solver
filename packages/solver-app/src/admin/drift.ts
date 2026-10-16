// Each stored settings change the restart banner names, with what it moves
// from and to. Market CRUD is live on this process and is not a restart item.

import type { Config } from '../config.js'
import { editableKnobValues } from './settings.js'

export interface RestartItem {
  key: string
  /** What this process runs on; `stored` is the next one. */
  loaded: string
  stored: string
}

/** That key set, not a second derivation. `loaded` is BOOT policy — `Services.bootPolicy`, never the live one. */
export const settingsDrift = (loaded: Config, stored: Config, keys: readonly string[]): RestartItem[] => {
  const was = editableKnobValues(loaded)
  const now = editableKnobValues(stored)
  return keys.flatMap((key) =>
    was[key] === now[key] ? [] : [{ key, loaded: String(was[key]), stored: String(now[key]) }],
  )
}
