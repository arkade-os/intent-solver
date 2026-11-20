import { DriveSwap } from '@arkade-os/solver-next/application/drive_swap.js'
import { Conflict } from '@arkade-os/solver-next/domain/shared/error.js'
import type { SwapId } from '@arkade-os/solver-next/domain/shared/ids.js'
import type { Side } from '@arkade-os/solver-next/domain/swap/leg.js'
import type { LegStatus, Observation } from '@arkade-os/solver-next/domain/swap/observation.js'
import { plan, type Policies } from '@arkade-os/solver-next/domain/swap/plan.js'
import { Quote } from '@arkade-os/solver-next/domain/swap/quote.js'
import { Swap } from '@arkade-os/solver-next/domain/swap/swap.js'
import type { SwapEvent } from '@arkade-os/solver-next/domain/swap/swap_event.js'
import { SwapState } from '@arkade-os/solver-next/domain/swap/swap_state.js'
import type { RailService, SendResult } from '@arkade-os/solver-next/application/rail_service.js'
import { btc, ref, SECRET, t, terms } from '../domain/support.js'
import type { Choice, Run } from './explore.js'

/** Times are small integers. Only their order matters, as in the TLA+ models. */
export interface Scenario {
  readonly maxClock: number
  readonly quoteUntil: number
  /** When our refund of the payout opens. */
  readonly payoutRefundAt: number
  /** When the client can take their own lock back. */
  readonly clientRefundAt: number
  readonly workers: number
  readonly crashes: number
  /** The rail shows a payout only after the indexer catches up. */
  readonly laggingIndexer: boolean
  readonly policies: (scenario: Scenario) => Policies
}

type SpentBy = 'nobody' | 'us' | 'client'

const BASE = 1_000
const SWAP: SwapId = terms.id
const SENT = (reference: string): SendResult => ({ status: 'sent', reference: ref(reference) })
const NOT_SENT: SendResult = { status: 'not_sent' }

/** The rules of the route under test. */
export const guarded = (scenario: Scenario): Policies => ({
  // Pay out only if our refund opens before the client's refund, and the client's has not opened yet.
  canFill: (_swap, seen) => {
    const { expiresAt } = seen.from
    const { refundOpensAt } = seen.to
    if (expiresAt === null || refundOpensAt === null) return { ok: false, reason: 'deadlines unknown' }
    if (seen.now >= expiresAt) return { ok: false, reason: 'the client can already refund' }
    return refundOpensAt < expiresAt ? { ok: true } : { ok: false, reason: 'our refund opens too late' }
  },
  acceptsOverfunding: false,
  onLockFailed: () => 'stuck',
  // Do not resend at once: another worker's send may still be running.
  // Do not resend at all if the rail can show a payout late: then a missing payout may still appear.
  onLockMissing: (swap, seen) => (!scenario.laggingIndexer && seen.now > swap.to.since ? 'retry' : 'wait'),
  canCollect: () => ({ ok: true }),
  onClaimFailed: () => 'retry',
  onRefundFailed: () => 'retry',
  onSpentUnknown: () => 'stuck',
  canRelease: () => true,
})

