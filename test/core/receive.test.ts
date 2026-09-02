import { describe, it, expect } from 'vitest'
import {
  evaluateReceiveFunding,
  htlcDeadlineFromHeight,
  HTLC_SECONDS_PER_BLOCK,
  MAX_REFUND_HORIZON,
  MIN_SETTLE_WINDOW,
  SETTLE_SAFETY_MARGIN,
  UNILATERAL_RECOURSE_MARGIN,
  MAX_FINAL_CLTV_BLOCKS,
  maxServableExitDelay,
  minFinalCltvBlocksFor,
  HTLC_SECONDS_PER_BLOCK as BLOCK_SECONDS,
  type ReceiveFundingInput,
} from '@arkade-os/solver-core/core/receive.js'
import { SECONDS_PER_BLOCK } from '@arkade-os/solver-core/core/send.js'
import {
  deriveUnilateralDelays,
  LOCKTIME_THRESHOLD,
  SEQUENCE_GRANULARITY_SECONDS,
} from '@arkade-os/solver-core/core/timelocks.js'

// A plausible "now" well above LOCKTIME_THRESHOLD, so refund deadlines are read
// as timestamps rather than block heights.
const NOW = 1_800_000_000

const input = (over: Partial<ReceiveFundingInput> = {}): ReceiveFundingInput => ({
  now: NOW,
  // The strict position, so every existing case below still asserts gate (d)
  // exactly as it did before the knob existed. The suite that accepts the gap
  // opts in explicitly, one case at a time.
  acceptUnilateralGap: false,
  invoiceExpiresAt: NOW + 600,
  htlcExpiresAt: NOW + 4 * 3600,
  // What a row quoted at NOW carries — the value the lockup script is built
  // from. This gate reads it; it never chooses it.
  refundLocktime: NOW + MAX_REFUND_HORIZON,
  // The regtest ladder's top rung: the solver's own solo recourse, relative to
  // funding. Snapshotted on the row at quote time, like every other delay.
  unilateralRefundWithoutReceiverDelay: 1536,
  ...over,
})

