/**
 * One question: is this solver healthy right now?
 *
 * Everything here is readable elsewhere — probes, corridor policy, wallet —
 * but spread across four routes an operator has to assemble by eye. The
 * headroom check is the part that exists nowhere else: whether a corridor can
 * actually honour the maximum it advertises.
 *
 * Headroom is a PER-CORRIDOR question on two axes, and getting either wrong
 * makes the answer worse than no answer:
 *
 *   - what it advertises differs per corridor. `corridorLimits` is what the
 *     RFQ path actually quotes against, and in production the corridors really
 *     do diverge. The global `limits.maxSats` is only the outer bound each
 *     corridor was narrowed from, so measuring against it reports a corridor
 *     as short when it is fine.
 *   - what funds it differs per corridor too. The solver pays out on the
 *     corridor's DESTINATION leg, so an Arkade->Lightning swap is funded by
 *     Lightning liquidity and an Arkade->onchain swap by confirmed UTXOs.
 *     Checking one wallet for all four reports a corridor as fundable when its
 *     actual payout rail is empty — the exact wrong answer to a question asked
 *     only when something is already going wrong.
 */
import type { Hono } from 'hono'
import { CORRIDORS } from '@arkade-os/solver-core/core/corridorPolicy.js'
import { balanceOfRail, readRails } from '@arkade-os/solver-core/core/rail.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import { descriptorFor } from '@arkade-os/solver-corridors/corridors/index.js'
import { applyOverrides } from '../settings.js'
import { probeBackends } from '../probes.js'
import { attempt } from '../../ops/attempt.js'
import { requireLn, requireOnchain } from '../../ops/rails.js'
import { publishStateOf } from '../publishState.js'
import type { AdminDeps } from '../server.js'

/**
 * `payoutRail` is REQUIRED on the descriptor, never a `split('->')` that could silently match nothing. An
 * unprobed rail resolves to UNKNOWN (`balanceOfRail`), never zero: a solver must not be reported as broke.
 */
export const registerDiagnosticsRoutes = (app: Hono, deps: AdminDeps): void => {
  app.get('/api/diagnostics', async (c) => {
    const { services } = deps
    const now = deps.now ?? nowSeconds
    const backends = await probeBackends(services, deps.relay)

    // One read per RAIL, not per corridor: two corridors pay out on Arkade, and
    // asking the wallet twice could return two different numbers and report the
    // pair inconsistently. Each is caught on its own so one dead rail cannot
    // take the other two down with it.
    const balances = await readRails([
      {
        id: 'lightning',
        balance: () => attempt(async () => (await requireLn(services.ln).getBalance()).availableSats),
      },
      { id: 'arkade', balance: () => attempt(async () => (await services.arkade.wallet.getBalance()).available) },
      {
        id: 'onchain',
        // CONFIRMED only. Unconfirmed funds are not reliably spendable, and the
        // question this number answers is "can I honour a quote right now".
        balance: () => attempt(async () => (await requireOnchain(services.onchain).getBalance()).confirmedSats),
      },
    ])

    // The same derivation `/api/overview` uses, so the console cannot show two
    // different "effective maximum" numbers on two pages. Reading the stored
    // overrides is a DISPLAY concern only — nothing here is applied to a
    // running service, which still holds the policy `createServices` gave it.
    const stored = await attempt(() => services.adminStore.getOverrides())
    const effective = applyOverrides(services.config, stored.value ?? {})

    const corridors = CORRIDORS.map((corridor) => {
      const payoutRail = descriptorFor(corridor).payoutRail
      // Indexed, never re-read: `readRails` already took one snapshot per rail.
      // A corridor naming a rail this build does not have lands on UNKNOWN here,
      // which is the same answer a dead rail gives — and not zero.
      const balance = balanceOfRail(balances, payoutRail)
      const max = effective.corridorLimits[corridor].maxSats
      return {
        corridor,
        advertisedMaxSats: max,
        payoutRail,
        // Null, never 0, when the rail could not be read: unknown is not zero.
        availableSats: balance.value,
        balanceError: balance.error,
        // Deliberately false when the balance could not be read: unknown
        // headroom is not headroom.
        canHonourMax: balance.error === null && balance.value !== null && balance.value >= max,
      }
    })

    return c.json({
      backends,
      relay: deps.relay ? { url: deps.relay.url, connected: deps.relay.isConnected() } : null,
      // Whether the solver is DISCOVERABLE, beside whether it is fundable: a
      // solver nobody can find is not serving anyone however green its rails
      // are. The same object `/api/card` reports, from the same function, so
      // the two views cannot disagree about it — plus the heartbeat, which only
      // this page needs to say when the next republish falls due.
      publish: {
        ...publishStateOf(deps),
        heartbeatSeconds: deps.adPublisher?.heartbeatSeconds() ?? null,
      },
      corridors,
      // Non-null means the limits above are the ENVIRONMENT's, with any stored
      // console overrides missing. Reported rather than thrown, because a
      // console that goes dark over an unreadable preferences table is the
      // failure this page exists to end.
      overridesError: stored.error,
      uptimeSeconds: now() - deps.startedAt,
      mode: deps.mode,
    })
  })
}
