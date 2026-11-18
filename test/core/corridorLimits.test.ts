/**
 * The layering rule for per-corridor amount ranges.
 *
 * Driven through `loadConfig` rather than the pure helper because the layering
 * is what is being tested, and only `loadConfig` applies all three layers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { configFromKnobs } from '@arkade-os/solver-app/config.js'
import { CORRIDORS } from '@arkade-os/solver-core/core/corridorPolicy.js'
import { descriptorFor } from '@arkade-os/solver-corridors/corridors/index.js'

const STEMS = CORRIDORS.map((c) => descriptorFor(c).envStem)
const CONFIG_KEYS = [
  'SWAP_NETWORK',
  'WALLET_MNEMONIC',
  'ARKADE_OPERATOR_URL',
  'EMULATOR_URL',
  'LN_BACKEND',
  'MAX_SWAP_SATS',
  'MAX_EXPOSED_SATS',
  ...STEMS.flatMap((s) => [`${s}_MIN_SATS`, `${s}_MAX_SATS`]),
]

const BASE_ENV: Record<string, string> = {
  SWAP_NETWORK: 'regtest',
  WALLET_MNEMONIC: 'test mnemonic, never a real one',
  ARKADE_OPERATOR_URL: 'http://localhost:7070',
  EMULATOR_URL: 'http://localhost:7073',
  // Required: the three corridors are enabled here, and each takes both its legs
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
    const config = configFromKnobs(process.env)
    for (const corridor of CORRIDORS) {
      expect(config.corridorLimits[corridor]).toEqual(config.limits)
    }
  })

  it('narrows one corridor without touching the other two', () => {
    process.env.ONCHAIN_SEND_MAX_SATS = '5000'
    const config = configFromKnobs(process.env)
    expect(config.corridorLimits['arkade:BTC->onchain:BTC'].maxSats).toBe(5000)
    for (const corridor of CORRIDORS) {
      if (corridor === 'arkade:BTC->onchain:BTC') continue
      expect(config.corridorLimits[corridor]).toEqual(config.limits)
    }
  })

  it('raises a corridor floor without raising the others', () => {
    process.env.ONCHAIN_SEND_MIN_SATS = '50000'
    const config = configFromKnobs(process.env)
    expect(config.corridorLimits['arkade:BTC->onchain:BTC'].minSats).toBe(50000)
    expect(config.corridorLimits['lightning:BTC->arkade:BTC'].minSats).toBe(config.limits.minSats)
  })

  it('lets a corridor set a range past the deployment cap and the network default, as the console can', () => {
    process.env.MAX_SWAP_SATS = '10000'
    process.env.LN_SEND_MAX_SATS = '9000000'
    process.env.LN_RECEIVE_MIN_SATS = '100'
    const config = configFromKnobs(process.env)
    expect(config.limits.maxSats).toBe(10000)
    expect(config.corridorLimits['arkade:BTC->lightning:BTC'].maxSats).toBe(9_000_000)
    expect(config.corridorLimits['lightning:BTC->arkade:BTC'].minSats).toBe(100)
  })

  it('lets MAX_SWAP_SATS raise the deployment past the network default, for every corridor that sets none', () => {
    process.env.MAX_SWAP_SATS = '5000000'
    const config = configFromKnobs(process.env)
    expect(config.limits.maxSats).toBe(5_000_000)
    for (const corridor of CORRIDORS) expect(config.corridorLimits[corridor].maxSats).toBe(5_000_000)
  })

  it('refuses a corridor floor above its own ceiling instead of quoting an empty range', () => {
    process.env.LN_RECEIVE_MIN_SATS = '900000'
    process.env.LN_RECEIVE_MAX_SATS = '1000'
    expect(() => configFromKnobs(process.env)).toThrow(/LN_RECEIVE/)
  })

  it('rejects a non-integer knob rather than absorbing it', () => {
    process.env.ONCHAIN_SEND_MAX_SATS = '1e3x'
    expect(() => configFromKnobs(process.env)).toThrow(/ONCHAIN_SEND_MAX_SATS/)
  })

  it('treats a set-but-empty knob as unset', () => {
    process.env.LN_SEND_MAX_SATS = '   '
    const config = configFromKnobs(process.env)
    expect(config.corridorLimits['arkade:BTC->lightning:BTC']).toEqual(config.limits)
  })
})
