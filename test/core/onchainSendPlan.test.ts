import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import {
  FUNDING_STUCK_ALERT_SECONDS,
  ONCHAIN_FOREIGN_SPEND,
  ONCHAIN_KEY_ROTATED,
  planOnchainSend,
  type OnchainSendAction,
  type OnchainSendObservation,
  type OnchainSendPlanRow,
  type OnchainSendRead,
} from '@arkade-os/solver-core/core/onchainSendPlan.js'
import {
  ARKADE_CLAIM_WINDOW_SECONDS,
  DEFAULT_ONCHAIN_LOCKUP_TIMEOUT,
  HTLC_REFUND_MTP_MARGIN,
} from '@arkade-os/solver-core/core/onchainSend.js'

const NOW = 1_800_000_000
const HOUR = 3_600
const P = new Uint8Array(32).fill(9)
const SIG = new Uint8Array(64)

const row = (state: string, over: Partial<OnchainSendPlanRow> = {}): OnchainSendPlanRow => {
  const paid = !['quoted', 'funded', 'funding_onchain'].includes(state)
  return {
    id: 'swap',
    state,
    createdAt: NOW,
    paymentHash: hex.encode(sha256(P)),
    amountSats: 50_000,
    payoutSats: 49_000,
    refundLocktime: NOW + 48 * HOUR,
    htlcLocktime: NOW + 24 * HOUR,
    minConfirmations: 1,
    onchainLockupValue: state === 'quoted' ? null : 50_000,
    fundingTxid: paid ? 'fund' : null,
    fundingVout: paid ? 0 : null,
    fundingTx: null,
    fundStartedAt: paid ? NOW : null,
    onchainRefundTxid: null,
    onchainRefundPriorTxids: [],
    ...over,
  }
}

type Facts = Omit<
  OnchainSendObservation,
  'nowSeconds' | 'providerKeyCurrent' | 'checksLockupExpiry' | 'maxLockupOutputs'
>
const FIELD: Record<OnchainSendRead, keyof Facts> = {
  lockups: 'lockups',
  approval: 'approved',
  lockup_held: 'lockupHeld',
  payout_outputs: 'payoutOutputs',
  spend_witness: 'spend',
  funding_outcome: 'fundingOutcome',
  refund_outcome: 'refundOutcome',
}

/** Answers each read from `world`, as the orchestrator would, and returns what was read and the action. */
const run = (subject: OnchainSendPlanRow, world: Facts, start: Partial<OnchainSendObservation> = {}) => {
  const seen: OnchainSendObservation = {
    nowSeconds: NOW,
    providerKeyCurrent: true,
    checksLockupExpiry: true,
    maxLockupOutputs: 16,
    ...start,
  }
  const reads: OnchainSendRead[] = []
  for (;;) {
    const next = planOnchainSend(subject, seen)
    if (next.do !== 'read') return { reads, next }
    if (reads.includes(next.what)) throw new Error(`asked for ${next.what} twice`)
    const field = FIELD[next.what]
    if (world[field] === undefined) throw new Error(`the test has no answer for ${next.what}`)
    Object.assign(seen, { [field]: world[field] })
    reads.push(next.what)
  }
}

const WAIT: OnchainSendAction = { do: 'wait' }
const fail = (reason: string): OnchainSendAction => ({ do: 'fail', reason })
const lockups = (...values: number[]) => ({
  held: values.reduce((sum, value) => sum + value, 0),
  spendable: values.map((value) => ({ value })),
})

describe('planOnchainSend: quoted', () => {
  const at = (nowSeconds: number) => ({ nowSeconds })
  const TIMEOUT = NOW + DEFAULT_ONCHAIN_LOCKUP_TIMEOUT

  it('adopts a lockup of exactly the amount', () => {
    expect(run(row('quoted'), { lockups: lockups(50_000) })).toEqual({
      reads: ['lockups'],
      next: { do: 'adopt_lockup' },
    })
    expect(run(row('quoted'), { lockups: lockups(30_000, 20_000) }).next).toEqual({ do: 'adopt_lockup' })
  })

  it('waits for an unfunded or part-funded lockup until the timeout', () => {
    expect(run(row('quoted'), { lockups: lockups() }).next).toEqual(WAIT)
    expect(run(row('quoted'), { lockups: lockups(10) }, at(TIMEOUT - 1)).next).toEqual(WAIT)
  })

  it('refuses at the timeout, and records what was held only when something was', () => {
    expect(run(row('quoted'), { lockups: lockups() }, at(TIMEOUT)).next).toEqual(fail('lockup timeout'))
    expect(run(row('quoted'), { lockups: lockups(10) }, at(TIMEOUT)).next).toEqual({
      do: 'fail',
      reason: 'lockup timeout with partial 10 sats',
      lockupValue: 10,
    })
    expect(run(row('quoted'), { lockups: lockups(50_000) }, at(TIMEOUT)).next).toEqual({
      do: 'fail',
      reason: 'lockup timeout with partial 50000 sats',
      lockupValue: 50_000,
    })
  })

  it('refuses an overfunded lockup and records all of it', () => {
    expect(run(row('quoted'), { lockups: lockups(50_001) }).next).toEqual({
      do: 'fail',
      reason: 'overfunded lockup: 50001 > 50000 sats',
      lockupValue: 50_001,
    })
  })

  it('refuses a lockup spread over more outputs than one claim spends', () => {
    const spread = lockups(...Array.from({ length: 17 }, (_, i) => (i === 0 ? 50_000 - 16 : 1)))
    expect(run(row('quoted'), { lockups: spread }).next).toEqual(fail('lockup funded in 17 outputs, over 16'))
    expect(run(row('quoted'), { lockups: spread }, { maxLockupOutputs: 17 }).next).toEqual({ do: 'adopt_lockup' })
  })

  it('refuses at once when the amount is there but part sits where a claim cannot spend it', () => {
    const world = { lockups: { held: 50_000, spendable: [{ value: 49_500 }] } }
    expect(run(row('quoted'), world).next).toEqual({
      do: 'fail',
      reason: 'lockup funded on an asset vtxo a claim cannot spend: 50000 held, 49500 spendable',
      lockupValue: 50_000,
    })
  })

  it('refuses a lockup that expires before a claim could still need it, except where expiry is not checked', () => {
    const early = { lockups: { held: 50_000, spendable: [{ value: 50_000, expiresAt: NOW + HOUR }] } }
    expect(run(row('quoted'), early).next.do).toBe('fail')
    expect(run(row('quoted'), early, { checksLockupExpiry: false }).next).toEqual({ do: 'adopt_lockup' })
  })
})

