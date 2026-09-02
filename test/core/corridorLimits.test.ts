/**
 * The layering rule for per-corridor amount ranges.
 *
 * Three layers narrow in sequence — network default, then `MAX_SWAP_SATS`,
 * then the corridor's own knob — and the whole safety argument rests on every
 * one of them being able to narrow only. If a more-specific knob could widen,
 * an operator could raise the amount at risk on one corridor past the
 * deployment-wide cap by reaching for the knob that looks more precise, which
 * is exactly the mistake a per-corridor override invites.
 *
 * Driven through `loadConfig` rather than the pure helper because the layering
 * is what is being tested, and only `loadConfig` applies all three layers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadConfig } from '@arkade-os/solver-app/config.js'
import { CORRIDORS } from '@arkade-os/solver-core/core/corridorPolicy.js'
import { descriptorFor } from '@arkade-os/solver-corridors/corridors/index.js'

const STEMS = CORRIDORS.map((c) => descriptorFor(c).envStem)
const CONFIG_KEYS = [
  'SWAP_NETWORK',
  'ARK_MNEMONIC',
  'ARK_SERVER_URL',
  'EMULATOR_URL',
  'LN_BACKEND',
  'MAX_SWAP_SATS',
  'MAX_EXPOSED_SATS',
  ...STEMS.flatMap((s) => [`${s}_MIN_SATS`, `${s}_MAX_SATS`]),
]

const BASE_ENV: Record<string, string> = {
  SWAP_NETWORK: 'regtest',
  ARK_MNEMONIC: 'test mnemonic, never a real one',
  ARK_SERVER_URL: 'http://localhost:7070',
  EMULATOR_URL: 'http://localhost:7073',
  // Required: the four corridors are enabled here, and each takes both its legs
  // from the rail, so `loadConfig` refuses an unset value.
  LN_BACKEND: 'fake',
}

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = Object.fromEntries(CONFIG_KEYS.map((key) => [key, process.env[key]]))
  for (const key of CONFIG_KEYS) delete process.env[key]
  Object.assign(process.env, BASE_ENV)
})

afterEach(() => {
  for (const key of CONFIG_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe('corridorLimits', () => {
  it('gives every corridor the deployment limits when no knob is set', () => {
    const config = loadConfig()
    for (const corridor of CORRIDORS) {
      expect(config.corridorLimits[corridor]).toEqual(config.limits)
    }
  })

  it('narrows one corridor without touching the other three', () => {
    process.env.ONCHAIN_SEND_MAX_SATS = '5000'
    const config = loadConfig()
    expect(config.corridorLimits['arkade:BTC->onchain:BTC'].maxSats).toBe(5000)
    for (const corridor of CORRIDORS) {
      if (corridor === 'arkade:BTC->onchain:BTC') continue
      expect(config.corridorLimits[corridor]).toEqual(config.limits)
    }
  })

  it('raises a corridor floor without raising the others', () => {
    process.env.ONCHAIN_RECEIVE_MIN_SATS = '50000'
    const config = loadConfig()
    expect(config.corridorLimits['onchain:BTC->arkade:BTC'].minSats).toBe(50000)
    expect(config.corridorLimits['lightning:BTC->arkade:BTC'].minSats).toBe(config.limits.minSats)
  })

  it('REFUSES to widen past the deployment cap — the whole point of the ordering', () => {
    process.env.MAX_SWAP_SATS = '10000'
    process.env.LN_SEND_MAX_SATS = '900000' // asking for more than the deployment allows
    const config = loadConfig()
    expect(config.limits.maxSats).toBe(10000)
    // Clamped to the cap, not honoured.
    expect(config.corridorLimits['arkade:BTC->lightning:BTC'].maxSats).toBe(10000)
  })

  it('refuses a corridor floor above its own ceiling instead of quoting an empty range', () => {
    process.env.LN_RECEIVE_MIN_SATS = '900000'
    process.env.LN_RECEIVE_MAX_SATS = '1000'
    expect(() => loadConfig()).toThrow(/LN_RECEIVE/)
  })

  it('rejects a non-integer knob rather than absorbing it', () => {
    process.env.ONCHAIN_SEND_MAX_SATS = '1e3x'
    expect(() => loadConfig()).toThrow(/ONCHAIN_SEND_MAX_SATS/)
  })

  it('treats a set-but-empty knob as unset', () => {
    process.env.LN_SEND_MAX_SATS = '   '
    const config = loadConfig()
    expect(config.corridorLimits['arkade:BTC->lightning:BTC']).toEqual(config.limits)
  })
})
