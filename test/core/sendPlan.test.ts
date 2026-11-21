import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  planSend,
  SEND_KEY_ROTATED,
  type SendAction,
  type SendObservation,
  type SendPlanCoupledReceive,
  type SendPlanRow,
  type SendRead,
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

type Fixed = 'nowSeconds' | 'lockupTimeout' | 'maxLockupOutputs' | 'providerKeyCurrent' | 'invoiceProbe'
type Facts = Omit<
  SendObservation,
  Fixed | 'backendName' | 'routeCltvBudgetBlocks' | 'enforcesRouteCltv' | 'hintDenylist'
>
const FIELD: Record<SendRead, keyof Facts> = {
  lockups: 'lockups',
  refund_deadline: 'refundDeadlineSeconds',
  coupled: 'coupled',
  coupled_preimage: 'coupledPreimage',
  failed_receive: 'failedReceive',
  wallet_identity: 'currentWallet',
  own_invoice: 'ownInvoice',
  pay_deadline: 'payDeadline',
  approval: 'approved',
}

/** Answers each read from `world`, as the orchestrator would, and returns what was read and the action. */
const run = (subject: SendPlanRow, world: Facts, start: Partial<SendObservation> = {}) => {
  const seen: SendObservation = {
    nowSeconds: NOW,
    lockupTimeout: DEFAULT_LOCKUP_TIMEOUT,
    maxLockupOutputs: 16,
    providerKeyCurrent: true,
    invoiceProbe: 'own',
    backendName: 'node-a',
    routeCltvBudgetBlocks: ROUTE_CLTV_BUDGET_BLOCKS,
    enforcesRouteCltv: true,
    hintDenylist: new Set(),
    ...start,
  }
  const reads: SendRead[] = []
  for (;;) {
    const next = planSend(subject, seen)
    if (next.do !== 'read') return { reads, next }
    if (reads.includes(next.what)) throw new Error(`asked for ${next.what} twice`)
    const field = FIELD[next.what]
    if (world[field] === undefined) throw new Error(`the test has no answer for ${next.what}`)
    Object.assign(seen, { [field]: world[field] })
    reads.push(next.what)
  }
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
  const at = (nowSeconds: number) => ({ nowSeconds })

  it('adopts a lockup of exactly the amount, in one output or several', () => {
    expect(run(row('quoted'), { lockups: lockups(2_100) })).toEqual({
      reads: ['lockups'],
      next: { do: 'adopt_lockup' },
    })
    expect(run(row('quoted'), { lockups: lockups(2_000, 100) }).next).toEqual({ do: 'adopt_lockup' })
  })

  it('waits for an unfunded or part-funded lockup until the deadline', () => {
    expect(run(row('quoted'), { lockups: lockups() }).next).toEqual(WAIT)
    expect(run(row('quoted'), { lockups: lockups(10) }, at(DEADLINE - 1)).next).toEqual(WAIT)
  })

  it('refuses at the deadline, in words for what was there, and records it only when something was', () => {
    expect(run(row('quoted'), { lockups: lockups() }, at(DEADLINE)).next).toEqual(fail('lockup timeout'))
    expect(run(row('quoted'), { lockups: lockups(10) }, at(DEADLINE)).next).toEqual(
      fail('lockup timeout with partial 10 sats', 10),
    )
    expect(run(row('quoted'), { lockups: lockups(2_100) }, at(DEADLINE)).next).toEqual(
      fail('lockup arrived after the funding deadline', 2_100),
    )
  })

  it('takes the earlier of the lockup timeout and the invoice window as the deadline', () => {
    const short = row('quoted', { invoiceExpiresAt: NOW + MIN_INVOICE_WINDOW + 60 })
    expect(run(short, { lockups: lockups(2_100) }, at(NOW + 59)).next).toEqual({ do: 'adopt_lockup' })
    expect(run(short, { lockups: lockups(2_100) }, at(NOW + 60)).next.do).toBe('fail')
  })

  it('names the expired invoice over the timeout', () => {
    expect(run(row('quoted'), { lockups: lockups(2_100) }, at(EXPIRES)).next).toEqual(
      fail('invoice expired before funding completed', 2_100),
    )
  })

  it('refuses an overfunded lockup and records what a claim would have taken', () => {
    const world = { lockups: { held: 2_500, spendable: [{ value: 2_101 }] } }
    expect(run(row('quoted'), world).next).toEqual(fail('overfunded lockup: 2101 > 2100 sats', 2_101))
  })

  it('refuses a lockup spread over more outputs than one claim spends', () => {
    const spread = lockups(...Array.from({ length: 17 }, (_, i) => (i === 0 ? 2_100 - 16 : 1)))
    expect(run(row('quoted'), { lockups: spread }).next).toEqual(fail('lockup funded in 17 outputs, over 16', 2_100))
  })

  it('refuses at once when the amount is there but part sits where a claim cannot spend it', () => {
    const world = { lockups: { held: 2_100, spendable: [{ value: 1_900 }] } }
    expect(run(row('quoted'), world).next).toEqual(
      fail('lockup funded on an asset vtxo a claim cannot spend: 2100 held, 1900 spendable', 2_100),
    )
  })
})

