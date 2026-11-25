import { describe, expect, it } from 'vitest'
import {
  EMPTY_LOCKUP_GRACE,
  planReceive,
  planRefundFailed,
  planSettleFailed,
  RECEIVE_FUNDING_LOST,
  RECEIVE_INVOICE_NEVER_ARMED,
  RECEIVE_LOCKUP_GONE,
  REFUND_CENSORSHIP_GRACE,
  type CoupledSend,
  type LockupFunding,
  type LockupOutpoint,
  type ReceiveAction,
  type ReceivePlanRow,
  type ReceiveReads,
} from '@arkade-os/solver-core/core/receivePlan.js'
import type { HoldState } from '@arkade-os/solver-core/ports/lightning.js'

const NOW = 1_800_000_000
const HOUR = 3_600
const OURS = { txid: 'aa', vout: 0, value: 50_000 }

const row = (state: string, over: Partial<ReceivePlanRow> = {}): ReceivePlanRow => ({
  state,
  invoiceExpiresAt: NOW + HOUR,
  payoutSats: 50_000,
  fundStartedAt: null,
  refundWithoutReceiverDelay: HOUR,
  arkadeLockupTxid: state === 'quoted' || state === 'armed' ? null : OURS.txid,
  arkadeLockupVout: state === 'quoted' || state === 'armed' ? null : OURS.vout,
  preimage: state === 'claimed' ? 'p'.repeat(64) : null,
  htlcExpiresAt: state === 'quoted' ? null : NOW + 4 * HOUR,
  settleAttemptedAt: null,
  updatedAt: NOW - 10,
  ...over,
})

/** What the outside world answers. A read the test gave no answer for fails the test. */
interface World {
  now?: number
  acceptsUnilateralGap?: boolean
  canRefundUnrolled?: boolean
  hold?: HoldState
  coupledSend?: CoupledSend | null
  coupledRefundDeadline?: number
  coupledLockupFunded?: boolean
  earlierFunding?: LockupFunding | null
  refundDeadline?: number
  spendable?: LockupOutpoint[]
  refundOpen?: boolean
  claim?: { history: LockupOutpoint[]; preimage: string | null }
  ownRefund?: string | null
  holdSettled?: boolean
}

const readsOf = (world: World) => {
  const made: string[] = []
  const answer = <K extends keyof World>(name: K): NonNullable<World[K]> | null => {
    made.push(name)
    if (world[name] === undefined) throw new Error(`the test has no answer for ${name}`)
    return world[name] ?? null
  }
  const reads: ReceiveReads = {
    now: () => world.now ?? NOW,
    acceptsUnilateralGap: () => world.acceptsUnilateralGap ?? false,
    canRefundUnrolled: () => world.canRefundUnrolled ?? true,
    hold: async () => answer('hold')!,
    coupledSend: async () => answer('coupledSend'),
    coupledRefundDeadline: async () => answer('coupledRefundDeadline')!,
    coupledLockupFunded: async () => answer('coupledLockupFunded')!,
    earlierFunding: async () => answer('earlierFunding'),
    refundDeadline: async () => answer('refundDeadline')!,
    spendable: async () => answer('spendable')!,
    refundOpen: async () => answer('refundOpen')!,
    claim: async () => answer('claim')!,
    ownRefund: async () => answer('ownRefund'),
    holdSettled: async () => answer('holdSettled')!,
  }
  return { reads, made }
}

/** The action the planner picks, and the async reads it made on the way, in order. */
const run = async (subject: ReceivePlanRow, world: World) => {
  const { reads, made } = readsOf(world)
  return { next: await planReceive(subject, reads), reads: made }
}

const PENDING: HoldState = { status: 'pending', expiresAt: null }
const HELD: HoldState = { status: 'armed', expiresAt: NOW + 4 * HOUR }
const SEND: CoupledSend = {
  state: 'funded',
  pkScript: 'send-pk',
  amountSats: 60_000,
  refundLocktime: NOW + HOUR,
  refundWithoutReceiverDelay: 24 * HOUR,
  createdAt: NOW - 60,
}
const WAIT: ReceiveAction = { do: 'wait' }
const fail = (reason: string): ReceiveAction => ({ do: 'fail', reason })

