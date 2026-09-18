import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildAdminApp } from '@arkade-os/solver-app/admin/server.js'
import { AdminStore } from '@arkade-os/solver-app/admin/db.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'

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
  // The two variables deciding whether a configured market is filled by
  // anything; the read-only block renders both. @see admin/servedBy.ts
  offerMarkets: [],
  assetRfqTokens: [],
}

const build = (overrides: Record<string, string> = {}, over: Record<string, unknown> = {}) => {
  const setOverrideWithAudit = vi.fn().mockResolvedValue(undefined)
  const services = {
    config: structuredClone(baseConfig),
    // What this process actually resolved its policy from. Defaulting both to
    // "booted with nothing overridden" keeps every existing case unchanged.
    policy: structuredClone(baseConfig),
    bootOverrides: {},
    adminStore: { getOverrides: vi.fn().mockResolvedValue(overrides), setOverrideWithAudit },
    ...over,
  } as never
  return { app: buildAdminApp({ services, startedAt: 1, mode: 'relay' }), setOverrideWithAudit }
}

const patch = (app: ReturnType<typeof buildAdminApp>, body: unknown) =>
  app.fetch(
    new Request('http://admin/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

const buildReal = async () => {
  const driver = betterSqliteDriver(':memory:')
  const adminStore = await AdminStore.open(driver, () => 1_000_000)
  const services = {
    config: structuredClone(baseConfig),
    policy: structuredClone(baseConfig),
    bootOverrides: {},
    adminStore,
  } as never
  return { app: buildAdminApp({ services, startedAt: 1, mode: 'relay' }), adminStore, driver }
}

const rejectAuditInserts = (driver: ReturnType<typeof betterSqliteDriver>) =>
  driver.exec(`
    CREATE TRIGGER reject_admin_action
    BEFORE INSERT ON admin_action
    BEGIN
      SELECT RAISE(FAIL, 'audit insert failed');
    END;
  `)

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

describe('GET /api/settings — what is actually pending', () => {
  const read = async (overrides: Record<string, string>, over: Record<string, unknown> = {}) => {
    const { app } = build(overrides, over)
    return (await (await app.fetch(new Request('http://admin/api/settings'))).json()) as {
      knobs: { key: string; pending?: boolean; restartRequired?: boolean }[]
      pendingRestart: string[]
    }
  }

  it('omits an override this process already booted with', async () => {
    const policy = structuredClone(baseConfig)
    policy.corridorFees['arkade:BTC->lightning:BTC'] = { bps: 25, flatSats: 0 }
    const body = await read({ LN_SEND_FEE_BPS: '25' }, { policy, bootOverrides: { LN_SEND_FEE_BPS: '25' } })

    expect(body.pendingRestart).toEqual([])
    expect(body.knobs.find((k) => k.key === 'LN_SEND_FEE_BPS')?.pending).toBeUndefined()
  })

  it('reports an override stored since boot, and still calls the knob restart-required', async () => {
    const body = await read({ LN_SEND_FEE_BPS: '25' })

    expect(body.pendingRestart).toEqual(['LN_SEND_FEE_BPS'])
    const knob = body.knobs.find((k) => k.key === 'LN_SEND_FEE_BPS')
    expect(knob?.pending).toBe(true)
    // Unchanged and still true: no seam hands a running service new policy yet.
    expect(knob?.restartRequired).toBe(true)
  })
})

describe('PATCH /api/settings', () => {
  it('persists a narrowing override', async () => {
    const { app, setOverrideWithAudit } = build()
    const response = await patch(app, { key: 'LN_SEND_MAX_SATS', value: '50000' })
    expect(response.status).toBe(200)
    expect(setOverrideWithAudit).toHaveBeenCalledWith('LN_SEND_MAX_SATS', '50000', {
      action: 'setting-set',
      target: 'LN_SEND_MAX_SATS',
      params: '{"value":"50000"}',
      outcome: 'ok',
      detail: null,
    })
  })

  it('always reports that a restart is needed, because nothing can apply live', async () => {
    const alreadyStored = { LN_SEND_MAX_SATS: '50000' }
    const { app } = build(alreadyStored)
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
    const { app, setOverrideWithAudit } = build()
    const response = await patch(app, { key: 'LN_SEND_MAX_SATS', value: '200000' })
    expect(response.status).toBe(200)
    expect(setOverrideWithAudit).toHaveBeenCalledWith(
      'LN_SEND_MAX_SATS',
      '200000',
      expect.objectContaining({ action: 'setting-set' }),
    )
  })

  it('refuses a malformed value and PERSISTS NOTHING', async () => {
    // Validate-before-persist still holds for the rules that remain; only the
    // narrowing rule went away.
    const { app, setOverrideWithAudit } = build()
    const response = await patch(app, { key: 'LN_SEND_MAX_SATS', value: '1e5x' })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'rejected' })
    expect(setOverrideWithAudit).not.toHaveBeenCalled()
  })

  it('refuses a non-editable key', async () => {
    const { app, setOverrideWithAudit } = build()
    expect((await patch(app, { key: 'ARK_MNEMONIC', value: 'hunter2' })).status).toBe(400)
    expect(setOverrideWithAudit).not.toHaveBeenCalled()
  })

  it('refuses to enable a corridor the environment disabled', async () => {
    const { app, setOverrideWithAudit } = build()
    const response = await patch(app, { key: 'ONCHAIN_SEND_ENABLED', value: 'true' })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { message: string }).message).toMatch(/disabled in the environment/i)
    expect(setOverrideWithAudit).not.toHaveBeenCalled()
  })

  it('clears an override when given null', async () => {
    const { app, setOverrideWithAudit } = build({ LN_SEND_FEE_BPS: '25' })
    expect((await patch(app, { key: 'LN_SEND_FEE_BPS', value: null })).status).toBe(200)
    expect(setOverrideWithAudit).toHaveBeenCalledWith('LN_SEND_FEE_BPS', null, {
      action: 'setting-clear',
      target: 'LN_SEND_FEE_BPS',
      params: '{}',
      outcome: 'ok',
      detail: null,
    })
  })

  it('rolls back a set when its audit insert fails', async () => {
    const { app, adminStore, driver } = await buildReal()
    try {
      await adminStore.setOverride('LN_SEND_MAX_SATS', '25000')
      await rejectAuditInserts(driver)

      expect((await patch(app, { key: 'LN_SEND_MAX_SATS', value: '50000' })).status).toBe(500)
      expect(await adminStore.getOverrides()).toEqual({ LN_SEND_MAX_SATS: '25000' })
      expect(await adminStore.listActions()).toEqual([])
    } finally {
      await adminStore.close()
    }
  })

  it('rolls back a clear when its audit insert fails', async () => {
    const { app, adminStore, driver } = await buildReal()
    try {
      await adminStore.setOverride('LN_SEND_FEE_BPS', '25')
      await rejectAuditInserts(driver)

      expect((await patch(app, { key: 'LN_SEND_FEE_BPS', value: null })).status).toBe(500)
      expect(await adminStore.getOverrides()).toEqual({ LN_SEND_FEE_BPS: '25' })
      expect(await adminStore.listActions()).toEqual([])
    } finally {
      await adminStore.close()
    }
  })

  it('rejects a malformed body rather than 500ing', async () => {
    const { app } = build()
    expect((await patch(app, { value: '1' })).status).toBe(400)
    expect((await patch(app, { key: 'LN_SEND_FEE_BPS', value: 25 })).status).toBe(400)
  })
})

describe('the settings table renders the pending state', () => {
  const appSource = readFileSync(
    fileURLToPath(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url)),
    'utf8',
  )
  const view = (): string =>
    appSource.slice(appSource.indexOf('const settingsView'), appSource.indexOf('/* ==== asset markets'))

  it('badges a knob that is waiting, not merely one that is overridden', () => {
    expect(view()).toContain('knob.pending')
  })

  it('stops spending the risk colour on every override', () => {
    // Amber is reserved for risk (styles.css:4). Being overridden is not one;
    // a stored change the process has not loaded is.
    const source = view()
    const amberAt = source.indexOf('phase-exposed')
    expect(amberAt).toBeGreaterThan(-1)
    expect(source.slice(amberAt - 120, amberAt)).toContain('pending')
  })
})
