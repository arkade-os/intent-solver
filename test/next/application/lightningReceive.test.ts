import { hex } from '@scure/base'
import { beforeEach, describe, expect, it } from 'vitest'
import { HoldInvoice } from '@arkade-os/solver-next/application/legs/hold_invoice.js'
import { SolverLockup } from '@arkade-os/solver-next/application/legs/solver_lockup.js'
import {
  EMPTY_LOCKUP_GRACE,
  LightningReceive,
  RECEIVE_FUNDING_LOST,
  RECEIVE_INVOICE_NEVER_ARMED,
  RECEIVE_LOCKUP_GONE,
} from '@arkade-os/solver-next/application/lightning_receive.js'
import { Hashlock } from '@arkade-os/solver-next/domain/swap/hashlock.js'
import { Quote } from '@arkade-os/solver-next/domain/swap/quote.js'
import { Swap } from '@arkade-os/solver-next/domain/swap/swap.js'
import type { LockupOutpoint } from '@arkade-os/solver-next/ports/arkade.js'
import type { HoldState } from '@arkade-os/solver-next/ports/lightning.js'
import { btc, quoted, ref, SECRET, t } from '../domain/support.js'
import { lockupContract } from './support.js'

const MINUTE = 60
const PAYOUT = 4_950
const HASH = Hashlock.ofPreimage(SECRET)
const QUOTED_AT = 1_800_000_000
const INVOICE_EXPIRES_AT = QUOTED_AT + 30 * MINUTE
const REFUND_OPENS_AT = QUOTED_AT + 120 * MINUTE
const HTLC_EXPIRES_AT = QUOTED_AT + 240 * MINUTE

const CONTRACT = lockupContract(HASH, PAYOUT)

// What the node and Arkade show. A test sets it, and reads back what was asked.
interface World {
  now: number
  hold: HoldState | Error
  history: LockupOutpoint[]
  claimedOn: string | null
  pendingRefund: string | null
  secondsToRefundAlone: number
  reads: string[]
}

let world: World
let receive: LightningReceive

const output = (txid: string, value = PAYOUT, flags: Partial<LockupOutpoint> = {}): LockupOutpoint => ({
  txid,
  vout: 0,
  value,
  spent: false,
  unrolled: false,
  ...flags,
})

const serviceWith = (acceptsNoRefundAlone = false): LightningReceive =>
  new LightningReceive(
    new HoldInvoice({
      getHoldState: async () => {
        world.reads.push('hold')
        if (world.hold instanceof Error) throw world.hold
        return world.hold
      },
      settleHold: async () => {
        throw new Error('next() must not settle')
      },
    }),
    new SolverLockup(
      { contract: async () => CONTRACT },
      {
        canRefundUnrolled: true,
        spendable: async () => (world.reads.push('spendable'), world.history.filter((o) => !o.spent && !o.unrolled)),
        history: async () => (world.reads.push('history'), world.history),
        claimPreimage: async (_contract, outpoints) => {
          world.reads.push('claim')
          return outpoints.some((o) => `${o.txid}:${o.vout}` === world.claimedOn) ? hex.decode(SECRET) : null
        },
        fund: async () => {
          throw new Error('next() must not fund')
        },
        refund: async () => {
          throw new Error('next() must not refund')
        },
        finalizePendingRefund: async () => world.pendingRefund,
        refundOpen: async () => world.now >= REFUND_OPENS_AT,
        refundOpensAt: async () => REFUND_OPENS_AT,
        secondsToRefundAlone: () => world.secondsToRefundAlone,
      },
    ),
    () => t(world.now),
    { acceptsNoRefundAlone },
  )

const ARMED: HoldState = { status: 'armed', expiresAt: HTLC_EXPIRES_AT }
const PENDING: HoldState = { status: 'pending', expiresAt: null }

const quotedSwap = (): Swap =>
  quoted({
    hashlock: HASH,
    quote: Quote.of(t(INVOICE_EXPIRES_AT), { fee: btc(50n), spreadBps: 0 }),
    from: { rail: 'lightning', amount: btc(5_000n), contract: 'lightning', version: null },
    to: { rail: 'arkade', amount: btc(BigInt(PAYOUT)), contract: 'vhtlc', version: null },
    at: t(QUOTED_AT),
  })