describe('evaluateReceiveFunding', () => {
  it('funds when the invoice is live and the settle window is comfortable', () => {
    expect(evaluateReceiveFunding(input())).toEqual({ fund: true })
  })

  /**
   * Issue #69: during a prolonged arkd outage the collaborative paths are all
   * unavailable, so the only live paths are the CSV ones. The trader's
   * `unilateralClaim` opens first (that ordering is mandatory — a funder whose
   * refund opened first could take the money from a claimant holding the
   * preimage). If `E` passes before the SOLVER's own `unilateralRefundWithout-
   * Receiver` opens, the trader can let the htlc fail back to the payer at zero
   * cost and only then claim the Arkade payout, taking both sides.
   *
   * Nothing here reorders the ladder. It refuses to fund into that window.
   */
  describe('gate (d): the solver own-recourse must open before E', () => {
    // A ladder LONGER than MIN_SETTLE_WINDOW, because otherwise gate (b) fires
    // first and this one is unreachable. That is not an artefact of the test:
    // on the regtest ladder (1536s) gate (d) can never bite, since 90 minutes
    // of required settle window already exceeds the whole exit delay. It starts
    // mattering exactly when the operator's exit delay grows past 90 minutes,
    // which is every real network.
    const LADDER = 6 * 3600

    it('refuses when the solo refund opens after E — the #69 outage timeline', () => {
      expect(
        evaluateReceiveFunding(input({ unilateralRefundWithoutReceiverDelay: LADDER, htlcExpiresAt: NOW + LADDER })),
      ).toEqual({ fund: false, reason: 'unilateral_recourse_after_htlc' })
    })

    it('refuses when the recourse opens before E but inside the margin', () => {
      expect(
        evaluateReceiveFunding(
          input({
            unilateralRefundWithoutReceiverDelay: LADDER,
            htlcExpiresAt: NOW + LADDER + UNILATERAL_RECOURSE_MARGIN - 1,
          }),
        ),
      ).toEqual({ fund: false, reason: 'unilateral_recourse_after_htlc' })
    })

    it('funds when the recourse opens a full margin before E', () => {
      expect(
        evaluateReceiveFunding(
          input({
            unilateralRefundWithoutReceiverDelay: LADDER,
            htlcExpiresAt: NOW + LADDER + UNILATERAL_RECOURSE_MARGIN,
          }),
        ),
      ).toEqual({ fund: true })
    })

    it('refuses a mainnet-scale ladder against an ordinary htlc deadline', () => {
      // The consequence worth stating out loud: with a week-long exit delay no
      // routable htlc carries an `E` far enough out, so this corridor cannot be
      // funded safely at those delays. The gate makes that visible rather than
      // leaving the exposure silent.
      expect(
        evaluateReceiveFunding(
          input({ unilateralRefundWithoutReceiverDelay: 7 * 24 * 3600, htlcExpiresAt: NOW + 30 * 3600 }),
        ),
      ).toEqual({ fund: false, reason: 'unilateral_recourse_after_htlc' })
    })
  })

  describe('gate (a): expired BOLT11', () => {
    it('refuses once the invoice has expired', () => {
      expect(evaluateReceiveFunding(input({ invoiceExpiresAt: NOW }))).toEqual({
        fund: false,
        reason: 'invoice_expired',
      })
    })

    it('refuses an invoice that expired in the past', () => {
      expect(evaluateReceiveFunding(input({ invoiceExpiresAt: NOW - 1 }))).toEqual({
        fund: false,
        reason: 'invoice_expired',
      })
    })

    it('still funds one second before expiry', () => {
      const decision = evaluateReceiveFunding(input({ invoiceExpiresAt: NOW + 1 }))
      expect(decision.fund).toBe(true)
    })

    it('refuses an expired invoice even when the settle window is enormous', () => {
      // The settle window must not be able to buy off an expired invoice: the
      // payer can pull the HTLC regardless of how long we were given to settle.
      expect(evaluateReceiveFunding(input({ invoiceExpiresAt: NOW - 1, htlcExpiresAt: NOW + 24 * 3600 }))).toEqual({
        fund: false,
        reason: 'invoice_expired',
      })
    })
  })

  describe('gate (b): settle window', () => {
    it('refuses when the HTLC is not armed yet', () => {
      expect(evaluateReceiveFunding(input({ htlcExpiresAt: null }))).toEqual({
        fund: false,
        reason: 'htlc_not_armed',
      })
    })

    it('refuses one second under the minimum settle window', () => {
      expect(evaluateReceiveFunding(input({ htlcExpiresAt: NOW + MIN_SETTLE_WINDOW - 1 }))).toEqual({
        fund: false,
        reason: 'settle_window_too_short',
      })
    })

    it('accepts exactly at the minimum settle window', () => {
      const htlcExpiresAt = NOW + MIN_SETTLE_WINDOW
      // Paired with a deadline that clears gate (c), so this isolates gate (b):
      // at this E the default 2h-out committed deadline would be refused by (c).
      const decision = evaluateReceiveFunding(
        input({ htlcExpiresAt, refundLocktime: htlcExpiresAt - SETTLE_SAFETY_MARGIN }),
      )
      expect(decision.fund).toBe(true)
    })

    it('does not assume a default settle deadline', () => {
      // A backend that hands back a much shorter E than its documented norm must
      // decline, not fall back to the norm.
      expect(evaluateReceiveFunding(input({ htlcExpiresAt: NOW + 60 }))).toEqual({
        fund: false,
        reason: 'settle_window_too_short',
      })
    })
  })

  /**
   * Gate (c). The committed deadline is an INPUT: the lockup script is already
   * built from it by the time this runs, so the only lever left is whether to
   * fund at all. These cases are therefore about accepting or refusing a given
   * deadline, never about choosing one.
   */
  describe('gate (c): the committed refund deadline versus E', () => {
    it('accepts a deadline exactly one safety margin before E', () => {
      const htlcExpiresAt = NOW + 4 * 3600
      const decision = evaluateReceiveFunding(
        input({
          htlcExpiresAt,
          refundLocktime: htlcExpiresAt - SETTLE_SAFETY_MARGIN,
        }),
      )
      expect(decision).toEqual({ fund: true })
    })

    it('refuses one second past the safety margin', () => {
      const htlcExpiresAt = NOW + 4 * 3600
      expect(
        evaluateReceiveFunding(
          input({
            htlcExpiresAt,
            refundLocktime: htlcExpiresAt - SETTLE_SAFETY_MARGIN + 1,
          }),
        ),
      ).toEqual({ fund: false, reason: 'refund_deadline_too_late' })
    })

    it('refuses a deadline that opens after E entirely', () => {
      // The case that loses the money outright: the payment is gone at E and
      // the Arkade side is still locked with no recourse open yet.
      const htlcExpiresAt = NOW + 4 * 3600
      expect(evaluateReceiveFunding(input({ htlcExpiresAt, refundLocktime: htlcExpiresAt + 1 }))).toEqual({
        fund: false,
        reason: 'refund_deadline_too_late',
      })
    })

    /**
     * The regression this gate exists for. A swap quoted at NOW commits to
     * `NOW + MAX_REFUND_HORIZON` (2h). An HTLC arming later with a short-dated
     * `E` clears gate (b) — it is measured from `now`, not from quote time —
     * yet leaves that already-committed deadline stranded past E. Nothing can
     * move the deadline at that point, so the only safe answer is to refuse.
     */
    it('refuses a short-dated E even though the settle window itself is satisfied', () => {
      const htlcExpiresAt = NOW + MIN_SETTLE_WINDOW
      const committed = NOW + MAX_REFUND_HORIZON
      // Gate (b) is genuinely satisfied here — this is not a settle-window refusal.
      expect(htlcExpiresAt - NOW).toBeGreaterThanOrEqual(MIN_SETTLE_WINDOW)
      expect(evaluateReceiveFunding(input({ htlcExpiresAt, refundLocktime: committed }))).toEqual({
        fund: false,
        reason: 'refund_deadline_too_late',
      })
    })

    it('every deadline it accepts opens strictly before E', () => {
      for (const window of [MIN_SETTLE_WINDOW, MIN_SETTLE_WINDOW + 1, 3 * 3600, 24 * 3600]) {
        const htlcExpiresAt = NOW + window
        for (const refundLocktime of [NOW + 60, NOW + MAX_REFUND_HORIZON, htlcExpiresAt, htlcExpiresAt + 3600]) {
          const decision = evaluateReceiveFunding(input({ htlcExpiresAt, refundLocktime }))
          // Funds must be recoverable while we can still settle. If the refund
          // path opened after E the payment would be gone and the Arkade side
          // still locked.
          if (decision.fund) expect(refundLocktime).toBeLessThan(htlcExpiresAt)
        }
      }
    })

    it('rejects a committed deadline a verifier would read as a block height, not a timestamp', () => {
      expect(() => evaluateReceiveFunding(input({ refundLocktime: LOCKTIME_THRESHOLD - 1 }))).toThrow()
    })
  })

  it('is a pure function of its inputs', () => {
    const frozen = input()
    const a = evaluateReceiveFunding(frozen)
    const b = evaluateReceiveFunding(frozen)
    expect(a).toEqual(b)
    expect(frozen).toEqual(input())
  })
})