describe('planOnchainSend: funded', () => {
  it('asks the gates, then for approval, then weighs the lockup again before funding', () => {
    expect(run(row('funded'), { approved: true, lockupHeld: 50_000 })).toEqual({
      reads: ['approval', 'lockup_held'],
      next: { do: 'enter_funding' },
    })
  })

  it('refuses on a rotated key or a closed window without asking for approval', () => {
    expect(run(row('funded'), {}, { providerKeyCurrent: false })).toEqual({
      reads: [],
      next: fail(ONCHAIN_KEY_ROTATED),
    })
    const late = run(row('funded'), {}, { nowSeconds: NOW + 48 * HOUR })
    expect(late.reads).toEqual([])
    expect(late.next.do).toBe('fail')
  })

  it('waits while approval is withheld, without reading the lockup', () => {
    expect(run(row('funded'), { approved: false })).toEqual({ reads: ['approval'], next: WAIT })
  })

  it('does not ask the gates again once approval has been read', () => {
    const seen = {
      nowSeconds: NOW + 48 * HOUR,
      providerKeyCurrent: false,
      checksLockupExpiry: true,
      maxLockupOutputs: 16,
    }
    expect(planOnchainSend(row('funded'), { ...seen, approved: true, lockupHeld: 50_000 })).toEqual({
      do: 'enter_funding',
    })
  })

  it('refuses when the lockup lost value while waiting', () => {
    expect(run(row('funded'), { approved: true, lockupHeld: 49_999 }).next).toEqual(
      fail('lockup holds 49999 of 50000 sats at funding: unrolled, swept or spent'),
    )
  })
})

describe('planOnchainSend: funding_onchain', () => {
  it('records a funding whose txid is on the row', () => {
    expect(run(row('funding_onchain', { fundingTxid: 'fund', fundingTx: 'raw' }), {})).toEqual({
      reads: [],
      next: { do: 'record_funded' },
    })
  })

  it('resends a recorded funding without asking the chain', () => {
    expect(run(row('funding_onchain', { fundingTx: 'raw' }), {})).toEqual({
      reads: [],
      next: { do: 'publish_recorded' },
    })
  })

  it('adopts an output of exactly the payout, and funds past anything else at the address', () => {
    const ours = { txid: 'seen', vout: 2, valueSats: 49_000 }
    const dust = { txid: 'dust', vout: 0, valueSats: 330 }
    expect(run(row('funding_onchain'), { payoutOutputs: [dust, ours] })).toEqual({
      reads: ['payout_outputs'],
      next: { do: 'adopt_funding', txid: 'seen', vout: 2 },
    })
    expect(run(row('funding_onchain'), { payoutOutputs: [dust] }).next).toEqual({ do: 'submit_funding' })
  })
})

