/**
 * What `loadConfig` makes of `<STEM>_FEE_CAP_SATS`, `<STEM>_FEE_MIN_SATS` and
 * the sampling cadence behind them.
 *
 * The first test here is the one that matters most and the only one that is not
 * about a refusal: with none of these set, every corridor's bounds must be
 * NULL, because null is what stops `createServices` handing a corridor any
 * pricing at all and so what keeps a deployment quoting the numbers it always
 * quoted. Everything else in this file guards a knob that silently does
 * nothing, which is the failure mode a fee ceiling can least afford.
 *
 * Stems are spelled out rather than derived from the descriptors, same
 * discipline as `corridorKnobs.test.ts`: a test that reads the name from the
 * table under test cannot notice the table changing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadConfig } from '@arkade-os/solver-app/config.js'

const BASE_ENV: Record<string, string> = {
  SWAP_NETWORK: 'regtest',
  ARK_MNEMONIC: 'test mnemonic, never a real one',
  ARK_SERVER_URL: 'http://localhost:7070',
  EMULATOR_URL: 'http://localhost:7073',
  LN_BACKEND: 'fake',
}

const STEMS = ['LN_SEND', 'LN_RECEIVE', 'ONCHAIN_SEND', 'ONCHAIN_RECEIVE'] as const
const ONCHAIN_STEMS = ['ONCHAIN_SEND', 'ONCHAIN_RECEIVE'] as const
const LIGHTNING_STEMS = ['LN_SEND', 'LN_RECEIVE'] as const

const KNOB_KEYS = STEMS.flatMap((stem) => [`${stem}_FEE_CAP_SATS`, `${stem}_FEE_MIN_SATS`, `${stem}_FEE_FLAT_SATS`])
const ALL_KEYS = [
  ...Object.keys(BASE_ENV),
  ...KNOB_KEYS,
  'ONCHAIN_FEE_RATE_REFRESH_MS',
  'ONCHAIN_FEE_RATE_STALE_MS',
  'MAX_EXPOSED_SATS',
  'DB_DIR',
  'SWAP_DB_PATH',
]

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

describe('per-corridor network fee bounds', () => {
  it('leaves every corridor on fixed pricing when nothing is set', () => {
    const { corridorNetworkFees } = loadConfig()
    for (const pair of Object.values(PAIR_OF)) {
      expect({ pair, bounds: corridorNetworkFees[pair] }).toEqual({ pair, bounds: null })
    }
  })

  it.each(ONCHAIN_STEMS)('reads %s_FEE_CAP_SATS onto that corridor alone', (stem) => {
    process.env[`${stem}_FEE_CAP_SATS`] = '400'
    const { corridorNetworkFees } = loadConfig()
    expect(corridorNetworkFees[PAIR_OF[stem]]).toEqual({ capSats: 400, minSats: 0 })
    for (const other of STEMS) {
      if (other === stem) continue
      expect({ other, bounds: corridorNetworkFees[PAIR_OF[other]] }).toEqual({ other, bounds: null })
    }
  })

  it('takes a floor beside the cap', () => {
    process.env.ONCHAIN_RECEIVE_FEE_CAP_SATS = '400'
    process.env.ONCHAIN_RECEIVE_FEE_MIN_SATS = '150'
    expect(loadConfig().corridorNetworkFees['onchain:BTC->arkade:BTC']).toEqual({ capSats: 400, minSats: 150 })
  })

  /**
   * A floor and a guess at cost are different questions, so the floor must not
   * be inferred from `FEE_FLAT_SATS`: an operator who configured 300 as a guess
   * would otherwise keep charging 300 on a quiet mempool that cost 50, which is
   * exactly what live pricing was turned on to stop.
   */
  it('does not read the configured flat as a floor', () => {
    process.env.ONCHAIN_SEND_FEE_FLAT_SATS = '300'
    process.env.ONCHAIN_SEND_FEE_CAP_SATS = '900'
    expect(loadConfig().corridorNetworkFees['arkade:BTC->onchain:BTC']).toEqual({ capSats: 900, minSats: 0 })
  })

  it.each(LIGHTNING_STEMS)('refuses %s_FEE_CAP_SATS rather than parsing a knob it cannot honour', (stem) => {
    process.env[`${stem}_FEE_CAP_SATS`] = '400'
    expect(() => loadConfig()).toThrow(/cannot price its execution cost live/)
  })

  it('refuses a floor with no ceiling, which would price nothing', () => {
    process.env.ONCHAIN_SEND_FEE_MIN_SATS = '150'
    expect(() => loadConfig()).toThrow(/ONCHAIN_SEND_FEE_MIN_SATS is set without ONCHAIN_SEND_FEE_CAP_SATS/)
  })

  it('refuses a floor above the ceiling, which the cap could never hold', () => {
    process.env.ONCHAIN_RECEIVE_FEE_CAP_SATS = '100'
    process.env.ONCHAIN_RECEIVE_FEE_MIN_SATS = '101'
    expect(() => loadConfig()).toThrow(/ONCHAIN_RECEIVE_FEE_MIN_SATS 101 exceeds ONCHAIN_RECEIVE_FEE_CAP_SATS 100/)
  })

  /** Equal is legal: it is "charge exactly this", not a contradiction. */
  it('allows a floor equal to the ceiling', () => {
    process.env.ONCHAIN_SEND_FEE_CAP_SATS = '250'
    process.env.ONCHAIN_SEND_FEE_MIN_SATS = '250'
    expect(loadConfig().corridorNetworkFees['arkade:BTC->onchain:BTC']).toEqual({ capSats: 250, minSats: 250 })
  })

  it('refuses a zero cap, which is fixed pricing spelled to look like something', () => {
    process.env.ONCHAIN_SEND_FEE_CAP_SATS = '0'
    expect(() => loadConfig()).toThrow(/ONCHAIN_SEND_FEE_CAP_SATS must be an integer between 1 and 1000000/)
  })

  it.each(['-1', '1000001', '12.5', 'lots'])('refuses %s as a cap', (raw) => {
    process.env.ONCHAIN_RECEIVE_FEE_CAP_SATS = raw
    expect(() => loadConfig()).toThrow(/ONCHAIN_RECEIVE_FEE_CAP_SATS must be an integer between 1 and 1000000/)
  })

  it('refuses a negative floor', () => {
    process.env.ONCHAIN_SEND_FEE_CAP_SATS = '400'
    process.env.ONCHAIN_SEND_FEE_MIN_SATS = '-1'
    expect(() => loadConfig()).toThrow(/ONCHAIN_SEND_FEE_MIN_SATS must be an integer between 0 and 1000000/)
  })
})

