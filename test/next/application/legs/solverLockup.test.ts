import { hex } from '@scure/base'
import { beforeEach, describe, expect, it } from 'vitest'
import { SolverLockup } from '@arkade-os/solver-next/application/legs/solver_lockup.js'
import { Hashlock } from '@arkade-os/solver-next/domain/swap/hashlock.js'
import type { Swap } from '@arkade-os/solver-next/domain/swap/swap.js'
import type { ArkadeLockups, LockupContract, LockupOutpoint } from '@arkade-os/solver-next/ports/arkade.js'
import { btc, quoted, ref, SECRET, t } from '../../domain/support.js'

const PAYOUT = 4_950
const HASH = Hashlock.ofPreimage(SECRET)
const WRONG_PREIMAGE = '22'.repeat(32)

const CONTRACT: LockupContract = {
  id: 'swap-1',
  paymentHash: HASH,
  pkScript: '5120aa',
  lockupAddress: 'tark1lockup',
  payoutAddress: 'tark1payout',
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
  /** The outpoint whose claim reveals a preimage, and which one. */
  claimedOn: string | null
  revealed: string
  lostRefund: string | null
  refundOpen: boolean
  fund: () => Promise<string | null>
  refund: () => Promise<string>
  refunded: string[][]
  reads: string[]
  searched: string[]
}

let world: World
let lockup: SolverLockup

const output = (txid: string, value = PAYOUT, flags: Partial<LockupOutpoint> = {}): LockupOutpoint => ({
  txid,
  vout: 0,
  value,
  spent: false,
  unrolled: false,
  ...flags,
})

const arkade = (): ArkadeLockups => ({
  spendable: async () => (world.reads.push('spendable'), world.history.filter((o) => !o.spent && !o.unrolled)),
  history: async () => (world.reads.push('history'), world.history),
  claimPreimage: async (_contract, outpoints) => {
    world.reads.push('claimPreimage')
    world.searched = outpoints.map((o) => `${o.txid}:${o.vout}`)
    return world.searched.includes(world.claimedOn ?? '') ? hex.decode(world.revealed) : null
  },
  fund: () => world.fund(),
  refund: (_contract, outputs) => (world.refunded.push(outputs.map((o) => `${o.txid}:${o.vout}`)), world.refund()),
  finalizePendingRefund: async () => world.lostRefund,
  refundOpen: async () => world.refundOpen,
  refundOpensAt: async () => CONTRACT.refundLocktime,
  secondsToRefundAlone: () => 1_536,
})

const armed = (): Swap =>
  quoted({
    hashlock: HASH,
    from: { rail: 'lightning', amount: btc(5_000n), contract: 'lightning', version: null },
    to: { rail: 'arkade', amount: btc(BigInt(PAYOUT)), contract: 'vhtlc', version: null },
  }).markFunded(t(1_001), ref(HASH), t(8_000))
const filling = (sentTx?: string): Swap => armed().startFill(t(1_002), sentTx === undefined ? undefined : ref(sentTx))
const toLocked = (outpoint = 'pay:0'): Swap => filling().markToLocked(t(1_003), ref(outpoint))
const refunding = (refundTx?: string): Swap =>
  toLocked().startRefund(t(1_010), refundTx === undefined ? undefined : ref(refundTx))

const NOT_FUNDED = { status: 'not_funded', outpoint: null, preimage: null, refundTx: null }
const at = (status: string, outpoint = 'pay:0', extra: object = {}) => ({
  status,
  outpoint,
  preimage: null,
  refundTx: null,
  ...extra,
})

beforeEach(() => {
  world = {
    history: [],
    claimedOn: null,
    revealed: SECRET,
    lostRefund: null,
    refundOpen: false,
    fund: async () => 'pay',
    refund: async () => 'refund-tx',
    refunded: [],
    reads: [],
    searched: [],
  }
  lockup = new SolverLockup({ contract: async () => CONTRACT }, arkade())
})