describe('planReceive: quoted', () => {
  it('arms on a held payment without looking for a coupled send', async () => {
    expect(await run(row('quoted'), { hold: HELD })).toEqual({
      reads: ['hold'],
      next: { do: 'arm', htlcExpiresAt: HELD.expiresAt },
    })
  })

  it('refuses from the first second the invoice is expired, retiring it, and waits before that', async () => {
    const world = { hold: PENDING, coupledSend: null }
    expect((await run(row('quoted', { invoiceExpiresAt: NOW }), world)).next).toEqual({
      do: 'fail',
      reason: RECEIVE_INVOICE_NEVER_ARMED,
      retireInvoice: true,
    })
    expect((await run(row('quoted', { invoiceExpiresAt: NOW + 1 }), world)).next).toEqual(WAIT)
  })

  it('acts only on an exact armed status', async () => {
    for (const status of ['pending', 'settled', 'cancelled', 'unknown'] as const) {
      const world = { hold: { status, expiresAt: null }, coupledSend: null }
      expect((await run(row('quoted'), world)).next).toEqual(WAIT)
    }
  })

  describe('against a coupled send', () => {
    const coupledTo = (send: CoupledSend) => ({ hold: PENDING, coupledSend: send, coupledRefundDeadline: NOW + HOUR })

    it('arms once the send is funded on chain, even past the invoice expiry', async () => {
      const late = row('quoted', { invoiceExpiresAt: NOW - 1 })
      expect(await run(late, { ...coupledTo(SEND), coupledLockupFunded: true })).toEqual({
        reads: ['hold', 'coupledSend', 'coupledRefundDeadline', 'coupledLockupFunded'],
        next: { do: 'arm_coupled' },
      })
    })

    it('waits while the send is not funded, on the row or on chain', async () => {
      expect(await run(row('quoted'), coupledTo({ ...SEND, state: 'quoted' }))).toEqual({
        reads: ['hold', 'coupledSend'],
        next: WAIT,
      })
      expect((await run(row('quoted'), { ...coupledTo(SEND), coupledLockupFunded: false })).next).toEqual(WAIT)
    })

    it('refuses a send that cannot cover the payout, before anything else about it', async () => {
      const small = { ...SEND, state: 'refused', amountSats: 1 }
      expect((await run(row('quoted'), coupledTo(small))).next).toEqual(
        fail('refused to fund: coupled send lockup of 1 sats cannot cover a 50000 sat payout'),
      )
    })

    it('refuses and retires the invoice when the send was refused', async () => {
      expect((await run(row('quoted'), coupledTo({ ...SEND, state: 'refused' }))).next).toEqual({
        do: 'fail',
        reason: 'coupled send was refused; the receive leg can never fund against it',
        retireInvoice: true,
      })
    })

    it('refuses when the client could not refund the send alone in time', async () => {
      const far = { ...coupledTo(SEND), coupledRefundDeadline: NOW + 48 * HOUR }
      expect(await run(row('quoted'), far)).toEqual({
        reads: ['hold', 'coupledSend', 'coupledRefundDeadline'],
        next: fail('refused to fund: coupled send refund timing is unsafe'),
      })
    })
  })
})

