import { hex } from '@scure/base'
import { describe, expect, it } from 'vitest'
import { planReceive, type ReceivePlanRow, type ReceiveReads } from '@arkade-os/solver-core/core/receivePlan.js'
import { rawDelaySeconds } from '@arkade-os/solver-core/core/timelocks.js'
import { adoptFunding } from '@arkade-os/solver-corridors/legs/arkadeLockup.js'
import { FromLightning } from '@arkade-os/solver-next/application/legs/from_lightning.js'
import { ToArkade } from '@arkade-os/solver-next/application/legs/to_arkade.js'
import { LightningReceive, type ReceiveStep } from '@arkade-os/solver-next/application/lightning_receive.js'
import { Hashlock } from '@arkade-os/solver-next/domain/swap/hashlock.js'
import {
  swapFromReceiveRow,
  type ReceiveSwapRecord,
} from '@arkade-os/solver-next/infrastructure/db/receive_swap_row.js'
import type { LockupOutpoint } from '@arkade-os/solver-next/ports/arkade.js'
import type { HoldState } from '@arkade-os/solver-next/ports/lightning.js'
import { SECRET, t } from '../domain/support.js'
import { lockupContract } from './support.js'

const MINUTE = 60
const PAYOUT = 4_950
const HASH = Hashlock.ofPreimage(SECRET)
const QUOTED_AT = 1_800_000_000
const INVOICE_EXPIRES_AT = QUOTED_AT + 30 * MINUTE
const REFUND_OPENS_AT = QUOTED_AT + 120 * MINUTE

// Seeded so a failure can be replayed.
const random = (seed: number) => (): number => {
  seed = (seed + 0x6d2b79f5) | 0
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296
}

type State =
  | 'quoted'
  | 'armed'
  | 'armed_fill_started'
  | 'funded'
  | 'claimed'
  | 'refunding'
  | 'settled'
  | 'refunded'
  | 'refused'
  | 'stuck'

/** One moment of one swap: what is on record, and what the node and Arkade show. */
interface Situation {
  state: State
  now: number
  hold: HoldState
  /** What the swap saved when it was armed. */
  savedHtlcExpiresAt: number | null
  history: LockupOutpoint[]
  /** Our output sits in a batch that expired: the history calls it unspent, and it cannot be spent. */
  batchExpired: boolean
  claimedOn: string | null
  pendingRefund: string | null
  /** The row says it was filled and names no output: it should never happen, and both sides must say the same. */
  outpointMissing: 'no' | 'txid' | 'vout'
  canRefundUnrolled: boolean
  /** An operator refunded by hand: the transaction is on the row, and the row is still refunding. */
  refundOnRecord: boolean
  rawRefundAloneDelay: number
  acceptsNoRefundAlone: boolean
  enteredStateAt: number
}

const RECORDED = { txid: 'pay', vout: 0 }
const isRecorded = (o: { txid: string; vout: number }) => o.txid === RECORDED.txid && o.vout === RECORDED.vout
const spendableOf = (s: Situation) =>
  s.history.filter((o) => !o.spent && !o.unrolled && !(s.batchExpired && isRecorded(o)))
const preimageOn = (s: Situation, outpoints: readonly { txid: string; vout: number }[]) =>
  outpoints.some((o) => `${o.txid}:${o.vout}` === s.claimedOn)

/** The row as `receive_swap` holds it. Both sides read this one. */
const rowOf = (s: Situation): ReceiveSwapRecord & ReceivePlanRow => {
  const fillStarted = s.state === 'armed_fill_started'
  const lockupRecorded = !['quoted', 'armed', 'armed_fill_started', 'refused'].includes(s.state)
  const claimed = s.state === 'claimed' || s.state === 'settled'
  return {
    id: 'swap-1',
    state: s.state === 'armed_fill_started' ? 'armed' : s.state,
    updatedAt: s.enteredStateAt,
    paymentHash: HASH,
    amountSats: 5_000,
    payoutSats: PAYOUT,
    invoiceExpiresAt: INVOICE_EXPIRES_AT,
    htlcExpiresAt: s.state === 'quoted' ? null : s.savedHtlcExpiresAt,
    fundStartedAt: fillStarted ? s.enteredStateAt : null,
    refundWithoutReceiverDelay: s.rawRefundAloneDelay,
    arkadeLockupTxid: lockupRecorded && s.outpointMissing !== 'txid' ? RECORDED.txid : null,
    arkadeLockupVout: lockupRecorded && s.outpointMissing === 'no' ? RECORDED.vout : null,
    settleAttemptedAt: s.state === 'settled' ? s.enteredStateAt : null,
    preimage: claimed ? SECRET : null,
    refundArkTxid: s.state === 'refunded' || (s.state === 'refunding' && s.refundOnRecord) ? 'refund-tx' : null,
    failureReason: s.state === 'refused' || s.state === 'stuck' ? 'a reason' : null,
    rfqId: null,
  }
}

