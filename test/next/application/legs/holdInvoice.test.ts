import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HoldInvoice } from '@arkade-os/solver-next/application/legs/hold_invoice.js'
import { Hashlock } from '@arkade-os/solver-next/domain/swap/hashlock.js'
import { Quote } from '@arkade-os/solver-next/domain/swap/quote.js'
import type { Swap } from '@arkade-os/solver-next/domain/swap/swap.js'
import type { HoldState, HoldStatus, HoldInvoiceNode } from '@arkade-os/solver-next/ports/lightning.js'
import { FakeLightningBackend } from '@arkade-os/solver-rails-fake/ln/fake/backend.js'
import { btc, quoted, ref, SECRET, t } from '../../domain/support.js'

const HASH = Hashlock.ofPreimage(SECRET)
const HTLC_EXPIRES_AT = 9_000

const unfilled = (): Swap =>
  quoted({
    hashlock: HASH,
    from: { rail: 'lightning', amount: btc(5_000n), contract: 'lightning', version: null },
    to: { rail: 'arkade', amount: btc(4_950n), contract: 'vhtlc', version: null },
  })
const filling = (): Swap => unfilled().markFunded(t(1_001), ref(HASH), t(HTLC_EXPIRES_AT)).startFill(t(1_002))
const toLocked = (): Swap => filling().markToLocked(t(1_003), ref('lockup:0'))
const filled = (): Swap => toLocked().markFilled(t(1_004), SECRET)

/** A node that answers what it is told to and remembers what it was asked to close. */
const nodeSaying = (answer: HoldState | Error, cancel?: () => Promise<void>) => {
  const closed: string[] = []
  const node: HoldInvoiceNode = {
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
  return { invoice: new HoldInvoice(node), closed }
}
const saying = (status: HoldStatus, expiresAt: number | null = null) => nodeSaying({ status, expiresAt })
const DOWN = new Error('node unreachable')

describe('a hold invoice on our Lightning node', () => {
  let dir: string
  let node: FakeLightningBackend
  let invoice: HoldInvoice

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'hold-invoice-'))
    node = new FakeLightningBackend(join(dir, 'ln.json'), 'bcrt', () => 1_000)
    invoice = new HoldInvoice(node)
    await node.createHoldInvoice({
      amountSats: 5_000,
      paymentHash: HASH,
      expirySeconds: 600,
      minFinalCltvBlocks: 40,
    })
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is pending until a payer pays, then armed until its HTLC expires', async () => {
    expect(await invoice.state(unfilled())).toEqual({ status: 'pending', htlcExpiresAt: null })
    node.armHold(HASH, HTLC_EXPIRES_AT)
    expect(await invoice.state(unfilled())).toEqual({ status: 'armed', htlcExpiresAt: HTLC_EXPIRES_AT })
  })

  it('is settled with the preimage', async () => {
    node.armHold(HASH, HTLC_EXPIRES_AT)
    await invoice.settle(filled())
    expect(await invoice.state(filled())).toEqual({ status: 'settled', htlcExpiresAt: null })
  })

  it('cannot be settled before the preimage is known', async () => {
    node.armHold(HASH, HTLC_EXPIRES_AT)
    await expect(invoice.settle(toLocked())).rejects.toThrow('no preimage to settle the hold with')
    expect((await node.getHoldState(HASH)).status).toBe('armed')
  })

  it('shows as cancelled once the node gave it up', async () => {
    await node.cancelHold(HASH)
    expect(await invoice.state(unfilled())).toEqual({ status: 'cancelled', htlcExpiresAt: null })
    expect(await invoice.state(filled())).toEqual({ status: 'cancelled', htlcExpiresAt: null })
  })

  it('closes an invoice nobody paid', async () => {
    await invoice.closeIfNotPaid(unfilled())
    expect((await node.getHoldState(HASH)).status).toBe('cancelled')
  })
})

