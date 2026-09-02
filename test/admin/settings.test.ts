import { describe, it, expect } from 'vitest'
import {
  applyOverrides,
  validateOverride,
  describeSettings,
  editableKeys,
} from '@arkade-os/solver-app/admin/settings.js'
import type { Config } from '@arkade-os/solver-app/config.js'

const config = {
  network: 'regtest',
  lnBackend: 'fake',
  swapDbPath: '.data/swaps.sqlite',
  sweepConcurrency: 8,
  relayUrl: null,
  relayProtocol: 'nostr',
  openRfqMaxBidsPerMinute: 30,
  emulatorUrl: 'http://emulator.test',
  arkade: { arkServerUrl: 'http://ark.test', databasePath: '.data/ark.sqlite' },
  limits: { minSats: 1_000, maxSats: 100_000 },
  maxExposedSats: 300_000,
  corridorLimits: {
    'arkade:BTC->lightning:BTC': { minSats: 1_000, maxSats: 100_000 },
    'lightning:BTC->arkade:BTC': { minSats: 1_000, maxSats: 100_000 },
    'arkade:BTC->onchain:BTC': { minSats: 1_000, maxSats: 100_000 },
    'onchain:BTC->arkade:BTC': { minSats: 1_000, maxSats: 100_000 },
  },
  corridorFees: {
    'arkade:BTC->lightning:BTC': { bps: 0, flatSats: 0 },
    'lightning:BTC->arkade:BTC': { bps: 0, flatSats: 0 },
    'arkade:BTC->onchain:BTC': { bps: 0, flatSats: 0 },
    'onchain:BTC->arkade:BTC': { bps: 0, flatSats: 0 },
  },
  corridorEnabled: {
    'arkade:BTC->lightning:BTC': true,
    'lightning:BTC->arkade:BTC': true,
    // Disabled in the environment on purpose: the console must not enable it.
    'arkade:BTC->onchain:BTC': false,
    'onchain:BTC->arkade:BTC': true,
  },
  // Rendered in the read-only block, which iterates it — an absent set throws
  // rather than showing empty.
  sendHintScidDenylist: new Set<string>(),
} as unknown as Config

describe('the editable key set', () => {
  it('covers five knobs per corridor plus the two globals', () => {
    // Deliberately a COUNT rather than a set comparison: it fails when a key
    // is added, which is the point. Anything reaching the admin port can write
    // every key in here, and the port has no authentication of its own, so
    // growing this surface should cost a deliberate edit here.
    //
    // The globals are `MAX_EXPOSED_SATS` and `LOCKUP_TIMEOUT_SECONDS`.
    expect(editableKeys()).toHaveLength(4 * 5 + 2)
  })

  it('admits the two globals by name, so the count above cannot pass on the wrong pair', () => {
    expect(editableKeys()).toContain('MAX_EXPOSED_SATS')
    expect(editableKeys()).toContain('LOCKUP_TIMEOUT_SECONDS')
  })

  it('never admits a secret or a path', () => {
    // The console has no authentication of its own, so an editable path knob
    // would let whatever reaches that port relocate the money-critical database.
    for (const key of [
      'ARK_MNEMONIC',
      'LN_MNEMONIC',
      'SWAP_DB_PATH',
      'ARK_DB_PATH',
      'DB_DIR',
      'ARK_SERVER_URL',
      'LN_BACKEND',
    ]) {
      expect(editableKeys()).not.toContain(key)
    }
  })
})