describe('htlcDeadlineFromHeight', () => {
  it('turns the remaining block span into seconds at the assumed interval', () => {
    expect(htlcDeadlineFromHeight(276, 193, NOW)).toBe(NOW + 83 * HTLC_SECONDS_PER_BLOCK)
  })

  it('shrinks as the chain advances toward the timeout height', () => {
    const early = htlcDeadlineFromHeight(276, 193, NOW)
    const later = htlcDeadlineFromHeight(276, 233, NOW)
    expect(later).toBeLessThan(early)
    expect(early - later).toBe(40 * HTLC_SECONDS_PER_BLOCK)
  })

  it('reports a deadline already past once the chain is past the timeout height', () => {
    // Not clamped to `now`. The HTLC really is gone, and every gate downstream
    // has to be able to see that rather than being handed a floor.
    expect(htlcDeadlineFromHeight(276, 300, NOW)).toBeLessThan(NOW)
    expect(evaluateReceiveFunding(input({ htlcExpiresAt: htlcDeadlineFromHeight(276, 300, NOW) }))).toEqual({
      fund: false,
      reason: 'settle_window_too_short',
    })
  })

  /**
   * THE SAFETY DIRECTION, stated as a test rather than only as a comment.
   *
   * A height becomes a time only under an assumption about block arrival, and
   * over-estimating the time available is the failure that costs money: the
   * solver funds the Arkade side believing it can still settle, and cannot.
   * So the conversion must never return a later instant than a nominal-rate
   * reading of the same height would.
   */
  it('never reports MORE time than the nominal block interval would', () => {
    for (const blocks of [1, 9, 36, 83, 144, 1008]) {
      const conservative = htlcDeadlineFromHeight(193 + blocks, 193, NOW)
      const nominal = NOW + blocks * SECONDS_PER_BLOCK
      expect(conservative).toBeLessThanOrEqual(nominal)
    }
  })

  /**
   * The bug this whole change exists for, pinned at the unit level.
   *
   * Live on regtest the shipped adapter reported the BOLT11 window — 600s
   * against a `MIN_SETTLE_WINDOW` of 5400 — so gate (b) refused EVERY receive
   * swap. The held HTLC observed on that same response was 83 blocks out
   * (`payments[0].timeout` 276, chain height 193).
   */
  it('clears the settle window for the 83-block HTLC a real LND actually arms', () => {
    const htlcExpiresAt = htlcDeadlineFromHeight(276, 193, NOW)
    expect(htlcExpiresAt - NOW).toBeGreaterThanOrEqual(MIN_SETTLE_WINDOW)
    expect(evaluateReceiveFunding(input({ htlcExpiresAt, refundLocktime: NOW + 3600 }))).toEqual({ fund: true })
  })

  /**
   * ...and the refusal still fires. The defect was that gate (b) refused
   * ALWAYS, not that it exists: an HTLC genuinely too close to its timeout
   * must still be declined.
   */
  describe('the settle-window refusal still works', () => {
    // 5400s of required window at 150s per block is 36 blocks.
    const blocksNeeded = MIN_SETTLE_WINDOW / HTLC_SECONDS_PER_BLOCK

    it('refuses an HTLC one block short of the required window', () => {
      const htlcExpiresAt = htlcDeadlineFromHeight(193 + blocksNeeded - 1, 193, NOW)
      expect(evaluateReceiveFunding(input({ htlcExpiresAt }))).toEqual({
        fund: false,
        reason: 'settle_window_too_short',
      })
    })

    it('accepts exactly at the required window', () => {
      const htlcExpiresAt = htlcDeadlineFromHeight(193 + blocksNeeded, 193, NOW)
      expect(htlcExpiresAt - NOW).toBe(MIN_SETTLE_WINDOW)
      const decision = evaluateReceiveFunding(
        input({ htlcExpiresAt, refundLocktime: htlcExpiresAt - SETTLE_SAFETY_MARGIN }),
      )
      expect(decision).toEqual({ fund: true })
    })

    it('refuses an HTLC that is only a handful of blocks from timing out', () => {
      expect(evaluateReceiveFunding(input({ htlcExpiresAt: htlcDeadlineFromHeight(196, 193, NOW) }))).toEqual({
        fund: false,
        reason: 'settle_window_too_short',
      })
    })
  })
})

