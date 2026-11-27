import { describe, expect, it } from 'vitest'
import { maxRoutingFeeSats } from '@arkade-os/solver-core/core/limits.js'
import {
  deadlineContainsHtlc,
  evaluateSendPayment,
  hintCltvBlocks,
  lockupDeadlineFor,
  payableCltvBlocks,
  refundWithoutReceiverDelayCovers,
} from '@arkade-os/solver-core/core/send.js'
import { planPolledPayment, planSend, type SendReads } from '@arkade-os/solver-core/core/sendPlan.js'
import { rawDelaySeconds } from '@arkade-os/solver-core/core/timelocks.js'
import {
  blocksThePaymentMayTake,
  clientCannotRefundAloneEarly,
  lockupDeadline,
  routeMayOutliveTheRefund,
  routingFeeCapSats,
  tooFewBlocksForTheHtlc,
  tooSoonToBelieveNoRecord,
  whatStopsThePayment,
  whatToDoWithTheLockup,
  type HtlcBlocks,
  type LockupRules,
  type PayTerms,
} from '@arkade-os/solver-next/domain/swap/lightning_send.js'
import { t } from '../support.js'

const MINUTE = 60
const HOUR = 60 * MINUTE
const NOW = t(1_800_000_000)
const after = (seconds: number) => t(NOW + seconds)

const BLOCKS: HtlcBlocks = {
  finalHop: 40,
  worstRouteHint: 0,
  bestRouteHint: 0,
  routeBudget: 432,
  nodeCapsTheRoute: true,
}
const terms = (override: Partial<PayTerms> = {}): PayTerms => ({
  invoiceExpiresAt: after(30 * MINUTE),
  refundOpensAt: after(100 * HOUR),
  lockedSats: 10_000,
  expectedSats: 10_000,
  blocks: BLOCKS,
  ...override,
})
const rules = (override: Partial<LockupRules> = {}): LockupRules => ({
  amountSats: 10_000,
  maxOutputs: 4,
  quotedAt: after(-MINUTE),
  invoiceExpiresAt: after(30 * MINUTE),
  longestWait: 15 * MINUTE,
  ...override,
})

describe('the client lockup of a Lightning send', () => {
  it('is adopted when exactly the amount is spendable, and waited for while less is', () => {
    expect(whatToDoWithTheLockup({ heldSats: 10_000, spendableSats: [10_000] }, rules(), NOW)).toEqual({ do: 'adopt' })
    expect(whatToDoWithTheLockup({ heldSats: 4_000, spendableSats: [4_000] }, rules(), NOW)).toEqual({ do: 'wait' })
    expect(whatToDoWithTheLockup({ heldSats: 0, spendableSats: [] }, rules(), NOW)).toEqual({ do: 'wait' })
  })

  it('is refused at once when it holds more than the amount, saying what the client has to take back', () => {
    expect(whatToDoWithTheLockup({ heldSats: 10_001, spendableSats: [10_001] }, rules(), NOW)).toEqual({
      do: 'refuse',
      reason: 'overfunded lockup: 10001 > 10000 sats',
      heldSats: 10_001,
    })
  })

  it('is refused when the amount came in too many outputs, or where a claim cannot spend it', () => {
    const five = { heldSats: 10_000, spendableSats: [2_000, 2_000, 2_000, 2_000, 2_000] }
    expect(whatToDoWithTheLockup(five, rules(), NOW)).toMatchObject({ reason: 'lockup funded in 5 outputs, over 4' })
    expect(whatToDoWithTheLockup({ heldSats: 10_000, spendableSats: [] }, rules(), NOW)).toMatchObject({
      reason: 'lockup funded on an asset vtxo a claim cannot spend: 10000 held, 0 spendable',
    })
  })

  it('is refused once the wait is over, in words that say what arrived', () => {
    const late = rules({ quotedAt: after(-15 * MINUTE) })
    expect(whatToDoWithTheLockup({ heldSats: 0, spendableSats: [] }, late, NOW)).toEqual({
      do: 'refuse',
      reason: 'lockup timeout',
      heldSats: null,
    })
    expect(whatToDoWithTheLockup({ heldSats: 4_000, spendableSats: [4_000] }, late, NOW)).toMatchObject({
      reason: 'lockup timeout with partial 4000 sats',
      heldSats: 4_000,
    })
    expect(whatToDoWithTheLockup({ heldSats: 10_000, spendableSats: [10_000] }, late, NOW)).toMatchObject({
      reason: 'lockup arrived after the funding deadline',
    })
    const expired = rules({ invoiceExpiresAt: NOW })
    expect(whatToDoWithTheLockup({ heldSats: 10_000, spendableSats: [10_000] }, expired, NOW)).toMatchObject({
      reason: 'invoice expired before funding completed',
    })
  })
})

