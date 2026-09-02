/**
 * `<CORRIDOR>_ENABLED`, and the strictness of it.
 *
 * A corridor that is not served should be REFUSED up front — quoted and then
 * failed per swap is strictly worse (the client has already committed by
 * then). The knob is what lets a deployment say so: `LN_SEND_ENABLED=false`
 * and friends, all defaulting on so a deployment that sets nothing behaves
 * exactly as before.
 *
 * It exists for the case where a corridor costs the operator money on every
 * swap, so the expensive mistake is a value that LOOKS like "off" and parses
 * as "on" — an operator who wrote `FALSE` and believed the corridor was dark
 * would keep quoting it and never see a reason to look. Only the exact strings
 * are accepted; everything else throws at startup, where it is loud.
 *
 * Driven through `loadConfig` for the same reason corridorLimits.test.ts is:
 * the env parsing IS the thing being tested.
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
  ...STEMS.map((s) => `${s}_ENABLED`),
]

const BASE_ENV: Record<string, string> = {
  SWAP_NETWORK: 'regtest',
  ARK_MNEMONIC: 'test mnemonic, never a real one',
  ARK_SERVER_URL: 'http://localhost:7070',
  EMULATOR_URL: 'http://localhost:7073',
  // Kept set even where every corridor is disabled below: that is the one
  // combination in which `loadConfig` would ALSO accept no rail, and this file
  // is about the enablement knob rather than about the rail.
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

describe('corridorEnabled', () => {
  it('serves every corridor when nothing is set', () => {
    const config = loadConfig()
    for (const corridor of CORRIDORS) expect(config.corridorEnabled[corridor]).toBe(true)
  })

  it('switches one corridor off without touching the other three', () => {
    process.env.ONCHAIN_RECEIVE_ENABLED = 'false'
    const config = loadConfig()
    expect(config.corridorEnabled['onchain:BTC->arkade:BTC']).toBe(false)
    for (const corridor of CORRIDORS) {
      if (corridor === 'onchain:BTC->arkade:BTC') continue
      expect(config.corridorEnabled[corridor]).toBe(true)
    }
  })

  it('accepts an explicit true', () => {
    process.env.LN_SEND_ENABLED = 'true'
    expect(loadConfig().corridorEnabled['arkade:BTC->lightning:BTC']).toBe(true)
  })

  it('can leave a Lightning-only deployment', () => {
    process.env.ONCHAIN_SEND_ENABLED = 'false'
    process.env.ONCHAIN_RECEIVE_ENABLED = 'false'
    const config = loadConfig()
    expect(config.corridorEnabled['arkade:BTC->lightning:BTC']).toBe(true)
    expect(config.corridorEnabled['lightning:BTC->arkade:BTC']).toBe(true)
    expect(config.corridorEnabled['arkade:BTC->onchain:BTC']).toBe(false)
    expect(config.corridorEnabled['onchain:BTC->arkade:BTC']).toBe(false)
  })

  it('can switch every corridor off — a solver that quotes nothing is a legal state', () => {
    for (const stem of STEMS) process.env[`${stem}_ENABLED`] = 'false'
    const config = loadConfig()
    for (const corridor of CORRIDORS) expect(config.corridorEnabled[corridor]).toBe(false)
  })

  it.each(['FALSE', 'False', '0', 'no', 'off', 'disabled'])('REFUSES %s rather than reading it as on', (value) => {
    process.env.LN_SEND_ENABLED = value
    expect(() => loadConfig()).toThrow(/LN_SEND_ENABLED/)
  })

  it('treats a set-but-empty value as unset', () => {
    process.env.LN_SEND_ENABLED = '   '
    expect(loadConfig().corridorEnabled['arkade:BTC->lightning:BTC']).toBe(true)
  })
})
