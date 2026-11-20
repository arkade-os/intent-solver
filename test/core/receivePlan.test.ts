import { describe, expect, it } from 'vitest'
import {
  EMPTY_LOCKUP_GRACE,
  planReceive,
  RECEIVE_FUNDING_LOST,
  RECEIVE_INVOICE_NEVER_ARMED,
  RECEIVE_LOCKUP_GONE,
  REFUND_CENSORSHIP_GRACE,
  type ReceiveAction,
  type ReceiveObservation,
  type ReceivePlanRow,
  type ReceiveRead,
} from '@arkade-os/solver-core/core/receivePlan.js'

const NOW = 1_800_000_000
const HOUR = 3_600
const OURS = { txid: 'aa', vout: 0 }

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

type Facts = Omit<ReceiveObservation, 'nowSeconds' | 'acceptUnilateralGap' | 'canRefundUnrolled'>
const FIELD: Record<ReceiveRead, keyof Facts> = {
  hold: 'hold',
  coupled: 'coupled',
  funding: 'funding',
  refund_deadline: 'refundDeadlineSeconds',
  coupled_refund_deadline: 'coupledRefundDeadlineSeconds',
  spendable: 'spendable',
  refund_open: 'refundOpen',
  claim: 'claim',
  own_refund: 'ownRefund',
  hold_settled: 'holdSettled',
}

/** Answers each read from `world`, as the orchestrator would, and returns what was read and the action. */
const run = (subject: ReceivePlanRow, world: Facts, start: Partial<ReceiveObservation> = {}) => {
  const seen: ReceiveObservation = { nowSeconds: NOW, acceptUnilateralGap: false, canRefundUnrolled: true, ...start }
  const reads: ReceiveRead[] = []
  for (;;) {
    const next = planReceive(subject, seen)
    if (next.do !== 'read') return { reads, next }
    if (reads.includes(next.what)) throw new Error(`asked for ${next.what} twice`)
    const field = FIELD[next.what]
    if (world[field] === undefined) throw new Error(`the test has no answer for ${next.what}`)
    Object.assign(seen, { [field]: world[field] })
    reads.push(next.what)
  }
}

const PENDING = { status: 'pending', expiresAt: null } as const
const HELD = { status: 'armed', expiresAt: NOW + 4 * HOUR } as const
const SEND = { state: 'funded', amountSats: 60_000, refundWithoutReceiverDelay: 24 * HOUR, createdAt: NOW - 60 }
const WAIT: ReceiveAction = { do: 'wait' }
const fail = (reason: string): ReceiveAction => ({ do: 'fail', reason })

describe('planReceive: quoted', () => {
  it('arms on a held payment without looking for a coupled send', () => {
    expect(run(row('quoted'), { hold: HELD })).toEqual({
      reads: ['hold'],
      next: { do: 'arm', htlcExpiresAt: HELD.expiresAt },
    })
  })

  it('hands a coupled send to its own rules, even past the invoice expiry', () => {
    const late = row('quoted', { invoiceExpiresAt: NOW - 1 })
    expect(run(late, { hold: PENDING, coupled: SEND })).toEqual({ reads: ['hold', 'coupled'], next: { do: 'couple' } })
  })

  it('refuses from the first second the invoice is expired, and waits before it', () => {
    const world = { hold: PENDING, coupled: null }
    expect(run(row('quoted', { invoiceExpiresAt: NOW }), world).next).toEqual(fail(RECEIVE_INVOICE_NEVER_ARMED))
    expect(run(row('quoted', { invoiceExpiresAt: NOW + 1 }), world).next).toEqual(WAIT)
  })

  it('acts only on an exact armed status', () => {
    for (const status of ['pending', 'settled', 'cancelled', 'unknown'] as const) {
      expect(run(row('quoted'), { hold: { status, expiresAt: null }, coupled: null }).next).toEqual(WAIT)
    }
  })
})

