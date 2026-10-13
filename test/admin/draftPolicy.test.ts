import { describe, it, expect } from 'vitest'
import { resolveDraftPolicy } from '@arkade-os/solver-app/admin/draftPolicy.js'
import type { Config } from '@arkade-os/solver-app/config.js'

const baseConfig = {
  corridorFees: {
    'arkade:BTC->lightning:BTC': { bps: 0, flatSats: 0 },
    'lightning:BTC->arkade:BTC': { bps: 0, flatSats: 0 },
    'arkade:BTC->onchain:BTC': { bps: 0, flatSats: 0 },
    'onchain:BTC->arkade:BTC': { bps: 0, flatSats: 0 },
  },
  corridorLimits: {
    'arkade:BTC->lightning:BTC': { minSats: 1_000, maxSats: 100_000 },
    'lightning:BTC->arkade:BTC': { minSats: 1_000, maxSats: 100_000 },
    'arkade:BTC->onchain:BTC': { minSats: 1_000, maxSats: 100_000 },
    'onchain:BTC->arkade:BTC': { minSats: 1_000, maxSats: 100_000 },
  },
  corridorEnabled: {
    'arkade:BTC->lightning:BTC': true,
    'lightning:BTC->arkade:BTC': true,
    'arkade:BTC->onchain:BTC': true,
    'onchain:BTC->arkade:BTC': true,
  },
  maxExposedSats: 1_000_000,
  lockupTimeoutSeconds: 3_600,
} as unknown as Config

describe('resolveDraftPolicy', () => {
  it('resolves a clean draft to the config the ladder is priced on', () => {
    const resolved = resolveDraftPolicy(baseConfig, { LN_SEND_FEE_BPS: '25', LN_SEND_MAX_SATS: '250000' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.config.corridorFees['arkade:BTC->lightning:BTC']).toEqual({ bps: 25, flatSats: 0 })
    expect(resolved.config.corridorLimits['arkade:BTC->lightning:BTC'].maxSats).toBe(250_000)
  })

  it('reports an invalid value rather than dropping it, which applyOverrides would', () => {
    const resolved = resolveDraftPolicy(baseConfig, { LN_SEND_FEE_BPS: '10000' })
    expect(resolved).toMatchObject({ ok: false })
    if (resolved.ok) return
    expect(resolved.invalid).toEqual([
      { key: 'LN_SEND_FEE_BPS', reason: expect.stringContaining('between 0 and 9999') },
    ])
  })

  it('refuses a crossed range on BOTH keys rather than reverting it to the environment’s', () => {
    // applyOverrides would instead revert this pair to the environment's range (settings.ts:277-279).
    const resolved = resolveDraftPolicy(baseConfig, { LN_SEND_MIN_SATS: '90000', LN_SEND_MAX_SATS: '5000' })
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.invalid.map((item) => item.key)).toEqual(['LN_SEND_MIN_SATS', 'LN_SEND_MAX_SATS'])
    expect(resolved.invalid[0]!.reason).toMatch(/admit no amount/)
  })

  it('crosses a stored minimum against a drafted maximum, which one key alone cannot see', () => {
    expect(resolveDraftPolicy(baseConfig, { LN_SEND_MAX_SATS: '500' }).ok).toBe(false)
  })

  it('refuses a key the console may not write', () => {
    const resolved = resolveDraftPolicy(baseConfig, { ARK_SERVER_URL: 'http://evil.test' })
    expect(resolved).toMatchObject({ ok: false })
  })

  it('collects every refusal, so one round of typing fixes them all', () => {
    const resolved = resolveDraftPolicy(baseConfig, { LN_SEND_FEE_BPS: '-1', MAX_EXPOSED_SATS: '0' })
    if (resolved.ok) throw new Error('expected a refusal')
    expect(resolved.invalid).toHaveLength(2)
  })
})