describe('our lockup on Arkade: its state', () => {
  it('is not funded while nothing of ours is at the script', async () => {
    expect(await lockup.state(armed())).toEqual(NOT_FUNDED)
    expect(await lockup.state(filling())).toEqual(NOT_FUNDED)
  })

  it('takes an output of exactly the payout as ours, and ignores dust sent to the address', async () => {
    world.history = [output('dust', 330), output('pay')]
    expect(await lockup.state(armed())).toEqual(at('funded'))
    world.history = [output('dust', 330)]
    expect(await lockup.state(armed())).toEqual(NOT_FUNDED)
  })

  it('still finds a fill that was already claimed, so it is not sent again', async () => {
    world.history = [output('pay', PAYOUT, { spent: true })]
    world.claimedOn = 'pay:0'
    expect(await lockup.state(armed())).toEqual(at('claimed', 'pay:0', { preimage: SECRET }))
  })

  it('prefers the unspent output when the fill went out twice', async () => {
    world.history = [output('first', PAYOUT, { spent: true }), output('second')]
    expect(await lockup.state(armed())).toEqual(at('funded', 'second:0'))
  })

  it('finds the output of a fill whose transaction was just sent', async () => {
    world.history = [output('other'), output('pay')]
    expect(await lockup.state(filling('pay'))).toEqual(at('funded'))
  })

  it('is funded while our recorded output is still there', async () => {
    world.history = [output('pay'), output('dust', 330)]
    expect(await lockup.state(toLocked())).toEqual(at('funded'))
  })

  it('reads the preimage from a claim of a sibling output', async () => {
    world.history = [output('pay'), output('sibling', PAYOUT, { spent: true })]
    world.claimedOn = 'sibling:0'
    expect(await lockup.state(refunding())).toEqual(at('claimed', 'pay:0', { preimage: SECRET }))
  })

  it('searches our own output even when the indexer does not list it yet', async () => {
    world.history = [output('dust', 330)]
    world.claimedOn = 'pay:0'
    expect(await lockup.state(refunding())).toEqual(at('claimed', 'pay:0', { preimage: SECRET }))
    expect(world.searched).toEqual(['dust:0', 'pay:0'])
  })

  it("stops on a claim that reveals anything but this swap's preimage: nothing may act on that", async () => {
    world.history = [output('pay', PAYOUT, { spent: true })]
    world.claimedOn = 'pay:0'
    for (const revealed of [WRONG_PREIMAGE, '11'.repeat(31), '11'.repeat(33)]) {
      world.revealed = revealed
      await expect(lockup.state(toLocked())).rejects.toThrow('does not open the hashlock')
    }
  })

  it('asks about our own output, not the script: dust does not make a spent fill look funded', async () => {
    world.history = [output('pay', PAYOUT, { spent: true }), output('dust', 330)]
    expect(await lockup.state(toLocked())).toEqual(at('gone'))
  })

  it('is gone, not funded, when its batch expired: neither spent nor spendable', async () => {
    const arkadeWithExpiredBatch = { ...arkade(), spendable: async () => [] }
    world.history = [output('pay')]
    const expired = new SolverLockup({ contract: async () => CONTRACT }, arkadeWithExpiredBatch)
    expect(await expired.state(toLocked())).toEqual(at('gone'))
  })

  it('is refunded once our recorded refund spent the output, and not before', async () => {
    world.history = [output('pay')]
    expect(await lockup.state(refunding('refund-tx'))).toEqual(at('funded'))
    world.history = [output('pay', PAYOUT, { spent: true })]
    expect(await lockup.state(refunding('refund-tx'))).toEqual(at('refunded', 'pay:0', { refundTx: 'refund-tx' }))
  })

  it('is not refunded by a refund on record alone: it may have swept only dust', async () => {
    const expiredBatch = new SolverLockup(
      { contract: async () => CONTRACT },
      { ...arkade(), spendable: async () => [] },
    )
    world.history = [output('pay'), output('dust', 330, { spent: true })]
    expect(await expiredBatch.state(refunding('dust-refund'))).toEqual(at('gone'))
    world.history = [output('dust', 330, { spent: true })]
    expect(await expiredBatch.state(refunding('dust-refund'))).toEqual(at('gone'))
  })

  it('is gone, not funded, when only dust is spendable and our output is not listed', async () => {
    world.history = [output('dust', 330)]
    expect(await lockup.state(toLocked())).toEqual(at('gone'))
  })

  it('finishes a refund whose answer was lost, only while refunding', async () => {
    world.history = [output('pay', PAYOUT, { spent: true })]
    world.lostRefund = 'refund-tx'
    expect(await lockup.state(refunding())).toEqual(at('refunded', 'pay:0', { refundTx: 'refund-tx' }))
    expect(await lockup.state(toLocked())).toEqual(at('gone'))
  })

  it('finishes a lost refund while the indexer does not list our output yet, but not for one in an expired batch', async () => {
    world.lostRefund = 'refund-tx'
    world.history = []
    expect(await lockup.state(refunding())).toEqual(at('refunded', 'pay:0', { refundTx: 'refund-tx' }))
    const expiredBatch = new SolverLockup(
      { contract: async () => CONTRACT },
      { ...arkade(), spendable: async () => [] },
    )
    world.history = [output('pay')]
    expect(await expiredBatch.state(refunding())).toEqual(at('gone'))
  })

  it('lets a claim win over a refund that was recorded', async () => {
    world.history = [output('pay', PAYOUT, { spent: true })]
    world.claimedOn = 'pay:0'
    expect((await lockup.state(refunding('refund-tx'))).status).toBe('claimed')
  })

  it('shows a claim made on Bitcoin after the lockup was unrolled, and tells the reader which outputs were', async () => {
    world.history = [output('pay', PAYOUT, { spent: true, unrolled: true })]
    world.claimedOn = 'pay:0'
    const unrolledSeen: (boolean | undefined)[] = []
    const watching = new SolverLockup(
      { contract: async () => CONTRACT },
      {
        ...arkade(),
        claimPreimage: async (contract, outpoints) => {
          unrolledSeen.push(...outpoints.map((o) => o.unrolled))
          return arkade().claimPreimage(contract, outpoints)
        },
      },
    )
    expect((await watching.state(refunding())).status).toBe('claimed')
    expect(unrolledSeen).toEqual([true])
  })

  it('is unrolled when a unilateral exit took it onto Bitcoin, whatever the spendable read says', async () => {
    world.history = [output('pay', PAYOUT, { unrolled: true })]
    expect(await lockup.state(refunding())).toEqual(at('unrolled'))
    world.history = [output('pay', PAYOUT, { spent: true, unrolled: true })]
    expect(await lockup.state(refunding('refund-tx'))).toEqual(at('unrolled'))
  })

  it('looks for a claim before a refund once the refund is open, even while our output is still there', async () => {
    world.history = [output('pay')]
    world.claimedOn = 'pay:0'
    world.refundOpen = true
    expect((await lockup.state(toLocked())).status).toBe('claimed')
  })

  it('shows a claim even when it cannot learn whether the refund is open', async () => {
    world.history = [output('pay', PAYOUT, { spent: true })]
    world.claimedOn = 'pay:0'
    const noChainTip = new SolverLockup(
      { contract: async () => CONTRACT },
      {
        ...arkade(),
        refundOpen: async () => {
          throw new Error('no chain tip')
        },
      },
    )
    expect((await noChainTip.state(toLocked())).status).toBe('claimed')
    world.history = [output('pay')]
    world.claimedOn = null
    world.reads = []
    expect(await noChainTip.state(toLocked())).toEqual(at('funded'))
    expect(world.reads).toEqual(['spendable', 'history', 'claimPreimage'])
  })

  it('tells outputs of one transaction apart, and takes no output larger than the payout', async () => {
    world.history = [output('pay', PAYOUT, { vout: 0, spent: true }), output('pay', PAYOUT, { vout: 3 })]
    expect(await lockup.state(toLocked('pay:3'))).toEqual(at('funded', 'pay:3'))
    expect((await lockup.state(toLocked('pay:0'))).status).toBe('gone')
    world.history = [output('big', PAYOUT + 1)]
    expect(await lockup.state(armed())).toEqual(NOT_FUNDED)
  })

  it('falls back to an exact output when the transaction it sent is not listed', async () => {
    world.history = [output('older')]
    expect(await lockup.state(filling('pay'))).toEqual(at('funded', 'older:0'))
  })

  it('refuses a swap that is locked or refunding with no outpoint on record, and a reference that is not one', async () => {
    const bare = filling().markToLocked(t(1_003), ref('pay'))
    await expect(lockup.state(bare)).rejects.toThrow('with no funded outpoint recorded')
    await expect(lockup.refund(bare.startRefund(t(1_010)))).rejects.toThrow('with no funded outpoint recorded')
    for (const odd of ['pay:', 'pay:x', 'pay:0:7', 'pay:00', ':0']) {
      await expect(lockup.state(filling().markToLocked(t(1_003), ref(odd))), odd).rejects.toThrow('not an outpoint')
    }
  })
})