describe('planReceive: armed', () => {
  const safe = { earlierFunding: null, hold: HELD, refundDeadline: NOW + HOUR }

  it('adopts an earlier funding before any gate is read', async () => {
    const expired = row('armed', { invoiceExpiresAt: NOW - 1, fundStartedAt: NOW - 5 })
    expect(await run(expired, { earlierFunding: OURS })).toEqual({
      reads: ['earlierFunding'],
      next: { do: 'adopt', funding: OURS },
    })
  })

  it('waits on a lost funding answer until the refund deadline, then needs a human', async () => {
    const lost = row('armed', { fundStartedAt: NOW - 5, invoiceExpiresAt: NOW - 1 })
    expect(await run(lost, { earlierFunding: null, refundDeadline: NOW + 1 })).toEqual({
      reads: ['earlierFunding', 'refundDeadline'],
      next: WAIT,
    })
    expect((await run(lost, { earlierFunding: null, refundDeadline: NOW })).next).toEqual({
      do: 'stuck',
      reason: RECEIVE_FUNDING_LOST,
    })
  })

  it('funds a held payment that passes the gates, reading the hold again first', async () => {
    expect(await run(row('armed'), safe)).toEqual({
      reads: ['earlierFunding', 'hold', 'refundDeadline'],
      next: { do: 'fund', coupled: false },
    })
  })

  it('refuses in the words of the gate that said no', async () => {
    expect((await run(row('armed', { invoiceExpiresAt: NOW }), safe)).next).toEqual(
      fail('refused to fund: invoice_expired'),
    )
    const late = { ...safe, refundDeadline: NOW + 4 * HOUR }
    expect((await run(row('armed'), late)).next).toEqual(fail('refused to fund: refund_deadline_too_late'))
  })

  it('fails closed when nothing is held and no coupled send is left', async () => {
    const world = { earlierFunding: null, hold: PENDING, coupledSend: null, refundDeadline: NOW + HOUR }
    const { reads, next } = await run(row('armed'), world)
    expect(reads).toEqual(['earlierFunding', 'hold', 'coupledSend', 'refundDeadline'])
    expect(next.do).toBe('fail')
  })

  it('asks for the operator consent as it stands now', async () => {
    const short = row('armed', { refundWithoutReceiverDelay: 5 * HOUR })
    expect((await run(short, safe)).next).toEqual(fail('refused to fund: unilateral_recourse_after_htlc'))
    expect((await run(short, { ...safe, acceptsUnilateralGap: true })).next).toEqual({ do: 'fund', coupled: false })
  })

  describe('against a coupled send', () => {
    const coupledTo = (send: CoupledSend, deadline = NOW + HOUR) => ({
      earlierFunding: null,
      hold: PENDING,
      coupledSend: send,
      coupledRefundDeadline: deadline,
    })

    it('funds once the send is funded, covers the payout and can still be refunded alone in time', async () => {
      expect(await run(row('armed'), { ...coupledTo(SEND), coupledLockupFunded: true })).toEqual({
        reads: ['earlierFunding', 'hold', 'coupledSend', 'coupledRefundDeadline', 'coupledLockupFunded'],
        next: { do: 'fund', coupled: true },
      })
    })

    it('waits when the coupled send lockup no longer holds the payout at funding time', async () => {
      expect((await run(row('armed'), { ...coupledTo(SEND), coupledLockupFunded: false })).next).toEqual(WAIT)
    })

    it('refuses when the invoice expires during the lockup read', async () => {
      const subject = row('armed')
      const world: World = {
        ...coupledTo(SEND),
        get coupledLockupFunded() {
          world.now = subject.invoiceExpiresAt
          return true
        },
      }
      expect((await run(subject, world)).next).toEqual(fail('refused to fund: invoice_expired'))
    })

    it('refuses a send that is not funded without reading its deadline', async () => {
      const { reads, next } = await run(row('armed'), coupledTo({ ...SEND, state: 'claiming' }))
      expect(reads).toEqual(['earlierFunding', 'hold', 'coupledSend'])
      expect(next).toEqual(fail('refused to fund: coupled send swap is claiming, not funded'))
    })

    it('refuses unsafe refund timing, a short lockup and an expired invoice, in that order', async () => {
      const expired = row('armed', { invoiceExpiresAt: NOW })
      const small = { ...SEND, amountSats: 1 }
      expect((await run(row('armed'), coupledTo(small, NOW + 48 * HOUR))).next).toEqual(
        fail('refused to fund: coupled send refund timing is unsafe'),
      )
      expect((await run(expired, coupledTo(small))).next).toEqual(
        fail('refused to fund: coupled send lockup of 1 sats cannot cover a 50000 sat payout'),
      )
      expect((await run(expired, coupledTo(SEND))).next).toEqual(fail('refused to fund: invoice_expired'))
    })

    it('ignores the coupled send when a payment is held', async () => {
      expect((await run(row('armed'), safe)).reads).not.toContain('coupledSend')
    })
  })
})