describe('paying the invoice of a Lightning send', () => {
  it('is allowed when the lockup covers it and there is time for everything', () => {
    expect(whatStopsThePayment(terms(), NOW)).toBeNull()
  })

  it.each([
    [{ lockedSats: 9_999 }, 'lockup_insufficient'],
    [{ expectedSats: 0 }, 'lockup_insufficient'],
    [{ lockedSats: Number.NaN }, 'lockup_insufficient'],
    [{ invoiceExpiresAt: NOW }, 'invoice_expired'],
    [{ invoiceExpiresAt: after(2 * MINUTE - 1) }, 'invoice_expires_too_soon'],
    [{ refundOpensAt: after(90 * MINUTE - 1) }, 'claim_window_too_short'],
    [{ refundOpensAt: after(2 * HOUR + 40 * 10 * MINUTE) }, 'cltv_budget_too_short'],
    [
      { blocks: { ...BLOCKS, nodeCapsTheRoute: false }, refundOpensAt: after(50 * HOUR) },
      'uncapped_route_deadline_too_short',
    ],
  ] as const)('stops on %o with %s', (override, refusal) => {
    expect(whatStopsThePayment(terms(override), NOW)).toBe(refusal)
  })

  it('caps the payment so its HTLC is over two hours before the refund opens', () => {
    expect(blocksThePaymentMayTake(BLOCKS, after(2 * HOUR + 100 * 10 * MINUTE), NOW)).toBe(100)
    expect(blocksThePaymentMayTake(BLOCKS, after(1_000 * HOUR), NOW)).toBe(40 + 432)
  })

  it('does not believe a missing payment for a minute after sending it', () => {
    expect(tooSoonToBelieveNoRecord(after(-59), NOW)).toBe(true)
    expect(tooSoonToBelieveNoRecord(after(-60), NOW)).toBe(false)
    expect(tooSoonToBelieveNoRecord(null, NOW)).toBe(false)
  })
})