/**
 * The counterpart to gate (d). The gate can only observe `E` and decline; this
 * chooses it, so a swap that would be declined after the client has already
 * paid is never quoted with an unservable invoice in the first place.
 */
describe('minFinalCltvBlocksFor', () => {
  it('buys at least the recourse delay plus its margin, at the FAST block bound', () => {
    const delay = 6 * 3600
    const blocks = minFinalCltvBlocksFor(delay, false)
    // The property that matters: even if blocks arrive as fast as the bound
    // allows, this many of them still outlast the recourse plus margin.
    expect(blocks * BLOCK_SECONDS).toBeGreaterThanOrEqual(delay + UNILATERAL_RECOURSE_MARGIN)
    // ...and it is not wastefully generous: one block fewer would not.
    expect((blocks - 1) * BLOCK_SECONDS).toBeLessThan(delay + UNILATERAL_RECOURSE_MARGIN)
  })

  it('also clears the settle window and the committed refund deadline', () => {
    // The regression this exists to stop: sizing the delta to the recourse
    // bound ALONE produced an `E` shorter than the older gates demand, and the
    // funding gate refused `settle_window_too_short` on a live node.
    const blocks = minFinalCltvBlocksFor(1536, false)
    expect(blocks * BLOCK_SECONDS).toBeGreaterThanOrEqual(MIN_SETTLE_WINDOW)
    expect(blocks * BLOCK_SECONDS).toBeGreaterThanOrEqual(MAX_REFUND_HORIZON + SETTLE_SAFETY_MARGIN)
  })

  it('an invoice minted to this delta passes EVERY funding gate', () => {
    // The end-to-end property: chooser and gates read the same bounds, so a
    // quote can never mint an invoice its own funding step will refuse.
    for (const delay of [1536, 3600, 6 * 3600]) {
      const e = NOW + minFinalCltvBlocksFor(delay, false) * BLOCK_SECONDS
      expect(evaluateReceiveFunding(input({ unilateralRefundWithoutReceiverDelay: delay, htlcExpiresAt: e }))).toEqual({
        fund: true,
      })
    }
  })

  it('stays well inside the payable ceiling on a regtest ladder', () => {
    expect(minFinalCltvBlocksFor(1536, false)).toBeLessThan(MAX_FINAL_CLTV_BLOCKS)
  })

  it('exceeds the payable ceiling at a mainnet-scale exit delay', () => {
    // Not a tuning problem: at a week-long exit delay no stock payer would
    // honour the delta this corridor needs, so it cannot be served safely at
    // all. The quote path turns this into a named refusal.
    expect(minFinalCltvBlocksFor(7 * 24 * 3600, false)).toBeGreaterThan(MAX_FINAL_CLTV_BLOCKS)
  })

  it('agrees with gate (d): an invoice built to this delta is fundable', () => {
    const delay = 6 * 3600
    const e = NOW + minFinalCltvBlocksFor(delay, false) * BLOCK_SECONDS
    expect(evaluateReceiveFunding(input({ unilateralRefundWithoutReceiverDelay: delay, htlcExpiresAt: e }))).toEqual({
      fund: true,
    })
  })
})