describe('planReceive: funded', () => {
  const dust = { txid: 'dd', vout: 1 }

  it('waits while our output is unspent and the refund is closed, without reading the claim', async () => {
    expect(await run(row('funded'), { spendable: [OURS], refundOpen: false })).toEqual({
      reads: ['spendable', 'refundOpen'],
      next: WAIT,
    })
  })

  it('starts the refund once it is open', async () => {
    expect((await run(row('funded'), { spendable: [OURS], refundOpen: true })).next).toEqual({ do: 'start_refund' })
  })

  it('records a claim when our output is gone, even with dust still on the script and the refund open', async () => {
    const world = { spendable: [dust], claim: { history: [OURS, dust], preimage: 'ab' }, refundOpen: true }
    expect(await run(row('funded'), world)).toEqual({
      reads: ['spendable', 'claim'],
      next: { do: 'record_claim', preimage: 'ab' },
    })
  })

  it('treats a gone output with no preimage as read lag until the refund opens', async () => {
    const gone = { spendable: [], claim: { history: [OURS], preimage: null } }
    expect((await run(row('funded'), { ...gone, refundOpen: false })).next).toEqual(WAIT)
    expect((await run(row('funded'), { ...gone, refundOpen: true })).next).toEqual({ do: 'start_refund' })
  })

  it('fails a row with no recorded outpoint, after the read it always made', async () => {
    const { reads, next } = await run(row('funded', { arkadeLockupVout: null }), { spendable: [OURS] })
    expect(reads).toEqual(['spendable'])
    expect(next).toEqual(fail('funded state with no funded outpoint recorded'))
  })
})

describe('planReceive: claimed', () => {
  it('settles a held payment without looking for a coupled send', async () => {
    expect(await run(row('claimed'), {})).toEqual({ reads: [], next: { do: 'settle' } })
  })

  it('fails a row with no preimage', async () => {
    expect((await run(row('claimed', { preimage: null }), {})).next).toEqual(fail('claimed state with no preimage'))
  })

  it('has nothing to settle on a coupled swap', async () => {
    const coupled = row('claimed', { htlcExpiresAt: null })
    expect(await run(coupled, { coupledSend: SEND })).toEqual({
      reads: ['coupledSend'],
      next: { do: 'record_settled' },
    })
    expect((await run(coupled, { coupledSend: null })).next).toEqual({ do: 'settle' })
  })
})

describe('planSettleFailed', () => {
  const after = async (subject: ReceivePlanRow, world: World) => {
    const { reads, made } = readsOf(world)
    return { next: await planSettleFailed(subject, reads, 'node said no'), reads: made }
  }

  it('rethrows on a first attempt before the deadline, without asking the node', async () => {
    expect(await after(row('claimed'), {})).toEqual({ reads: [], next: { do: 'rethrow' } })
  })

  it('asks the node on a repeat, and records the settle it reports', async () => {
    const repeat = row('claimed', { settleAttemptedAt: NOW - 30 })
    expect(await after(repeat, { holdSettled: true })).toEqual({
      reads: ['holdSettled'],
      next: { do: 'record_settled' },
    })
    expect((await after(repeat, { holdSettled: false })).next).toEqual({ do: 'rethrow' })
  })

  it('gives up from the first second past the deadline, with what the node said', async () => {
    expect((await after(row('claimed', { htlcExpiresAt: NOW }), {})).next).toEqual(
      fail('settle failing past E: node said no'),
    )
  })

  it('gives up at once on a row with no deadline', async () => {
    expect((await after(row('claimed', { htlcExpiresAt: null }), {})).next).toEqual(
      fail('claimed state with no htlcExpiresAt recorded'),
    )
  })
})

