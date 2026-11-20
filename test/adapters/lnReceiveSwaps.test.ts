import { beforeEach, describe, expect, it } from 'vitest'
import { RfqId } from '@arkade-os/solver-core/domain/shared/ids.js'
import { Hashlock } from '@arkade-os/solver-core/domain/swap/hashlock.js'
import { SwapState } from '@arkade-os/solver-core/domain/swap/swap_state.js'
import { LnReceiveSwaps } from '@arkade-os/solver-corridors/adapters/lnReceiveSwaps.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { ReceiveSwapStore, type ReceiveSwapState } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import { LnReceiveMachine } from '@arkade-os/solver-corridors/machines/lnReceive.js'

const HASH = 'ab'.repeat(32)
const PREIMAGE = 'cd'.repeat(32)
const RFQ = 'ef'.repeat(32)
const LOCKUP = { arkade_lockup_txid: 'lockup', arkade_lockup_vout: 1, arkade_lockup_value: 4_950 }

let store: ReceiveSwapStore
let swaps: LnReceiveSwaps
let now: number

const insert = (id = 'swap-1', paymentHash = HASH) =>
  store.insertQuote({
    id,
    paymentHash,
    amountSats: 5_000,
    payoutSats: 4_950,
    invoice: 'lnbcrt1',
    invoiceExpiresAt: 2_000,
    payoutAddress: 'tark1',
    payoutPkScript: '51',
    payoutPubkey: '02',
    claimPacket: null,
    refundLocktime: 9_000,
    solverPubkey: '03',
    serverPubkey: '04',
    claimDelay: 1,
    refundDelay: 2,
    refundWithoutReceiverDelay: 3,
    emulatorPubkey: '05',
    pkScript: `5120${id}`,
    lockupAddress: 'tark1lockup',
    solverRefundPkScript: '52',
    nonInteractiveParameters: true,
    rfqId: RFQ,
  })

type Step = readonly [from: ReceiveSwapState, to: ReceiveSwapState, fields?: Record<string, unknown>]
const walk = async (...steps: Step[]) => {
  for (const [from, to, fields = {}] of steps) {
    now += 1
    await store.transition('swap-1', from, to, fields)
  }
}
const load = async () => swaps.load(await store.get('swap-1'))
const legs = async () => {
  const swap = await load()
  return `${swap.from.state}/${swap.to.state} ${swap.state}`
}

const ARMED: Step = ['quoted', 'armed', { htlc_expires_at: 5_000 }]
const FUNDED: Step = ['armed', 'funded', LOCKUP]
const CLAIMED: Step = ['funded', 'claimed', { preimage: PREIMAGE }]

beforeEach(async () => {
  now = 1_000
  store = await ReceiveSwapStore.open(betterSqliteDriver(':memory:'), () => now)
  swaps = new LnReceiveSwaps(store)
  await insert()
})

describe('receive_swap read as a swap', () => {
  it('carries the terms the row was quoted on', async () => {
    const swap = await load()
    expect(swap.snapshot).toMatchObject({ id: 'swap-1', rfqId: RFQ, hashlock: HASH, preimage: null, outcome: null })
    expect([swap.from.rail, swap.from.amount.units, swap.to.rail, swap.to.amount.units]).toEqual([
      'lightning',
      5_000n,
      'arkade',
      4_950n,
    ])
    expect(swap.quote.pricing.fee.units).toBe(50n)
    expect(swap.quote.validUntil).toBe(2_000)
    expect(swap.version).toBe(1_000)
  })

  it('places every state of the happy path and of the refund', async () => {
    expect(await legs()).toBe('pending/pending quoted')
    await walk(ARMED)
    expect(await legs()).toBe('locked/pending funded')
    await walk(FUNDED)
    expect(await legs()).toBe('locked/locked awaiting_claim')
    expect((await load()).to.reference('funding')).toBe('lockup:1')
    await walk(['funded', 'refunding'])
    expect(await legs()).toBe('locked/refunding refunding')
    await walk(['refunding', 'claimed', { preimage: PREIMAGE }])
    expect(await legs()).toBe('locked/claimed filled')
    expect((await load()).preimage).toBe(PREIMAGE)
    await store.patch('swap-1', { settle_attempted_at: now })
    expect(await legs()).toBe('claiming/claimed settling')
    await walk(['claimed', 'settled'])
    expect(await legs()).toBe('claimed/claimed settled')
  })

  it('reads our own refund with the transaction that made it', async () => {
    await walk(ARMED, FUNDED, ['funded', 'refunding'], ['refunding', 'refunded', { refund_ark_txid: 'refund' }])
    expect(await legs()).toBe('locked/refunded refunded')
    expect((await load()).to.reference('refund')).toBe('refund')
  })

  it('reads a held fund lease as a payout in flight', async () => {
    await walk(ARMED)
    await store.claimFundLease('swap-1', 'armed')
    expect(await legs()).toBe('locked/locking filling')
    expect((await load()).to.since).toBe(now)
    await store.releaseFundLease('swap-1')
    expect(await legs()).toBe('locked/pending funded')
  })

  it('keeps the legs a failed row had, from its history', async () => {
    await walk(ARMED)
    await store.claimFundLease('swap-1', 'armed')
    await walk(['armed', 'stuck', { failure_reason: 'funding response lost' }])
    const stuck = await load()
    expect([stuck.from.state, stuck.to.state, stuck.state]).toEqual(['locked', 'locking', 'stuck'])
    expect(stuck.snapshot.outcomeReason).toBe('funding response lost')
    expect(stuck.capitalOut).toBe(true)
  })

  it('reads a refusal as nothing of ours having gone out', async () => {
    await store.fail('swap-1', 'quoted', 'invoice expired before it was ever armed')
    const refused = await load()
    expect([refused.from.state, refused.to.state, refused.state]).toEqual(['pending', 'pending', 'refused'])
    expect(refused.capitalOut).toBe(false)
  })

  it('finds a swap by its request and by its hash, and nothing refused by hash', async () => {
    expect((await swaps.findByRfqId(RfqId.of(RFQ)))?.id).toBe('swap-1')
    expect(await swaps.findByRfqId(RfqId.of('00'.repeat(32)))).toBeNull()
    expect((await swaps.findLiveByHash(Hashlock.of(HASH))).map((s) => s.id)).toEqual(['swap-1'])
    await store.fail('swap-1', 'quoted', 'gone')
    expect(await swaps.findLiveByHash(Hashlock.of(HASH))).toEqual([])
  })
})

describe('against the machine it reads', () => {
  const paths: Record<ReceiveSwapState, Step[]> = {
    quoted: [],
    armed: [ARMED],
    funded: [ARMED, FUNDED],
    claimed: [ARMED, FUNDED, CLAIMED],
    refunding: [ARMED, FUNDED, ['funded', 'refunding']],
    settled: [ARMED, FUNDED, CLAIMED, ['claimed', 'settled']],
    refunded: [ARMED, FUNDED, ['funded', 'refunded', { refund_ark_txid: 'refund' }]],
    refused: [ARMED, ['armed', 'refused', { failure_reason: 'no' }]],
    stuck: [ARMED, FUNDED, ['funded', 'stuck', { failure_reason: 'no' }]],
  }

  it.each(LnReceiveMachine.states)('agrees on whether %s is live and exposed', async (state) => {
    await walk(...paths[state])
    const swap = await load()
    expect(SwapState.isTerminal(swap.state)).toBe(LnReceiveMachine.isTerminal(state))
    expect(swap.exposed).toBe(LnReceiveMachine.isExposed(state))
  })
})
