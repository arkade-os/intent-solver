import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HeldPayment } from '@arkade-os/solver-next/application/legs/held_payment.js'
import { Hashlock } from '@arkade-os/solver-next/domain/swap/hashlock.js'
import { Quote } from '@arkade-os/solver-next/domain/swap/quote.js'
import type { Swap } from '@arkade-os/solver-next/domain/swap/swap.js'
import type { HoldState, HoldStatus, HoldingNode } from '@arkade-os/solver-next/ports/lightning.js'
import { FakeLightningBackend } from '@arkade-os/solver-rails-fake/ln/fake/backend.js'
import { btc, quoted, ref, SECRET, t } from '../../domain/support.js'

const INVOICE = Hashlock.ofPreimage(SECRET)
const GOES_BACK_AT = 9_000

const notPaidOut = (): Swap =>
  quoted({
    hashlock: INVOICE,
    from: { rail: 'lightning', amount: btc(5_000n), contract: 'lightning', version: null },
    to: { rail: 'arkade', amount: btc(4_950n), contract: 'vhtlc', version: null },
  })
const payingOut = (): Swap => notPaidOut().markFunded(t(1_001), ref(INVOICE), t(GOES_BACK_AT)).startFill(t(1_002))
const paidOut = (): Swap => payingOut().markToLocked(t(1_003), ref('lockup:0'))
const takenByClient = (): Swap => paidOut().markFilled(t(1_004), SECRET)

/** A node that answers what it is told to and remembers what it was asked to close. */
const nodeSaying = (answer: HoldState | Error, cancel?: () => Promise<void>) => {
  const closed: string[] = []
  const node: HoldingNode = {
    getHoldState: async () => {
      if (answer instanceof Error) throw answer
      return answer
    },
    settleHold: async () => undefined,
    cancelHold: async (invoice) => {
      closed.push(invoice)
      await cancel?.()
    },
  }
  return { payment: new HeldPayment(node), closed }
}
const saying = (status: HoldStatus, expiresAt: number | null = null) => nodeSaying({ status, expiresAt })
const DOWN = new Error('node unreachable')

describe('a payment our Lightning node holds', () => {
  let dir: string
  let node: FakeLightningBackend
  let payment: HeldPayment

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'held-payment-'))
    node = new FakeLightningBackend(join(dir, 'ln.json'), 'bcrt', () => 1_000)
    payment = new HeldPayment(node)
    await node.createHoldInvoice({
      amountSats: 5_000,
      paymentHash: INVOICE,
      expirySeconds: 600,
      minFinalCltvBlocks: 40,
    })
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is not paid until a payer pays, then waits until its time is up', async () => {
    expect(await payment.look(notPaidOut())).toEqual({ is: 'not_paid', goesBackAt: null })
    node.armHold(INVOICE, GOES_BACK_AT)
    expect(await payment.look(notPaidOut())).toEqual({ is: 'waiting', goesBackAt: GOES_BACK_AT })
  })

  it('is collected with the secret', async () => {
    node.armHold(INVOICE, GOES_BACK_AT)
    await payment.collect(takenByClient())
    expect(await payment.look(takenByClient())).toEqual({ is: 'collected', goesBackAt: null })
  })

  it('cannot be collected before the secret is known', async () => {
    node.armHold(INVOICE, GOES_BACK_AT)
    await expect(payment.collect(paidOut())).rejects.toThrow('no secret to collect the payment with')
    expect((await node.getHoldState(INVOICE)).status).toBe('armed')
  })

  it('shows as gone back once the node gave it up', async () => {
    await node.cancelHold(INVOICE)
    expect(await payment.look(notPaidOut())).toEqual({ is: 'gone_back', goesBackAt: null })
    expect(await payment.look(takenByClient())).toEqual({ is: 'gone_back', goesBackAt: null })
  })

  it('closes an invoice nobody paid', async () => {
    await payment.closeIfNotPaid(notPaidOut())
    expect((await node.getHoldState(INVOICE)).status).toBe('cancelled')
  })
})