const armed = (htlcExpiresAt: number | null = HTLC_EXPIRES_AT): Swap =>
  quotedSwap().markFunded(t(QUOTED_AT + 60), ref(HASH), htlcExpiresAt === null ? null : t(htlcExpiresAt))
const filling = (): Swap => armed().startFill(t(QUOTED_AT + 61))
const toLocked = (): Swap => filling().markToLocked(t(QUOTED_AT + 62), ref('pay:0'))
const filled = (): Swap => toLocked().markFilled(t(QUOTED_AT + 63), SECRET)
const refunding = (since = REFUND_OPENS_AT): Swap => toLocked().startRefund(t(since))

beforeEach(() => {
  world = {
    now: QUOTED_AT + 5 * MINUTE,
    hold: PENDING,
    history: [],
    claimedOn: null,
    pendingRefund: null,
    secondsToRefundAlone: 60 * MINUTE,
    reads: [],
  }
  receive = serviceWith()
})

describe('a Lightning receive that is quoted', () => {
  it('arms on a held payment, with the expiry the node gives', async () => {
    world.hold = ARMED
    expect(await receive.next(quotedSwap())).toEqual({ do: 'arm', htlcExpiresAt: HTLC_EXPIRES_AT })
    world.hold = { status: 'armed', expiresAt: null }
    expect(await receive.next(quotedSwap())).toEqual({ do: 'arm', htlcExpiresAt: null })
  })

  it('refuses from the first second the invoice is expired, closing it, and waits before that', async () => {
    world.now = INVOICE_EXPIRES_AT - 1
    expect(await receive.next(quotedSwap())).toEqual({ do: 'wait' })
    world.now = INVOICE_EXPIRES_AT
    expect(await receive.next(quotedSwap())).toEqual({
      do: 'fail',
      reason: RECEIVE_INVOICE_NEVER_ARMED,
      closeInvoice: true,
    })
  })

  it('acts only on an exact armed status', async () => {
    for (const status of ['pending', 'settled', 'cancelled', 'unknown'] as const) {
      world.hold = { status, expiresAt: HTLC_EXPIRES_AT }
      expect((await receive.next(quotedSwap())).do, status).toBe('wait')
    }
  })

  it('stops when the node cannot be read', async () => {
    world.hold = new Error('node unreachable')
    await expect(receive.next(quotedSwap())).rejects.toThrow('node unreachable')
  })
})