describe('the Lightning send rules against production', () => {
  const random = (seed: number) => () => {
    seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296
    return seed / 4_294_967_296
  }

  // `expect` is too slow for a loop this long.
  const same = (ours: unknown, today: unknown, what: string): void => {
    if (ours !== today && JSON.stringify(ours) !== JSON.stringify(today)) {
      throw new Error(`${what}: ours ${JSON.stringify(ours)}, today ${JSON.stringify(today)}`)
    }
  }

  it('agree on 300,000 random situations, 20,000 of them with a lockup', async () => {
    const next = random(20261127)
    const pick = <T>(of: readonly T[]): T => of[Math.floor(next() * of.length)]!
    const around = (center: number) => center + pick([-1, 0, 1, -MINUTE, MINUTE, -HOUR, HOUR, 0, 0])
    let s = { heldSats: 0, spendable: [] as { value: number }[], longestWait: 0, maxOutputs: 0 }
    const reads = {
      now: () => NOW,
      lockupTimeout: () => s.longestWait,
      maxLockupOutputs: () => s.maxOutputs,
      lockups: async () => ({ held: s.heldSats, spendable: s.spendable }),
    } as unknown as SendReads
    const reached = new Set<string>()

    for (let i = 0; i < 300_000; i++) {
      const blocks: HtlcBlocks = {
        finalHop: pick([9, 18, 40, 80, 144, 500]),
        worstRouteHint: pick([0, 0, 40, 144, 1_000]),
        bestRouteHint: pick([0, 0, 40, 144]),
        routeBudget: pick([432, 2_016, 100]),
        nodeCapsTheRoute: next() < 0.5,
      }
      const cltv = {
        minFinalCltvBlocks: blocks.finalHop,
        worstRouteHintCltvBlocks: blocks.worstRouteHint,
        bestRouteHintCltvBlocks: blocks.bestRouteHint,
        routeCltvBudgetBlocks: blocks.routeBudget,
        enforcesRouteCltv: blocks.nodeCapsTheRoute,
      }
      const hint = hintCltvBlocks(cltv)
      const worst = blocks.finalHop + hint + blocks.routeBudget
      const untilRefund = pick([
        0,
        90 * MINUTE,
        2 * HOUR,
        2 * HOUR + worst * 600,
        2 * HOUR + (blocks.finalHop + hint) * 600,
      ])
      const refundOpensAt = after(around(next() < 0.7 ? untilRefund : 400 * HOUR))
      const invoiceExpiresAt = after(around(pick([0, 2 * MINUTE, 17 * MINUTE, HOUR, HOUR])))
      const expectedSats = pick([10_000, 10_000, 10_000, 1, 0, -5, Number.NaN])
      const lockedSats = pick([10_000, 10_000, 10_000, 9_999, 10_001, 0, Number.NaN, Number.POSITIVE_INFINITY])

      const today = evaluateSendPayment({
        ...cltv,
        invoiceExpiresAt,
        refundLocktime: refundOpensAt,
        lockedSats,
        expectedSats,
        now: NOW,
      })
      const ours = whatStopsThePayment({ invoiceExpiresAt, refundOpensAt, lockedSats, expectedSats, blocks }, NOW)
      same(ours, today.pay ? null : today.reason, `payment ${i}`)
      reached.add(ours ?? 'pay')
      const cap = payableCltvBlocks(cltv, refundOpensAt, NOW)
      same(blocksThePaymentMayTake(blocks, refundOpensAt, NOW), cap, `cap ${i}`)
      same(
        routeMayOutliveTheRefund(blocks, refundOpensAt, NOW),
        !cltv.enforcesRouteCltv && !deadlineContainsHtlc(cltv, refundOpensAt, NOW),
        `route ${i}`,
      )
      same(tooFewBlocksForTheHtlc(blocks, refundOpensAt, NOW), cap <= cltv.minFinalCltvBlocks + hint, `blocks ${i}`)

      const amountSats = pick([10_000, 1, 4_999, 5_001, 123_457, 1_000_000])
      same(routingFeeCapSats(amountSats), maxRoutingFeeSats(amountSats), `fee cap ${i}`)

      const quotedAt = after(-pick([0, MINUTE, 14 * MINUTE, 15 * MINUTE, 16 * MINUTE, HOUR]))
      const longestWait = pick([15 * MINUTE, 15 * MINUTE, 5 * MINUTE, 2 * HOUR])
      same(
        lockupDeadline(quotedAt, invoiceExpiresAt, longestWait),
        lockupDeadlineFor(quotedAt, invoiceExpiresAt, longestWait),
        `lockup deadline ${i}`,
      )
      const rawDelay = pick([512, 1_024, 4_096, 86_400 + 512, 144, 12])
      same(
        clientCannotRefundAloneEarly(rawDelaySeconds(rawDelay), refundOpensAt, quotedAt),
        refundWithoutReceiverDelayCovers(rawDelay, refundOpensAt, quotedAt),
        `refund alone ${i}`,
      )

      // Today's lockup verdict is only reachable through an async call, and a long loop of awaits is slow on Node 22.
      if (i % 15 === 0) {
        const spendableSats = Array.from({ length: pick([0, 1, 1, 1, 2, 5]) }, () =>
          pick([10_000, 5_000, 2_000, 1, 10_001]),
        )
        const heldSats = spendableSats.reduce((sum, sats) => sum + sats, 0) + pick([0, 0, 0, 10_000, 3])
        const maxOutputs = pick([1, 4])
        s = { heldSats, spendable: spendableSats.map((value) => ({ value })), longestWait, maxOutputs }
        const row = { state: 'quoted', createdAt: quotedAt, invoice: '', invoiceExpiresAt, amountSats: 10_000 }
        const old = await planSend(row as never, reads)
        const step = whatToDoWithTheLockup(
          { heldSats, spendableSats },
          { amountSats: 10_000, maxOutputs, quotedAt, invoiceExpiresAt, longestWait },
          NOW,
        )
        const expected =
          old.do === 'fail'
            ? { do: 'refuse', reason: old.reason, heldSats: old.lockupValue ?? null }
            : { do: old.do === 'adopt_lockup' ? 'adopt' : 'wait' }
        same(step, expected, `lockup ${i}`)
        reached.add(step.do === 'refuse' ? step.reason.replace(/\d+/g, 'N') : step.do)
      }

      const sentAt = pick([null, after(-59), after(-60), after(-1), after(-HOUR)])
      const polled = pick([
        { status: 'failed', evidence: 'no_record' },
        { status: 'failed', evidence: 'terminal' },
        { status: 'failed' },
        { status: 'pending' },
        { status: 'succeeded' },
      ] as const)
      const noRecord = polled.status === 'failed' && 'evidence' in polled && polled.evidence === 'no_record'
      same(
        noRecord && tooSoonToBelieveNoRecord(sentAt, NOW),
        planPolledPayment({ payAttemptedAt: sentAt }, polled, () => NOW) === 'wait',
        `polled ${i}`,
      )
    }

    expect([...reached].sort()).toEqual([
      'adopt',
      'claim_window_too_short',
      'cltv_budget_too_short',
      'invoice expired before funding completed',
      'invoice_expired',
      'invoice_expires_too_soon',
      'lockup arrived after the funding deadline',
      'lockup funded in N outputs, over N',
      'lockup funded on an asset vtxo a claim cannot spend: N held, N spendable',
      'lockup timeout',
      'lockup timeout with partial N sats',
      'lockup_insufficient',
      'overfunded lockup: N > N sats',
      'pay',
      'uncapped_route_deadline_too_short',
      'wait',
    ])
  }, 60_000)
})
