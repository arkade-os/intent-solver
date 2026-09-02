/**
 * The at-a-glance routes: overview, backends, wallet, quotes.
 *
 * Grouped because they answer one question between them — "what is this solver
 * doing right now" — and each is small. Splitting four ~20-line handlers into
 * four files would spread one screenful of the UI across four modules.
 *
 * All read-only.
 */

import type { Hono } from 'hono'
import { CORRIDORS } from '@arkade-os/solver-core/core/corridorPolicy.js'
import { NETWORKS } from '@arkade-os/solver-core/core/networks.js'
import { applyOverrides } from '../settings.js'
import { probeBackends } from '../probes.js'
import { poolPlan } from '../../ops/pool.js'
import { requireLn, requireOnchain } from '../../ops/rails.js'
import {
  projectSend,
  projectReceive,
  projectOnchainSend,
  projectOnchainReceive,
  type AdminSwap,
} from '../projection.js'
import type { AdminDeps } from '../server.js'

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Read a value that depends on a backend, or report why it could not be read.
 *
 * Same discipline as `probes.ts`: an unreachable Lightning node must not take
 * the wallet page down, it must show as unreadable beside the parts that DID
 * answer.
 */
const attempt = async <T>(
  read: () => Promise<T>,
): Promise<{ value: T; error: null } | { value: null; error: string }> => {
  try {
    return { value: await read(), error: null }
  } catch (error) {
    return { value: null, error: messageOf(error) }
  }
}

/**
 * Every swap parked in `stuck`, across all four corridors.
 *
 * A separate read from {@link liveSwaps} because `stuck` is TERMINAL: it is
 * excluded from `findRecoverable`, from every sweep, and from `findRefundable`
 * — all deliberately, since `stuck` means "we may have paid" and a false
 * "failed" verdict plus an automatic refund is a double payout.
 *
 * The consequence nobody had accounted for: a stuck row waits for a human
 * indefinitely, and nothing anywhere said one was waiting. One held 50,151 sats
 * for four days.
 */
/**
 * Rows per corridor on the overview. `stuck` is terminal, so this set only ever
 * GROWS — unbounded, every parked row costs a full-row read on every load and
 * on every SSE event, forever, and the payload grows with it. The count below
 * is read separately so capping the list never understates the problem.
 */
const STUCK_PER_CORRIDOR = 25

const stuckSwaps = async (deps: AdminDeps): Promise<{ rows: AdminSwap[]; total: number }> => {
  const { services } = deps
  // Newest first: `created_at` ascending buries the most recently parked rows —
  // the ones an operator is most likely to be looking for — below a cap that
  // fills with the oldest.
  const page = { limit: STUCK_PER_CORRIDOR, newestFirst: true } as const
  const [send, receive, onchainSend, onchainReceive, ...counts] = await Promise.all([
    services.store.findByStates(['stuck'], page),
    services.receiveStore.findByStates(['stuck'], page),
    services.onchainStore.findByStates(['stuck'], page),
    services.onchainReceiveStore.findByStates(['stuck'], page),
    services.store.countByStates(['stuck']),
    services.receiveStore.countByStates(['stuck']),
    services.onchainStore.countByStates(['stuck']),
    services.onchainReceiveStore.countByStates(['stuck']),
  ])
  return {
    rows: [
      ...send.map(projectSend),
      ...receive.map(projectReceive),
      ...onchainSend.map(projectOnchainSend),
      ...onchainReceive.map(projectOnchainReceive),
    ],
    total: counts.reduce((sum, n) => sum + n, 0),
  }
}

/** Every non-terminal swap, projected — the live set across all four corridors. */
const liveSwaps = async (deps: AdminDeps): Promise<AdminSwap[]> => {
  const { services } = deps
  const [send, receive, onchainSend, onchainReceive] = await Promise.all([
    services.store.findRecoverable(),
    services.receiveStore.findRecoverable(),
    services.onchainStore.findRecoverable(),
    services.onchainReceiveStore.findRecoverable(),
  ])
  return [
    ...send.map(projectSend),
    ...receive.map(projectReceive),
    ...onchainSend.map(projectOnchainSend),
    ...onchainReceive.map(projectOnchainReceive),
  ]
}