describe('a Lightning receive that is armed', () => {
  beforeEach(() => {
    world.hold = ARMED
  })

  it('adopts an earlier fill before any rule is read', async () => {
    world.history = [output('pay')]
    world.now = INVOICE_EXPIRES_AT + 1
    expect(await receive.next(armed())).toEqual({ do: 'adopt', outpoint: 'pay:0' })
    expect(world.reads).toEqual(['history'])
  })

  it('adopts an earlier fill that the client already claimed', async () => {
    world.history = [output('pay', PAYOUT, { spent: true })]
    world.claimedOn = 'pay:0'
    expect(await receive.next(armed())).toEqual({ do: 'adopt', outpoint: 'pay:0' })
  })

  it('adopts an earlier fill that is spent with no claim readable yet, rather than filling again', async () => {
    world.history = [output('pay', PAYOUT, { spent: true })]
    expect(await receive.next(armed())).toEqual({ do: 'adopt', outpoint: 'pay:0' })
  })

  it('funds a held payment that passes the rules, reading the hold again first', async () => {
    expect(await receive.next(armed())).toEqual({ do: 'fund' })
    expect(world.reads).toEqual(['history', 'hold'])
  })

  it('refuses in the words of the rule that said no', async () => {
    world.now = INVOICE_EXPIRES_AT
    expect(await receive.next(armed())).toEqual({ do: 'fail', reason: 'refused to fund: invoice_expired' })
    world.now = QUOTED_AT + 5 * MINUTE
    world.hold = { status: 'armed', expiresAt: world.now + 89 * MINUTE }
    expect(await receive.next(armed())).toEqual({ do: 'fail', reason: 'refused to fund: settle_window_too_short' })
    world.hold = { status: 'armed', expiresAt: REFUND_OPENS_AT + 14 * MINUTE }
    expect(await receive.next(armed())).toEqual({ do: 'fail', reason: 'refused to fund: refund_deadline_too_late' })
  })

  it('goes by the hold as it is now, not as it was when the swap was armed', async () => {
    world.hold = PENDING
    expect(await receive.next(armed())).toEqual({ do: 'fail', reason: 'refused to fund: htlc_not_armed' })
    world.hold = { status: 'armed', expiresAt: null }
    expect(await receive.next(armed())).toEqual({ do: 'fail', reason: 'refused to fund: htlc_not_armed' })
  })

  it('asks for the operator consent as it stands now', async () => {
    world.secondsToRefundAlone = 300 * MINUTE
    expect(await receive.next(armed())).toEqual({
      do: 'fail',
      reason: 'refused to fund: unilateral_recourse_after_htlc',
    })
    expect(await serviceWith(true).next(armed())).toEqual({ do: 'fund' })
  })

  it('stops when the node cannot be read: that read decides the fill', async () => {
    world.hold = new Error('node unreachable')
    await expect(receive.next(armed())).rejects.toThrow('node unreachable')
  })
})

describe('a Lightning receive whose fill was started and never recorded', () => {
  it('adopts the lockup once it shows', async () => {
    world.history = [output('pay')]
    expect(await receive.next(filling())).toEqual({ do: 'adopt', outpoint: 'pay:0' })
  })

  it('waits until the refund opens, then needs a human, and never funds again', async () => {
    world.hold = ARMED
    world.now = REFUND_OPENS_AT - 1
    expect(await receive.next(filling())).toEqual({ do: 'wait' })
    world.now = REFUND_OPENS_AT
    expect(await receive.next(filling())).toEqual({ do: 'stuck', reason: RECEIVE_FUNDING_LOST })
    expect(world.reads).not.toContain('hold')
  })
})

describe('a Lightning receive that is filled and waits for the client', () => {
  it('waits while our output is unspent and the refund is closed, with one read', async () => {
    world.history = [output('pay')]
    expect(await receive.next(toLocked())).toEqual({ do: 'wait' })
    expect(world.reads).toEqual(['spendable'])
  })

  it('starts the refund once it is open', async () => {
    world.history = [output('pay')]
    world.now = REFUND_OPENS_AT
    expect(await receive.next(toLocked())).toEqual({ do: 'start_refund' })
  })

  it('records a claim when our output is gone, even with dust on the script and the refund open', async () => {
    world.history = [output('pay', PAYOUT, { spent: true }), output('dust', 330)]
    world.claimedOn = 'pay:0'
    world.now = REFUND_OPENS_AT
    expect(await receive.next(toLocked())).toEqual({ do: 'record_claim', preimage: SECRET })
  })

  it('takes a gone output with no preimage as read lag until the refund opens', async () => {
    world.history = [output('pay', PAYOUT, { spent: true })]
    expect(await receive.next(toLocked())).toEqual({ do: 'wait' })
    world.now = REFUND_OPENS_AT
    expect(await receive.next(toLocked())).toEqual({ do: 'start_refund' })
  })
})

describe('a Lightning receive recorded as filled with no outpoint', () => {
  it('fails in the words production uses, without reading anything', async () => {
    const bare = filling().markToLocked(t(QUOTED_AT + 62), ref('pay'))
    expect(await receive.next(bare)).toEqual({ do: 'fail', reason: 'funded state with no funded outpoint recorded' })
    expect(await receive.next(bare.startRefund(t(REFUND_OPENS_AT)))).toEqual({
      do: 'fail',
      reason: 'refunding state with no funded outpoint recorded',
    })
    expect(world.reads).toEqual([])
  })

  it('fails the same way when what is recorded is not an outpoint at all', async () => {
    const garbled = filling().markToLocked(t(QUOTED_AT + 62), ref('pay:0:1'))
    expect(await receive.next(garbled)).toEqual({ do: 'fail', reason: 'funded state with no funded outpoint recorded' })
    expect(world.reads).toEqual([])
  })
})

