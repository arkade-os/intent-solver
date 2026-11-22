import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  closeFailedPayment,
  NO_RECORD_GRACE_SECONDS,
  ownNodeMayCollect,
  planPolledPayment,
  planSend,
  SEND_KEY_ROTATED,
  type SendAction,
  type ClientLockup,
  type SendPlanCoupledReceive,
  type SendPlanRow,
} from '@arkade-os/solver-core/core/sendPlan.js'
import {
  DEFAULT_LOCKUP_TIMEOUT,
  MIN_INVOICE_WINDOW,
  ROUTE_CLTV_BUDGET_BLOCKS,
} from '@arkade-os/solver-core/core/send.js'
import { forgeInvoice } from '@arkade-os/solver-rails-fake/ln/fake/bolt11.js'

const NOW = 1_800_000_000
const HOUR = 3_600
const EXPIRES = NOW + 12 * HOUR
const INVOICE = forgeInvoice({
  network: 'bc',
  amountSats: 2_100,
  paymentHash: sha256(new Uint8Array(32).fill(21)),
  timestamp: NOW,
  expirySeconds: 12 * HOUR,
})

const row = (state: string, over: Partial<SendPlanRow> = {}): SendPlanRow => ({
  state,
  createdAt: NOW,
  invoice: INVOICE,
  invoiceExpiresAt: EXPIRES,
  amountSats: 2_100,
  lockupValue: state === 'quoted' ? null : 2_100,
  refundWithoutReceiverDelay: 5_120,
  quotedRefundDeadline: NOW + 5_000,
  ...over,
})

/** What the outside world answers. A read the test gave no answer for fails the test. */
interface World {
  now?: number
  providerKeyCurrent?: boolean
  invoiceProbe?: 'own' | 'known' | 'none'
  backendName?: string | null
  lockups?: ClientLockup
  refundDeadline?: number
  coupledReceive?: SendPlanCoupledReceive | null
  coupledPreimage?: string | null
  failedReceive?: SendPlanCoupledReceive | null
  currentWallet?: string | null
  ownInvoice?: string | null
  payDeadline?: number
  approved?: boolean
}

/** The action the planner picks, and the reads it made on the way, in order. */
const run = async (subject: SendPlanRow, world: World, start: World = {}) => {
  const all = { ...world, ...start }
  const reads: string[] = []
  const answer = <K extends keyof World>(name: K): NonNullable<World[K]> | null => {
    reads.push(name)
    if (all[name] === undefined) throw new Error(`the test has no answer for ${name}`)
    return all[name] ?? null
  }
  const next = await planSend(subject, {
    now: () => all.now ?? NOW,
    lockupTimeout: () => DEFAULT_LOCKUP_TIMEOUT,
    maxLockupOutputs: () => 16,
    providerKeyCurrent: () => all.providerKeyCurrent ?? true,
    invoiceProbe: () => all.invoiceProbe ?? 'own',
    backendName: () => (all.backendName === null ? undefined : (all.backendName ?? 'node-a')),
    routeCltvBudgetBlocks: () => ROUTE_CLTV_BUDGET_BLOCKS,
    enforcesRouteCltv: () => true,
    hintDenylist: () => new Set(),
    lockups: async () => answer('lockups')!,
    refundDeadline: async () => answer('refundDeadline')!,
    coupledReceive: async () => answer('coupledReceive'),
    coupledPreimage: async () => answer('coupledPreimage'),
    failedReceive: async () => answer('failedReceive'),
    currentWallet: async () => answer('currentWallet'),
    ownInvoice: async () => answer('ownInvoice'),
    payDeadline: async () => answer('payDeadline')!,
    approved: async () => answer('approved')!,
  })
  return { reads, next }
}

const WAIT: SendAction = { do: 'wait' }
const fail = (reason: string, lockupValue?: number): SendAction =>
  lockupValue === undefined ? { do: 'fail', reason } : { do: 'fail', reason, lockupValue }
const lockups = (...values: number[]) => ({
  held: values.reduce((sum, value) => sum + value, 0),
  spendable: values.map((value) => ({ value })),
})