describe('planSend: funded', () => {
  const REFUND = NOW + 24 * HOUR
  const payable = { refundDeadlineSeconds: REFUND, coupled: null, failedReceive: null, payDeadline: REFUND }
  const refused: SendPlanCoupledReceive = {
    state: 'refused',
    invoice: INVOICE.toUpperCase(),
    htlcExpiresAt: null,
    fundStartedAt: null,
    invoiceWalletFingerprint: 'wallet-a',
    invoiceBackendName: 'node-a',
  }

  it('reads in the order the gates need, and starts paying once approved', () => {
    expect(run(row('funded'), { ...payable, approved: true })).toEqual({
      reads: ['refund_deadline', 'coupled', 'failed_receive', 'pay_deadline', 'approval'],
      next: { do: 'start_paying' },
    })
  })

  it('refuses on a rotated key before anything is read', () => {
    expect(run(row('funded'), {}, { providerKeyCurrent: false })).toEqual({ reads: [], next: fail(SEND_KEY_ROTATED) })
  })

  it('refuses when the client could refund alone before the quoted refund', () => {
    const { reads, next } = run(row('funded', { refundWithoutReceiverDelay: 512, quotedRefundDeadline: null }), payable)
    expect(reads).toEqual(['refund_deadline'])
    expect(next).toEqual(fail('refused to proceed: client solo refund opens before the quoted refund'))
    const quotedEarlier = row('funded', { refundWithoutReceiverDelay: 512, quotedRefundDeadline: NOW + 500 })
    expect(run(quotedEarlier, { ...payable, approved: true }).next).toEqual({ do: 'start_paying' })
  })

  it('refuses to pay in the words of the gate, without asking for approval', () => {
    const { reads, next } = run(row('funded', { lockupValue: 2_099 }), payable)
    expect(reads).not.toContain('approval')
    expect(next).toEqual(fail('refused to pay: lockup_insufficient'))
    expect(run(row('funded'), { ...payable, payDeadline: NOW }).next).toEqual(
      fail('refused to pay: claim_window_too_short'),
    )
    expect(run(row('funded', { lockupValue: null }), payable).next).toEqual(fail('refused to pay: lockup_insufficient'))
  })

  it('waits while approval is withheld', () => {
    expect(run(row('funded'), { ...payable, approved: false }).next).toEqual(WAIT)
  })

  it('does not ask the gates again once approval has been read', () => {
    const { next } = run(row('funded'), {}, { approved: true, providerKeyCurrent: false, nowSeconds: EXPIRES + 1 })
    expect(next).toEqual({ do: 'start_paying' })
  })

  describe('coupled to a receive of our own', () => {
    const live: SendPlanCoupledReceive = { state: 'funded', invoice: INVOICE, htlcExpiresAt: null, fundStartedAt: NOW }
    const coupledTo = (coupled: SendPlanCoupledReceive) => ({ refundDeadlineSeconds: REFUND, coupled })

    it('collects with the preimage the client revealed, and never pays', () => {
      expect(run(row('funded'), { ...coupledTo(live), coupledPreimage: 'ab' })).toEqual({
        reads: ['refund_deadline', 'coupled', 'coupled_preimage'],
        next: { do: 'collect', preimage: 'ab' },
      })
    })

    it('waits until the client claims', () => {
      expect(run(row('funded'), { ...coupledTo(live), coupledPreimage: null }).next).toEqual(WAIT)
    })

    it('refuses to collect when the receive took a real payment', () => {
      const { reads, next } = run(row('funded'), coupledTo({ ...live, htlcExpiresAt: NOW + HOUR }))
      expect(reads).toEqual(['refund_deadline', 'coupled'])
      expect(next).toEqual(fail('refused to collect: receive took a real htlc'))
    })
  })

  describe('after the coupled receive was refused', () => {
    const afterRefusal = (failedReceive: SendPlanCoupledReceive) => ({
      refundDeadlineSeconds: REFUND,
      coupled: null,
      failedReceive,
    })

    it('refuses the send once the node says its own invoice is unpaid', () => {
      for (const status of ['pending', 'cancelled']) {
        expect(run(row('funded'), { ...afterRefusal(refused), ownInvoice: status })).toEqual({
          reads: ['refund_deadline', 'coupled', 'failed_receive', 'own_invoice'],
          next: { do: 'refuse_coupled' },
        })
      }
    })

    it('waits on any other answer about the invoice', () => {
      for (const status of ['armed', 'settled', null]) {
        expect(run(row('funded'), { ...afterRefusal(refused), ownInvoice: status }).next).toEqual(WAIT)
      }
    })

    it('waits while the refused receive may still have paid out', () => {
      expect(run(row('funded'), afterRefusal({ ...refused, fundStartedAt: NOW })).next).toEqual(WAIT)
      expect(run(row('funded'), afterRefusal({ ...refused, htlcExpiresAt: NOW })).next).toEqual(WAIT)
    })

    it('tells a human when the node cannot be asked about its own invoice', () => {
      const { reads, next } = run(row('funded'), afterRefusal(refused), { invoiceProbe: 'none' })
      expect(reads).toEqual(['refund_deadline', 'coupled', 'failed_receive'])
      expect(next).toMatchObject({ do: 'wait', alert: expect.stringContaining('cannot probe its own invoice') })
    })

    it('asks a node that only knows invoices by wallet after checking it is the wallet that minted this one', () => {
      const known = { invoiceProbe: 'known' as const }
      expect(
        run(row('funded'), { ...afterRefusal(refused), currentWallet: 'wallet-a', ownInvoice: 'pending' }, known),
      ).toEqual({
        reads: ['refund_deadline', 'coupled', 'failed_receive', 'wallet_identity', 'own_invoice'],
        next: { do: 'refuse_coupled' },
      })
      const changed = [
        { world: { currentWallet: 'wallet-b' }, start: known },
        { world: { currentWallet: null }, start: known },
        { world: { currentWallet: 'wallet-a' }, start: { ...known, backendName: 'node-b' } },
        { world: { currentWallet: 'wallet-a' }, start: { ...known, backendName: undefined } },
      ]
      for (const { world, start } of changed) {
        const { reads, next } = run(row('funded'), { ...afterRefusal(refused), ...world }, start)
        expect(reads).not.toContain('own_invoice')
        expect(next).toMatchObject({ do: 'wait', alert: expect.stringContaining('identity unavailable or changed') })
      }
      const unsigned = { ...refused, invoiceWalletFingerprint: null }
      expect(run(row('funded'), { ...afterRefusal(unsigned), currentWallet: 'wallet-a' }, known).next.do).toBe('wait')
    })

    it('pays as usual when the refused receive was for another invoice or is not refused', () => {
      const world = { ...payable, approved: true }
      expect(run(row('funded'), { ...world, failedReceive: { ...refused, invoice: 'lnbc1other' } }).next).toEqual({
        do: 'start_paying',
      })
      expect(run(row('funded'), { ...world, failedReceive: { ...refused, state: 'refunded' } }).next).toEqual({
        do: 'start_paying',
      })
    })
  })
})

describe('planSend: other states', () => {
  it('hands the paying, paid and claiming states to the orchestrator', () => {
    for (const state of ['paying', 'paid', 'claiming']) {
      expect(run(row(state), {})).toEqual({ reads: [], next: { do: 'hand_over' } })
    }
  })

  it('plans nothing for a finished swap', () => {
    for (const state of ['claimed', 'refused', 'stuck']) {
      expect(run(row(state), {})).toEqual({ reads: [], next: WAIT })
    }
  })
})