describe('the state of a hold', () => {
  it('passes on the words of a node that refuses to settle', async () => {
    const refusing = new HoldInvoice({
      getHoldState: async () => ({ status: 'armed', expiresAt: HTLC_EXPIRES_AT }),
      settleHold: async () => {
        throw new Error('permission denied')
      },
    })
    await expect(refusing.settle(filled())).rejects.toThrow('permission denied')
  })

  it('gives the expiry only for an armed hold, and none when the node gives no usable one', async () => {
    expect(await saying('armed', null).invoice.state(unfilled())).toEqual({ status: 'armed', htlcExpiresAt: null })
    expect(await saying('armed', 9_000.9).invoice.state(unfilled())).toEqual({ status: 'armed', htlcExpiresAt: 9_000 })
    for (const unusable of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 1e300]) {
      expect(await saying('armed', unusable).invoice.state(unfilled())).toEqual({
        status: 'armed',
        htlcExpiresAt: null,
      })
    }
    for (const status of ['pending', 'settled', 'cancelled', 'unknown'] as const) {
      expect((await saying(status, HTLC_EXPIRES_AT).invoice.state(unfilled())).htlcExpiresAt).toBeNull()
    }
  })

  it('is unknown when the node says something this code does not know', async () => {
    expect(await saying('unknown').invoice.state(unfilled())).toEqual({ status: 'unknown', htlcExpiresAt: null })
    expect((await saying('half_settled' as HoldStatus).invoice.state(unfilled())).status).toBe('unknown')
  })

  it('stops the fill when the node cannot be read', async () => {
    await expect(nodeSaying(DOWN).invoice.state(unfilled())).rejects.toThrow('node unreachable')
  })

  it('is unknown, not an error, when the node cannot be read once the fill has started', async () => {
    for (const swap of [filling(), toLocked(), filled()]) {
      expect(await nodeSaying(DOWN).invoice.state(swap)).toEqual({ status: 'unknown', htlcExpiresAt: null })
    }
  })

  it('does not believe a node that calls a hold pending after we filled against it', async () => {
    expect((await saying('pending').invoice.state(unfilled())).status).toBe('pending')
    for (const swap of [filling(), toLocked(), filled()]) {
      expect((await saying('pending').invoice.state(swap)).status).toBe('unknown')
    }
  })

  it('needs a swap with a hashlock, whatever is asked', async () => {
    const offer = quoted({
      hashlock: null,
      quote: Quote.of(null, { fee: btc(0n), spreadBps: 0 }),
      from: { rail: 'arkade', amount: btc(5_000n), contract: 'offer', version: null },
      to: { rail: 'arkade', amount: btc(4_950n), contract: 'payment', version: null },
    })
    const { invoice, closed } = saying('pending')
    await expect(invoice.state(offer)).rejects.toThrow('needs a hashlock')
    await expect(invoice.settle(offer)).rejects.toThrow('needs a hashlock')
    await expect(invoice.closeIfNotPaid(offer)).rejects.toThrow('needs a hashlock')
    expect(closed).toEqual([])
  })
})

describe('closing an invoice', () => {
  it('closes only one the node calls pending', async () => {
    for (const status of ['armed', 'settled', 'cancelled', 'unknown'] as const) {
      const { invoice, closed } = saying(status)
      await invoice.closeIfNotPaid(unfilled())
      expect(closed, status).toEqual([])
    }
    const { invoice, closed } = saying('pending')
    await invoice.closeIfNotPaid(unfilled())
    expect(closed).toEqual([HASH])
  })

  it('never closes one we started filling against', async () => {
    const { invoice, closed } = saying('pending')
    for (const swap of [filling(), toLocked(), filled()]) await invoice.closeIfNotPaid(swap)
    expect(closed).toEqual([])
  })

  it('waits for the node to finish closing', async () => {
    let finished = false
    const { invoice } = nodeSaying({ status: 'pending', expiresAt: null }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      finished = true
    })
    await invoice.closeIfNotPaid(unfilled())
    expect(finished).toBe(true)
  })

  it('never stops the swap: a node that is down, or refuses, is ignored', async () => {
    await expect(nodeSaying(DOWN).invoice.closeIfNotPaid(unfilled())).resolves.toBeUndefined()
    const refusing = nodeSaying({ status: 'pending', expiresAt: null }, async () => {
      throw new Error('a payment just arrived')
    })
    await expect(refusing.invoice.closeIfNotPaid(unfilled())).resolves.toBeUndefined()
  })

  it('does nothing on a node that cannot close invoices', async () => {
    let asked = false
    const cannotClose: HoldInvoiceNode = {
      getHoldState: async () => {
        asked = true
        return { status: 'pending', expiresAt: null }
      },
      settleHold: async () => undefined,
    }
    await new HoldInvoice(cannotClose).closeIfNotPaid(unfilled())
    expect(asked).toBe(false)
  })
})