describe('planReceive: refunding', () => {
  const noClaim = { history: [OURS], preimage: null }

  it('records a late claim before anything else is read', async () => {
    expect(await run(row('refunding'), { claim: { history: [OURS], preimage: 'ab' } })).toEqual({
      reads: ['claim'],
      next: { do: 'record_claim', preimage: 'ab' },
    })
  })

  it('refunds our own unspent output', async () => {
    expect(await run(row('refunding'), { claim: noClaim, spendable: [OURS] })).toEqual({
      reads: ['claim', 'spendable'],
      next: { do: 'refund' },
    })
  })

  it('refunds an unrolled lockup on Bitcoin before reading what is spendable, when the backend can', async () => {
    const world = { claim: { history: [{ ...OURS, unrolled: true }], preimage: null }, spendable: [] }
    expect(await run(row('refunding'), world)).toEqual({ reads: ['claim'], next: { do: 'refund_unrolled' } })
    const cannot = { ...world, ownRefund: 'r1', canRefundUnrolled: false }
    expect((await run(row('refunding'), cannot)).next).toEqual({ do: 'record_refund', txid: 'r1' })
  })

  it('does not refund dust: only our recorded output counts', async () => {
    const world = { claim: noClaim, spendable: [{ txid: 'dd', vout: 1 }], ownRefund: null }
    expect(await run(row('refunding'), world)).toEqual({ reads: ['claim', 'spendable', 'ownRefund'], next: WAIT })
  })

  it('records our own refund that landed without its answer', async () => {
    const world = { claim: noClaim, spendable: [], ownRefund: 'r1' }
    expect((await run(row('refunding'), world)).next).toEqual({ do: 'record_refund', txid: 'r1' })
  })

  it('waits out the read lag, then the held payment, before calling a gone output inexplicable', async () => {
    const gone = { claim: noClaim, spendable: [], ownRefund: null }
    const justNow = row('refunding', { updatedAt: NOW - EMPTY_LOCKUP_GRACE + 1, htlcExpiresAt: NOW })
    const held = row('refunding', { updatedAt: NOW - EMPTY_LOCKUP_GRACE, htlcExpiresAt: NOW + 1 })
    const over = row('refunding', { updatedAt: NOW - EMPTY_LOCKUP_GRACE, htlcExpiresAt: NOW })
    expect((await run(justNow, gone)).next).toEqual(WAIT)
    expect((await run(held, gone)).next).toEqual(WAIT)
    expect((await run(over, gone)).next).toEqual(fail(RECEIVE_LOCKUP_GONE))
    expect((await run({ ...over, htlcExpiresAt: null }, gone)).next).toEqual(fail(RECEIVE_LOCKUP_GONE))
  })

  it('fails a row with no recorded outpoint before any read', async () => {
    expect(await run(row('refunding', { arkadeLockupTxid: null }), {})).toEqual({
      reads: [],
      next: fail('refunding state with no funded outpoint recorded'),
    })
  })
})

describe('planRefundFailed', () => {
  it('keeps retrying for the grace, counted from entering the state, then gives up', () => {
    const early = row('refunding', { updatedAt: NOW - REFUND_CENSORSHIP_GRACE + 1 })
    const late = row('refunding', { updatedAt: NOW - REFUND_CENSORSHIP_GRACE })
    expect(planRefundFailed(early, NOW, 'arkd said no')).toEqual({ do: 'rethrow' })
    expect(planRefundFailed(late, NOW, 'arkd said no — exit by hand')).toEqual(
      fail('refund failing past the refund deadline: arkd said no — exit by hand'),
    )
  })
})

describe('planReceive: other states', () => {
  it('plans nothing for a finished swap', async () => {
    for (const state of ['settled', 'refunded', 'refused', 'stuck']) {
      expect(await run(row(state), {})).toEqual({ reads: [], next: WAIT })
    }
  })
})
