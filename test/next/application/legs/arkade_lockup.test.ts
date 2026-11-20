import { hex } from '@scure/base'
import { beforeEach, describe, expect, it } from 'vitest'
import { Hashlock } from '@arkade-os/solver-next/domain/swap/hashlock.js'
import type { Swap } from '@arkade-os/solver-next/domain/swap/swap.js'
import { ArkadeLockup } from '@arkade-os/solver-next/application/legs/arkade_lockup.js'
import type { ArkadeLockups, LockupContract, LockupOutpoint } from '@arkade-os/solver-next/ports/arkade.js'
import { btc, quoted, ref, SECRET, t } from '../../domain/support.js'

const PAYOUT = 4_950
const HASH = Hashlock.ofPreimage(SECRET)

const CONTRACT: LockupContract = {
  id: 'swap-1',
  paymentHash: HASH,
  pkScript: '5120aa',
  lockupAddress: 'tark1lockup',
  payoutSats: PAYOUT,
  claimPacket: null,
  refundLocktime: 9_000,
  claimDelay: 512,
  refundDelay: 1_024,
  refundWithoutReceiverDelay: 1_536,
  receiverPubkey: '02',
  receiverPkScript: '51',
  serverPubkey: '04',
  emulatorPubkey: '05',
  clientRefundPubkey: '03',
  refundPkScript: '52',
  nonInteractiveParameters: true,
}

// Arkade as the leg sees it. A test sets what the indexer shows and what the wallet answers.
interface World {
  history: LockupOutpoint[]
  claimedOn: string | null
  lostRefund: string | null
  fund: () => Promise<string | null>
  refund: () => Promise<string>
  refunds: number
  /** Every read the leg made, in order. */
  reads: string[]
}

let world: World
let leg: ArkadeLockup

const output = (txid: string, value = PAYOUT, flags: Partial<LockupOutpoint> = {}): LockupOutpoint => ({
  txid,
  vout: 0,
  value,
  spent: false,
  unrolled: false,
  ...flags,
})

const arkade = (): ArkadeLockups => ({
  spendable: async () => (world.reads.push('spendable'), world.history.filter((o) => !o.spent)),
  history: async () => (world.reads.push('history'), world.history),
  claimPreimage: async (_contract, outpoints) =>
    (world.reads.push('claimPreimage'), outpoints).some((o) => `${o.txid}:${o.vout}` === world.claimedOn)
      ? hex.decode(SECRET)
      : null,
  fund: () => world.fund(),
  refund: () => world.refund(),
  finishLostRefund: async () => world.lostRefund,
  refundOpen: async () => false,
  refundOpensAt: async () => CONTRACT.refundLocktime,
  refundAloneDelaySeconds: () => 1_536,
})

const receive = (): Swap =>
  quoted({
    hashlock: HASH,
    from: { rail: 'lightning', amount: btc(5_000n), contract: 'lightning', version: null },
    to: { rail: 'arkade', amount: btc(BigInt(PAYOUT)), contract: 'vhtlc', version: null },
  })
const held = (): Swap => {
  const swap = receive()
  swap.lock('from', t(1_001), ref(HASH), t(8_000))
  return swap
}
const paidOut = (reference = 'pay:0'): Swap => {
  const swap = held()
  swap.locking('to', t(1_002))
  swap.lock('to', t(1_003), ref(reference))
  return swap
}
const refunding = (): Swap => {
  const swap = paidOut()
  swap.refunding('to', t(1_010))
  return swap
}

beforeEach(() => {
  world = {
    history: [],
    claimedOn: null,
    lostRefund: null,
    fund: async () => 'pay',
    refund: async () => ((world.refunds += 1), 'refund-tx'),
    refunds: 0,
    reads: [],
  }
  leg = new ArkadeLockup({ contract: async () => CONTRACT }, arkade())
})