/**
 * The cliff: how short an Arkade exit delay has to be for gate (d) to be
 * SATISFIABLE rather than merely accepted.
 *
 * This is the number an operator needs when they learn their server enforces a
 * shorter minimum than it advertises, and it is worth deriving rather than
 * writing down because it sits several constants away from anything nameable.
 */
describe('maxServableExitDelay', () => {
  it('is servable, and one second more is not', () => {
    // The boundary is the whole value of the function. Asserted from both
    // sides, because an implementation that merely returns SOME servable delay
    // would pass a one-sided test while understating the headroom — which is
    // exactly what a first cut of this did, by searching off the BIP68 grid.
    const cliff = maxServableExitDelay()
    const blocksFor = (delay: number) =>
      minFinalCltvBlocksFor(deriveUnilateralDelays(delay).unilateralRefundWithoutReceiverDelay, false)
    expect(blocksFor(cliff)).toBeLessThanOrEqual(MAX_FINAL_CLTV_BLOCKS)
    expect(blocksFor(cliff + 1)).toBeGreaterThan(MAX_FINAL_CLTV_BLOCKS)
  })

  it('lands on a whole BIP68 unit, since anything else rounds up and fails', () => {
    expect(maxServableExitDelay() % SEQUENCE_GRANULARITY_SECONDS).toBe(0)
  })

  it('places what mainnet ADVERTISES outside it and what it ENFORCES inside', () => {
    // The two real numbers, and the whole reason the override exists. arkd's
    // /v1/info reports 605184 — its "Public unilateral exit" — while covenant
    // leaves are checked against the plain "Unilateral exit" of 259584. One is
    // unservable and the other has room to spare, so reading the wrong field
    // makes a working corridor look impossible.
    expect(maxServableExitDelay()).toBeLessThan(605_184)
    expect(maxServableExitDelay()).toBeGreaterThan(259_584)
  })

  it('leaves route-CLTV budget at the value mainnet should actually be set to', () => {
    // 260096 is one BIP68 unit above the enforced floor: far enough not to sit
    // on a `>` vs `>=` boundary, low enough to leave most of the payer's route
    // timelock budget unspent. `MAX_FINAL_CLTV_BLOCKS` bounds the WHOLE route,
    // not the final hop, so a delta at the ceiling would not route at all.
    const blocks = minFinalCltvBlocksFor(deriveUnilateralDelays(260_096).unilateralRefundWithoutReceiverDelay, false)
    expect(blocks).toBeLessThan(MAX_FINAL_CLTV_BLOCKS)
    expect(MAX_FINAL_CLTV_BLOCKS - blocks).toBeGreaterThan(200)
  })
})

