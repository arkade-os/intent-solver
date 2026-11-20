import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hashlock } from '@arkade-os/solver-next/domain/swap/hashlock.js'
import type { Swap } from '@arkade-os/solver-next/domain/swap/swap.js'
import { HeldPayment } from '@arkade-os/solver-next/infrastructure/lightning/held_payment.js'
import { FakeLightningBackend } from '@arkade-os/solver-rails-fake/ln/fake/backend.js'
import { btc, quoted, ref, SECRET, t } from '../../domain/support.js'

const HASH = Hashlock.ofPreimage(SECRET)
const TIMES_OUT = 9_000

let dir: string
let node: FakeLightningBackend
let leg: HeldPayment

const receive = (): Swap =>
  quoted({
    hashlock: HASH,
    from: { rail: 'lightning', amount: btc(5_000n), contract: 'lightning', version: null },
    to: { rail: 'arkade', amount: btc(4_950n), contract: 'vhtlc', version: null },
  })

const claimedByClient = (): Swap => {
  const swap = receive()
  swap.lock('from', t(1_001), ref(HASH), t(TIMES_OUT))
  swap.locking('to', t(1_002))
  swap.lock('to', t(1_003), ref('lockup:0'))
  swap.claim('to', t(1_004), { preimage: SECRET })
  return swap
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'held-payment-'))
  node = new FakeLightningBackend(join(dir, 'ln.json'), 'bcrt', () => 1_000)
  leg = new HeldPayment(node)
  await node.createHoldInvoice({ amountSats: 5_000, paymentHash: HASH, expirySeconds: 600, minFinalCltvBlocks: 40 })
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('a held Lightning payment', () => {
  it('shows nothing until a payer holds the invoice, then the hold and its timeout', async () => {
    expect(await leg.status(receive())).toMatchObject({ funding: 'none', expiresAt: null })
    node.armHold(HASH, TIMES_OUT)
    expect(await leg.status(receive())).toMatchObject({
      funding: 'exact',
      matured: true,
      expiresAt: TIMES_OUT,
      lockReference: HASH,
    })
  })

  it('settles with the preimage, and the node then shows it claimed', async () => {
    node.armHold(HASH, TIMES_OUT)
    expect(await leg.claim(claimedByClient())).toEqual({ status: 'sent', reference: HASH })
    expect(await leg.status(claimedByClient())).toMatchObject({ funding: 'none', claim: 'landed' })
  })

  it('does not know whether a settle that threw went through', async () => {
    expect(await leg.claim(claimedByClient())).toEqual({ status: 'unknown' })
  })

  it('retires an invoice nobody paid', async () => {
    await leg.retire(receive())
    expect((await node.getHoldState(HASH)).status).toBe('cancelled')
  })

  it('leaves a held payment alone: it is neither retired nor refunded', async () => {
    node.armHold(HASH, TIMES_OUT)
    await leg.retire(receive())
    expect(await leg.refund()).toEqual({ status: 'not_sent' })
    expect((await node.getHoldState(HASH)).status).toBe('armed')
  })

  it('treats a status it does not know as nothing held', async () => {
    const odd = new HeldPayment({
      getHoldState: async () => ({ status: 'unknown', expiresAt: null }),
      settleHold: async () => undefined,
    })
    expect(await odd.status(receive())).toMatchObject({ funding: 'none', claim: 'none' })
  })

  it('lets a failed read stop the payout, but not the collection after it', async () => {
    const down = new HeldPayment({
      getHoldState: async () => {
        throw new Error('node unreachable')
      },
      settleHold: async () => undefined,
    })
    await expect(down.status(receive())).rejects.toThrow('node unreachable')
    expect(await down.status(claimedByClient())).toMatchObject({ funding: 'none', claim: 'none' })
    expect(claimedByClient().from.expiresAt).toBe(TIMES_OUT)
  })

  it('shows a payment that went back: nothing held before the payout, lost after it', async () => {
    await node.cancelHold(HASH)
    expect(await leg.status(receive())).toMatchObject({ spent: { by: 'nobody' }, refund: 'landed' })
    expect(await leg.status(claimedByClient())).toMatchObject({ spent: { by: 'refund' } })
  })
})