describe('limit overrides, which may widen as well as narrow', () => {
  it('narrows a corridor maximum', () => {
    const next = applyOverrides(config, { LN_SEND_MAX_SATS: '50000' })
    expect(next.corridorLimits['arkade:BTC->lightning:BTC'].maxSats).toBe(50_000)
  })

  it('WIDENS a corridor maximum past the environment ceiling', () => {
    // The refusal this replaces is the whole change: the environment is a
    // starting point for the console now, not a ceiling on the amount at risk.
    expect(() => validateOverride(config, 'LN_SEND_MAX_SATS', '200000')).not.toThrow()
    const next = applyOverrides(config, { LN_SEND_MAX_SATS: '200000' })
    expect(next.corridorLimits['arkade:BTC->lightning:BTC'].maxSats).toBe(200_000)
  })

  it('raises a minimum', () => {
    const next = applyOverrides(config, { LN_SEND_MIN_SATS: '5000' })
    expect(next.corridorLimits['arkade:BTC->lightning:BTC'].minSats).toBe(5_000)
  })

  it('lowers a minimum below the environment floor', () => {
    expect(() => validateOverride(config, 'LN_SEND_MIN_SATS', '500')).not.toThrow()
    const next = applyOverrides(config, { LN_SEND_MIN_SATS: '500' })
    expect(next.corridorLimits['arkade:BTC->lightning:BTC'].minSats).toBe(500)
  })

  it('still refuses a bound that is not a positive integer', () => {
    // The narrowing rule is gone; the shape rule is not. A NaN absorbed here
    // would compare false against every amount and remove the cap entirely.
    expect(() => validateOverride(config, 'LN_SEND_MAX_SATS', '0')).toThrow(/positive integer/i)
    expect(() => validateOverride(config, 'LN_SEND_MAX_SATS', '1e5x')).toThrow(/positive integer/i)
  })

  it('accepts a minimum above the environment maximum once the maximum is raised too', () => {
    // The emptiness check this replaces compared each bound against the ENV
    // range, so it would have refused this pair even though it is coherent.
    const next = applyOverrides(config, { LN_SEND_MAX_SATS: '500000', LN_SEND_MIN_SATS: '200000' })
    expect(next.corridorLimits['arkade:BTC->lightning:BTC']).toEqual({ minSats: 200_000, maxSats: 500_000 })
  })

  it('falls back to the environment range for a pair that crosses', () => {
    // Neither bound is refusable on its own now, so a crossed pair can only be
    // caught in applyOverrides, where both are known.
    const next = applyOverrides(config, { LN_SEND_MIN_SATS: '90000', LN_SEND_MAX_SATS: '5000' })
    expect(next.corridorLimits['arkade:BTC->lightning:BTC']).toEqual({ minSats: 1_000, maxSats: 100_000 })
  })

  it('moves the exposure cap in both directions', () => {
    expect(applyOverrides(config, { MAX_EXPOSED_SATS: '100000' }).maxExposedSats).toBe(100_000)
    expect(applyOverrides(config, { MAX_EXPOSED_SATS: '900000' }).maxExposedSats).toBe(900_000)
  })

  it('honours a stored override that exceeds what the environment allows', () => {
    // Previously clamped back to the env bound by narrow(). Assigning instead
    // is what stops a widening override validating, persisting and then
    // silently doing nothing.
    const next = applyOverrides(config, { LN_SEND_MAX_SATS: '999999' })
    expect(next.corridorLimits['arkade:BTC->lightning:BTC'].maxSats).toBe(999_999)
  })
})

describe('fees', () => {
  it('moves freely in both directions — neither is a safety question', () => {
    expect(applyOverrides(config, { LN_SEND_FEE_BPS: '25' }).corridorFees['arkade:BTC->lightning:BTC'].bps).toBe(25)
    expect(applyOverrides(config, { LN_SEND_FEE_BPS: '0' }).corridorFees['arkade:BTC->lightning:BTC'].bps).toBe(0)
  })

  it('keeps the two fee components independent', () => {
    const next = applyOverrides(config, { LN_SEND_FEE_BPS: '25', LN_SEND_FEE_FLAT_SATS: '100' })
    expect(next.corridorFees['arkade:BTC->lightning:BTC']).toEqual({ bps: 25, flatSats: 100 })
  })

  it('rejects a spread at or above 100%, matching config.ts', () => {
    expect(() => validateOverride(config, 'LN_SEND_FEE_BPS', '10000')).toThrow(/between 0 and 9999/)
  })

  it('rejects an absurd flat fee, matching config.ts', () => {
    expect(() => validateOverride(config, 'LN_SEND_FEE_FLAT_SATS', '2000000')).toThrow(/between 0 and 1000000/)
  })

  it('replaces the fee object rather than mutating it, so a live quote cannot read a torn value', () => {
    const before = config.corridorFees['arkade:BTC->lightning:BTC']
    const next = applyOverrides(config, { LN_SEND_FEE_BPS: '25' })
    expect(next.corridorFees['arkade:BTC->lightning:BTC']).not.toBe(before)
    expect(before).toEqual({ bps: 0, flatSats: 0 })
  })
})