describe('the sampled fee rate cadence', () => {
  it('defaults to a minute of refresh and a quarter hour of trust', () => {
    const config = loadConfig()
    expect(config.onchainFeeRateRefreshMs).toBe(60_000)
    expect(config.onchainFeeRateStaleMs).toBe(900_000)
  })

  it('reads both', () => {
    process.env.ONCHAIN_FEE_RATE_REFRESH_MS = '5000'
    process.env.ONCHAIN_FEE_RATE_STALE_MS = '20000'
    const config = loadConfig()
    expect([config.onchainFeeRateRefreshMs, config.onchainFeeRateStaleMs]).toEqual([5_000, 20_000])
  })

  /**
   * `freshly` refuses this too, but from inside `createServices`, where the
   * message names neither variable. Below or equal, every read past the refresh
   * age returns null and the sample degrades to permanently absent — quietly,
   * and only once quotes are flowing.
   */
  it.each(['60000', '30000'])('refuses a staleness of %s that does not exceed the refresh age', (raw) => {
    process.env.ONCHAIN_FEE_RATE_STALE_MS = raw
    expect(() => loadConfig()).toThrow(/ONCHAIN_FEE_RATE_STALE_MS .* must exceed ONCHAIN_FEE_RATE_REFRESH_MS 60000/)
  })
})
