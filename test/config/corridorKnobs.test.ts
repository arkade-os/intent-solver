/**
 * What `loadConfig` makes of the per-corridor env knobs.
 *
 * Written as a characterisation test ahead of moving the env stems onto the
 * corridor descriptors: the three readers (`corridorLimitsFromEnv`,
 * `corridorFeesFromEnv`, `corridorEnabledFromEnv`) currently walk `CORRIDORS`
 * and look each stem up in `CORRIDOR_ENV_STEM`, and they are about to walk the
 * descriptors instead. Nothing observable may change.
 *
 * The fee and enablement knobs had no coverage through `loadConfig` at all —
 * `_FEE_BPS` appeared in tests only as an admin override STRING, which is a
 * different code path. Both decide money: a stem that silently stopped
 * resolving would price every swap at zero, or dark a corridor an operator
 * believes is live, and either would typecheck.
 *
 * Stems are spelled out rather than imported from `CORRIDOR_ENV_STEM`. A test
 * that derives the name from the table under test cannot notice the table
 * changing — the literal is the point.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadConfig } from '../../src/config.js'

const BASE_ENV: Record<string, string> = {
  SWAP_NETWORK: 'regtest',
  ARK_MNEMONIC: 'test mnemonic, never a real one',
  ARK_SERVER_URL: 'http://localhost:7070',
  EMULATOR_URL: 'http://localhost:7073',
  // Required rather than defaulted: every BTC corridor takes both its legs from
  // the rail, so `loadConfig` refuses an unset value while any of the four is
  // enabled — and enabled is exactly what this file exercises.
  LN_BACKEND: 'fake',
}

const STEMS = ['LN_SEND', 'LN_RECEIVE', 'ONCHAIN_SEND', 'ONCHAIN_RECEIVE'] as const
const SUFFIXES = ['MIN_SATS', 'MAX_SATS', 'FEE_BPS', 'FEE_FLAT_SATS', 'ENABLED'] as const

const KNOB_KEYS = STEMS.flatMap((stem) => SUFFIXES.map((suffix) => `${stem}_${suffix}`))
const ALL_KEYS = [...Object.keys(BASE_ENV), ...KNOB_KEYS, 'MAX_EXPOSED_SATS', 'DB_DIR', 'SWAP_DB_PATH']

/** Stem -> the pair it configures. The mapping this refactor must preserve. */
const PAIR_OF = {
  LN_SEND: 'arkade:BTC->lightning:BTC',
  LN_RECEIVE: 'lightning:BTC->arkade:BTC',
  ONCHAIN_SEND: 'arkade:BTC->onchain:BTC',
  ONCHAIN_RECEIVE: 'onchain:BTC->arkade:BTC',
} as const

let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(ALL_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ALL_KEYS) delete process.env[key]
  Object.assign(process.env, BASE_ENV)
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('per-corridor fee knobs', () => {
  it('charges nothing on every corridor when nothing is set', () => {
    const { corridorFees } = loadConfig()
    for (const pair of Object.values(PAIR_OF)) {
      expect({ pair, fee: corridorFees[pair] }).toEqual({ pair, fee: { bps: 0, flatSats: 0 } })
    }
  })

  it.each(STEMS)('reads %s_FEE_BPS and _FEE_FLAT_SATS onto that corridor alone', (stem) => {
    process.env[`${stem}_FEE_BPS`] = '25'
    process.env[`${stem}_FEE_FLAT_SATS`] = '110'
    const { corridorFees } = loadConfig()
    expect(corridorFees[PAIR_OF[stem]]).toEqual({ bps: 25, flatSats: 110 })
    for (const other of STEMS) {
      if (other === stem) continue
      expect({ other, fee: corridorFees[PAIR_OF[other]] }).toEqual({ other, fee: { bps: 0, flatSats: 0 } })
    }
  })

  it('refuses a spread at or above 100%', () => {
    process.env.LN_SEND_FEE_BPS = '10000'
    expect(() => loadConfig()).toThrow(/LN_SEND_FEE_BPS must be an integer between 0 and 9999/)
  })

  it('refuses a negative flat fee', () => {
    process.env.ONCHAIN_SEND_FEE_FLAT_SATS = '-1'
    expect(() => loadConfig()).toThrow(/ONCHAIN_SEND_FEE_FLAT_SATS must be an integer between 0 and 1000000/)
  })
})

describe('per-corridor enablement', () => {
  it('serves every corridor when nothing is set', () => {
    const { corridorEnabled } = loadConfig()
    for (const pair of Object.values(PAIR_OF)) expect({ pair, on: corridorEnabled[pair] }).toEqual({ pair, on: true })
  })

  it.each(STEMS)('darks only %s when its _ENABLED is false', (stem) => {
    process.env[`${stem}_ENABLED`] = 'false'
    const { corridorEnabled } = loadConfig()
    expect(corridorEnabled[PAIR_OF[stem]]).toBe(false)
    for (const other of STEMS) {
      if (other === stem) continue
      expect({ other, on: corridorEnabled[PAIR_OF[other]] }).toEqual({ other, on: true })
    }
  })

  /**
   * Only the exact strings are accepted. A typo'd `FALSE` silently meaning "on"
   * would leave a corridor quoting that an operator believes is dark — and this
   * knob exists precisely for the case where that corridor loses money.
   */
  it.each(['FALSE', '0', 'no', 'off'])('refuses %s rather than reading it as on', (raw) => {
    process.env.LN_RECEIVE_ENABLED = raw
    expect(() => loadConfig()).toThrow(/LN_RECEIVE_ENABLED must be 'true' or 'false'/)
  })
})

describe('per-corridor amount bounds', () => {
  it.each(STEMS)('narrows %s_MAX_SATS onto that corridor alone', (stem) => {
    process.env[`${stem}_MIN_SATS`] = '2000'
    process.env[`${stem}_MAX_SATS`] = '30000'
    const { corridorLimits } = loadConfig()
    expect(corridorLimits[PAIR_OF[stem]]).toEqual({ minSats: 2000, maxSats: 30000 })
  })

  it('refuses a zero bound, which would be a corridor nobody can use', () => {
    process.env.ONCHAIN_RECEIVE_MIN_SATS = '0'
    expect(() => loadConfig()).toThrow(/ONCHAIN_RECEIVE_MIN_SATS must be a positive integer/)
  })
})