// Built once and pointed at one situation at a time: sixty thousand sets of them is what a busy test worker chokes on.
let s: Situation
const CONTRACT = lockupContract(HASH, PAYOUT)
const SECRET_BYTES = hex.decode(SECRET)

// As the orchestrator builds them today.
const READS: ReceiveReads = {
  now: () => s.now,
  acceptsUnilateralGap: () => s.acceptsNoRefundAlone,
  canRefundUnrolled: () => s.canRefundUnrolled,
  hold: async () => s.hold,
  coupledSend: async () => null,
  coupledRefundDeadline: async () => 0,
  coupledLockupFunded: async () => false,
  earlierFunding: async () => adoptFunding(s.history, PAYOUT),
  refundDeadline: async () => REFUND_OPENS_AT,
  spendable: async () => spendableOf(s),
  refundOpen: async () => s.now >= REFUND_OPENS_AT,
  claim: async () => {
    const searched = s.history.some(isRecorded) ? s.history : [...s.history, RECORDED]
    return { history: s.history, preimage: preimageOn(s, searched) ? SECRET : null }
  },
  ownRefund: async () => s.pendingRefund,
  holdSettled: async () => s.hold.status === 'settled',
}

const receiveWith = (acceptsNoRefundAlone: boolean, canRefundUnrolled: boolean): LightningReceive =>
  new LightningReceive(
    new FromLightning({ getHoldState: async () => s.hold, settleHold: async () => undefined }),
    new ToArkade(
      { contract: async () => CONTRACT },
      {
        canRefundUnrolled,
        spendable: async () => spendableOf(s),
        history: async () => s.history,
        claimPreimage: async (_contract, outpoints) => (preimageOn(s, outpoints) ? SECRET_BYTES : null),
        fund: async () => null,
        refund: async () => 'refund-tx',
        finalizePendingRefund: async () => s.pendingRefund,
        refundOpen: async () => s.now >= REFUND_OPENS_AT,
        refundOpensAt: async () => REFUND_OPENS_AT,
        secondsToRefundAlone: () => rawDelaySeconds(s.rawRefundAloneDelay),
      },
    ),
    () => t(s.now),
    { acceptsNoRefundAlone },
  )
const RECEIVE = [false, true].map((accepts) => [false, true].map((unrolled) => receiveWith(accepts, unrolled)))

const today = (row: ReceivePlanRow): Promise<{ do: string; reason?: string }> => planReceive(row, READS)
const ours = (row: ReceiveSwapRecord): Promise<ReceiveStep> =>
  RECEIVE[Number(s.acceptsNoRefundAlone)]![Number(s.canRefundUnrolled)]!.next(swapFromReceiveRow(row))

// Where the new decision differs from today's on purpose. Each is safer, and takes one tick less.
const intended = (s: Situation, old: { do: string }, step: ReceiveStep): string | null => {
  const claimReadable = preimageOn(s, s.history.some(isRecorded) ? s.history : [...s.history, RECORDED])
  if (s.state === 'funded' && old.do === 'start_refund' && step.do === 'record_claim' && claimReadable) {
    return 'refund open and our output still there: today starts the refund and reads the claim a tick later'
  }
  const ourOutput = s.history.find(isRecorded)
  const neitherSpentNorSpendable = ourOutput?.spent === false && !spendableOf(s).some(isRecorded)
  if (s.state === 'refunding' && old.do === 'record_refund' && neitherSpentNorSpendable) {
    return 'our output is neither spent nor spendable: a refund the server finished cannot have spent it'
  }
  if (s.state === 'refunding' && s.refundOnRecord && step.do === 'record_refund' && ourOutput?.spent === true) {
    return 'a refund made by hand is on the row and our output is spent: today waits, then calls the lockup gone'
  }
  return null
}