describe('a Lightning receive the client has claimed', () => {
  it('settles the hold, on the first attempt and on a repeat', async () => {
    expect(await receive.next(filled())).toEqual({ do: 'settle' })
    expect(await receive.next(filled().startSettle(t(QUOTED_AT + 64)))).toEqual({ do: 'settle' })
    expect(world.reads).toEqual([])
  })
})

describe('a Lightning receive that is refunding', () => {
  beforeEach(() => {
    world.now = REFUND_OPENS_AT + 10
  })

  it('records a late claim before anything else', async () => {
    world.history = [output('pay')]
    world.claimedOn = 'pay:0'
    expect(await receive.next(refunding())).toEqual({ do: 'record_claim', preimage: SECRET })
  })

  it('refunds our own unspent output, and not dust', async () => {
    world.history = [output('pay'), output('dust', 330)]
    expect(await receive.next(refunding())).toEqual({ do: 'refund' })
    world.history = [output('pay', PAYOUT, { spent: true }), output('dust', 330)]
    expect((await receive.next(refunding())).do).toBe('wait')
  })

  it('refunds an unrolled lockup on Bitcoin', async () => {
    world.history = [output('pay', PAYOUT, { unrolled: true })]
    expect(await receive.next(refunding())).toEqual({ do: 'refund_unrolled' })
  })

  it('records our own refund that landed without its answer', async () => {
    world.history = [output('pay', PAYOUT, { spent: true })]
    world.pendingRefund = 'refund-tx'
    expect(await receive.next(refunding())).toEqual({ do: 'record_refund', refundTx: 'refund-tx' })
  })

  it('waits out the read lag, then the held payment, before calling a gone output inexplicable', async () => {
    world.history = [output('pay', PAYOUT, { spent: true })]
    world.now = REFUND_OPENS_AT + EMPTY_LOCKUP_GRACE - 1
    expect(await receive.next(refunding())).toEqual({ do: 'wait' })
    world.now = HTLC_EXPIRES_AT - 1
    expect(await receive.next(refunding())).toEqual({ do: 'wait' })
    world.now = HTLC_EXPIRES_AT
    expect(await receive.next(refunding())).toEqual({ do: 'fail', reason: RECEIVE_LOCKUP_GONE })
  })

  it('gives up after the read lag alone when no hold expiry was saved', async () => {
    const noExpiry = armed(null)
      .startFill(t(QUOTED_AT + 61))
      .markToLocked(t(QUOTED_AT + 62), ref('pay:0'))
    world.history = [output('pay', PAYOUT, { spent: true })]
    world.now = REFUND_OPENS_AT + EMPTY_LOCKUP_GRACE
    expect(await receive.next(noExpiry.startRefund(t(REFUND_OPENS_AT)))).toEqual({
      do: 'fail',
      reason: RECEIVE_LOCKUP_GONE,
    })
  })
})

describe('a Lightning receive that is over', () => {
  it('has nothing left to do', async () => {
    const over = [
      filled().startSettle(t(1)).markSettled(t(2)),
      refunding().markRefunded(t(REFUND_OPENS_AT + 5)),
      armed().refuse('x'),
      toLocked().stick('x'),
      toLocked().markLost('x'),
    ]
    for (const swap of over) expect(await receive.next(swap), swap.state).toEqual({ do: 'wait' })
    expect(world.reads).toEqual([])
  })
})

describe('a quote that never expires', () => {
  it('is not a Lightning receive', async () => {
    const endless = Swap.restore({ ...quotedSwap().snapshot, quote: Quote.of(null, { fee: btc(0n), spreadBps: 0 }) }, 0)
    await expect(receive.next(endless)).rejects.toThrow('must expire')
  })
})