describe('planSend: quoted', () => {
  const DEADLINE = NOW + DEFAULT_LOCKUP_TIMEOUT
  const at = (now: number) => ({ now })

  it('adopts a lockup of exactly the amount, in one output or several', async () => {
    expect(await run(row('quoted'), { lockups: lockups(2_100) })).toEqual({
      reads: ['lockups'],
      next: { do: 'adopt_lockup' },
    })
    expect((await run(row('quoted'), { lockups: lockups(2_000, 100) })).next).toEqual({ do: 'adopt_lockup' })
  })

  it('waits for an unfunded or part-funded lockup until the deadline', async () => {
    expect((await run(row('quoted'), { lockups: lockups() })).next).toEqual(WAIT)
    expect((await run(row('quoted'), { lockups: lockups(10) }, at(DEADLINE - 1))).next).toEqual(WAIT)
  })

  it('refuses at the deadline, in words for what was there, and records it only when something was', async () => {
    expect((await run(row('quoted'), { lockups: lockups() }, at(DEADLINE))).next).toEqual(fail('lockup timeout'))
    expect((await run(row('quoted'), { lockups: lockups(10) }, at(DEADLINE))).next).toEqual(
      fail('lockup timeout with partial 10 sats', 10),
    )
    expect((await run(row('quoted'), { lockups: lockups(2_100) }, at(DEADLINE))).next).toEqual(
      fail('lockup arrived after the funding deadline', 2_100),
    )
  })

  it('takes the earlier of the lockup timeout and the invoice window as the deadline', async () => {
    const short = row('quoted', { invoiceExpiresAt: NOW + MIN_INVOICE_WINDOW + 60 })
    expect((await run(short, { lockups: lockups(2_100) }, at(NOW + 59))).next).toEqual({ do: 'adopt_lockup' })
    expect((await run(short, { lockups: lockups(2_100) }, at(NOW + 60))).next.do).toBe('fail')
  })

  it('names the expired invoice over the timeout', async () => {
    expect((await run(row('quoted'), { lockups: lockups(2_100) }, at(EXPIRES))).next).toEqual(
      fail('invoice expired before funding completed', 2_100),
    )
  })

  it('refuses an overfunded lockup and records all it holds', async () => {
    const world = { lockups: { held: 2_500, spendable: [{ value: 2_101 }] } }
    expect((await run(row('quoted'), world)).next).toEqual(fail('overfunded lockup: 2101 > 2100 sats', 2_500))
  })

  it('refuses a lockup spread over more outputs than one claim spends', async () => {
    const spread = lockups(...Array.from({ length: 17 }, (_, i) => (i === 0 ? 2_100 - 16 : 1)))
    expect((await run(row('quoted'), { lockups: spread })).next).toEqual(
      fail('lockup funded in 17 outputs, over 16', 2_100),
    )
  })

  it('refuses at once when the amount is there but part sits where a claim cannot spend it', async () => {
    const world = { lockups: { held: 2_100, spendable: [{ value: 1_900 }] } }
    expect((await run(row('quoted'), world)).next).toEqual(
      fail('lockup funded on an asset vtxo a claim cannot spend: 2100 held, 1900 spendable', 2_100),
    )
  })
})