describe('our lockup on Arkade: how much it reads', () => {
  it('makes one read while nothing was filled', async () => {
    await lockup.state(armed())
    expect(world.reads).toEqual(['history'])
  })

  it('makes one read to adopt an untouched fill', async () => {
    world.history = [output('pay')]
    await lockup.state(armed())
    await lockup.state(filling('pay'))
    expect(world.reads).toEqual(['history', 'history'])
  })

  it('reads the spendable list once, late, for an output the history calls unspent', async () => {
    world.history = [output('pay')]
    await lockup.state(refunding())
    expect(world.reads).toEqual(['history', 'claimPreimage', 'spendable'])
  })

  it('makes one read while the fill waits for the client', async () => {
    world.history = [output('pay')]
    await lockup.state(toLocked())
    expect(world.reads).toEqual(['spendable'])
  })

  it('reads the rest only once our output is gone, and the spendable list only once', async () => {
    world.history = [output('pay', PAYOUT, { spent: true })]
    world.claimedOn = 'pay:0'
    await lockup.state(toLocked())
    expect(world.reads).toEqual(['spendable', 'history', 'claimPreimage'])
  })
})

describe('our lockup on Arkade: funding and refunding', () => {
  it('funds and gives the transaction', async () => {
    expect(await lockup.fund(armed())).toBe('pay')
  })

  it('gives nothing only when the wallet is certain nothing left it, and passes on any other failure', async () => {
    world.fund = async () => null
    expect(await lockup.fund(armed())).toBeNull()
    world.fund = async () => {
      throw new Error('arkd timed out')
    }
    await expect(lockup.fund(armed())).rejects.toThrow('arkd timed out')
  })

  it('refunds everything spendable at the script', async () => {
    world.history = [output('pay'), output('dust', 330)]
    expect(await lockup.refund(refunding())).toBe('refund-tx')
    expect(world.refunded).toEqual([['pay:0', 'dust:0']])
  })

  it('sends no refund when our own output is not there, even with dust at the address', async () => {
    expect(await lockup.refund(refunding())).toBeNull()
    world.history = [output('pay', PAYOUT, { spent: true }), output('dust', 330)]
    expect(await lockup.refund(refunding())).toBeNull()
    expect(world.refunded).toEqual([])
  })

  it('passes on the words of a server that refuses the refund', async () => {
    world.history = [output('pay')]
    world.refund = async () => {
      throw new Error('arkd refused to co-sign')
    }
    await expect(lockup.refund(refunding())).rejects.toThrow('arkd refused to co-sign')
  })

  it('tells when the refund opens and how long refunding alone takes', async () => {
    world.refundOpen = true
    expect(await lockup.refundTimes(armed())).toEqual({
      refundOpen: true,
      refundOpensAt: 9_000,
      secondsToRefundAlone: 1_536,
    })
  })
})
