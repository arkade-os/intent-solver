import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HeldPayment } from './lnReceiveLegs.js'
import { LnReceiveSwaps } from './lnReceiveSwaps.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { ReceiveSwapStore } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import { FakeLightningBackend } from '@arkade-os/solver-rails-fake/ln/fake/backend.js'

const PREIMAGE = 'cd'.repeat(32)
const HASH = hex.encode(sha256(hex.decode(PREIMAGE)))
const TIMES_OUT = 9_000

let dir: string
let now: number
let ln: FakeLightningBackend
let store: ReceiveSwapStore
let leg: HeldPayment

const swap = async () => new LnReceiveSwaps(store).load(await store.get('swap-1'))

beforeEach(async () => {
  now = 1_000
  dir = mkdtempSync(join(tmpdir(), 'held-payment-'))
  ln = new FakeLightningBackend(join(dir, 'ln.json'), 'bcrt', () => now)
  store = await ReceiveSwapStore.open(betterSqliteDriver(':memory:'), () => now)
  leg = new HeldPayment(store, ln)
  await ln.createHoldInvoice({ amountSats: 5_000, paymentHash: HASH, expirySeconds: 600, minFinalCltvBlocks: 40 })
  await store.insertQuote({
    id: 'swap-1',
    paymentHash: HASH,
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
    pkScript: '5120aa',
    lockupAddress: 'tark1lockup',
    solverRefundPkScript: '52',
    nonInteractiveParameters: true,
    rfqId: 'ef'.repeat(32),
  })
})

afterEach(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

const paidOutAndClaimed = async () => {
  await store.transition('swap-1', 'quoted', 'armed', { htlc_expires_at: TIMES_OUT })
  await store.transition('swap-1', 'armed', 'funded', {
    arkade_lockup_txid: 'lockup',
    arkade_lockup_vout: 0,
    arkade_lockup_value: 4_950,
  })
  await store.transition('swap-1', 'funded', 'claimed', { preimage: PREIMAGE })
}

describe('the held Lightning payment', () => {
  it('shows nothing until a payer holds the invoice, then the hold and its timeout', async () => {
    expect(await leg.status(await swap())).toMatchObject({ funding: 'none', expiresAt: null })
    ln.armHold(HASH, TIMES_OUT)
    expect(await leg.status(await swap())).toMatchObject({
      funding: 'exact',
      matured: true,
      expiresAt: TIMES_OUT,
      lockReference: HASH,
    })
  })

  it('settles with the preimage, and the node then shows it claimed', async () => {
    ln.armHold(HASH, TIMES_OUT)
    await paidOutAndClaimed()
    expect(await leg.claim(await swap())).toEqual({ status: 'sent', reference: HASH })
    expect(await leg.status(await swap())).toMatchObject({ claim: 'landed' })
  })

  it('does not know whether a settle that threw went through', async () => {
    await paidOutAndClaimed()
    expect(await leg.claim(await swap())).toEqual({ status: 'unknown' })
  })

  it('retires an unpaid invoice but never touches a held payment', async () => {
    expect(await leg.refund(await swap())).toEqual({ status: 'sent', reference: HASH })
    expect((await ln.getHoldState(HASH)).status).toBe('cancelled')
  })

  it('leaves a held payment alone', async () => {
    ln.armHold(HASH, TIMES_OUT)
    expect(await leg.refund(await swap())).toEqual({ status: 'not_sent' })
    expect((await ln.getHoldState(HASH)).status).toBe('armed')
  })

  it('goes by the saved timeout once the node no longer knows the invoice', async () => {
    await paidOutAndClaimed()
    const forgetful = new HeldPayment(store, {
      getHoldState: async () => {
        throw new Error('invoice not found')
      },
      settleHold: ln.settleHold.bind(ln),
    })
    expect(await forgetful.status(await swap())).toMatchObject({ funding: 'none', claim: 'none' })
    expect((await swap()).from.expiresAt).toBe(TIMES_OUT)
  })
})
