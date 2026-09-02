/**
 * Reading and changing the knobs a solver will honour.
 *
 * The layering rules live in `../settings.ts` and are pure; this module owns
 * the HTTP shape and persistence.
 *
 * ## Every override needs a restart, and the API says so
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
 * So overrides are stored and take effect on next boot, and every response
 * carries `restartRequired: true`. Making them live means giving the services
 * a way to accept new policy — a change to money-path files, and a decision
 * for the operator rather than something to slip in behind a settings form.
 *
 * Storing them is still worth doing on its own: it puts corridor pricing and
 * caps in one durable place an operator edits and reviews, instead of spread
 * across a `.env` file and a shell history.
 */

import type { Hono } from 'hono'
import { describeSettings, validateOverride, editableKeys } from '../settings.js'
import type { AdminDeps } from '../server.js'

/**
 * Why a stored override is not yet in force. One string, so the UI renders the
 * same sentence everywhere and it can be corrected in one place if the
 * plumbing ever changes.
 */
export const RESTART_NOTICE =
  'Stored. It takes effect when the solver restarts: createServices resolves overrides at startup and hands the ' +
  'result to every service, and nothing re-reads that afterwards. The values shown here are what THIS process is ' +
  'quoting; a pending override is what the next one will.'

export const registerSettingsRoutes = (app: Hono, deps: AdminDeps): void => {
  app.get('/api/settings', async (c) => {
    const overrides = await deps.services.adminStore.getOverrides()
    return c.json({
      knobs: describeSettings(deps.services.config, overrides),
      editable: editableKeys(),
      /** Every stored override is pending a restart; listed so the UI can badge them. */
      pendingRestart: Object.keys(overrides),
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
      await deps.services.adminStore.setOverride(key, null)
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

    await deps.services.adminStore.setOverride(key, value)
    return c.json(await snapshot(deps, key))
  })
}

const snapshot = async (deps: AdminDeps, changedKey: string) => {
  const overrides = await deps.services.adminStore.getOverrides()
  return {
    knobs: describeSettings(deps.services.config, overrides),
    changed: changedKey,
    restartRequired: true,
    restartNotice: RESTART_NOTICE,
  }
}