describe('the Lightning receive decision', () => {
  it('is the one production makes today, on 10,000 random rows read from the table', async () => {
    const next = random(20261127)
    const pick = <T>(of: readonly T[]): T => of[Math.floor(next() * of.length)]!
    const TIMES = [-1, 0, 1].flatMap((d) => [INVOICE_EXPIRES_AT + d, REFUND_OPENS_AT + d, REFUND_OPENS_AT + 120 + d])
    const anyTime = () => (next() < 0.5 ? pick(TIMES) : QUOTED_AT + Math.floor(next() * 400 * MINUTE))
    const lockup = (): LockupOutpoint[] => {
      const outputs: LockupOutpoint[] = []
      if (next() < 0.7)
        outputs.push({ txid: 'pay', vout: 0, value: PAYOUT, spent: next() < 0.5, unrolled: next() < 0.15 })
      if (next() < 0.3) outputs.push({ txid: 'dust', vout: 0, value: 330, spent: next() < 0.3, unrolled: false })
      if (next() < 0.15) outputs.push({ txid: 'twin', vout: 1, value: PAYOUT, spent: next() < 0.5, unrolled: false })
      return outputs
    }

    const counts: Record<string, number> = {}
    const onPurpose = new Set<string>()
    for (let i = 0; i < 10_000; i++) {
      const now = anyTime()
      const history = lockup()
      s = {
        state: pick([
          ...(['quoted', 'armed', 'armed_fill_started', 'funded', 'claimed', 'refunding'] as const),
          ...(['quoted', 'armed', 'armed_fill_started', 'funded', 'claimed', 'refunding'] as const),
          ...(['settled', 'refunded', 'refused', 'stuck'] as const),
        ]),
        now,
        hold: {
          status: pick(['pending', 'armed', 'armed', 'armed', 'settled', 'cancelled', 'unknown'] as const),
          expiresAt: next() < 0.1 ? null : now + Math.floor((next() * 300 - 20) * MINUTE),
        },
        savedHtlcExpiresAt: next() < 0.1 ? null : pick([now - 1, now, now + 1, now + 200 * MINUTE]),
        history,
        batchExpired: next() < 0.2,
        claimedOn: next() < 0.4 ? pick(['pay:0', 'twin:1', 'dust:0']) : null,
        pendingRefund: next() < 0.2 ? 'refund-tx' : null,
        outpointMissing: next() < 0.97 ? 'no' : pick(['txid', 'vout'] as const),
        canRefundUnrolled: next() < 0.7,
        refundOnRecord: next() < 0.15,
        rawRefundAloneDelay: pick([6, 144, 512, 1024, 4096, 20_480]),
        acceptsNoRefundAlone: next() < 0.3,
        enteredStateAt: pick([now, now - 119, now - 120, now - 121, now - 10_000]),
      }
      // Only what can really happen: a claim needs a spent output, and a swap is recorded funded once its output was seen.
      const claimed = history.find((o) => `${o.txid}:${o.vout}` === s.claimedOn)
      if (s.claimedOn !== null && claimed?.spent !== true) s.claimedOn = null
      if (s.hold.expiresAt !== null && s.hold.expiresAt < 0) s.hold = { ...s.hold, expiresAt: null }

      const row = rowOf(s)
      const old = await today(row)
      const step = await ours(row)
      counts[old.do] = (counts[old.do] ?? 0) + 1
      const same = old.do === step.do && (old.reason ?? null) === (step.reason ?? null)
      const why = same ? null : intended(s, old, step)
      if (why !== null) onPurpose.add(why)
      if (!same && why === null) {
        throw new Error(`differs on ${JSON.stringify(s)}: today ${JSON.stringify(old)}, ours ${JSON.stringify(step)}`)
      }
    }
    expect(onPurpose.size).toBe(3)
    const reached = Object.keys(counts).sort()
    expect(reached).toEqual(
      [
        'adopt',
        'arm',
        'fail',
        'fund',
        'record_claim',
        'record_refund',
        'refund',
        'refund_unrolled',
        'settle',
        'start_refund',
        'stuck',
        'wait',
      ].sort(),
    )
  }, 60_000)
})