describe('corridor toggles', () => {
  it('disables an enabled corridor', () => {
    const next = applyOverrides(config, { LN_SEND_ENABLED: 'false' })
    expect(next.corridorEnabled['arkade:BTC->lightning:BTC']).toBe(false)
  })

  it('refuses to enable a corridor the environment disabled — no service exists for it', () => {
    expect(() => validateOverride(config, 'ONCHAIN_SEND_ENABLED', 'true')).toThrow(/disabled in the environment/i)
  })

  it('still allows re-enabling one the console itself disabled', () => {
    expect(() => validateOverride(config, 'LN_SEND_ENABLED', 'true')).not.toThrow()
  })

  it('accepts only the exact strings true and false', () => {
    for (const bad of ['TRUE', '1', 'yes', 'off']) {
      expect(() => validateOverride(config, 'LN_SEND_ENABLED', bad)).toThrow(/must be 'true' or 'false'/)
    }
  })
})

describe('non-editable keys', () => {
  it('refuses anything outside the editable set', () => {
    expect(() => validateOverride(config, 'ARK_MNEMONIC', 'hunter2')).toThrow(/not editable/i)
    expect(() => validateOverride(config, 'LN_BACKEND', 'lnd')).toThrow(/not editable/i)
  })

  it('does not mutate the config it was handed', () => {
    const before = JSON.stringify(config)
    applyOverrides(config, { LN_SEND_FEE_BPS: '25', MAX_EXPOSED_SATS: '1000' })
    expect(JSON.stringify(config)).toBe(before)
  })
})

describe('describeSettings', () => {
  it('marks a knob as overridden once it is set, and env otherwise', () => {
    const knobs = describeSettings(config, { LN_SEND_FEE_BPS: '25' })
    expect(knobs.find((k) => k.key === 'LN_SEND_FEE_BPS')).toMatchObject({ value: 25, source: 'override' })
    expect(knobs.find((k) => k.key === 'LN_SEND_FEE_FLAT_SATS')).toMatchObject({ source: 'env' })
  })

  it('reports EVERY editable knob as restart-required', () => {
    // Not a limitation of this module: createServices hands each service its
    // policy at construction (maxExposedSats by value, the rest as references
    // it never revisits), the orchestrator's deps is `private readonly`, and
    // corridor toggles are read once when the ingress is built. Nothing can
    // hand a running service new policy, so claiming any of these apply live
    // would be a lie an operator finds out about from a mispriced quote.
    for (const knob of describeSettings(config, {}).filter((k) => k.editable)) {
      expect(knob.restartRequired, `${knob.key} should be restart-required`).toBe(true)
    }
  })

  it('never marks a read-only knob restart-required — there is nothing to restart for', () => {
    const readOnly = describeSettings(config, {}).filter((k) => !k.editable && k.key !== 'ONCHAIN_SEND_ENABLED')
    for (const knob of readOnly) expect(knob.restartRequired).toBeUndefined()
  })

  it('marks an env-disabled corridor toggle as not editable', () => {
    const knobs = describeSettings(config, {})
    expect(knobs.find((k) => k.key === 'ONCHAIN_SEND_ENABLED')?.editable).toBe(false)
    expect(knobs.find((k) => k.key === 'LN_SEND_ENABLED')?.editable).toBe(true)
  })

  it('exposes no secret at all — absent, not redacted', () => {
    const serialised = JSON.stringify(describeSettings(config, {}))
    expect(serialised).not.toContain('MNEMONIC')
    expect(serialised).not.toContain('MACAROON')
  })

  it('shows read-only operational context an operator needs to confirm what is running', () => {
    const keys = describeSettings(config, {}).map((k) => k.key)
    expect(keys).toContain('SWAP_NETWORK')
    expect(keys).toContain('LN_BACKEND')
    expect(keys).toContain('EMULATOR_URL')
  })

  it('shows BOTH resolved database paths, since DB_DIR places them without naming either', () => {
    // The wallet database is money-critical and was never on this page. With one
    // directory knob behind them, "which files is this process using" is a
    // question the console has to be able to answer on its own.
    const knobs = describeSettings(config, {})
    expect(knobs.find((k) => k.key === 'SWAP_DB_PATH')?.value).toBe('.data/swaps.sqlite')
    expect(knobs.find((k) => k.key === 'ARK_DB_PATH')?.value).toBe('.data/ark.sqlite')
  })
})
