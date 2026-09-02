/**
 * Operator actions, and the friction in front of the dangerous ones.
 *
 * THE FRICTION IS ENFORCED HERE, NOT IN THE BROWSER. A button is not a security
 * boundary and neither is client-side JavaScript: anyone who can reach this port can
 * `fetch()` it directly. So an armed action's `confirm` is checked in this module
 * BEFORE `run` is called, and the UI's dialog is a convenience asking for the same
 * string. The CLI got this friction for free — you have to type a swap id to refund
 * one — and a button collapses that to a click, so it is put back deliberately.
 *
 * `onchain-refund-now` gets the loudest treatment because refunding a `stuck` row "is
 * correct in some of its cases and A DOUBLE-PAYOUT in others", and it carries that
 * warning to the client so the UI renders the real reason.
 *
 * EVERYTHING IS AUDITED, INCLUDING FAILURES: a refund that threw is precisely the one
 * an operator needs a record of, and a log that only remembers successes lies by
 * omission.
 *
 * Every action calls `src/ops/`, the same functions the CLI calls. No second
 * implementation of a money path lives in this file.
 */

import type { Hono } from 'hono'
import {
  refundNow,
  onchainRefundNow,
  reclaimL1Htlc,
  receiveRefundNow,
  onchainReceiveRefundNow,
  onchainReceiveClaimNow,
} from '../../ops/refunds.js'
import { claimNow, parkSwap } from '../../ops/claims.js'
import { requireLn } from '../../ops/rails.js'
import { mintPool, poolPlan } from '../../ops/pool.js'
import { runFloatLifecycle } from '../../ops/float.js'
import type { Services } from '../../ops/services.js'
import type { AdminDeps } from '../server.js'
import { clampLimit } from '@arkade-os/solver-core/core/page.js'
import { CORRIDORS, isCorridor, type Corridor } from '@arkade-os/solver-core/core/corridorPolicy.js'

export type ActionTier = 'safe' | 'armed'

interface ActionBody {
  id?: unknown
  /** Which corridor's store owns {@link id} — see `requireCorridor`. */
  corridor?: unknown
  confirm?: unknown
  force?: unknown
  /** `claim-now` only: an operator's own preimage, where the backend has none. */
  preimage?: unknown
  /** `park-swap` only: why this row is being stopped. Required, and recorded. */
  reason?: unknown
}

/**
 * What the UI must ask the operator to type.
 *
 * `swap-id` for anything scoped to one row; `literal:WORD` where there is no
 * per-swap identifier and a fixed word supplies the deliberation instead.
 */
export type ConfirmKind = 'swap-id' | `literal:${string}`

interface ActionShape {
  /** What this action acted on, for the audit row. */
  target?: (body: ActionBody) => string | null
  /** Rendered by the UI above the confirm box. Only where the danger is non-obvious. */
  warning?: string
  run: (services: Services, body: ActionBody) => Promise<unknown>
}

/**
 * An action, with the friction an ARMED one cannot be defined without.
 *
 * A union rather than one interface with optional fields, so the compiler refuses an
 * armed action with no prompt rather than letting the UI invent one. Deriving
 * `confirmKind` from the action's NAME instead would let a new armed action that is not
 * swap-scoped silently inherit `swap-id`, prompting for an identifier that does not
 * exist — unusable through the console while looking well-formed here.
 *
 * `expectedConfirm` is required for the same reason: it is what the server checks, and
 * an armed action without it would fall through to `?? null` and reject every request.
 */
export type ActionDefinition =
  | (ActionShape & { tier: 'safe' })
  | (ActionShape & {
      tier: 'armed'
      /** What the UI asks for. @see ConfirmKind */
      confirmKind: ConfirmKind
      /**
       * What `confirm` must equal, given the request body. Returning null means
       * the body was malformed enough that no confirmation could match — the
       * caller gets a 400 either way.
       */
      expectedConfirm: (body: ActionBody) => string | null
    })

const requireId = (body: ActionBody): string => {
  if (typeof body.id !== 'string' || body.id.length === 0) throw new Error('id is required')
  return body.id
}

/**
 * An operator's own `P`, where they have one from outside the backend.
 *
 * Not validated here beyond its type: `claimNow` refuses any preimage that does
 * not hash to the row's payment hash, and that check is the one that matters —
 * a weaker duplicate here would only be a second answer to disagree with.
 */
