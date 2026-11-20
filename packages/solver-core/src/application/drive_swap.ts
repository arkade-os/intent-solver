import { Conflict, RuleViolated } from '../domain/shared/error.js'
import type { SwapId } from '../domain/shared/ids.js'
import type { UnixSeconds } from '../domain/shared/time.js'
import type { Preimage } from '../domain/swap/hashlock.js'
import { ReferenceKind, Side, type LegState } from '../domain/swap/leg.js'
import type { Observation } from '../domain/swap/observation.js'
import { Action, plan, type Decision, type Policies } from '../domain/swap/plan.js'
import type { Swap } from '../domain/swap/swap.js'
import type { SwapRepository } from '../domain/swap/swap_repo.js'
import { SendStatus, type RailService, type RailWatcher } from '../ports/rail.js'

/** What a decision needs to know besides the two rails. */
export type SwapContext = Pick<Observation, 'peer' | 'keyCurrent' | 'approval' | 'ownInvoice'>

/** A route is its rules and its two rails. The steps below are the same for every route. */
export interface DriveSwapDeps {
  readonly swaps: Pick<SwapRepository, 'get' | 'update'>
  readonly policies: Policies
  readonly watchers: Readonly<Record<Side, RailWatcher>>
  readonly services: Readonly<Record<Side, RailService>>
  readonly context: (swap: Swap) => Promise<SwapContext>
  readonly now: () => UnixSeconds
}

/** Another worker changed the swap first, so this one did nothing. */
export const SKIPPED = 'skipped'
export type StepResult = Action | typeof SKIPPED

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
      if (result === Action.Wait || result === SKIPPED) return result
    }
    throw new RuleViolated(`swap ${id}: still not finished after ${MAX_STEPS} steps`)
  }

  /** Load the swap, look at both rails, decide one thing, do it. Nothing is remembered between calls. */
  async step(id: SwapId): Promise<StepResult> {
    const swap = await this.deps.swaps.get(id)
    if (swap === null) throw new RuleViolated(`swap ${id} does not exist`)
    const decision = plan(swap, await this.observe(swap), this.deps.policies)
    try {
      await this.apply(swap, decision)
    } catch (error) {
      if (error instanceof Conflict) return SKIPPED
      throw error
    }
    return decision.do
  }

  private async observe(swap: Swap): Promise<Observation> {
    const { watchers, context, now } = this.deps
    const [from, to, rest] = await Promise.all([
      watchers.from.observe(swap, Side.From),
      watchers.to.observe(swap, Side.To),
      context(swap),
    ])
    return { now: now(), from, to, ...rest }
  }

  private async apply(swap: Swap, decision: Decision): Promise<void> {
    switch (decision.do) {
      case Action.Wait:
        return
      case Action.Record:
        return this.save(swap, (s, at) => this.setLegState(s, decision.side, decision.state, at, decision.preimage))
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
        return this.save(swap, (s, at) => void s.fail(decision.outcome, decision.reason, at))
    }
  }

  private async send(swap: Swap, action: SendAction, side: Side): Promise<void> {
    // 1. Write down that we are about to send. Only the worker whose write succeeds goes on to step 2.
    await this.save(swap, (s, at) => this.markSending(s, action, side, at))
    // 2. Send.
    const result = await this.deps.services[side][action](swap, side)
    if (result.status !== SendStatus.Sent) return
    // 3. Write down what was sent.
    const reference = { [REFERENCE_KIND[action]]: result.reference }
    await this.deps.swaps.update(swap.id, (s) => void s.reference(side, reference, this.deps.now()))
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

  private setLegState(swap: Swap, side: Side, state: LegState, at: UnixSeconds, preimage?: Preimage): void {
    switch (state) {
      case 'locking':
        return void swap.locking(side, at)
      case 'locked':
        return void swap.lock(side, at)
      case 'claiming':
        return void swap.claiming(side, at)
      case 'claimed':
        return void swap.claim(side, at, preimage ? { preimage } : {})
      case 'refunding':
        return void swap.refunding(side, at)
      case 'refunded':
        return void swap.refund(side, at)
      case 'pending':
        throw new RuleViolated(`swap ${swap.id}: a leg is never set back to pending this way`)
    }
  }

  /** Saves only if nobody changed the swap since it was loaded; otherwise throws Conflict. */
  private async save(loaded: Swap, change: (swap: Swap, at: UnixSeconds) => void): Promise<void> {
    await this.deps.swaps.update(loaded.id, (current) => {
      if (current.version !== loaded.version) {
        throw new Conflict(`swap ${loaded.id} changed from version ${loaded.version} to ${current.version}`)
      }
      change(current, this.deps.now())
    })
  }
}