describe('looking at a payment', () => {
  it('passes on the words of a node that refuses to collect', async () => {
    const refusing = new HeldPayment({
      getHoldState: async () => ({ status: 'armed', expiresAt: GOES_BACK_AT }),
      settleHold: async () => {
        throw new Error('permission denied')
      },
    })
    await expect(refusing.collect(takenByClient())).rejects.toThrow('permission denied')
  })

  it('gives the time only for a waiting payment, and none when the node gives no usable one', async () => {
    expect(await saying('armed', null).payment.look(notPaidOut())).toEqual({ is: 'waiting', goesBackAt: null })
    expect(await saying('armed', 9_000.9).payment.look(notPaidOut())).toEqual({ is: 'waiting', goesBackAt: 9_000 })
    for (const unusable of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 1e300]) {
      expect(await saying('armed', unusable).payment.look(notPaidOut())).toEqual({ is: 'waiting', goesBackAt: null })
    }
    for (const status of ['pending', 'settled', 'cancelled', 'unknown'] as const) {
      expect((await saying(status, GOES_BACK_AT).payment.look(notPaidOut())).goesBackAt).toBeNull()
    }
  })

  it('is unknown when the node says something this code does not know', async () => {
    expect(await saying('unknown').payment.look(notPaidOut())).toEqual({ is: 'unknown', goesBackAt: null })
    expect((await saying('half_settled' as HoldStatus).payment.look(notPaidOut())).is).toBe('unknown')
  })

  it('stops the payout when the node cannot be read', async () => {
    await expect(nodeSaying(DOWN).payment.look(notPaidOut())).rejects.toThrow('node unreachable')
  })

  it('is unknown, not an error, when the node cannot be read once the payout has started', async () => {
    for (const swap of [payingOut(), paidOut(), takenByClient()]) {
      expect(await nodeSaying(DOWN).payment.look(swap)).toEqual({ is: 'unknown', goesBackAt: null })
    }
  })

  it('does not believe a node that calls a payment unpaid after we paid out against it', async () => {
    expect((await saying('pending').payment.look(notPaidOut())).is).toBe('not_paid')
    for (const swap of [payingOut(), paidOut(), takenByClient()]) {
      expect((await saying('pending').payment.look(swap)).is).toBe('unknown')
    }
  })

  it('needs a swap with a hashlock, whatever is asked', async () => {
    const offer = quoted({
      hashlock: null,
      quote: Quote.of(null, { fee: btc(0n), spreadBps: 0 }),
      from: { rail: 'arkade', amount: btc(5_000n), contract: 'offer', version: null },
      to: { rail: 'arkade', amount: btc(4_950n), contract: 'payment', version: null },
    })
    const { payment, closed } = saying('pending')
    await expect(payment.look(offer)).rejects.toThrow('needs a hashlock')
    await expect(payment.collect(offer)).rejects.toThrow('needs a hashlock')
    await expect(payment.closeIfNotPaid(offer)).rejects.toThrow('needs a hashlock')
    expect(closed).toEqual([])
  })
})

describe('closing an invoice', () => {
  it('closes only one the node calls unpaid', async () => {
    for (const status of ['armed', 'settled', 'cancelled', 'unknown'] as const) {
      const { payment, closed } = saying(status)
      await payment.closeIfNotPaid(notPaidOut())
      expect(closed, status).toEqual([])
    }
    const { payment, closed } = saying('pending')
    await payment.closeIfNotPaid(notPaidOut())
    expect(closed).toEqual([INVOICE])
  })

  it('never closes one we started paying out against', async () => {
    const { payment, closed } = saying('pending')
    for (const swap of [payingOut(), paidOut(), takenByClient()]) await payment.closeIfNotPaid(swap)
    expect(closed).toEqual([])
  })

  it('waits for the node to finish closing', async () => {
    let finished = false
    const { payment } = nodeSaying({ status: 'pending', expiresAt: null }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      finished = true
    })
    await payment.closeIfNotPaid(notPaidOut())
    expect(finished).toBe(true)
  })

  it('never stops the swap: a node that is down, or refuses, is ignored', async () => {
    await expect(nodeSaying(DOWN).payment.closeIfNotPaid(notPaidOut())).resolves.toBeUndefined()
    const refusing = nodeSaying({ status: 'pending', expiresAt: null }, async () => {
      throw new Error('a payment just arrived')
    })
    await expect(refusing.payment.closeIfNotPaid(notPaidOut())).resolves.toBeUndefined()
  })

  it('does nothing on a node that cannot close invoices', async () => {
    let asked = false
    const cannotClose: HoldingNode = {
      getHoldState: async () => {
        asked = true
        return { status: 'pending', expiresAt: null }
      },
      settleHold: async () => undefined,
    }
    await new HeldPayment(cannotClose).closeIfNotPaid(notPaidOut())
    expect(asked).toBe(false)
  })
})
