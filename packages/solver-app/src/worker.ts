/**
 * Cloudflare Workers entry: the API, the scheduler, and the queue consumer —
 * one module, three handlers, zero listening ports of our own.
 *
 * - `fetch`      the Hono app (quotes + status), unchanged from Node
 * - `scheduled`  a cron trigger: find every swap that needs driving and either
 *                do the work inline or fan it out one-job-per-swap to a queue
 * - `queue`      the consumer for that fan-out; one message = one swap tick
 *
 * The split matters because Workers have no long-lived process: the Node
 * `watch` loop's "every 3 seconds" becomes "every cron firing", and the
 * per-swap isolation the in-process loop got from `tick`'s in-flight guard is
 * provided here by one queue message per swap. Money-safety does NOT depend on
 * either: the store's compare-and-swap is what makes concurrent drivers safe,
 * and it is runtime-independent.
 *
 * All Cloudflare shapes are STRUCTURAL (no @cloudflare/workers-types
 * dependency): a real Queue/MessageBatch binding satisfies them by shape, and
 * the tests satisfy them with fakes.
 *
 * Deployment caveat, stated plainly: `fetch` + D1 is proven by tests; the
 * scheduled/queue handlers additionally need the Lightning and Arkade SDKs to run
 * inside a Workers isolate, which is NOT yet verified (both hold long-lived
 * connections). Until it is, the supported production split is: this module's
 * `fetch` on Workers, and the money-mover as the Node `watch`/`serve` process.
 * The seam that keeps both options open is `createDeps` in `makeWorkerEntry`.
 *
 * One deliberate asymmetry with the Node loop, so its absence reads as a
 * decision rather than an oversight: the VTXO-lifecycle pass (renewal,
 * recovery and lockup contract registration — `arkade/vtxoLifecycle.ts`, wired
 * into `watchUntilStopped` in `cli.ts`) has NO counterpart here. Every Arkade
 * operation this module drives reaches the wallet indirectly, through the
 * injected services, and `WorkerDeps` carries no Arkade context of its own by
 * design. The lifecycle pass is wallet-level rather than swap-level, so wiring
 * it would mean putting the Arkade wallet itself into `WorkerDeps` — adding
 * the exact unverified dependency the caveat above says this deployment does
 * not yet take. Since that same caveat already places the money-mover on the
 * Node process, the pass belongs where the wallet already lives.
 */

import { buildApp } from '@arkade-os/solver-transport/http/server.js'
import { corridorSetFromDeps, readerSetFromDeps } from './ops/corridorSet.js'
import type { SendSwapService } from '@arkade-os/solver-corridors/send/orchestrator.js'
import type { OnchainSendSwapService } from '@arkade-os/solver-corridors/send/onchainOrchestrator.js'
import type { SwapStore } from '@arkade-os/solver-corridors/db/swaps.js'
import type { OnchainSendSwapStore } from '@arkade-os/solver-corridors/db/onchainSwaps.js'

/** One unit of scheduled work. Versioned like every other payload. `leg`
 * discriminates which store/service a `tick_swap` job belongs to — swap ids
 * are UUIDs from independent stores, so nothing else disambiguates them. */
export type DriveJob =
  { v: 1; type: 'tick_swap'; leg: 'lightning' | 'onchain'; swap_id: string } | { v: 1; type: 'refund_sweep' }

export interface QueueLike<T> {
  send(message: T): Promise<void>
}

export interface QueueMessageLike<T> {
  body: T
  ack(): void
  retry(): void
}

export interface MessageBatchLike<T> {
  messages: readonly QueueMessageLike<T>[]
}

export interface WorkerDeps {
  service: SendSwapService
  store: SwapStore
  onchainService: OnchainSendSwapService
  onchainStore: OnchainSendSwapStore
  network: string
  /**
   * Queue binding for fan-out. Optional on purpose: a small fleet is fine
   * driving every swap inline in the cron invocation, and the queue only
   * earns its keep when one slow swap must not delay the others.
   */
  driveQueue?: QueueLike<DriveJob>
}

export interface Worker {
  fetch: (request: Request) => Response | Promise<Response>
  scheduled: () => Promise<void>
  queue: (batch: MessageBatchLike<DriveJob>) => Promise<void>
}