export const start = (scenario: Scenario) => (): Run => {
  let clock = 0
  let funded = false
  let payouts = 0
  let visible = 0
  let deposit: SpentBy = 'nobody'
  let payout: SpentBy = 'nobody'
  let crashes = scenario.crashes
  const history: SwapEvent[] = []
  const policies = scenario.policies(scenario)

  const now = () => t(BASE + clock)
  const load = (): Swap => Swap.fromEvents(history)
  const seen = (side: Side): LegStatus => {
    const none = { lock: 'none', claim: 'none', refund: 'none', refundOpen: false, matured: false } as const
    const deadlines = {
      expiresAt: t(BASE + scenario.clientRefundAt),
      refundOpensAt: t(BASE + scenario.payoutRefundAt),
      refundAloneDelay: null,
      lockReference: null,
    }
    if (side === 'from') {
      return {
        ...none,
        ...deadlines,
        funding: funded ? 'exact' : 'none',
        matured: funded,
        spent: deposit === 'client' ? { by: 'refund' } : { by: 'nobody' },
        claim: deposit === 'us' ? 'landed' : 'none',
      }
    }
    return {
      ...none,
      ...deadlines,
      funding: 'none',
      lock: visible > 0 ? 'landed' : 'none',
      spent: payout === 'client' ? { by: 'claim', preimage: SECRET } : { by: 'nobody' },
      refund: payout === 'us' ? 'landed' : 'none',
      refundOpen: payouts > 0 && payout === 'nobody' && clock >= scenario.payoutRefundAt,
    }
  }
  const observation = (): Observation => ({
    now: now(),
    from: seen('from'),
    to: seen('to'),
    peer: null,
    keyCurrent: true,
    approval: 'not_required',
    ownInvoice: false,
  })

  history.push(
    ...Swap.quote({
      ...terms,
      quote: Quote.of(t(BASE + scenario.quoteUntil), { fee: btc(10n), spreadBps: 0 }),
      at: now(),
    }).changes,
  )

  interface Gate {
    readonly label: string
    readonly effect: () => unknown
    readonly moves: boolean
    readonly resolve: (value: unknown) => void
    readonly reject: (error: unknown) => void
  }
  const waiting = new Map<number, Gate>()
  const busy = new Set<number>()
  const memory = new Map<number, string>()

  const gate = <T>(worker: number, label: string, effect: () => T, moves = false): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      waiting.set(worker, { label, effect, moves, resolve: resolve as (value: unknown) => void, reject })
    })

  const workerFor = (worker: number): DriveSwap => {
    const rail: RailService = {
      status: async (_swap, side) => seen(side),
      lock: () =>
        gate(
          worker,
          'send-lock',
          () => ((payouts += 1), scenario.laggingIndexer || (visible = payouts), SENT('payout')),
          true,
        ),
      claim: () =>
        gate(
          worker,
          'send-claim',
          () => (funded && deposit === 'nobody' ? ((deposit = 'us'), SENT('collect')) : NOT_SENT),
          true,
        ),
      refund: (_swap, side) =>
        gate(
          worker,
          'send-refund',
          () => {
            if (side === 'from')
              return funded && deposit === 'nobody' ? ((deposit = 'client'), SENT('returned')) : NOT_SENT
            const open = payouts > 0 && payout === 'nobody' && clock >= scenario.payoutRefundAt
            return open ? ((payout = 'us'), SENT('refund')) : NOT_SENT
          },
          true,
        ),
    }
    return new DriveSwap({
      now,
      policies,
      rails: { from: rail, to: rail },
      context: async () => ({ peer: null, keyCurrent: true, approval: 'not_required', ownInvoice: false }),
      swaps: {
        get: () =>
          gate(worker, 'read', () => {
            memory.set(worker, `${history.length}|${JSON.stringify(observation())}`)
            return load()
          }),
        update: (_id, change) =>
          gate(worker, 'write', () => {
            const swap = load()
            void change(swap)
            if (swap.version !== history.length) throw new Conflict('raced')
            history.push(...swap.changes)
            return load()
          }),
      },
    })
  }

  const begin = (worker: number): void => {
    busy.add(worker)
    const done = (): void => {
      busy.delete(worker)
      memory.delete(worker)
    }
    workerFor(worker).step(SWAP).then(done, done)
  }
  const pass = (worker: number, gated: Gate): void => {
    waiting.delete(worker)
    try {
      gated.resolve(gated.effect())
    } catch (error) {
      gated.reject(error)
    }
  }
  // The worker dies: it forgets everything and never gets the answer it was waiting for.
  const kill = (worker: number, gated: Gate, afterEffect: boolean): void => {
    crashes -= 1
    waiting.delete(worker)
    busy.delete(worker)
    memory.delete(worker)
    if (afterEffect) gated.effect()
  }

  const idle = (): boolean => busy.size === 0
  const settledOrWaiting = (): boolean => plan(load(), observation(), policies).do === 'wait'

  return {
    choices(): Choice[] {
      const choices: Choice[] = []
      for (let worker = 0; worker < scenario.workers; worker++) {
        const gated = waiting.get(worker)
        if (gated) {
          choices.push({ label: `w${worker}:${gated.label}`, run: () => pass(worker, gated) })
          if (crashes > 0) {
            choices.push({ label: `w${worker}:crash`, run: () => kill(worker, gated, false) })
            if (gated.moves)
              choices.push({ label: `w${worker}:${gated.label}:lost`, run: () => kill(worker, gated, true) })
          }
          // Workers are identical, so worker 1 starts only when worker 0 is busy. Fewer duplicate paths.
        } else if (!busy.has(worker) && [...Array(worker).keys()].every((w) => busy.has(w))) {
          if (!SwapState.isTerminal(load().state) || !settledOrWaiting()) {
            choices.push({ label: `w${worker}:start`, run: () => begin(worker) })
          }
        }
      }
      if (!funded) choices.push({ label: 'client:fund', run: () => void (funded = true) })
      if (payouts > 0 && payout === 'nobody') {
        choices.push({ label: 'client:claim', run: () => void (payout = 'client') })
      }
      if (funded && deposit === 'nobody' && clock >= scenario.clientRefundAt) {
        choices.push({ label: 'client:refund', run: () => void (deposit = 'client') })
      }
      if (visible < payouts) choices.push({ label: 'indexer:catch-up', run: () => void (visible = payouts) })
      // Time moves only when the solver has nothing to do (assumption A2 in the TLA+ models).
      if (clock < scenario.maxClock && idle() && settledOrWaiting()) {
        choices.push({ label: 'tick', run: () => void (clock += 1) })
      }
      return choices
    },

    fingerprint(): string {
      const swap = load()
      const workers = [...Array(scenario.workers).keys()].map(
        (w) => `${waiting.get(w)?.label ?? (busy.has(w) ? 'busy' : 'idle')}@${memory.get(w) ?? ''}`,
      )
      return JSON.stringify([
        clock,
        funded,
        payouts,
        visible,
        deposit,
        payout,
        crashes,
        swap.from.state,
        swap.to.state,
        swap.outcome,
        swap.preimage,
        swap.to.reference('funding'),
        workers,
      ])
    },

    violated(): string | null {
      const { state } = load()
      if (payouts > 1) return 'NoDoubleFund'
      if (payout === 'client' && deposit === 'client') return 'NoNetLoss'
      const out = payouts > 0 && payout !== 'us'
      if (out && deposit !== 'us' && SwapState.isTerminal(state) && state !== 'stuck' && state !== 'lost') {
        return 'NoSilentLoss'
      }
      if (state === 'settled' && !(deposit === 'us' && payout === 'client')) return 'SettledMeansCollected'
      return null
    },
  }
}
