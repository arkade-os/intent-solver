import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import {
  FUNDING_STUCK_ALERT_SECONDS,
  ONCHAIN_FOREIGN_SPEND,
  ONCHAIN_KEY_ROTATED,
  planOnchainSend,
  type OnchainSendAction,
  planRefundNotSent,
  type ClientLockup,
  type OnchainSendPlanRow,
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

/** What the outside world answers. A read the test gave no answer for fails the test. */
interface World {
  now?: number
  providerKeyCurrent?: boolean
  checksLockupExpiry?: boolean
  maxLockupOutputs?: number
  lockups?: ClientLockup
  approved?: boolean
  lockupHeld?: number
  payoutOutputs?: { txid: string; vout: number; valueSats: number }[]
  spend?: { preimage: Uint8Array | null } | null
  fundingOutcome?: 'unknown' | 'mempool' | 'confirmed'
  refundOutcome?: { outcome: 'unknown' | 'mempool' | 'confirmed'; txid: string | null }
}

/** The action the planner picks, and the reads it made on the way, in order. */
const run = async (subject: OnchainSendPlanRow, world: World, start: World = {}) => {
  const all = { ...world, ...start }
  const reads: string[] = []
  const answer = <K extends keyof World>(name: K): NonNullable<World[K]> | null => {
    reads.push(name)
    if (all[name] === undefined) throw new Error(`the test has no answer for ${name}`)
    return all[name] ?? null
  }
  const next = await planOnchainSend(subject, {
    now: () => all.now ?? NOW,
    providerKeyCurrent: () => all.providerKeyCurrent ?? true,
    checksLockupExpiry: () => all.checksLockupExpiry ?? true,
    maxLockupOutputs: () => all.maxLockupOutputs ?? 16,
    lockups: async () => answer('lockups')!,
    approved: async () => answer('approved')!,
    lockupHeld: async () => answer('lockupHeld')!,
    payoutOutputs: async () => answer('payoutOutputs')!,
    spend: async () => answer('spend'),
    fundingOutcome: async () => answer('fundingOutcome')!,
    refundOutcome: async () => answer('refundOutcome')!,
  })
  return { reads, next }
}

const WAIT: OnchainSendAction = { do: 'wait' }
const fail = (reason: string): OnchainSendAction => ({ do: 'fail', reason })
const lockups = (...values: number[]) => ({
  held: values.reduce((sum, value) => sum + value, 0),
  spendable: values.map((value) => ({ value })),
})

describe('planOnchainSend: quoted', () => {
  const at = (now: number) => ({ now })
  const TIMEOUT = NOW + DEFAULT_ONCHAIN_LOCKUP_TIMEOUT

  it('adopts a lockup of exactly the amount', async () => {
    expect(await run(row('quoted'), { lockups: lockups(50_000) })).toEqual({
      reads: ['lockups'],
      next: { do: 'adopt_lockup' },
    })
    expect((await run(row('quoted'), { lockups: lockups(30_000, 20_000) })).next).toEqual({ do: 'adopt_lockup' })
  })

  it('waits for an unfunded or part-funded lockup until the timeout', async () => {
    expect((await run(row('quoted'), { lockups: lockups() })).next).toEqual(WAIT)
    expect((await run(row('quoted'), { lockups: lockups(10) }, at(TIMEOUT - 1))).next).toEqual(WAIT)
  })

  it('refuses at the timeout, and records what was held only when something was', async () => {
    expect((await run(row('quoted'), { lockups: lockups() }, at(TIMEOUT))).next).toEqual(fail('lockup timeout'))
    expect((await run(row('quoted'), { lockups: lockups(10) }, at(TIMEOUT))).next).toEqual({
      do: 'fail',
      reason: 'lockup timeout with partial 10 sats',
      lockupValue: 10,
    })
    expect((await run(row('quoted'), { lockups: lockups(50_000) }, at(TIMEOUT))).next).toEqual({
      do: 'fail',
      reason: 'lockup timeout with partial 50000 sats',
      lockupValue: 50_000,
    })
  })

  it('refuses an overfunded lockup and records all of it', async () => {
    expect((await run(row('quoted'), { lockups: lockups(50_001) })).next).toEqual({
      do: 'fail',
      reason: 'overfunded lockup: 50001 > 50000 sats',
      lockupValue: 50_001,
    })
  })

  it('refuses a lockup spread over more outputs than one claim spends', async () => {
    const spread = lockups(...Array.from({ length: 17 }, (_, i) => (i === 0 ? 50_000 - 16 : 1)))
    expect((await run(row('quoted'), { lockups: spread })).next).toEqual(fail('lockup funded in 17 outputs, over 16'))
    expect((await run(row('quoted'), { lockups: spread }, { maxLockupOutputs: 17 })).next).toEqual({
      do: 'adopt_lockup',
    })
  })

  it('refuses at once when the amount is there but part sits where a claim cannot spend it', async () => {
    const world = { lockups: { held: 50_000, spendable: [{ value: 49_500 }] } }
    expect((await run(row('quoted'), world)).next).toEqual({
      do: 'fail',
      reason: 'lockup funded on an asset vtxo a claim cannot spend: 50000 held, 49500 spendable',
      lockupValue: 50_000,
    })
  })

  it('refuses a lockup that expires before a claim could still need it, except where expiry is not checked', async () => {
    const early = { lockups: { held: 50_000, spendable: [{ value: 50_000, expiresAt: NOW + HOUR }] } }
    expect((await run(row('quoted'), early)).next.do).toBe('fail')
    expect((await run(row('quoted'), early, { checksLockupExpiry: false })).next).toEqual({ do: 'adopt_lockup' })
  })
})

describe('planOnchainSend: funded', () => {
  it('asks the gates, then for approval, then weighs the lockup again before funding', async () => {
    expect(await run(row('funded'), { approved: true, lockupHeld: 50_000 })).toEqual({
      reads: ['approved', 'lockupHeld'],
      next: { do: 'enter_funding' },
    })
  })

  it('refuses on a rotated key or a closed window without asking for approval', async () => {
    expect(await run(row('funded'), {}, { providerKeyCurrent: false })).toEqual({
      reads: [],
      next: fail(ONCHAIN_KEY_ROTATED),
    })
    const late = await run(row('funded'), {}, { now: NOW + 48 * HOUR })
    expect(late.reads).toEqual([])
    expect(late.next.do).toBe('fail')
  })

  it('waits while approval is withheld, without reading the lockup', async () => {
    expect(await run(row('funded'), { approved: false })).toEqual({ reads: ['approved'], next: WAIT })
  })

  it('asks the gates before the approval, and not again after it', async () => {
    let clock = NOW
    const next = await planOnchainSend(row('funded'), {
      now: () => clock,
      providerKeyCurrent: () => true,
      checksLockupExpiry: () => true,
      maxLockupOutputs: () => 16,
      lockups: async () => ({ held: 0, spendable: [] }),
      approved: async () => {
        clock = NOW + 48 * HOUR
        return true
      },
      lockupHeld: async () => 50_000,
      payoutOutputs: async () => [],
      spend: async () => null,
      fundingOutcome: async () => 'unknown',
      refundOutcome: async () => ({ outcome: 'unknown', txid: null }),
    })
    expect(next).toEqual({ do: 'enter_funding' })
  })

  it('refuses when the lockup lost value while waiting', async () => {
    expect((await run(row('funded'), { approved: true, lockupHeld: 49_999 })).next).toEqual(
      fail('lockup holds 49999 of 50000 sats at funding: unrolled, swept or spent'),
    )
  })
})

describe('planOnchainSend: funding_onchain', () => {
  it('records a funding whose txid is on the row', async () => {
    expect(await run(row('funding_onchain', { fundingTxid: 'fund', fundingTx: 'raw' }), {})).toEqual({
      reads: [],
      next: { do: 'record_funded' },
    })
  })

  it('resends a recorded funding without asking the chain', async () => {
    expect(await run(row('funding_onchain', { fundingTx: 'raw' }), {})).toEqual({
      reads: [],
      next: { do: 'publish_recorded' },
    })
  })

  it('adopts an output of exactly the payout, and funds past anything else at the address', async () => {
    const ours = { txid: 'seen', vout: 2, valueSats: 49_000 }
    const dust = { txid: 'dust', vout: 0, valueSats: 330 }
    expect(await run(row('funding_onchain'), { payoutOutputs: [dust, ours] })).toEqual({
      reads: ['payoutOutputs'],
      next: { do: 'adopt_funding', txid: 'seen', vout: 2 },
    })
    expect((await run(row('funding_onchain'), { payoutOutputs: [dust] })).next).toEqual({ do: 'submit_funding' })
  })
})

describe('planOnchainSend: awaiting_claim', () => {
  const REFUND_AT = NOW + 24 * HOUR + HTLC_REFUND_MTP_MARGIN

  it('waits while the output is unspent and the refund is closed', async () => {
    expect(await run(row('awaiting_claim'), { spend: null })).toEqual({ reads: ['spend'], next: WAIT })
  })

  it('starts the refund only past the locktime plus the margin', async () => {
    const before = await run(
      row('awaiting_claim'),
      { spend: null, fundingOutcome: 'confirmed' },
      { now: REFUND_AT - 1 },
    )
    expect(before.next).toEqual(WAIT)
    expect((await run(row('awaiting_claim'), { spend: null }, { now: REFUND_AT })).next).toEqual({ do: 'start_refund' })
  })

  it('tells a human about a funding still unconfirmed after the alert time', async () => {
    const late = { now: NOW + FUNDING_STUCK_ALERT_SECONDS }
    const { reads, next } = await run(row('awaiting_claim'), { spend: null, fundingOutcome: 'mempool' }, late)
    expect(reads).toEqual(['spend', 'fundingOutcome'])
    expect(next).toMatchObject({ do: 'wait', alert: expect.stringContaining('funding fund unconfirmed 1200s') })
    expect((await run(row('awaiting_claim'), { spend: null, fundingOutcome: 'confirmed' }, late)).next).toEqual(WAIT)
    expect((await run(row('awaiting_claim'), { spend: null }, { now: late.now - 1 })).reads).toEqual(['spend'])
  })

  it('records a matching claim', async () => {
    expect((await run(row('awaiting_claim'), { spend: { preimage: P } })).next).toEqual({
      do: 'record_claim',
      preimage: hex.encode(P),
    })
  })

  it('records the claim and warns when little time is left to collect', async () => {
    const squeezed = { now: NOW + 48 * HOUR - ARKADE_CLAIM_WINDOW_SECONDS + 1 }
    expect((await run(row('awaiting_claim'), { spend: { preimage: P } }, squeezed)).next).toMatchObject({
      do: 'record_claim',
      preimage: hex.encode(P),
      alert: expect.stringContaining('claim race'),
    })
  })

  it('needs a human for a spend that is not a matching claim', async () => {
    for (const preimage of [null, new Uint8Array(32).fill(1), new Uint8Array(0)]) {
      expect((await run(row('awaiting_claim'), { spend: { preimage } })).next).toEqual(fail(ONCHAIN_FOREIGN_SPEND))
    }
  })

  it('fails a row with no funding outpoint before any read', async () => {
    expect(await run(row('awaiting_claim', { fundingVout: null }), {})).toEqual({
      reads: [],
      next: fail('awaiting_claim state with no funding txid/vout'),
    })
  })
})

describe('planOnchainSend: refunding_onchain', () => {
  const tracked = row('refunding_onchain', { onchainRefundTxid: 'r2', onchainRefundPriorTxids: ['r1'] })

  it('pushes a first refund once no claim is on chain', async () => {
    expect(await run(row('refunding_onchain'), { spend: null })).toEqual({
      reads: ['spend'],
      next: { do: 'push_refund' },
    })
  })

  it('records its own confirmed refund before looking for a claim', async () => {
    expect(await run(tracked, { refundOutcome: { outcome: 'confirmed', txid: 'r1' } })).toEqual({
      reads: ['refundOutcome'],
      next: { do: 'record_refund', txid: 'r1' },
    })
  })

  it('bumps a refund still in the mempool', async () => {
    expect(await run(tracked, { refundOutcome: { outcome: 'mempool', txid: null } })).toEqual({
      reads: ['refundOutcome'],
      next: { do: 'bump_refund' },
    })
  })

  it('looks for a claim when no earlier refund is known to the chain', async () => {
    const world = { refundOutcome: { outcome: 'unknown' as const, txid: null }, spend: null }
    expect(await run(tracked, world)).toEqual({ reads: ['refundOutcome', 'spend'], next: { do: 'push_refund' } })
    expect((await run(row('refunding_onchain', { onchainRefundPriorTxids: ['r1'] }), world)).reads).toContain(
      'refundOutcome',
    )
  })

  it('records a late claim instead of refunding over it', async () => {
    expect((await run(row('refunding_onchain'), { spend: { preimage: P } })).next).toEqual({
      do: 'record_claim',
      preimage: hex.encode(P),
    })
    expect((await run(row('refunding_onchain'), { spend: { preimage: null } })).next).toEqual(
      fail(ONCHAIN_FOREIGN_SPEND),
    )
  })

  it('retries a refund that could not be sent until the refund locktime, then gives up', () => {
    const subject = row('refunding_onchain')
    const attempt = (retry: boolean) => ({ reason: 'too small', retry })
    expect(planRefundNotSent(subject, NOW, attempt(true))).toEqual({ do: 'throw', message: 'too small' })
    expect(planRefundNotSent(subject, NOW + 48 * HOUR, attempt(true))).toEqual(fail('too small'))
    expect(planRefundNotSent(subject, NOW, attempt(false))).toEqual(fail('too small'))
  })

  it('fails a row with no funding outpoint before any read', async () => {
    expect(await run(row('refunding_onchain', { fundingTxid: null }), {})).toEqual({
      reads: [],
      next: fail('refunding_onchain state with no funding txid/vout'),
    })
  })
})

describe('planOnchainSend: other states', () => {
  it('leaves the claim of the Arkade lockup to the orchestrator', async () => {
    expect(await run(row('claiming'), {})).toEqual({ reads: [], next: { do: 'claim_lockup' } })
  })

  it('plans nothing for a finished swap', async () => {
    for (const state of ['claimed', 'refunded', 'refused', 'stuck']) {
      expect(await run(row(state), {})).toEqual({ reads: [], next: WAIT })
    }
  })
})