const optionalPreimage = (body: ActionBody): string | undefined =>
  typeof body.preimage === 'string' && body.preimage.length > 0 ? body.preimage : undefined

/** Why a row is being parked. Required: the row outlives the operator's memory. */
const requireReason = (body: ActionBody): string => {
  if (typeof body.reason !== 'string' || body.reason.trim().length === 0) {
    throw new Error('reason is required: a parked row with no explanation is a mystery later')
  }
  return body.reason
}

const idConfirm = (body: ActionBody): string | null => (typeof body.id === 'string' ? body.id : null)
const idTarget = (body: ActionBody): string | null => (typeof body.id === 'string' ? body.id : null)

/**
 * The corridor whose store owns this id.
 *
 * Required rather than inferred, and that is not pedantry: a swap id is unique
 * within its OWN corridor's store, so trying each store in turn would tick
 * whichever corridor answered first — the wrong swap, on a collision, driven a
 * step down a money path. The console always knows the corridor because every
 * row it renders carries one.
 */
const requireCorridor = (body: ActionBody): Corridor => {
  const corridor = body.corridor
  if (typeof corridor !== 'string' || !isCorridor(corridor)) {
    throw new Error(`corridor is required and must be one of ${CORRIDORS.join(', ')}`)
  }
  return corridor
}

/**
 * Each corridor's orchestrator, or undefined where the operator disabled it.
 *
 * All four are optional on {@link Services} by design — a deployment constructs
 * only the corridors it serves — so an absent one is a normal answer, not a bug,
 * and has to read as "not enabled here" rather than a crash.
 */
const serviceFor = (services: Services, corridor: Corridor): { tick(id: string): Promise<unknown> } | undefined => {
  switch (corridor) {
    case 'arkade:BTC->lightning:BTC':
      return services.service
    case 'lightning:BTC->arkade:BTC':
      return services.receiveService
    case 'arkade:BTC->onchain:BTC':
      return services.onchainService
    case 'onchain:BTC->arkade:BTC':
      return services.onchainReceiveService
  }
}