/**
 * The operator-accepted #69 window (`Config.lnReceiveAcceptUnilateralGap`).
 *
 * The knob exists because gate (d) does not degrade at a mainnet exit delay, it
 * forecloses: 605184s of Arkade exit delay needs 4074 blocks of final CLTV,
 * which is roughly 28 days of a payer's funds and unroutable, so every quote is
 * refused and the corridor cannot run. What is asserted here is that accepting
 * it changes that one thing and nothing else.
 */
describe('accepting the unilateral gap', () => {
  const MAINNET_EXIT_DELAY = 605_184
  const MAINNET_SOLO_DELAY = MAINNET_EXIT_DELAY + 8 * 512

  it('is what stands between mainnet and an unservable corridor', () => {
    // Strict: past the ceiling, so `quote` refuses `recourse_window_unservable`
    // before minting anything and no client payload can change the answer.
    expect(minFinalCltvBlocksFor(MAINNET_SOLO_DELAY, false)).toBeGreaterThan(MAX_FINAL_CLTV_BLOCKS)
    // Accepting: gates (b) and (c) still set the floor, and the result is an
    // ordinary short delta a stock payer routes without noticing.
    const accepted = minFinalCltvBlocksFor(MAINNET_SOLO_DELAY, true)
    expect(accepted).toBeLessThan(MAX_FINAL_CLTV_BLOCKS)
    expect(accepted * BLOCK_SECONDS).toBeGreaterThanOrEqual(MAX_REFUND_HORIZON + SETTLE_SAFETY_MARGIN)
  })

  it('does not depend on the exit delay once accepted', () => {
    // The gate (d) term is dropped, not scaled, so a longer server delay stops
    // moving the delta at all. A deployment cannot be pushed back over the
    // ceiling by an Arkade operator lengthening its exit delay.
    expect(minFinalCltvBlocksFor(MAINNET_SOLO_DELAY, true)).toBe(minFinalCltvBlocksFor(1536, true))
  })

  it('funds a swap whose solo recourse opens after E', () => {
    const htlcExpiresAt = NOW + 4 * 3600
    const late = { unilateralRefundWithoutReceiverDelay: MAINNET_SOLO_DELAY, htlcExpiresAt }
    expect(evaluateReceiveFunding(input({ ...late, acceptUnilateralGap: false }))).toEqual({
      fund: false,
      reason: 'unilateral_recourse_after_htlc',
    })
    expect(evaluateReceiveFunding(input({ ...late, acceptUnilateralGap: true }))).toEqual({ fund: true })
  })

  it('still refuses everything the other gates refuse', () => {
    // The narrow claim, asserted rather than described: accepting the #69
    // window buys exactly one gate. An expired invoice, an unarmed htlc, a
    // settle window too short to use, and a committed refund deadline past `E`
    // are all still refused with the same reasons — these are the cases where
    // funding loses money for reasons gate (d) was never about.
    const accepted = { acceptUnilateralGap: true }
    expect(evaluateReceiveFunding(input({ ...accepted, invoiceExpiresAt: NOW }))).toEqual({
      fund: false,
      reason: 'invoice_expired',
    })
    expect(evaluateReceiveFunding(input({ ...accepted, htlcExpiresAt: null }))).toEqual({
      fund: false,
      reason: 'htlc_not_armed',
    })
    expect(evaluateReceiveFunding(input({ ...accepted, htlcExpiresAt: NOW + MIN_SETTLE_WINDOW - 1 }))).toEqual({
      fund: false,
      reason: 'settle_window_too_short',
    })
    const htlcExpiresAt = NOW + 4 * 3600
    expect(evaluateReceiveFunding(input({ ...accepted, htlcExpiresAt, refundLocktime: htlcExpiresAt + 1 }))).toEqual({
      fund: false,
      reason: 'refund_deadline_too_late',
    })
  })
})