export const registerStatusRoutes = (app: Hono, deps: AdminDeps): void => {
  app.get('/api/overview', async (c) => {
    const { services } = deps
    const effective = applyOverrides(services.config, await services.adminStore.getOverrides())
    const live = await liveSwaps(deps)
    const stuck = await stuckSwaps(deps)

    const committed = await Promise.all([
      services.store.committedSats(),
      services.receiveStore.committedSats(),
      services.onchainStore.committedSats(),
      services.onchainReceiveStore.committedSats(),
    ])
    const committedSats = committed.reduce((sum, value) => sum + value, 0)

    // Balances are best-effort: the overview is the first thing an operator
    // loads, and it must render even when a backend is down.
    const [lightning, arkade] = await Promise.all([
      attempt(async () => (await requireLn(services.ln).getBalance()).availableSats),
      attempt(async () => await services.arkade.wallet.getBalance()),
    ])

    return c.json({
      mode: deps.mode,
      network: services.config.network,
      // Sent rather than duplicated in the client: `NETWORKS` is the one table
      // of per-network facts, and a second copy in untyped browser code is a
      // copy that will eventually point a mainnet swap at a signet explorer.
      explorers: NETWORKS[services.config.network].explorers,
      uptimeSeconds: Math.max(0, (deps.now?.() ?? Math.floor(Date.now() / 1000)) - deps.startedAt),
      providerPubkey: services.providerPubkey,
      corridors: CORRIDORS.map((corridor) => ({
        corridor,
        enabled: effective.corridorEnabled[corridor],
        fee: effective.corridorFees[corridor],
        limits: effective.corridorLimits[corridor],
        liveCount: live.filter((swap) => swap.corridor === corridor).length,
        exposedCount: live.filter((swap) => swap.corridor === corridor && swap.phase === 'exposed').length,
      })),
      exposure: {
        committedSats,
        capSats: effective.maxExposedSats,
        // Exposed is the set where the solver has paid out and is not yet
        // whole — the number that actually matters, as distinct from every
        // open swap.
        exposedCount: live.filter((swap) => swap.phase === 'exposed').length,
        liveCount: live.length,
      },
      /**
       * What needs a human, and what the process is currently failing on.
       *
       * `stuck` is terminal and excluded from every sweep — deliberately, since
       * a false "failed" verdict plus an automatic refund is a double payout —
       * so a stuck row waits for an operator indefinitely and NOTHING says so.
       * One sat there four days holding 50,151 sats before anyone looked, and
       * the only reason they did was looking.
       *
       * `failing` is the other half: swaps being backed off after repeated tick
       * failures, which the log now collapses rather than repeating 98 times.
       */
      attention: {
        // The true total, not the length of the capped list below.
        stuckCount: stuck.total,
        stuck: stuck.rows.map((row) => ({
          id: row.id,
          corridor: row.corridor,
          amountSats: row.amountSats,
          updatedAt: row.updatedAt,
          failureReason: row.failureReason,
        })),
        failing: services.tickErrors.failing,
      },
      balances: {
        lightningSats: lightning.value,
        lightningError: lightning.error,
        arkade: arkade.value,
        arkadeError: arkade.error,
      },
    })
  })

  app.get('/api/backends', async (c) => c.json({ backends: await probeBackends(deps.services, deps.relay) }))

  app.get('/api/wallet', async (c) => {
    const { services } = deps
    const [arkadeAddress, arkadeBalance, lightningBalance, feeRate, pool] = await Promise.all([
      attempt(() => services.arkade.wallet.getAddress()),
      attempt(() => services.arkade.wallet.getBalance()),
      attempt(() => requireLn(services.ln).getBalance()),
      attempt(() => requireOnchain(services.onchain).estimateFeeRate()),
      // The pool plan is the answer to "how many swaps can this float fund AT
      // ONCE", which is not the same question as how many sats it holds.
      attempt(() => poolPlan(services)),
    ])

    return c.json({
      arkade: {
        address: arkadeAddress.value,
        addressError: arkadeAddress.error,
        balance: arkadeBalance.value,
        balanceError: arkadeBalance.error,
        pool: pool.value
          ? {
              pieces: [...pool.value.spendable].sort((a, b) => b - a),
              target: pool.value.target,
              plan: pool.value.plan,
            }
          : null,
        poolError: pool.error,
      },
      lightning: { balance: lightningBalance.value, error: lightningBalance.error },
      onchain: { feeRate: feeRate.value, error: feeRate.error },
    })
  })

  app.get('/api/quotes', async (c) => {
    // A quote IS a swap in `quoted` state — insertQuote writes the row — so
    // this is a projection of the same tables rather than a separate store.
    const quoted = (await liveSwaps(deps)).filter((swap) => swap.state === 'quoted')
    return c.json({ quoted, bids: deps.bids?.recent() ?? { entries: [], ephemeral: true, capacity: 0 } })
  })
}