export const ACTIONS: Record<string, ActionDefinition> = {
  /**
   * Drive one swap a single step. Safe because it is exactly what the sweep
   * does on its own cadence — the orchestrators are re-entrant by contract and
   * re-read the row first, so an extra tick costs one redundant pass.
   */
  tick: {
    tier: 'safe',
    target: idTarget,
    run: async (services, body) => {
      const id = requireId(body)
      const corridor = requireCorridor(body)
      const service = serviceFor(services, corridor)
      if (!service) throw new Error(`the ${corridor} corridor is not enabled on this deployment`)
      return { row: await service.tick(id) }
    },
  },

  /**
   * Ask the Lightning backend what became of this swap's payment.
   *
   * The one question a `stuck` row cannot answer about itself: it means the payment was
   * ALREADY EXPOSED when it failed, and it is terminal, so `tick` re-polls nothing.
   *
   * Safe, and specifically safer than a hand-written script: it reuses the running
   * solver's OWN backend connection. Initialising a second wallet on the same mnemonic
   * starts the SDK's background leaf optimisation, and tearing it down mid-flight
   * interrupts a claim — observed in production.
   *
   * NEVER returns the preimage. Knowing one EXISTS is what decides refund-versus-claim;
   * the value itself would then live in a browser, a screenshot and a support thread.
   */
  'read-payment': {
    tier: 'safe',
    target: idTarget,
    run: async (services, body) => {
      const id = requireId(body)
      const corridor = requireCorridor(body)
      if (corridor !== 'arkade:BTC->lightning:BTC') {
        throw new Error(`read-payment is for the Lightning send corridor; ${corridor} pays over a different rail`)
      }
      // Read once: this action is entirely about the Lightning send corridor,
      // which cannot exist without a rail, so a missing one is a refusal here
      // rather than five null checks below.
      const ln = requireLn(services.ln)
      const row = await services.store.get(id)
      if (!row.paymentId) {
        // A missing id is NOT proof that nothing was submitted, and reading it
        // that way is a double payout waiting to happen. A backend can commit
        // our funds against the payment hash one call BEFORE the call that
        // mints the id — observed on a production rail — so a failure in
        // between leaves sats committed with no id naming them, which is the
        // exact row an operator reads this action for. Ask by hash first.
        const probe = ln.getSendHtlcState
        if (!probe) {
          // A backend that cannot be asked. Kept as the old answer because on a
          // backend with no commit-before-id gap it is the true one, but the
          // caveat is reported rather than hidden.
          return { paymentId: null, commitment: 'probe-unavailable' as const, verdict: 'never-submitted' as const }
        }
        let committed
        try {
          committed = await probe.call(ln, row.paymentHash)
        } catch {
          // Could not tell. That is not "nothing committed", and must not
          // authorise a refund.
          return { paymentId: null, commitment: 'probe-failed' as const, verdict: 'undecided-push-nothing' as const }
        }
        if (committed === null) {
          // Now earned: the backend holds nothing against this hash, so nothing
          // was ever taken.
          return { paymentId: null, commitment: 'none' as const, verdict: 'never-submitted' as const }
        }
        const seenByHash = {
          paymentId: null,
          commitment: committed.status,
          hasPreimage: Boolean(committed.preimage),
        }
        // A commitment the payee revealed against IS settlement, with or
        // without an id to name it.
        if (committed.status === 'settled') return { ...seenByHash, verdict: 'paid-do-not-refund' as const }
        if (committed.status === 'returned') return { ...seenByHash, verdict: 'not-paid-refund-is-safe' as const }
        // `committed`: the sats are at stake and the payee has not revealed.
        return { ...seenByHash, verdict: 'undecided-push-nothing' as const }
      }
      // Before blaming the backend: was this payment even made from the wallet
      // we are running? A payment id is meaningful only to the backend that
      // minted it, pointed at the seed it was minted from — and after a
      // provider or seed change the lookup fails EXACTLY like a sick database.
      // Reporting that as `undecided` sends an operator to debug a backend that
      // is working perfectly.
      //
      // Null on either side is UNKNOWN, never a match: rows written before this
      // was recorded must not be claimed as ours.
      const running = await ln.walletFingerprint?.().catch(() => undefined)
      const foreignWallet = Boolean(running && row.paymentWallet && row.paymentWallet !== running)
      const foreignBackend = Boolean(row.paymentBackend && row.paymentBackend !== services.config.lnBackend)
      if (foreignWallet || foreignBackend) {
        return {
          paymentId: row.paymentId,
          paidBy: { backend: row.paymentBackend, wallet: row.paymentWallet },
          runningNow: { backend: services.config.lnBackend, wallet: running ?? null },
          verdict: 'other-wallet-push-nothing' as const,
        }
      }

      let payment
      try {
        payment = await ln.getPayment(row.paymentId)
      } catch (error) {
        // The id was allocated but the backend has no record of it — one of the
        // exact rows this action exists for, since `submitPayment` can fail
        // between allocating an id and persisting it. NOT proof nothing was
        // sent, though: a backend that has forgotten a payment looks identical
        // from here. So no verdict that authorises a push.
        return {
          paymentId: row.paymentId,
          error: error instanceof Error ? error.message : String(error),
          verdict: 'undecided-push-nothing' as const,
        }
      }
      const hasPreimage = Boolean(payment.preimage)
      // Spelled out rather than left to the reader: this is the decision the
      // operator is about to make with real money, and "succeeded" next to a
      // refund button has been misread before.
      const seen = { paymentId: row.paymentId, status: payment.status, hasPreimage }
      // A preimage IS settlement, whatever the status word says.
      if (payment.status === 'succeeded' || hasPreimage) {
        return { ...seen, verdict: 'paid-do-not-refund' as const }
      }
      if (payment.status !== 'failed') return { ...seen, verdict: 'undecided-push-nothing' as const }

      // A payer-side "failed" is not enough ON ITS OWN, and this is the case
      // that parks in `stuck` — so it is the case an operator most often reads
      // this action for. `refundProvenSelfPayment` withholds the refund when our
      // OWN node holds an armed or settled htlc for this invoice, because the
      // payee side may still collect. Answering `not-paid-refund-is-safe` here
      // would steer the operator into exactly the double payout that withhold
      // exists to prevent, so run the same probe and mirror its rule.
      const probeOwnInvoice = ln.getOwnInvoiceState
      let own = null
      // Reported verbatim, because "we could not check" is a different fact
      // from "we checked and it is not ours", and only one of them means the
      // operator should go and look at the node themselves.
      let probe: string
      if (probeOwnInvoice === undefined) probe = 'probe-unavailable'
      else {
        try {
          own = (await probeOwnInvoice.call(ln, row.paymentHash)) ?? null
          probe = own === null ? 'not-ours' : own.status
        } catch {
          // Same as the orchestrator: a probe that could not run teaches nothing
          // about the payee side, so the terminal-failure rule stands alone.
          probe = 'probe-failed'
        }
      }
      if (own !== null && own.status !== 'pending' && own.status !== 'cancelled') {
        return { ...seen, ownInvoice: probe, verdict: 'self-payment-do-not-refund' as const }
      }
      return { ...seen, ownInvoice: probe, verdict: 'not-paid-refund-is-safe' as const }
    },
  },

  /** Read the float's shape. Spends nothing; the dry run of `pool-mint`. */
  'pool-plan': {
    tier: 'safe',
    run: async (services) => {
      const { spendable, target, plan } = await poolPlan(services)
      return { pieces: [...spendable].sort((a, b) => b - a), target, plan }
    },
  },

  'refund-now': {
    tier: 'armed',
    confirmKind: 'swap-id',
    expectedConfirm: idConfirm,
    target: idTarget,
    warning:
      'Pushes the covenant refund for this swap immediately, bypassing the deadline gate that deliberately ' +
      'excludes swaps which were ever exposed. Only do this after looking at the row and deciding a refund is warranted.',
    run: (services, body) => refundNow(services, requireId(body)),
  },

  /**
   * The other answer to a stuck send, and the opposite of `refund-now`.
   *
   * Reach for it when `read-payment` comes back `paid-do-not-refund` — the row
   * whose sats were committed against the payment hash before any id named
   * them. Pushes nothing itself: it records the preimage and returns the row to
   * `claiming` so the sweep moves the money through the same path every other
   * claim takes. Armed because that is a state change on an exposed row, and
   * because the swap it fits is one where the WRONG button is the expensive one.
   */
  'claim-now': {
    tier: 'armed',
    confirmKind: 'swap-id',
    expectedConfirm: idConfirm,
    target: idTarget,
    warning:
      'For this swap the solver ALREADY PAID. Records the preimage and returns the row to claiming so the sweep ' +
      'pushes the claim. Run read-payment first: if it says paid-do-not-refund then refunding this row instead ' +
      'is the DOUBLE-PAYOUT, and this is the action that avoids it. Refuses any preimage that does not hash to ' +
      'the row’s payment hash.',
    run: (services, body) => claimNow(services, requireId(body), optionalPreimage(body)),
  },

  /**
   * Stop driving a swap that cannot make progress, and say why on the row.
   *
   * The console had no way to do this at all. A row whose every tick throws was
   * re-driven by the sweep indefinitely — `tick` drives it again, `refund-now`
   * does not change state — so stopping one meant a hand-written script against
   * the live database inside the container. Swap d69041e8 retried on mainnet
   * for six days before anyone could park it.
   *
   * Armed because it forecloses the automatic path: whatever the row might
   * still have resolved into on its own, it will not now.
   */
  'park-swap': {
    tier: 'armed',
    confirmKind: 'swap-id',
    expectedConfirm: idConfirm,
    target: idTarget,
    warning:
      'STOPS this swap being driven. The sweep will not touch it again and it cannot resolve itself afterwards; an ' +
      'exposed row lands in `stuck` for a human, an unexposed one in `refused`. Use it when a swap is failing in a ' +
      'way that retrying cannot fix. It does NOT refund or claim — decide that separately, with read-payment.',
    run: (services, body) => parkSwap(services, requireId(body), requireReason(body)),
  },

  'onchain-refund-now': {
    tier: 'armed',
    confirmKind: 'swap-id',
    expectedConfirm: idConfirm,
    target: idTarget,
    warning:
      'REFUNDS THE CLIENT THEIR ARKADE LOCKUP. For a `stuck` row this is correct in some cases and A DOUBLE-PAYOUT ' +
      'in others — the solver may already have paid out on the onchain leg. Read the row and the onchain HTLC first. ' +
      'This does not touch the solver’s own L1 HTLC; that is reclaim-l1-htlc.',
    run: (services, body) => onchainRefundNow(services, requireId(body)),
  },

  /**
   * The two RECEIVE legs, and the reason they read less alarming than the send
   * ones above: this money is the solver's own. The receive corridors fund the
   * Arkade lockup out of the float, so refunding recovers our sats rather than
   * handing the client theirs — there is no double payout to walk into.
   *
   * Still armed, for the hazard that IS here: refunding while the client can
   * still claim spends the output out from under them and fails their held
   * payment back to the payer. Nobody is out of pocket, but a live swap dies.
   */
  'receive-refund-now': {
    tier: 'armed',
    confirmKind: 'swap-id',
    expectedConfirm: idConfirm,
    target: idTarget,
    warning:
      "RECOVERS THE SOLVER'S OWN Arkade lockup on the lightning:BTC->arkade:BTC leg — this money is ours, not the " +
      'client’s. The risk here is different from the send legs: if the client can still claim, this spends the ' +
      'output out from under them and their held payment fails back to the payer, killing a live swap. Read the ' +
      'row first; on a `stuck` row this is the only way out.',
    run: (services, body) => receiveRefundNow(services, requireId(body)),
  },

  'onchain-receive-refund-now': {
    tier: 'armed',
    confirmKind: 'swap-id',
    expectedConfirm: idConfirm,
    target: idTarget,
    warning:
      "RECOVERS THE SOLVER'S OWN Arkade lockup on the onchain:BTC->arkade:BTC leg. Same direction and same caveat " +
      'as receive-refund-now: our money, but refunding under a client who can still claim kills a live swap.',
    run: (services, body) => onchainReceiveRefundNow(services, requireId(body)),
  },

  /**
   * The fee-dust retry, and the one operator action here that carries no
   * judgement call at all: every attempt spends the SAME output, so a
   * redundant broadcast is a double-spend the network rejects. Armed anyway,
   * because it is a broadcast — but the warning says what it is rather than
   * inventing a hazard.
   */
  'onchain-receive-claim-now': {
    tier: 'armed',
    confirmKind: 'swap-id',
    expectedConfirm: idConfirm,
    target: idTarget,
    warning:
      "Retries the solver's own claim of the CLIENT's L1 HTLC at today's fee rate, for a row that parked in " +
      '`stuck` because the fee once left less than dust. Safe to repeat — every attempt spends the same output, ' +
      'so a redundant broadcast is a double-spend the network rejects, never a second payout. Refuses with both ' +
      'numbers if the fee still eats the payout.',
    run: (services, body) => onchainReceiveClaimNow(services, requireId(body)),
  },

  'reclaim-l1-htlc': {
    tier: 'armed',
    confirmKind: 'swap-id',
    expectedConfirm: idConfirm,
    target: idTarget,
    warning:
      "Re-broadcasts the solver's own Bitcoin L1 HTLC refund, to the solver. Safe to repeat — both legs spend the " +
      'same output, so a redundant refund is a double-spend the network rejects rather than a second payout.',
    run: (services, body) => reclaimL1Htlc(services, requireId(body)),
  },

  /**
   * Renew and recover the solver's OWN float, now rather than on the loop's
   * five-minute cadence.
   *
   * Armed because it settles. It is also the action most likely to be reached
   * for while something is already wrong — a float that has aged into
   * `recoverable` reads healthy on `total` and funds nothing, so every corridor
   * refuses with a reason that names the corridor rather than the float.
   *
   * Runs the SAME pass the daemon runs, deliberately: recovery puts every
   * recoverable output into one settlement, and a lockup still short of its
   * CLTV fails that whole batch. `runFloatLifecycle` holds recovery back when
   * that would happen and reports `recoverySkipped`. A manual path that skipped
   * that guard would be the dangerous half of a duplicated money path.
   */
  'float-lifecycle': {
    tier: 'armed',
    confirmKind: 'literal:FLOAT',
    warning:
      'Settles: renews VTXOs near expiry and recovers any the server has swept, in one pass. Recovery is held back ' +
      'when a live lockup is still short of its refund deadline, because that would fail the whole settlement and ' +
      'take unrelated coins with it — the response says so as `recoverySkipped`.',
    expectedConfirm: () => 'FLOAT',
    // `runFloatLifecycle` never throws - the report was built for a watch loop
    // that must not die - so this route would answer HTTP 200 `{ok: true}` even
    // when renewal AND recovery both failed. The failures are in the body, but a
    // 200 read on its own says the opposite of what happened, and this module's
    // own rule is that a log which only remembers successes lies by omission.
    //
    // So the result carries its own verdict, at the top level where a renderer
    // and the audit row's `detail` both see it without having to know what a
    // `VtxoLifecycleReport` is. `settled` is the honest word: recovery held back
    // by the CLTV guard is neither a failure nor a settlement.
    run: async (services) => {
      const report = await runFloatLifecycle(services)
      return {
        ...report,
        ok: report.failures.length === 0,
        settled: report.renewed !== null || report.recovered !== null,
      }
    },
  },
  'pool-mint': {
    tier: 'armed',
    // A literal rather than an id: there is no per-swap identifier to type, and
    // a fixed word still forces a deliberate second action.
    confirmKind: 'literal:MINT',
    expectedConfirm: () => 'MINT',
    warning:
      'Spends: splits the float into smaller pieces in one Arkade transaction. Refused while any corridor has a ' +
      'non-terminal swap, because coin reservations are process-local and a concurrent provider could be holding them.',
    run: (services, body) => mintPool(services, { force: body.force === true }),
  },
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const registerActionRoutes = (app: Hono, deps: AdminDeps): void => {
  /** So the UI can render buttons, tiers and warnings without hardcoding them. */
  app.get('/api/actions', (c) =>
    c.json({
      actions: Object.entries(ACTIONS).map(([name, definition]) => ({
        name,
        tier: definition.tier,
        warning: definition.warning ?? null,
        // Read off the definition, never re-derived here. @see ActionDefinition
        confirmKind: definition.tier === 'armed' ? definition.confirmKind : null,
      })),
    }),
  )

  app.post('/api/actions/:name', async (c) => {
    const name = c.req.param('name')
    const definition = ACTIONS[name]
    if (!definition) return c.json({ error: 'unknown_action', action: name }, 404)

    let body: ActionBody = {}
    try {
      const parsed: unknown = await c.req.json()
      body = (parsed ?? {}) as ActionBody
    } catch {
      // An armed action with no body cannot possibly carry a confirmation, and
      // a safe one may legitimately have none.
      body = {}
    }

    if (definition.tier === 'armed') {
      const expected = definition.expectedConfirm?.(body) ?? null
      if (expected === null || body.confirm !== expected) {
        // Checked BEFORE run, and nothing is audited: no action was attempted,
        // so an audit row would record something that never happened.
        return c.json(
          {
            error: 'confirm_required',
            message: `this action requires a matching \`confirm\` field${expected ? '' : ' and a valid target'}`,
            warning: definition.warning ?? null,
          },
          400,
        )
      }
    }

    const target = definition.target?.(body) ?? null
    // The body is echoed into the audit row, minus `confirm` — it carries no
    // secret, but recording the ceremony alongside the action is noise.
    const params = JSON.stringify({ ...body, confirm: undefined })

    try {
      const result = await definition.run(deps.services, body)
      await deps.services.adminStore.recordAction({
        action: name,
        target,
        params,
        outcome: 'ok',
        detail: JSON.stringify(result).slice(0, 500),
      })
      return c.json({ ok: true, result })
    } catch (error) {
      await deps.services.adminStore.recordAction({
        action: name,
        target,
        params,
        outcome: 'error',
        detail: messageOf(error),
      })
      // 500 with a readable body rather than a thrown fault: the operator needs
      // the reason, and the action WAS attempted, unlike a confirm failure.
      return c.json({ ok: false, error: 'action_failed', message: messageOf(error) }, 500)
    }
  })

  app.get('/api/audit', async (c) => {
    // Validated and capped, the same way `pageQuery` treats its own limit.
    // Unbounded, `?limit=999999` hands SQLite a million-row request; unchecked,
    // `Number('abc')` is NaN and better-sqlite3 coerces `LIMIT NaN` to zero —
    // so a typo would silently return an EMPTY audit log, and an operator
    // seeing no entries would conclude no actions had been taken.
    const raw = c.req.query('limit')
    let limit: number | undefined
    try {
      limit = raw === undefined ? undefined : clampLimit(Number(raw))
    } catch (error) {
      return c.json({ error: 'bad_request', message: error instanceof Error ? error.message : String(error) }, 400)
    }
    return c.json({ actions: await deps.services.adminStore.listActions(limit) })
  })
}
