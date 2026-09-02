import { describe, it, expect, vi } from 'vitest'
import { buildAdminApp } from '@arkade-os/solver-app/admin/server.js'

const baseConfig = {
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
    'arkade:BTC->onchain:BTC': false,
    'onchain:BTC->arkade:BTC': true,
  },
  // Rendered in the read-only block, which iterates it.
  sendHintScidDenylist: new Set<string>(),
}

const build = (overrides: Record<string, string> = {}) => {
  const setOverride = vi.fn().mockResolvedValue(undefined)
  const services = {
    config: structuredClone(baseConfig),
    adminStore: { getOverrides: vi.fn().mockResolvedValue(overrides), setOverride },
  } as never
  return { app: buildAdminApp({ services, startedAt: 1, mode: 'relay' }), setOverride }
}

const patch = (app: ReturnType<typeof buildAdminApp>, body: unknown) =>
  app.fetch(
    new Request('http://admin/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

describe('GET /api/settings', () => {
  it('lists knobs with their source', async () => {
    const { app } = build({ LN_SEND_FEE_BPS: '25' })
    const body = (await (await app.fetch(new Request('http://admin/api/settings'))).json()) as {
      knobs: { key: string; source: string; value: unknown }[]
      pendingRestart: string[]
    }
    expect(body.knobs.find((k) => k.key === 'LN_SEND_FEE_BPS')).toMatchObject({ value: 25, source: 'override' })
    expect(body.pendingRestart).toContain('LN_SEND_FEE_BPS')
  })

  it('exposes no secrets', async () => {
    const { app } = build()
    const text = await (await app.fetch(new Request('http://admin/api/settings'))).text()
    expect(text).not.toContain('MNEMONIC')
  })
})

describe('PATCH /api/settings', () => {
  it('persists a narrowing override', async () => {
    const { app, setOverride } = build()
    const response = await patch(app, { key: 'LN_SEND_MAX_SATS', value: '50000' })
    expect(response.status).toBe(200)
    expect(setOverride).toHaveBeenCalledWith('LN_SEND_MAX_SATS', '50000')
  })

  it('always reports that a restart is needed, because nothing can apply live', async () => {
    const { app } = build()
    const body = await (await patch(app, { key: 'LN_SEND_MAX_SATS', value: '50000' })).json()
    expect(body).toMatchObject({ restartRequired: true })
    // The notice may only promise a restart applies the override because
    // createServices actually resolves them at startup — see
    // test/cli/overridesApplied.test.ts, which pins that wiring. This claim
    // was false once; the pairing is what stops it being false again.
    const notice = (body as { restartNotice: string }).restartNotice
    expect(notice).toMatch(/takes effect when the solver restarts/i)
  })

  it('persists a WIDENING value, which the narrowing guard used to refuse', async () => {
    const { app, setOverride } = build()
    const response = await patch(app, { key: 'LN_SEND_MAX_SATS', value: '200000' })
    expect(response.status).toBe(200)
    expect(setOverride).toHaveBeenCalledWith('LN_SEND_MAX_SATS', '200000')
  })

  it('refuses a malformed value and PERSISTS NOTHING', async () => {
    // Validate-before-persist still holds for the rules that remain; only the
    // narrowing rule went away.
    const { app, setOverride } = build()
    const response = await patch(app, { key: 'LN_SEND_MAX_SATS', value: '1e5x' })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'rejected' })
    expect(setOverride).not.toHaveBeenCalled()
  })

  it('refuses a non-editable key', async () => {
    const { app, setOverride } = build()
    expect((await patch(app, { key: 'ARK_MNEMONIC', value: 'hunter2' })).status).toBe(400)
    expect(setOverride).not.toHaveBeenCalled()
  })

  it('refuses to enable a corridor the environment disabled', async () => {
    const { app, setOverride } = build()
    const response = await patch(app, { key: 'ONCHAIN_SEND_ENABLED', value: 'true' })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { message: string }).message).toMatch(/disabled in the environment/i)
    expect(setOverride).not.toHaveBeenCalled()
  })

  it('clears an override when given null', async () => {
    const { app, setOverride } = build({ LN_SEND_FEE_BPS: '25' })
    expect((await patch(app, { key: 'LN_SEND_FEE_BPS', value: null })).status).toBe(200)
    expect(setOverride).toHaveBeenCalledWith('LN_SEND_FEE_BPS', null)
  })

  it('rejects a malformed body rather than 500ing', async () => {
    const { app } = build()
    expect((await patch(app, { value: '1' })).status).toBe(400)
    expect((await patch(app, { key: 'LN_SEND_FEE_BPS', value: 25 })).status).toBe(400)
  })
})