describe('our lockup on Arkade: what it shows', () => {
  it('shows only the deadlines while nothing was paid out', async () => {
    expect(await leg.status(held())).toMatchObject({
      lock: 'none',
      lockReference: null,
      refundOpensAt: 9_000,
      refundAloneDelay: 1_536,
    })
  })

  it('takes an output of exactly the payout as ours, and ignores dust sent to the address', async () => {
    world.history = [output('dust', 330), output('pay')]
    expect(await leg.status(held())).toMatchObject({ lock: 'landed', lockReference: 'pay:0', spent: { by: 'nobody' } })
    world.history = [output('dust', 330)]
    expect(await leg.status(held())).toMatchObject({ lock: 'none' })
  })

  it('still finds a payout that was already claimed, so it is not paid again', async () => {
    world.history = [output('pay', PAYOUT, { spent: true })]
    world.claimedOn = 'pay:0'
    expect(await leg.status(held())).toMatchObject({ lock: 'landed', spent: { by: 'claim', preimage: SECRET } })
  })

  it('prefers the unspent output when the payout went out twice', async () => {
    world.history = [output('first', PAYOUT, { spent: true }), output('second')]
    expect(await leg.status(held())).toMatchObject({ lockReference: 'second:0' })
  })

  it('finds the output of a payout whose transaction was just sent', async () => {
    const swap = held()
    swap.locking('to', t(1_002), ref('pay'))
    world.history = [output('pay')]
    expect(await leg.status(swap)).toMatchObject({ lock: 'landed', lockReference: 'pay:0' })
  })

  it('reads the preimage from a claim of a sibling output before it refunds', async () => {
    world.history = [output('pay'), output('sibling', PAYOUT, { spent: true })]
    world.claimedOn = 'sibling:0'
    expect(await leg.status(refunding())).toMatchObject({ spent: { by: 'claim', preimage: SECRET } })
  })

  it('asks about our own output, not the script: dust does not make a spent payout look unspent', async () => {
    world.history = [output('pay', PAYOUT, { spent: true }), output('dust', 330)]
    expect(await leg.status(paidOut())).toMatchObject({ spent: { by: 'unknown' }, refund: 'none' })
  })

  it('recognises our refund once the output is gone, and not before', async () => {
    const swap = refunding()
    swap.reference('to', { refund: ref('refund-tx') }, t(1_011))
    world.history = [output('pay')]
    expect(await leg.status(swap)).toMatchObject({ spent: { by: 'nobody' }, refund: 'none' })
    world.history = [output('pay', PAYOUT, { spent: true })]
    expect(await leg.status(swap)).toMatchObject({ spent: { by: 'refund' }, refund: 'landed' })
  })

  it('recognises a refund whose answer was lost, only while refunding', async () => {
    world.history = [output('pay', PAYOUT, { spent: true })]
    world.lostRefund = 'refund-tx'
    expect(await leg.status(refunding())).toMatchObject({ spent: { by: 'refund' }, refund: 'landed' })
    expect(await leg.status(paidOut())).toMatchObject({ spent: { by: 'unknown' }, refund: 'none' })
  })

  it('lets a claim win over a refund that was recorded', async () => {
    const swap = refunding()
    swap.reference('to', { refund: ref('refund-tx') }, t(1_011))
    world.history = [output('pay', PAYOUT, { spent: true })]
    world.claimedOn = 'pay:0'
    expect(await leg.status(swap)).toMatchObject({ spent: { by: 'claim' }, refund: 'none' })
  })

  it('treats a lockup taken onto Bitcoin as still ours to refund', async () => {
    world.history = [output('pay', PAYOUT, { spent: true, unrolled: true })]
    expect(await leg.status(refunding())).toMatchObject({ spent: { by: 'nobody' } })
  })
})

describe('our lockup on Arkade: what it sends', () => {
  it('pays out and reports the transaction', async () => {
    expect(await leg.lock(held())).toEqual({ status: 'sent', reference: 'pay' })
  })

  it('says not sent only when the wallet is certain nothing left it', async () => {
    world.fund = async () => null
    expect(await leg.lock(held())).toEqual({ status: 'not_sent' })
    world.fund = async () => {
      throw new Error('arkd timed out')
    }
    expect(await leg.lock(held())).toEqual({ status: 'unknown' })
  })

  it('refunds everything spendable at the script, and nothing when it is empty', async () => {
    expect(await leg.refund(refunding())).toEqual({ status: 'not_sent' })
    world.history = [output('pay')]
    expect(await leg.refund(refunding())).toEqual({ status: 'sent', reference: 'refund-tx' })
    expect(world.refunds).toBe(1)
  })

  it('does not know whether a refund that threw went through', async () => {
    world.history = [output('pay')]
    world.refund = async () => {
      throw new Error('arkd refused to co-sign')
    }
    expect(await leg.refund(refunding())).toEqual({ status: 'unknown' })
  })

  it('never claims: that is the client', async () => {
    await expect(leg.claim(paidOut(), 'to')).rejects.toThrow('claimed by the client')
  })
})

describe('our lockup on Arkade: how much it reads', () => {
  it('makes one read while nothing was paid out', async () => {
    await leg.status(held())
    expect(world.reads).toEqual(['history'])
  })

  it('makes one read while the payout waits for the client', async () => {
    world.history = [output('pay')]
    await leg.status(paidOut())
    expect(world.reads).toEqual(['spendable'])
  })

  it('reads the rest only once our output is gone', async () => {
    world.history = [output('pay', PAYOUT, { spent: true })]
    world.claimedOn = 'pay:0'
    await leg.status(paidOut())
    expect(world.reads).toEqual(['spendable', 'history', 'claimPreimage'])
  })

  it('adopts an untouched payout with one read', async () => {
    world.history = [output('pay')]
    await leg.status(held())
    expect(world.reads).toEqual(['history'])
  })
})
