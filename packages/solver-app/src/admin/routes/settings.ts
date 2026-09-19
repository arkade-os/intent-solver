/**
 * Reading and changing the knobs a solver will honour.
 *
 * The layering rules live in `../settings.ts` and are pure; this module owns
 * the HTTP shape and persistence.
 *
 * ## Every override needs a restart to take effect, and the API says which ones are still waiting.
 *
 * This was checked against `src/cli.ts` and `src/send/orchestrator.ts` rather
 * than assumed, because a console that claims a change took effect when it did
 * not is worse than one that changes nothing:
 *
 * - `createServices` passes each service `limits: config.corridorLimits[c]`
 *   and `maxExposedSats: config.maxExposedSats`. The number is copied BY
 *   VALUE, so writing to `config.maxExposedSats` afterwards reaches nothing.
 * - The orchestrator does re-read `this.deps.limits` and
 *   `this.deps.maxExposedSats` on every quote — but nothing ever updates
 *   `this.deps`, and it is `private readonly`, so there is no seam to update
 *   it through from here.
 * - `fee` is additionally snapshotted into `this.fee` in the constructor, so
 *   even an updated deps object would not move it.
 * - Corridor toggles go through `cli.ts`'s `enabled()` helper, which is
 *   evaluated ONCE when the ingress is built.
 *
 * So overrides are stored and take effect on next boot. Making them live
 * means giving the services a way to accept new policy — a change to
 * money-path files, and a decision for the operator rather than something to
 * slip in behind a settings form.
 *
 * Storing them is still worth doing on its own: it puts corridor pricing and
 * caps in one durable place an operator edits and reviews, instead of spread
 * across a `.env` file and a shell history.
 */

import type { Hono } from 'hono'
import {
  describeSettings,
  validateOverride,
  editableKeys,
  applyOverrides,
  pendingRestartKeys,
  LIVE_KEYS,
} from '../settings.js'
import { settingsDrift } from '../drift.js'
import type { AdminDeps } from '../server.js'

/**
 * Why a stored override is not yet in force. One string, so the UI renders the
 * same sentence everywhere and it can be corrected in one place if the
 * plumbing ever changes.
 */
export const RESTART_NOTICE =
  'Corridor fees, limits and caps are read once at startup: createServices resolves overrides and hands the result ' +
  'to every service, and nothing re-reads it afterwards. A knob badged pending is one whose override differs from ' +
  'what this process loaded at boot; every other value here is what it is quoting right now. ASSET_MARKETS and OFFER_MARKETS ' +
  'below are read once at startup like everything else on this page, not an exception to it. The markets this ' +
  'solver actually trades are a separate, live list — edited with no restart on the markets screen.'

// The same derivation `/api/overview` uses, reduced to keys. `bootPolicy` NOT `policy`:
// `replacePolicy` moves `policy` over EVERY stored override at once, so diffing that
// would un-badge the ones that did not apply. A LIVE key is then subtracted.
const pendingKeys = (deps: AdminDeps, overrides: Record<string, string>): string[] => {
  const effective = applyOverrides(deps.services.config, overrides)
  const moved = pendingRestartKeys(deps.services.bootOverrides, overrides)
  return settingsDrift(deps.services.bootPolicy, effective, moved)
    .map((item) => item.key)
    .filter((key) => !LIVE_KEYS.has(key))
}

export const registerSettingsRoutes = (app: Hono, deps: AdminDeps): void => {
  app.get('/api/settings', async (c) => {
    const overrides = await deps.services.adminStore.getOverrides()
    const pending = pendingKeys(deps, overrides)
    return c.json({
      knobs: describeSettings(deps.services.config, overrides, pending),
      editable: editableKeys(),
      pendingRestart: pending,
      restartNotice: RESTART_NOTICE,
    })
  })

  app.patch('/api/settings', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'bad_request', message: 'body must be JSON' }, 400)
    }
    const { key, value } = (body ?? {}) as { key?: unknown; value?: unknown }
    if (typeof key !== 'string') return c.json({ error: 'bad_request', message: 'key must be a string' }, 400)

    // null clears the override, reverting the knob to the environment's value.
    if (value === null) {
      await deps.services.adminStore.setOverrideWithAudit(key, null, {
        action: 'setting-clear',
        target: key,
        params: '{}',
        outcome: 'ok',
        detail: null,
      })
      return c.json(await snapshot(deps, key))
    }
    if (typeof value !== 'string') {
      return c.json({ error: 'bad_request', message: 'value must be a string or null' }, 400)
    }

    // Validate BEFORE persisting. A stored override that is silently ignored on
    // load is the worst of both: the console would show it as set while the
    // solver quotes on something else entirely.
    try {
      validateOverride(deps.services.config, key, value)
    } catch (error) {
      return c.json({ error: 'rejected', message: error instanceof Error ? error.message : String(error) }, 400)
    }

    await deps.services.adminStore.setOverrideWithAudit(key, value, {
      action: 'setting-set',
      target: key,
      params: JSON.stringify({ value }),
      outcome: 'ok',
      detail: null,
    })
    // Re-read the store rather than patch policy here: `applyOverrides` is the one definition of layering.
    if (LIVE_KEYS.has(key)) {
      const stored = await deps.services.adminStore.getOverrides()
      try {
        await deps.services.replacePolicy(applyOverrides(deps.services.config, stored))
      } catch (error) {
        // `pendingKeys` subtracts LIVE_KEYS, so a later GET badges this key as needing no restart, which reads
        // as in force. The generic 500 carries the reason but neither the key nor whether anything was written.
        return c.json(
          {
            error: 'reload_failed',
            key,
            stored: true,
            applied: false,
            message: error instanceof Error ? error.message : String(error),
          },
          500,
        )
      }
    }
    return c.json(await snapshot(deps, key))
  })
}

const snapshot = async (deps: AdminDeps, changedKey: string) => {
  const overrides = await deps.services.adminStore.getOverrides()
  const pending = pendingKeys(deps, overrides)
  return {
    knobs: describeSettings(deps.services.config, overrides, pending),
    changed: changedKey,
    restartRequired: pending.includes(changedKey),
    restartNotice: RESTART_NOTICE,
  }
}