describe('planOnchainSend: awaiting_claim', () => {
  const REFUND_AT = NOW + 24 * HOUR + HTLC_REFUND_MTP_MARGIN

  it('waits while the output is unspent and the refund is closed', () => {
    expect(run(row('awaiting_claim'), { spend: null })).toEqual({ reads: ['spend_witness'], next: WAIT })
  })

  it('starts the refund only past the locktime plus the margin', () => {
    expect(
      run(row('awaiting_claim'), { spend: null, fundingOutcome: 'confirmed' }, { nowSeconds: REFUND_AT - 1 }).next,
    ).toEqual(WAIT)
    expect(run(row('awaiting_claim'), { spend: null }, { nowSeconds: REFUND_AT }).next).toEqual({ do: 'start_refund' })
  })

  it('tells a human about a funding still unconfirmed after the alert time', () => {
    const late = { nowSeconds: NOW + FUNDING_STUCK_ALERT_SECONDS }
    const { reads, next } = run(row('awaiting_claim'), { spend: null, fundingOutcome: 'mempool' }, late)
    expect(reads).toEqual(['spend_witness', 'funding_outcome'])
    expect(next).toMatchObject({ do: 'wait', alert: expect.stringContaining('funding fund unconfirmed 1200s') })
    expect(run(row('awaiting_claim'), { spend: null, fundingOutcome: 'confirmed' }, late).next).toEqual(WAIT)
    expect(run(row('awaiting_claim'), { spend: null }, { nowSeconds: late.nowSeconds - 1 }).reads).toEqual([
      'spend_witness',
    ])
  })

  it('records a matching claim', () => {
    expect(run(row('awaiting_claim'), { spend: { preimage: P } }).next).toEqual({
      do: 'record_claim',
      preimage: hex.encode(P),
    })
  })

  it('records the claim and warns when little time is left to collect', () => {
    const squeezed = { nowSeconds: NOW + 48 * HOUR - ARKADE_CLAIM_WINDOW_SECONDS + 1 }
    expect(run(row('awaiting_claim'), { spend: { preimage: P } }, squeezed).next).toMatchObject({
      do: 'record_claim',
      preimage: hex.encode(P),
      alert: expect.stringContaining('claim race'),
    })
  })

  it('needs a human for a spend that is not a matching claim', () => {
    for (const preimage of [null, new Uint8Array(32).fill(1), new Uint8Array(0)]) {
      expect(run(row('awaiting_claim'), { spend: { preimage } }).next).toEqual(fail(ONCHAIN_FOREIGN_SPEND))
    }
  })

  it('fails a row with no funding outpoint before any read', () => {
    expect(run(row('awaiting_claim', { fundingVout: null }), {})).toEqual({
      reads: [],
      next: fail('awaiting_claim state with no funding txid/vout'),
    })
  })
})

describe('planOnchainSend: refunding_onchain', () => {
  const tracked = row('refunding_onchain', { onchainRefundTxid: 'r2', onchainRefundPriorTxids: ['r1'] })

  it('pushes a first refund once no claim is on chain', () => {
    expect(run(row('refunding_onchain'), { spend: null })).toEqual({
      reads: ['spend_witness'],
      next: { do: 'push_refund' },
    })
  })

  it('records its own confirmed refund before looking for a claim', () => {
    expect(run(tracked, { refundOutcome: { outcome: 'confirmed', txid: 'r1' } })).toEqual({
      reads: ['refund_outcome'],
      next: { do: 'record_refund', txid: 'r1' },
    })
  })

  it('bumps a refund still in the mempool', () => {
    expect(run(tracked, { refundOutcome: { outcome: 'mempool', txid: null } })).toEqual({
      reads: ['refund_outcome'],
      next: { do: 'bump_refund' },
    })
  })

  it('looks for a claim when no earlier refund is known to the chain', () => {
    const world = { refundOutcome: { outcome: 'unknown' as const, txid: null }, spend: null }
    expect(run(tracked, world)).toEqual({ reads: ['refund_outcome', 'spend_witness'], next: { do: 'push_refund' } })
    expect(run(row('refunding_onchain', { onchainRefundPriorTxids: ['r1'] }), world).reads).toContain('refund_outcome')
  })

  it('records a late claim instead of refunding over it', () => {
    expect(run(row('refunding_onchain'), { spend: { preimage: P } }).next).toEqual({
      do: 'record_claim',
      preimage: hex.encode(P),
    })
    expect(run(row('refunding_onchain'), { spend: { preimage: null } }).next).toEqual(fail(ONCHAIN_FOREIGN_SPEND))
  })

  it('retries a refund that could not be sent until the refund locktime, then gives up', () => {
    const world = { spend: null }
    const notSent = (retry: boolean, nowSeconds = NOW) => ({
      nowSeconds,
      refundNotSent: { reason: 'too small', retry },
    })
    expect(run(row('refunding_onchain'), world, notSent(true)).next).toEqual({ do: 'throw', message: 'too small' })
    expect(run(row('refunding_onchain'), world, notSent(true, NOW + 48 * HOUR)).next).toEqual(fail('too small'))
    expect(run(row('refunding_onchain'), world, notSent(false)).next).toEqual(fail('too small'))
  })

  it('fails a row with no funding outpoint before any read', () => {
    expect(run(row('refunding_onchain', { fundingTxid: null }), {})).toEqual({
      reads: [],
      next: fail('refunding_onchain state with no funding txid/vout'),
    })
  })
})

describe('planOnchainSend: other states', () => {
  it('leaves the claim of the Arkade lockup to the orchestrator', () => {
    expect(run(row('claiming'), {})).toEqual({ reads: [], next: { do: 'claim_lockup' } })
  })

  it('plans nothing for a finished swap', () => {
    for (const state of ['claimed', 'refunded', 'refused', 'stuck']) {
      expect(run(row(state), {})).toEqual({ reads: [], next: WAIT })
    }
  })
})