describe('planReceive: armed', () => {
  const safe = { funding: null, hold: HELD, refundDeadlineSeconds: NOW + HOUR }

  it('adopts an earlier funding before any gate is read', () => {
    const expired = row('armed', { invoiceExpiresAt: NOW - 1, fundStartedAt: NOW - 5 })
    expect(run(expired, { funding: OURS })).toEqual({ reads: ['funding'], next: { do: 'adopt' } })
  })

  it('waits on a lost funding answer until the refund deadline, then needs a human', () => {
    const lost = row('armed', { fundStartedAt: NOW - 5, invoiceExpiresAt: NOW - 1 })
    expect(run(lost, { funding: null, refundDeadlineSeconds: NOW + 1 })).toEqual({
      reads: ['funding', 'refund_deadline'],
      next: WAIT,
    })
    expect(run(lost, { funding: null, refundDeadlineSeconds: NOW }).next).toEqual({
      do: 'stuck',
      reason: RECEIVE_FUNDING_LOST,
    })
  })

  it('funds a held payment that passes the gates, reading the hold again first', () => {
    expect(run(row('armed'), safe)).toEqual({
      reads: ['funding', 'hold', 'refund_deadline'],
      next: { do: 'fund', coupled: false },
    })
  })

  it('refuses in the words of the gate that said no', () => {
    expect(run(row('armed', { invoiceExpiresAt: NOW }), safe).next).toEqual(fail('refused to fund: invoice_expired'))
    const late = { ...safe, refundDeadlineSeconds: HELD.expiresAt }
    expect(run(row('armed'), late).next).toEqual(fail('refused to fund: refund_deadline_too_late'))
  })

  it('fails closed when nothing is held and no coupled send is left', () => {
    const world = { funding: null, hold: PENDING, coupled: null, refundDeadlineSeconds: NOW + HOUR }
    const { reads, next } = run(row('armed'), world)
    expect(reads).toEqual(['funding', 'hold', 'coupled', 'refund_deadline'])
    expect(next.do).toBe('fail')
  })

  it('reads the operator consent it is given on each call', () => {
    const short = row('armed', { refundWithoutReceiverDelay: 5 * HOUR })
    expect(run(short, safe).next).toEqual(fail('refused to fund: unilateral_recourse_after_htlc'))
    expect(run(short, safe, { acceptUnilateralGap: true }).next).toEqual({ do: 'fund', coupled: false })
  })

  describe('against a coupled send', () => {
    const coupledTo = (send: typeof SEND, deadline = NOW + HOUR) => ({
      funding: null,
      hold: PENDING,
      coupled: send,
      coupledRefundDeadlineSeconds: deadline,
    })

    it('funds once the send is funded, covers the payout and can still be refunded alone in time', () => {
      expect(run(row('armed'), coupledTo(SEND))).toEqual({
        reads: ['funding', 'hold', 'coupled', 'coupled_refund_deadline'],
        next: { do: 'fund', coupled: true },
      })
    })

    it('refuses a send that is not funded without reading its deadline', () => {
      const { reads, next } = run(row('armed'), coupledTo({ ...SEND, state: 'claiming' }))
      expect(reads).toEqual(['funding', 'hold', 'coupled'])
      expect(next).toEqual(fail('refused to fund: coupled send swap is claiming, not funded'))
    })

    it('refuses unsafe refund timing, a short lockup and an expired invoice, in that order', () => {
      const far = coupledTo({ ...SEND, amountSats: 1 }, NOW + 48 * HOUR)
      expect(run(row('armed'), far).next).toEqual(fail('refused to fund: coupled send refund timing is unsafe'))
      expect(run(row('armed', { invoiceExpiresAt: NOW }), coupledTo({ ...SEND, amountSats: 1 })).next).toEqual(
        fail('refused to fund: coupled send lockup of 1 sats cannot cover a 50000 sat payout'),
      )
      expect(run(row('armed', { invoiceExpiresAt: NOW }), coupledTo(SEND)).next).toEqual(
        fail('refused to fund: invoice_expired'),
      )
    })

    it('ignores the coupled send when a payment is held', () => {
      expect(run(row('armed'), safe).reads).not.toContain('coupled')
    })
  })
})

describe('planReceive: funded', () => {
  const dust = { txid: 'dd', vout: 1 }

  it('waits while our output is unspent and the refund is closed, without reading the claim', () => {
    expect(run(row('funded'), { spendable: [OURS], refundOpen: false })).toEqual({
      reads: ['spendable', 'refund_open'],
      next: WAIT,
    })
  })

  it('starts the refund once it is open', () => {
    expect(run(row('funded'), { spendable: [OURS], refundOpen: true }).next).toEqual({ do: 'start_refund' })
  })

  it('records a claim when our output is gone, even with dust still on the script and the refund open', () => {
    const world = { spendable: [dust], claim: { history: [OURS, dust], preimage: 'ab' }, refundOpen: true }
    expect(run(row('funded'), world)).toEqual({
      reads: ['spendable', 'claim'],
      next: { do: 'record_claim', preimage: 'ab' },
    })
  })

  it('treats a gone output with no preimage as read lag until the refund opens', () => {
    const gone = { spendable: [], claim: { history: [OURS], preimage: null } }
    expect(run(row('funded'), { ...gone, refundOpen: false }).next).toEqual(WAIT)
    expect(run(row('funded'), { ...gone, refundOpen: true }).next).toEqual({ do: 'start_refund' })
  })

  it('fails a row with no recorded outpoint, after the read it always made', () => {
    const { reads, next } = run(row('funded', { arkadeLockupVout: null }), { spendable: [OURS] })
    expect(reads).toEqual(['spendable'])
    expect(next).toEqual(fail('funded state with no funded outpoint recorded'))
  })
})

