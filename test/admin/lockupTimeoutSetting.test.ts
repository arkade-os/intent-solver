/**
 * `LOCKUP_TIMEOUT_SECONDS` on the console, and the bound it must not escape.
 *
 * The knob decides how long a send quote stays fundable. It was readable only
 * from the environment: absent from `describeSettings` entirely — not editable,
 * and not even in the read-only block beside `SWEEP_CONCURRENCY` — so an
 * operator could neither see the window their solver was quoting nor change it
 * without a redeploy.
 *
 * The hazard in adding it is the one `settings.ts` already names for fees: "a
 * mismatch would let the console set what the env refuses". `config.ts` clamps
 * this knob to `[60, MAX_LOCKUP_TIMEOUT]`, and `MAX_LOCKUP_TIMEOUT` is
 * `REFUND_SAFETY_MARGIN` under another name — a funding window longer than the
 * margin quotes a deadline the swap's own refund cannot sit behind. So the
 * console's bound is asserted against the imported constant here, not against a
 * number copied from it.
 */

import { describe, it, expect } from 'vitest'
import {
  applyOverrides,
  describeSettings,
  editableKeys,
  validateOverride,
} from '@arkade-os/solver-app/admin/settings.js'
import { MAX_LOCKUP_TIMEOUT, DEFAULT_LOCKUP_TIMEOUT } from '@arkade-os/solver-core/core/send.js'
import type { Config } from '@arkade-os/solver-app/config.js'
import { CORRIDORS, FREE } from '@arkade-os/solver-core/core/corridorPolicy.js'

const config = (over: Partial<Config> = {}): Config =>
  ({
    lockupTimeoutSeconds: DEFAULT_LOCKUP_TIMEOUT,
    maxExposedSats: 1_000_000,
    corridorLimits: Object.fromEntries(CORRIDORS.map((c) => [c, { minSats: 1_000, maxSats: 100_000 }])),
    corridorFees: Object.fromEntries(CORRIDORS.map((c) => [c, FREE])),
    corridorEnabled: Object.fromEntries(CORRIDORS.map((c) => [c, true])),
    // `describeSettings` also renders a read-only block; these keep it from
    // throwing on a fixture that only cares about one knob.
    network: 'regtest',
    lnBackend: 'lnd',
    arkade: { arkServerUrl: 'http://localhost:7070' },
    emulatorUrl: 'http://localhost:7073',
    swapDbPath: '/tmp/swaps.sqlite',
    sweepConcurrency: 4,
    relayUrl: 'wss://relay.example',
    relayProtocol: 'nostr',
    openRfqMaxBidsPerMinute: 10,
    sendHintScidDenylist: new Set<string>(),
    ...over,
  }) as unknown as Config

describe('LOCKUP_TIMEOUT_SECONDS is visible and editable', () => {
  it('appears in the console at all, which it did not before', () => {
    const shown = describeSettings(config(), {}).find((k) => k.key === 'LOCKUP_TIMEOUT_SECONDS')
    expect(shown).toBeDefined()
    expect(shown?.value).toBe(DEFAULT_LOCKUP_TIMEOUT)
  })

  it('is editable, because it is policy rather than a deployment fact', () => {
    const shown = describeSettings(config(), {}).find((k) => k.key === 'LOCKUP_TIMEOUT_SECONDS')
    expect(shown?.editable).toBe(true)
    // Every editable knob here needs a restart: services take their policy at
    // construction and never revisit it. Claiming otherwise would promise a
    // live seam that does not exist.
    expect(shown?.restartRequired).toBe(true)
  })

  it('is in the writable key set the route checks against', () => {
    expect(editableKeys()).toContain('LOCKUP_TIMEOUT_SECONDS')
  })

  it('reports an override as coming from the override, not the environment', () => {
    const shown = describeSettings(config(), { LOCKUP_TIMEOUT_SECONDS: '600' }).find(
      (k) => k.key === 'LOCKUP_TIMEOUT_SECONDS',
    )
    expect(shown?.source).toBe('override')
    expect(shown?.value).toBe(600)
  })

  it('actually reaches the Config a service would be built from', () => {
    // The failure this rules out is an override that validates, persists, and
    // then does nothing — which `applyOverrides` has shipped before for the
    // corridor bounds.
    expect(applyOverrides(config(), { LOCKUP_TIMEOUT_SECONDS: '600' }).lockupTimeoutSeconds).toBe(600)
  })

  it('leaves the value alone when no override is set', () => {
    expect(applyOverrides(config(), {}).lockupTimeoutSeconds).toBe(DEFAULT_LOCKUP_TIMEOUT)
  })
})

describe('the console cannot set what the environment refuses', () => {
  it.each([
    ['below the floor', '59'],
    ['zero', '0'],
    ['negative', '-1'],
    ['fractional', '90.5'],
    ['not a number', 'soon'],
    ['blank', ''],
  ])('refuses %s', (_why, value) => {
    expect(() => validateOverride(config(), 'LOCKUP_TIMEOUT_SECONDS', value)).toThrow()
  })

  it('refuses a window longer than the refund safety margin', () => {
    // The bound that matters: `MAX_LOCKUP_TIMEOUT` IS `REFUND_SAFETY_MARGIN`, so
    // a longer window quotes a funding deadline the swap's own refund cannot sit
    // behind. Asserted against the imported constant so a change to the margin
    // moves this test with it rather than leaving a stale copy behind.
    expect(() => validateOverride(config(), 'LOCKUP_TIMEOUT_SECONDS', String(MAX_LOCKUP_TIMEOUT + 1))).toThrow(
      /must be between/,
    )
  })

  it.each([
    ['the floor exactly', 60],
    ['the ceiling exactly', MAX_LOCKUP_TIMEOUT],
  ])('accepts %s', (_why, seconds) => {
    expect(() => validateOverride(config(), 'LOCKUP_TIMEOUT_SECONDS', String(seconds))).not.toThrow()
  })

  it('matches the bounds config.ts applies to the same knob', () => {
    // Stated as a property rather than as two numbers: whatever the env clamp
    // admits, the console must admit, and no more. A drift here is how the
    // console starts accepting a value the environment would have refused.
    expect(() => validateOverride(config(), 'LOCKUP_TIMEOUT_SECONDS', String(MAX_LOCKUP_TIMEOUT))).not.toThrow()
    expect(() => validateOverride(config(), 'LOCKUP_TIMEOUT_SECONDS', String(MAX_LOCKUP_TIMEOUT + 1))).toThrow()
  })

  it('drops a stored override that is out of range rather than refusing to start', () => {
    // `applyOverrides` skips what does not validate, on purpose: a stored value
    // that the rules later outlawed must not take the solver down.
    expect(applyOverrides(config(), { LOCKUP_TIMEOUT_SECONDS: '1' }).lockupTimeoutSeconds).toBe(DEFAULT_LOCKUP_TIMEOUT)
  })
})
