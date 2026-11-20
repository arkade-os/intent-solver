import { Conflict, RuleViolated } from '../domain/shared/error.js'
import type { SwapId } from '../domain/shared/ids.js'
import type { UnixSeconds } from '../domain/shared/time.js'
import { ReferenceKind, Side, type LegState } from '../domain/swap/leg.js'
import { NOT_SEEN, type Observation } from '../domain/swap/observation.js'
import { Action, legsToRead, plan, type Decision, type Policies, type Recorded } from '../domain/swap/plan.js'
import type { Swap } from '../domain/swap/swap.js'
import type { SwapRepository } from '../domain/swap/swap_repo.js'
import { SendStatus, type RailService } from './rail_service.js'

/** What a decision needs to know besides the two rails. */
export type SwapContext = Pick<Observation, 'peer' | 'keyCurrent' | 'approval' | 'ownInvoice'>

/** A route is its rules and its two rails. The steps below are the same for every route. */
export interface DriveSwapDeps {
  readonly swaps: Pick<SwapRepository, 'get' | 'update'>
  readonly policies: Policies
  readonly rails: Readonly<Record<Side, RailService>>
  readonly context: (swap: Swap) => Promise<SwapContext>
  readonly now: () => UnixSeconds
}

/** Another worker changed the swap first, so this one did nothing. */
export const SKIPPED = 'skipped'
/** The rail did not confirm a send. The next tick tries again; asking again at once would only hammer the rail. */
export const NOT_SENT = 'not_sent'
export type StepResult = Action | typeof SKIPPED | typeof NOT_SENT

type SendAction = typeof Action.Lock | typeof Action.Claim | typeof Action.Refund

const SENDING_STATE: Record<SendAction, LegState> = { lock: 'locking', claim: 'claiming', refund: 'refunding' }
const REFERENCE_KIND: Record<SendAction, ReferenceKind> = { lock: 'funding', claim: 'claim', refund: 'refund' }

const MAX_STEPS = 32

export class DriveSwap {
  constructor(private readonly deps: DriveSwapDeps) {}

  /** Repeat `step` until there is nothing to do right now. */
  async drive(id: SwapId): Promise<StepResult> {
    for (let i = 0; i < MAX_STEPS; i++) {
      const result = await this.step(id)
      if (result === Action.Wait || result === SKIPPED || result === NOT_SENT) return result
    }
    throw new RuleViolated(`swap ${id}: still not finished after ${MAX_STEPS} steps`)
  }

  /** Load the swap, look at both rails, decide one thing, do it. Nothing is remembered between calls. */
  async step(id: SwapId): Promise<StepResult> {
    const swap = await this.deps.swaps.get(id)
    if (swap === null) throw new RuleViolated(`swap ${id} does not exist`)
    const decision = plan(swap, await this.observe(swap), this.deps.policies)
    try {
      const sent = await this.apply(swap, decision)
      return sent === false ? NOT_SENT : decision.do
    } catch (error) {
      if (error instanceof Conflict) return SKIPPED
      throw error
    }
  }

  private async observe(swap: Swap): Promise<Observation> {
    const { rails, context, now } = this.deps
    const read = legsToRead(swap)
    const [from, to, rest] = await Promise.all([
      read.from ? rails.from.status(swap, Side.From) : NOT_SEEN,
      read.to ? rails.to.status(swap, Side.To) : NOT_SEEN,
      context(swap),
    ])
    return { now: now(), from, to, ...rest }
  }

  private async apply(swap: Swap, decision: Decision): Promise<unknown> {
    switch (decision.do) {
      case Action.Wait:
        return
      case Action.Record:
        return this.save(swap, (s, at) => {
          this.setLegState(s, decision.side, decision.state, at, decision)
          if (decision.resume && s.canResume) s.resume(at)
        })
      case Action.Lock:
      case Action.Claim:
      case Action.Refund:
        return this.send(swap, decision.do, decision.side)
      case Action.Unlock:
        return this.save(swap, (s, at) => void s.lockFailed(Side.To, at))
      case Action.Abandon:
        return this.save(swap, (s, at) => {
          s.lockFailed(Side.To, at)
          s.fail('refused', decision.reason, at)
        })
      case Action.Fill:
        return this.save(swap, (s, at) => void s.fillOffer(at, s.to.reference(ReferenceKind.Funding) ?? undefined))
      case Action.Fail:
        // Before the write, so a crash in between retires again instead of leaving the invoice open.
        if (swap.from.state === 'pending') await this.deps.rails.from.retire?.(swap, Side.From).catch(() => undefined)
        return this.save(swap, (s, at) => void s.fail(decision.outcome, decision.reason, at))
    }
  }

  private async send(swap: Swap, action: SendAction, side: Side): Promise<boolean> {
    // 1. Write down that we are about to send. Only the worker whose write succeeds goes on to step 2.
    const marked = await this.save(swap, (s, at) => this.markSending(s, action, side, at))
    // 2. Send.
    const result = await this.deps.rails[side][action](marked, side)
    // A lock that was not sent is undone at once, so the route's checks run again instead of waiting for a payout
    // that will never show. Only if nobody else touched the swap: another worker may be sending by now.
    if (result.status === SendStatus.NotSent && action === Action.Lock) {
      await this.save(marked, (s, at) => void s.lockFailed(side, at))
      return false
    }
    if (result.status !== SendStatus.Sent) return false
    // 3. Write down what was sent.
    const reference = { [REFERENCE_KIND[action]]: result.reference }
    await this.deps.swaps.update(swap.id, (s) => void s.reference(side, reference, this.deps.now()))
    return true
  }

  private markSending(swap: Swap, action: SendAction, side: Side, at: UnixSeconds): void {
    const leg = swap[side]
    if (leg.state !== SENDING_STATE[action]) return this.setLegState(swap, side, SENDING_STATE[action], at)
    // The leg is already marked, so this is a second try. Step 1 still has to be a write, or two workers
    // could both send. A lock with no reference is cancelled and marked again. A claim or a refund spends
    // one output, so sending it twice is harmless; a lock that has a reference is the same transaction again.
    if (action === Action.Lock && leg.reference(ReferenceKind.Funding) === null) {
      swap.lockFailed(side, at)
      swap.locking(side, at)
    }
  }

  private setLegState(swap: Swap, side: Side, state: LegState, at: UnixSeconds, seen: Recorded = {}): void {
    switch (state) {
      case 'locking':
        return void swap.locking(side, at)
      case 'locked':
        return void swap.lock(side, at, seen.funding, seen.expiresAt)
      case 'claiming':
        return void swap.claiming(side, at)
      case 'claimed':
        return void swap.claim(side, at, seen.preimage ? { preimage: seen.preimage } : {})
      case 'refunding':
        return void swap.refunding(side, at)
      case 'refunded':
        return void swap.refund(side, at)
      case 'pending':
        throw new RuleViolated(`swap ${swap.id}: a leg is never set back to pending this way`)
    }
  }

  /** Saves only if nobody changed the swap since it was loaded; otherwise throws Conflict. */
  private async save(loaded: Swap, change: (swap: Swap, at: UnixSeconds) => void): Promise<Swap> {
    return this.deps.swaps.update(loaded.id, (current) => {
      if (current.version !== loaded.version) {
        throw new Conflict(`swap ${loaded.id} changed from version ${loaded.version} to ${current.version}`)
      }
      change(current, this.deps.now())
    })
  }
}