describe('planReceive: claimed', () => {
  it('settles a held payment without looking for a coupled send', () => {
    expect(run(row('claimed'), {})).toEqual({ reads: [], next: { do: 'settle' } })
  })

  it('fails a row with no preimage', () => {
    expect(run(row('claimed', { preimage: null }), {}).next).toEqual(fail('claimed state with no preimage'))
  })

  it('has nothing to settle on a coupled swap', () => {
    const coupled = row('claimed', { htlcExpiresAt: null })
    expect(run(coupled, { coupled: SEND })).toEqual({ reads: ['coupled'], next: { do: 'record_settled' } })
    expect(run(coupled, { coupled: null }).next).toEqual({ do: 'settle' })
  })

  describe('after settle failed', () => {
    const failed = { settleFailed: 'node said no' }

    it('rethrows on a first attempt before the deadline, without asking the node', () => {
      expect(run(row('claimed'), {}, failed)).toEqual({ reads: [], next: { do: 'rethrow' } })
    })

    it('asks the node on a repeat, and records the settle it reports', () => {
      const repeat = row('claimed', { settleAttemptedAt: NOW - 30 })
      expect(run(repeat, { holdSettled: true }, failed)).toEqual({
        reads: ['hold_settled'],
        next: { do: 'record_settled' },
      })
      expect(run(repeat, { holdSettled: false }, failed).next).toEqual({ do: 'rethrow' })
    })

    it('gives up from the first second past the deadline, with what the node said', () => {
      const past = row('claimed', { htlcExpiresAt: NOW })
      expect(run(past, {}, failed).next).toEqual(fail('settle failing past E: node said no'))
    })

    it('gives up at once on a row with no deadline that is not coupled', () => {
      const corrupt = row('claimed', { htlcExpiresAt: null })
      expect(run(corrupt, { coupled: null }, failed).next).toEqual(fail('claimed state with no htlcExpiresAt recorded'))
    })
  })
})

describe('planReceive: refunding', () => {
  const noClaim = { history: [OURS], preimage: null }

  it('records a late claim before anything else is read', () => {
    expect(run(row('refunding'), { claim: { history: [OURS], preimage: 'ab' } })).toEqual({
      reads: ['claim'],
      next: { do: 'record_claim', preimage: 'ab' },
    })
  })

  it('refunds our own unspent output', () => {
    expect(run(row('refunding'), { claim: noClaim, spendable: [OURS] })).toEqual({
      reads: ['claim', 'spendable'],
      next: { do: 'refund' },
    })
  })

  it('refunds an unrolled lockup on Bitcoin before reading what is spendable, when the backend can', () => {
    const world = { claim: { history: [{ ...OURS, unrolled: true }], preimage: null }, spendable: [] }
    expect(run(row('refunding'), world)).toEqual({ reads: ['claim'], next: { do: 'refund_unrolled' } })
    expect(run(row('refunding'), { ...world, ownRefund: 'r1' }, { canRefundUnrolled: false }).next.do).toBe(
      'record_refund',
    )
  })

  it('does not refund dust: only our recorded output counts', () => {
    const world = { claim: noClaim, spendable: [{ txid: 'dd', vout: 1 }], ownRefund: null }
    expect(run(row('refunding'), world)).toEqual({ reads: ['claim', 'spendable', 'own_refund'], next: WAIT })
  })

  it('records our own refund that landed without its answer', () => {
    const world = { claim: noClaim, spendable: [], ownRefund: 'r1' }
    expect(run(row('refunding'), world).next).toEqual({ do: 'record_refund', txid: 'r1' })
  })

  it('waits out the read lag, then the held payment, before calling a gone output inexplicable', () => {
    const gone = { claim: noClaim, spendable: [], ownRefund: null }
    const justNow = row('refunding', { updatedAt: NOW - EMPTY_LOCKUP_GRACE + 1, htlcExpiresAt: NOW })
    const held = row('refunding', { updatedAt: NOW - EMPTY_LOCKUP_GRACE, htlcExpiresAt: NOW + 1 })
    const over = row('refunding', { updatedAt: NOW - EMPTY_LOCKUP_GRACE, htlcExpiresAt: NOW })
    expect(run(justNow, gone).next).toEqual(WAIT)
    expect(run(held, gone).next).toEqual(WAIT)
    expect(run(over, gone).next).toEqual(fail(RECEIVE_LOCKUP_GONE))
    expect(run({ ...over, htlcExpiresAt: null }, gone).next).toEqual(fail(RECEIVE_LOCKUP_GONE))
  })

  it('keeps retrying a failing refund for the grace, counted from entering the state', () => {
    const failed = { refundFailed: 'arkd said no — exit by hand' }
    const early = row('refunding', { updatedAt: NOW - REFUND_CENSORSHIP_GRACE + 1 })
    const late = row('refunding', { updatedAt: NOW - REFUND_CENSORSHIP_GRACE })
    expect(run(early, {}, failed)).toEqual({ reads: [], next: { do: 'rethrow' } })
    expect(run(late, {}, failed).next).toEqual(
      fail('refund failing past the refund deadline: arkd said no — exit by hand'),
    )
  })

  it('fails a row with no recorded outpoint before any read', () => {
    expect(run(row('refunding', { arkadeLockupTxid: null }), {})).toEqual({
      reads: [],
      next: fail('refunding state with no funded outpoint recorded'),
    })
  })
})

describe('planReceive: other states', () => {
  it('plans nothing for a finished swap', () => {
    for (const state of ['settled', 'refunded', 'refused', 'stuck']) {
      expect(run(row(state), {})).toEqual({ reads: [], next: WAIT })
    }
  })
})