export const buildWorker = (deps: WorkerDeps): Worker => {
  // Assembled here rather than inside `buildApp`, which now takes the sets. The
  // Workers deployment serves the two send corridors and nothing else, which is
  // exactly what `deps` carries — so the set this builds is the same one the
  // host used to derive for itself.
  const app = buildApp({
    corridors: corridorSetFromDeps(deps),
    readers: readerSetFromDeps(deps),
    network: deps.network,
    // The platform-asserted client address; header spoofing fails on Workers
    // because the edge overwrites it. Per-isolate limiting only, which still
    // bounds what any one address can open per isolate.
    clientKey: (c) => c.req.header('cf-connecting-ip') ?? 'unknown',
  })

  return {
    fetch: (request) => app.fetch(request),

    scheduled: async () => {
      if (!deps.driveQueue) {
        // Inline: tickAll already isolates per-swap failures, and the refund
        // sweep retries anything it could not push on the next firing.
        await deps.service.tickAll()
        await deps.service.refundSweep()
        await deps.onchainService.tickAll()
        await deps.onchainService.refundSweep()
        // Last, and on the sweeps' cadence rather than the refund's: a
        // reclaimed deposit is only settleable once it has confirmed, so this
        // is always finishing an EARLIER firing's refund, never this one's.
        // Caught here, unlike the sweeps above, same reasoning as
        // watchUntilStopped's Node loop (cli.ts): it adds a network call
        // whose failure must not read as the whole cron firing having failed
        // when everything ahead of it already succeeded. The next firing
        // re-lists whatever this pass missed.
        try {
          await deps.onchainService.settleRefundDeposits()
        } catch (error) {
          console.error('onchain refund deposit sweep failed:', error instanceof Error ? error.message : String(error))
        }
        return
      }
      // Fan-out: one message per swap so a slow Lightning poll on one swap
      // cannot eat the whole cron budget, plus one sweep job.
      for (const row of await deps.store.findRecoverable()) {
        await deps.driveQueue.send({ v: 1, type: 'tick_swap', leg: 'lightning', swap_id: row.id })
      }
      for (const row of await deps.onchainStore.findRecoverable()) {
        await deps.driveQueue.send({ v: 1, type: 'tick_swap', leg: 'onchain', swap_id: row.id })
      }
      await deps.driveQueue.send({ v: 1, type: 'refund_sweep' })
    },

    queue: async (batch) => {
      for (const message of batch.messages) {
        try {
          if (message.body.type === 'tick_swap') {
            if (message.body.leg === 'onchain') await deps.onchainService.tick(message.body.swap_id)
            else await deps.service.tick(message.body.swap_id)
          } else {
            await deps.service.refundSweep()
            await deps.onchainService.refundSweep()
            await deps.onchainService.settleRefundDeposits()
          }
          message.ack()
        } catch {
          // The row kept its state (that is the orchestrator's contract), so a
          // redelivery simply resumes from it. Retry, never drop: dropping a
          // tick for an exposed swap is how a claim gets forgotten.
          message.retry()
        }
      }
    },
  }
}

/**
 * Wrap `buildWorker` for a real wrangler entry: deps are built once per
 * isolate from the environment (D1 binding, secrets, queue binding) and cached
 * — isolates are reused across invocations and the wallets are expensive.
 *
 * The deployer owns `createDeps`; it is the one place runtime wiring happens:
 *
 *   export default makeWorkerEntry(async (env: Env) => ({ ...built from env }))
 */
export const makeWorkerEntry = <Env>(createDeps: (env: Env) => Promise<WorkerDeps>) => {
  let cached: Promise<Worker> | undefined
  const worker = (env: Env): Promise<Worker> => {
    if (!cached) {
      const attempt = createDeps(env).then(buildWorker)
      cached = attempt
      // A rejected init must not stay cached: one transient blip during the
      // first invocation would otherwise brick the isolate — every later
      // fetch/scheduled/queue call re-awaiting the same stale rejection until
      // the platform happens to recycle it. Evict so the next invocation
      // retries; the guard keeps a concurrent successful attempt intact.
      attempt.catch(() => {
        if (cached === attempt) cached = undefined
      })
    }
    return cached
  }
  return {
    fetch: async (request: Request, env: Env): Promise<Response> => (await worker(env)).fetch(request),
    scheduled: async (_controller: unknown, env: Env): Promise<void> => (await worker(env)).scheduled(),
    queue: async (batch: MessageBatchLike<DriveJob>, env: Env): Promise<void> => (await worker(env)).queue(batch),
  }
}
