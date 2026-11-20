import { Conflict, RuleViolated } from '../domain/shared/error.js'
import type { SwapId } from '../domain/shared/ids.js'
import type { UnixSeconds } from '../domain/shared/time.js'
import { FactKind, Side, type LegState } from '../domain/swap/leg.js'
import type { Observation } from '../domain/swap/observation.js'
import { Act, plan, type Decision, type Policies } from '../domain/swap/plan.js'
import type { Swap } from '../domain/swap/swap.js'
import type { SwapRepository } from '../domain/swap/swap_repo.js'
import { Dispatch, type RailService, type RailWatcher, type Sent } from '../ports/rail.js'

/** What a decision needs beyond the two rails. */
export type Circumstances = Pick<Observation, 'peer' | 'keyCurrent' | 'approval' | 'ownInvoice'>

/** Everything that makes one route differ from another; the loop below is the same for all of them. */
export interface RouteDriver {
  readonly policies: Policies
  readonly watchers: Readonly<Record<Side, RailWatcher>>
  readonly services: Readonly<Record<Side, RailService>>
  circumstances(swap: Swap): Promise<Circumstances>
}

export interface DriveSwapDeps {
  readonly swaps: Pick<SwapRepository, 'get' | 'update'>
  readonly route: RouteDriver
  readonly now: () => UnixSeconds
}

/** `lost`: another worker moved the swap first. Ordinary, and nothing was sent. */
export const LOST = 'lost'
export type Step = Act | typeof LOST

type Moving = typeof Act.Lock | typeof Act.Claim | typeof Act.Refund

const INTENT: Record<Moving, { readonly state: LegState; readonly fact: FactKind }> = {
  lock: { state: 'locking', fact: FactKind.Funding },
  claim: { state: 'claiming', fact: FactKind.Claim },
  refund: { state: 'refunding', fact: FactKind.Refund },
}

// A swap may take a few decisions in a row; more than this is a plan that never settles.
const MAX_STEPS = 32

export class DriveSwap {
  constructor(private readonly deps: DriveSwapDeps) {}

  /** Decide and act until there is nothing to do right now. */
  async drive(id: SwapId): Promise<Step> {
    for (let i = 0; i < MAX_STEPS; i++) {
      const step = await this.step(id)
      if (step === Act.Wait || step === LOST) return step
    }
    throw new RuleViolated(`swap ${id}: still deciding after ${MAX_STEPS} steps`)
  }

  /** One decision, carried out. Keeps nothing between calls: a crash anywhere is resumed from the store. */
  async step(id: SwapId): Promise<Step> {
    const { swaps, route } = this.deps
    const swap = await swaps.get(id)
    if (swap === null) throw new RuleViolated(`swap ${id} does not exist`)
    const [from, to, circumstances] = await Promise.all([
      route.watchers.from.observe(swap, Side.From),
      route.watchers.to.observe(swap, Side.To),
      route.circumstances(swap),
    ])
    const decision = plan(swap, { now: this.deps.now(), from, to, ...circumstances }, route.policies)
    try {
      await this.carryOut(swap, decision)
    } catch (error) {
      if (error instanceof Conflict) return LOST
      throw error
    }
    return decision.do
  }

  private async carryOut(swap: Swap, decision: Decision): Promise<void> {
    switch (decision.do) {
      case Act.Wait:
        return
      case Act.Record:
        return this.change(swap, (s, at) => this.record(s, decision.side, decision.state, at, decision.preimage))
      case Act.Lock:
      case Act.Claim:
      case Act.Refund:
        return this.move(swap, decision.do, decision.side)
      case Act.Unlock:
        return this.change(swap, (s, at) => void s.lockFailed(Side.To, at))
      case Act.Abandon:
        return this.change(swap, (s, at) => {
          s.lockFailed(Side.To, at)
          s.fail('refused', decision.reason, at)
        })
      case Act.Fill:
        return this.change(swap, (s, at) => void s.fillOffer(at, s.to.reference(FactKind.Funding) ?? undefined))
      case Act.Fail:
        return this.change(swap, (s, at) => void s.fail(decision.outcome, decision.reason, at))
    }
  }

  // The write is what gives ONE worker the right to act: whoever loses it must not reach the rail.
  private async move(swap: Swap, act: Moving, side: Side): Promise<void> {
    const { state, fact } = INTENT[act]
    await this.change(swap, (s, at) => {
      if (s[side].state !== state) return void this.record(s, side, state, at)
      // Already recorded, so this is a second attempt. A lock that left no reference is withdrawn and
      // recorded again, which is a write to win; one that left a reference can only be sent again as is.
      if (act === Act.Lock && s[side].reference(fact) === null) {
        s.lockFailed(side, at)
        s.locking(side, at)
      }
    })
    const sent: Sent = await this.deps.route.services[side][act](swap, side)
    if (sent.dispatch !== Dispatch.Sent) return
    await this.deps.swaps.update(swap.id, (s) => void s.reference(side, { [fact]: sent.reference }, this.deps.now()))
  }

  private record(swap: Swap, side: Side, state: LegState, at: UnixSeconds, preimage?: Swap['preimage']): void {
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
        throw new RuleViolated(`swap ${swap.id}: a leg is never recorded back to pending`)
    }
  }

  // Applies only to the version the decision was made on: a decision about an older swap is void.
  private async change(planned: Swap, apply: (swap: Swap, at: UnixSeconds) => void): Promise<void> {
    await this.deps.swaps.update(planned.id, (fresh) => {
      if (fresh.version !== planned.version) {
        throw new Conflict(`swap ${planned.id} moved from version ${planned.version} to ${fresh.version}`)
      }
      apply(fresh, this.deps.now())
    })
  }
}
