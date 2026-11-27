import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ToLightning } from '@arkade-os/solver-next/application/legs/to_lightning.js'
import { Hashlock } from '@arkade-os/solver-next/domain/swap/hashlock.js'
import type { Swap } from '@arkade-os/solver-next/domain/swap/swap.js'
import type {
  PayInvoiceParams,
  PayingNode,
  PaymentResult,
  SendHtlcState,
} from '@arkade-os/solver-next/ports/lightning.js'
import { FakeLightningBackend } from '@arkade-os/solver-rails-fake/ln/fake/backend.js'
import { btc, quoted, ref, SECRET, t } from '../../domain/support.js'

const HASH = Hashlock.ofPreimage(SECRET)
const ORDER = { invoice: 'lnbcrt1invoice', maxFeeSats: 30, maxCltvBlocks: 144 }
const NOTHING = { preimage: null, feePaidSats: null, noRecord: false }

const filling = (hashlock: Hashlock = HASH): Swap =>
  quoted({
    hashlock,
    from: { rail: 'arkade', amount: btc(10_000n), contract: 'vhtlc', version: null },
    to: { rail: 'lightning', amount: btc(9_990n), contract: 'lightning', version: null },
  })
    .markFunded(t(1_001), ref('lockup:0'), t(9_000))
    .startFill(t(1_002))
const sent = (): Swap => filling().recordFact('to', { funding: ref('pay-1') })

/** A node that answers what it is told to and remembers what it was asked. */
const nodeSaying = (answers: { payment?: Partial<PaymentResult> | Error; htlc?: SendHtlcState | null | Error }) => {
  const asked: string[] = []
  const orders: PayInvoiceParams[] = []
  const answer = (): PaymentResult => {
    if (answers.payment instanceof Error) throw answers.payment
    return { id: 'pay-1', status: 'pending', ...answers.payment }
  }
  const node: PayingNode = {
    payInvoice: async (order) => (orders.push(order), answer()),
    getPayment: async (id) => (asked.push(`payment ${id}`), answer()),
    ...(answers.htlc === undefined
      ? {}
      : {
          getSendHtlcState: async (hash) => {
            asked.push(`htlc ${hash}`)
            if (answers.htlc instanceof Error) throw answers.htlc
            return answers.htlc ?? null
          },
        }),
  }
  return { leg: new ToLightning(node), asked, orders }
}
const DOWN = new Error('node unreachable')

describe('a payment from our Lightning node', () => {
  let dir: string
  let node: FakeLightningBackend

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'to-lightning-'))
    node = new FakeLightningBackend(join(dir, 'ln.json'), 'bcrt', () => 1_000)
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('pays the invoice, learns the preimage, and reads the same again by the id it got', async () => {
    const { invoice, paymentHash } = node.forgeInvoice(9_990)
    const leg = new ToLightning(node)
    const swap = filling(Hashlock.of(paymentHash))
    const { id, payment } = await leg.pay(swap, { ...ORDER, invoice })
    expect(payment.status).toBe('paid')
    expect(Hashlock.ofPreimage(payment.preimage!)).toBe(paymentHash)
    expect(await leg.state(swap.recordFact('to', { funding: id }))).toEqual(payment)
  })

  it('reports a payment the node could not route as failed', async () => {
    const stranger = new FakeLightningBackend(join(dir, 'other.json'), 'bcrt', () => 1_000)
    const { invoice, paymentHash } = stranger.forgeInvoice(9_990)
    const { payment } = await new ToLightning(node).pay(filling(Hashlock.of(paymentHash)), { ...ORDER, invoice })
    expect(payment).toEqual({ status: 'failed', ...NOTHING })
  })
})

describe('paying', () => {
  it('sends the order with the key production uses for the swap', async () => {
    const { leg, orders } = nodeSaying({})
    expect(await leg.pay(filling(), ORDER)).toEqual({ id: 'pay-1', payment: { status: 'in_flight', ...NOTHING } })
    expect(orders).toEqual([{ ...ORDER, idempotencyKey: `swap-${HASH}` }])
  })

  it('lets a failure through', async () => {
    await expect(nodeSaying({ payment: DOWN }).leg.pay(filling(), ORDER)).rejects.toThrow('node unreachable')
  })
})

describe('the state of a payment with its id on record', () => {
  it.each([
    ['pending', {}, { status: 'in_flight', ...NOTHING }],
    ['failed', {}, { status: 'failed', ...NOTHING }],
    ['failed', { evidence: 'no_record' }, { status: 'failed', ...NOTHING, noRecord: true }],
    ['failed', { evidence: 'terminal' }, { status: 'failed', ...NOTHING }],
    ['succeeded', {}, { status: 'paid', ...NOTHING }],
    [
      'succeeded',
      { preimage: SECRET, feePaidSats: 7 },
      { status: 'paid', ...NOTHING, preimage: SECRET, feePaidSats: 7 },
    ],
    ['succeeded', { preimage: SECRET.toUpperCase() }, { status: 'paid', ...NOTHING, preimage: SECRET }],
    ['something new', {}, { status: 'unknown', ...NOTHING }],
  ] as const)('a node saying %s %o', async (status, more, expected) => {
    const { leg, asked } = nodeSaying({ payment: { status: status as never, ...more }, htlc: null })
    expect(await leg.state(sent())).toEqual(expected)
    expect(asked).toEqual(['payment pay-1'])
  })

  it('refuses a preimage that does not open the hashlock', async () => {
    const { leg } = nodeSaying({ payment: { status: 'succeeded', preimage: '22'.repeat(32) } })
    await expect(leg.state(sent())).rejects.toThrow('does not open the hashlock')
  })

  it('lets a failed read through', async () => {
    await expect(nodeSaying({ payment: DOWN }).leg.state(sent())).rejects.toThrow('node unreachable')
  })
})

describe('the state of a payment with no id on record', () => {
  it('is unknown when the node cannot be asked by hash, and nothing is asked', async () => {
    const { leg, asked } = nodeSaying({})
    expect(await leg.state(filling())).toEqual({ status: 'unknown', ...NOTHING })
    expect(asked).toEqual([])
  })

  it.each([
    [null, { status: 'not_sent', ...NOTHING }],
    [{ status: 'committed' }, { status: 'in_flight', ...NOTHING }],
    [{ status: 'returned' }, { status: 'failed', ...NOTHING }],
    [{ status: 'settled' }, { status: 'paid', ...NOTHING }],
    [
      { status: 'settled', preimage: SECRET },
      { status: 'paid', ...NOTHING, preimage: SECRET },
    ],
    [{ status: 'something new' }, { status: 'unknown', ...NOTHING }],
  ] as const)('a node holding %o against the hash', async (htlc, expected) => {
    const { leg, asked } = nodeSaying({ htlc: htlc as SendHtlcState | null })
    expect(await leg.state(filling())).toEqual(expected)
    expect(asked).toEqual([`htlc ${HASH}`])
  })

  it('does not take a node that cannot answer for a node that holds nothing', async () => {
    await expect(nodeSaying({ htlc: DOWN }).leg.state(filling())).rejects.toThrow('node unreachable')
  })

  it('refuses a preimage that does not open the hashlock', async () => {
    const { leg } = nodeSaying({ htlc: { status: 'settled', preimage: '22'.repeat(32) } })
    await expect(leg.state(filling())).rejects.toThrow('does not open the hashlock')
  })
})