describe('planSend: funded', () => {
  const REFUND = NOW + 24 * HOUR
  const payable = { refundDeadline: REFUND, coupledReceive: null, failedReceive: null, payDeadline: REFUND }
  const refused: SendPlanCoupledReceive = {
    state: 'refused',
    pkScript: 'receive-pk',
    invoice: INVOICE.toUpperCase(),
    htlcExpiresAt: null,
    fundStartedAt: null,
    invoiceWalletFingerprint: 'wallet-a',
    invoiceBackendName: 'node-a',
  }

  it('reads in the order the gates need, and starts paying once approved', async () => {
    expect(await run(row('funded'), { ...payable, approved: true })).toEqual({
      reads: ['refundDeadline', 'coupledReceive', 'failedReceive', 'payDeadline', 'approved'],
      next: { do: 'start_paying' },
    })
  })

  it('refuses on a rotated key before anything is read', async () => {
    expect(await run(row('funded'), {}, { providerKeyCurrent: false })).toEqual({
      reads: [],
      next: fail(SEND_KEY_ROTATED),
    })
  })

  it('refuses when the client could refund alone before the quoted refund', async () => {
    const { reads, next } = await run(
      row('funded', { refundWithoutReceiverDelay: 512, quotedRefundDeadline: null }),
      payable,
    )
    expect(reads).toEqual(['refundDeadline'])
    expect(next).toEqual(fail('refused to proceed: client solo refund opens before the quoted refund'))
    const quotedEarlier = row('funded', { refundWithoutReceiverDelay: 512, quotedRefundDeadline: NOW + 500 })
    expect((await run(quotedEarlier, { ...payable, approved: true })).next).toEqual({ do: 'start_paying' })
  })

  it('refuses to pay in the words of the gate, without asking for approval', async () => {
    const { reads, next } = await run(row('funded', { lockupValue: 2_099 }), payable)
    expect(reads).not.toContain('approved')
    expect(next).toEqual(fail('refused to pay: lockup_insufficient'))
    expect((await run(row('funded'), { ...payable, payDeadline: NOW })).next).toEqual(
      fail('refused to pay: claim_window_too_short'),
    )
    expect((await run(row('funded', { lockupValue: null }), payable)).next).toEqual(
      fail('refused to pay: lockup_insufficient'),
    )
  })

  it('waits while approval is withheld', async () => {
    expect((await run(row('funded'), { ...payable, approved: false })).next).toEqual(WAIT)
  })

  it('asks the payment gate before the approval, and not again after it', async () => {
    let clock = NOW
    const { reads, next } = await (async () => {
      const made: string[] = []
      const action = await planSend(row('funded'), {
        now: () => clock,
        lockupTimeout: () => DEFAULT_LOCKUP_TIMEOUT,
        maxLockupOutputs: () => 16,
        providerKeyCurrent: () => true,
        invoiceProbe: () => 'own',
        backendName: () => 'node-a',
        routeCltvBudgetBlocks: () => ROUTE_CLTV_BUDGET_BLOCKS,
        enforcesRouteCltv: () => true,
        hintDenylist: () => new Set(),
        lockups: async () => ({ held: 0, spendable: [] }),
        refundDeadline: async () => REFUND,
        coupledReceive: async () => null,
        coupledPreimage: async () => null,
        failedReceive: async () => null,
        currentWallet: async () => null,
        ownInvoice: async () => null,
        payDeadline: async () => REFUND,
        approved: async () => {
          made.push('approved')
          clock = EXPIRES + 1
          return true
        },
      })
      return { reads: made, next: action }
    })()
    expect(reads).toEqual(['approved'])
    expect(next).toEqual({ do: 'start_paying' })
  })

  describe('coupled to a receive of our own', () => {
    const live: SendPlanCoupledReceive = {
      state: 'funded',
      pkScript: 'receive-pk',
      invoice: INVOICE,
      htlcExpiresAt: null,
      fundStartedAt: NOW,
    }
    const coupledTo = (coupled: SendPlanCoupledReceive) => ({ refundDeadline: REFUND, coupledReceive: coupled })

    it('collects with the preimage the client revealed, and never pays', async () => {
      expect(await run(row('funded'), { ...coupledTo(live), coupledPreimage: 'ab' })).toEqual({
        reads: ['refundDeadline', 'coupledReceive', 'coupledPreimage'],
        next: { do: 'collect', preimage: 'ab' },
      })
    })

    it('waits until the client claims', async () => {
      expect((await run(row('funded'), { ...coupledTo(live), coupledPreimage: null })).next).toEqual(WAIT)
    })

    it('refuses to collect when the receive took a real payment', async () => {
      const { reads, next } = await run(row('funded'), coupledTo({ ...live, htlcExpiresAt: NOW + HOUR }))
      expect(reads).toEqual(['refundDeadline', 'coupledReceive'])
      expect(next).toEqual(fail('refused to collect: receive took a real htlc'))
    })
  })

  describe('after the coupled receive was refused', () => {
    const afterRefusal = (failedReceive: SendPlanCoupledReceive) => ({
      refundDeadline: REFUND,
      coupledReceive: null,
      failedReceive,
    })

    it('refuses the send once the node says its own invoice is unpaid', async () => {
      for (const status of ['pending', 'cancelled']) {
        expect(await run(row('funded'), { ...afterRefusal(refused), ownInvoice: status })).toEqual({
          reads: ['refundDeadline', 'coupledReceive', 'failedReceive', 'ownInvoice'],
          next: { do: 'refuse_coupled' },
        })
      }
    })

    it('waits on any other answer about the invoice', async () => {
      for (const status of ['armed', 'settled', null]) {
        expect((await run(row('funded'), { ...afterRefusal(refused), ownInvoice: status })).next).toEqual(WAIT)
      }
    })

    it('waits while the refused receive may still have paid out', async () => {
      expect((await run(row('funded'), afterRefusal({ ...refused, fundStartedAt: NOW }))).next).toEqual(WAIT)
      expect((await run(row('funded'), afterRefusal({ ...refused, htlcExpiresAt: NOW }))).next).toEqual(WAIT)
    })

    it('tells a human when the node cannot be asked about its own invoice', async () => {
      const { reads, next } = await run(row('funded'), afterRefusal(refused), { invoiceProbe: 'none' })
      expect(reads).toEqual(['refundDeadline', 'coupledReceive', 'failedReceive'])
      expect(next).toMatchObject({ do: 'wait', alert: expect.stringContaining('cannot probe its own invoice') })
    })

    it('asks a node that only knows invoices by wallet after checking it is the wallet that minted this one', async () => {
      const known = { invoiceProbe: 'known' as const }
      expect(
        await run(row('funded'), { ...afterRefusal(refused), currentWallet: 'wallet-a', ownInvoice: 'pending' }, known),
      ).toEqual({
        reads: ['refundDeadline', 'coupledReceive', 'failedReceive', 'currentWallet', 'ownInvoice'],
        next: { do: 'refuse_coupled' },
      })
      const changed = [
        { world: { currentWallet: 'wallet-b' }, start: known },
        { world: { currentWallet: null }, start: known },
        { world: { currentWallet: 'wallet-a' }, start: { ...known, backendName: 'node-b' } },
        { world: { currentWallet: 'wallet-a' }, start: { ...known, backendName: null } },
      ]
      for (const { world, start } of changed) {
        const { reads, next } = await run(row('funded'), { ...afterRefusal(refused), ...world }, start)
        expect(reads).not.toContain('ownInvoice')
        expect(next).toMatchObject({ do: 'wait', alert: expect.stringContaining('identity unavailable or changed') })
      }
      const unsigned = { ...refused, invoiceWalletFingerprint: null }
      expect((await run(row('funded'), { ...afterRefusal(unsigned), currentWallet: 'wallet-a' }, known)).next.do).toBe(
        'wait',
      )
    })

    it('pays as usual when the refused receive was for another invoice or is not refused', async () => {
      const world = { ...payable, approved: true }
      expect(
        (await run(row('funded'), { ...world, failedReceive: { ...refused, invoice: 'lnbc1other' } })).next,
      ).toEqual({
        do: 'start_paying',
      })
      expect((await run(row('funded'), { ...world, failedReceive: { ...refused, state: 'refunded' } })).next).toEqual({
        do: 'start_paying',
      })
    })
  })
})