/**
 * TLA+ finding F6 (#38): gate (b) `MIN_SETTLE_WINDOW` "has no independent
 * teeth" — gate (c) always demands more, so gate (b) never decides an outcome.
 *
 * That arithmetic is correct, and the resolution is to STATE it rather than to
 * delete the gate. These tests pin both halves of that answer so the comment on
 * `MIN_SETTLE_WINDOW` cannot quietly stop being true — the same discipline as
 * #144's resolution, where a bound's documented reason was void while the
 * number still held an unnamed invariant.
 */
describe('gate (b) MIN_SETTLE_WINDOW — what it is and is not', () => {
  it('is subsumed by gate (c) today, which is the finding', () => {
    // Anything failing (b) also fails (c), so (b) never changes WHETHER a swap
    // is funded. If this ever inverts, the comment on MIN_SETTLE_WINDOW is
    // wrong and gate (b) has become decisive.
    expect(MAX_REFUND_HORIZON + SETTLE_SAFETY_MARGIN).toBeGreaterThan(MIN_SETTLE_WINDOW)
  })

  it('still owns the refusal reason, which is the job it does do', () => {
    // Checked FIRST, so a short-dated HTLC is told something actionable —
    // its own window is too short — rather than something about OUR refund
    // horizon, which the payer cannot do anything about.
    const decision = evaluateReceiveFunding(input({ htlcExpiresAt: NOW + MIN_SETTLE_WINDOW - 60 }))
    expect(decision).toEqual({ fund: false, reason: 'settle_window_too_short' })
  })

  it('is the floor that becomes decisive the moment gate (c) shrinks', () => {
    // The reason deleting it would be wrong. Gate (c)'s threshold is derived
    // from MAX_REFUND_HORIZON; below this figure, gate (b) is the only thing
    // left holding the window open.
    expect(MIN_SETTLE_WINDOW - SETTLE_SAFETY_MARGIN).toBeGreaterThan(0)
    const horizonAtWhichGateBBinds = MIN_SETTLE_WINDOW - SETTLE_SAFETY_MARGIN
    expect(MAX_REFUND_HORIZON).toBeGreaterThan(horizonAtWhichGateBBinds)
  })
})
