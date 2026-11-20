import { expect } from 'vitest'
import { UnixSeconds } from '@arkade-os/solver-next/domain/shared/time.js'
import { lnReceivePolicies } from '@arkade-os/solver-next/domain/swap/ln_receive.js'
import { plan, type Decision } from '@arkade-os/solver-next/domain/swap/plan.js'
import { LnReceiveSwaps } from './lnReceiveSwaps.js'
import { HeldPayment } from '@arkade-os/solver-next/infrastructure/lightning/held_payment.js'
import { ArkadeLockup } from '@arkade-os/solver-next/infrastructure/arkade/lockup.js'
import { contractFromRow, legacyArkadeLockups } from './legacyArkadeLockups.js'
import type { ReceiveSwapRow } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import { ReceiveSwapService, type ReceiveServiceDeps } from '@arkade-os/solver-corridors/receive/orchestrator.js'

export interface Difference {
  readonly test: string
  readonly step: string
  readonly legacy: string
  readonly planned: string
}

// Tests whose point is what happens in the middle of one step, or how many reads a step makes.
// A second reader beside the step changes exactly that.
const NOT_SHADOWED = [
  'gives up within the time budget however slow each indexer read is',
  'does not fund when the HTLC goes away while the adoption scan is in flight',
  'two workers on one store fund the lockup ONCE, not twice',
  'refunds when the deadline opens while the lockup read is in flight',
]

/** Why a difference is expected, or null when it is not. */
export const explained = ({ test, step, legacy, planned }: Difference): string | null => {
  if (step === 'claimed->stuck' && planned === 'claim from')
    return 'new: tries the settle first and goes stuck on the next tick'
  if (step === 'claimed->settled' && planned === 'record from claimed')
    return 'new: the node already shows the payment settled, so nothing is sent'
  if (step === 'funded->refunding' && planned === 'record to claimed')
    return 'new: sees a claim on a sibling output one step earlier'
  if (step === 'refunding->refunded' && legacy === 'refund to' && planned === 'record to refunded')
    return 'same: our own refund found already landed'
  if (test.includes('unrolled onto Bitcoin') && planned === 'refund to')
    return 'open: the steps of a refund on Bitcoin are not ported yet; plan only says keep refunding'
  return null
}

const named = (d: Decision): string => {
  switch (d.do) {
    case 'record':
      return `record ${d.side} ${d.state}`
    case 'lock':
    case 'claim':
    case 'refund':
      return `${d.do} ${d.side}`
    case 'fail':
      return `fail ${d.outcome}`
    default:
      return d.do
  }
}

// What one legacy step did, in the words `plan` uses.
const legacyDid = (before: ReceiveSwapRow, after: ReceiveSwapRow): string => {
  // The fund lease is taken just before a payout is sent, and only then.
  const paidOut = before.fundStartedAt === null && after.fundStartedAt !== null
  const move = `${before.state}->${after.state}`
  if (after.state === 'refused' || after.state === 'stuck') return `fail ${after.state}`
  if (before.state === after.state) return 'wait'
  const known: Record<string, string> = {
    'quoted->armed': 'record from locked',
    'armed->funded': paidOut ? 'lock to' : 'record to locked',
    'funded->claimed': 'record to claimed',
    'funded->refunding': 'refund to',
    'claimed->settled': 'claim from',
    'refunding->refunded': 'refund to',
    'refunding->claimed': 'record to claimed',
  }
  return known[move] ?? move
}

interface Internals {
  readonly deps: ReceiveServiceDeps
  readonly now: () => number
}

/** Before every legacy step, asks `plan` what it would do on the same row and the same fakes, and notes each difference. */
export const shadowPlan = (): { differences: Difference[]; steps: () => number; stop: () => void } => {
  const differences: Difference[] = []
  let steps = 0
  const proto = ReceiveSwapService.prototype as unknown as { step(row: ReceiveSwapRow): Promise<boolean> }
  const legacyStep = proto.step

  proto.step = async function (this: Internals, row: ReceiveSwapRow): Promise<boolean> {
    const { deps, now } = this
    // The path between two of our own clients is not in the new rules yet.
    if (deps.coupledSendStore) return legacyStep.call(this, row)
    const test = expect.getState().currentTestName ?? '?'
    if (NOT_SHADOWED.some((name) => test.endsWith(name))) return legacyStep.call(this, row)

    let planned: string
    try {
      const swap = await new LnReceiveSwaps(deps.store).load(row)
      const lockups = legacyArkadeLockups({ arkade: deps.arkade, onchain: deps.onchain, chainTip: deps.chainTip, now })
      const contracts = { contract: async () => contractFromRow(row) }
      const [from, to] = await Promise.all([
        new HeldPayment(deps.ln).status(swap),
        new ArkadeLockup(contracts, lockups).status(swap),
      ])
      const seen = {
        now: UnixSeconds.of(now()),
        from,
        to,
        peer: null,
        keyCurrent: true,
        approval: 'not_required',
        ownInvoice: false,
      } as const
      planned = named(plan(swap, seen, lnReceivePolicies({ acceptRefundAloneGap: deps.acceptUnilateralGap })))
    } catch (error) {
      planned = `threw: ${error instanceof Error ? error.message : String(error)}`
    }

    const advanced = await legacyStep.call(this, row)
    const after = await deps.store.get(row.id)
    const legacy = legacyDid(row, after)
    steps += 1
    if (legacy !== planned) {
      differences.push({ test, step: `${row.state}->${after.state}`, legacy, planned })
    }
    return advanced
  }

  return { differences, steps: () => steps, stop: () => void (proto.step = legacyStep) }
}