describe('planSend: other states', () => {
  it('hands the paying, paid and claiming states to the orchestrator', async () => {
    for (const state of ['paying', 'paid', 'claiming']) {
      expect(await run(row(state), {})).toEqual({ reads: [], next: { do: 'hand_over' } })
    }
  })

  it('plans nothing for a finished swap', async () => {
    for (const state of ['claimed', 'refused', 'stuck']) {
      expect(await run(row(state), {})).toEqual({ reads: [], next: WAIT })
    }
  })
})

describe('planPolledPayment', () => {
  const submitted = { payAttemptedAt: NOW - NO_RECORD_GRACE_SECONDS + 1 }
  const never = () => {
    throw new Error('the clock was read')
  }

  it('advances on anything that is not a failure, without reading the clock', () => {
    expect(planPolledPayment(submitted, { status: 'pending' }, never)).toBe('advance')
    expect(planPolledPayment(submitted, { status: 'succeeded' }, never)).toBe('advance')
    expect(planPolledPayment(submitted, { status: 'pending', evidence: 'no_record' }, never)).toBe('advance')
    expect(planPolledPayment(submitted, { status: 'not-a-status' as never }, never)).toBe('advance')
  })

  it('waits on "no record" only inside the grace after a submission', () => {
    const noRecord = { status: 'failed', evidence: 'no_record' } as const
    let reads = 0
    expect(planPolledPayment(submitted, noRecord, () => (reads++, NOW))).toBe('wait')
    expect(reads).toBe(1)
    expect(planPolledPayment(submitted, noRecord, () => NOW + 1)).toBe('settle_failure')
    expect(planPolledPayment({ payAttemptedAt: null }, noRecord, never)).toBe('settle_failure')
  })

  it('settles any other failure at once, without reading the clock', () => {
    for (const evidence of [undefined, 'terminal', 'in_flight'] as const) {
      expect(planPolledPayment(submitted, { status: 'failed', evidence }, never)).toBe('settle_failure')
    }
  })
})

describe('ownNodeMayCollect', () => {
  it('is false only for an invoice still pending or cancelled', () => {
    expect(['pending', 'cancelled', 'armed', 'settled', 'anything-else'].map(ownNodeMayCollect)).toEqual([
      false,
      false,
      true,
      true,
      true,
    ])
  })
})

describe('closeFailedPayment', () => {
  const said = (why: string) => `lightning payment failed terminally; ${why}`

  it('closes as refused only when refunded and the invoice is not ours', () => {
    expect(closeFailedPayment(true, 'not-ours')).toEqual({ do: 'refuse', reason: said('client refunded') })
  })

  it('does not close as refused on an answer it does not know', () => {
    expect(closeFailedPayment(true, 'resolved' as never).do).toBe('fail')
  })

  it('leaves every other case to a person, most urgent reason first', () => {
    const withheld = said('refund withheld — our own node may still collect against this hash')
    const unlanded = said('the refund did not land — see refund_attempt')
    expect(closeFailedPayment(true, 'withhold')).toEqual({ do: 'fail', reason: withheld })
    expect(closeFailedPayment(false, 'withhold')).toEqual({ do: 'fail', reason: withheld })
    expect(closeFailedPayment(false, 'not-ours')).toEqual({ do: 'fail', reason: unlanded })
    expect(closeFailedPayment(false, 'unknown')).toEqual({ do: 'fail', reason: unlanded })
    expect(closeFailedPayment(true, 'unknown')).toEqual({
      do: 'fail',
      reason: said('client refunded, but the self-payment probe could not be asked'),
    })
  })
})
