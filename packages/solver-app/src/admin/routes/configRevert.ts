/**
 * `POST /api/config/revert`: preview, then apply, putting console state back to the config.
 *
 * The preview is the confirmation's whole content, so an apply must carry the
 * preview's basis and is refused when the state has moved since: what the
 * operator agreed to is exactly what is written.
 */
import type { Hono } from 'hono'
import { messageOf } from '@arkade-os/solver-core/util/poll.js'
import { planRevert, type RevertScope } from '../revert.js'
import { applyOverrides, LIVE_KEYS } from '../settings.js'
import type { AdminDeps } from '../server.js'

const scopeFrom = (body: Record<string, unknown>): RevertScope | null => {
  if (body.scope === 'all') return { scope: 'all' }
  if (body.scope === 'market' && typeof body.marketKey === 'string')
    return { scope: 'market', marketKey: body.marketKey }
  return null
}

export const registerConfigRevertRoutes = (app: Hono, deps: AdminDeps): void => {
  app.post('/api/config/revert', async (c) => {
    let body: Record<string, unknown>
    try {
      body = ((await c.req.json()) ?? {}) as Record<string, unknown>
    } catch {
      return c.json({ error: 'bad_request', message: 'body must be JSON' }, 400)
    }
    const scope = scopeFrom(body)
    // `dryRun` must be stated either way: a body that forgot it must not apply.
    if (scope === null || typeof body.dryRun !== 'boolean') {
      return c.json(
        { error: 'bad_request', message: "scope must be 'all', or 'market' with a marketKey, and dryRun a boolean" },
        400,
      )
    }

    const { config, adminStore: store } = deps.services
    const plan = await planRevert(scope, { config, store })
    if (plan === null) {
      return c.json(
        { error: 'not_found', message: `no market is configured as ${(scope as { marketKey: string }).marketKey}` },
        404,
      )
    }
    if (body.dryRun) {
      const { changes, basis, revertibleAlone } = plan
      return c.json({ changes, basis, revertibleAlone, loadedAt: deps.startedAt })
    }
    if (body.basis !== plan.basis) {
      return c.json({ error: 'stale', message: 'config or console state changed since the preview; review again' }, 409)
    }

    await store.revertToConfig(plan.serving, plan.overrideKeys, {
      action: 'config-revert',
      target: scope.scope === 'market' ? scope.marketKey : null,
      params: JSON.stringify({ scope: scope.scope, changes: plan.changes }),
      outcome: 'ok',
      detail: null,
    })
    try {
      if (plan.serving.length > 0) await deps.services.replaceMarkets()
      // Mirrors a cleared setting: only a LIVE key's change reaches the running policy.
      if (plan.overrideKeys.some((key) => LIVE_KEYS.has(key))) {
        await deps.services.replacePolicy(applyOverrides(config, await store.getOverrides()))
      }
    } catch (error) {
      return c.json({ error: 'reload_failed', stored: true, applied: false, message: messageOf(error) }, 500)
    }
    return c.json({ applied: plan.changes })
  })
}
