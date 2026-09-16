/**
 * The P&L screen's data, through the assembled admin app over REAL stores.
 *
 * Real stores rather than a stub reader, because the property most worth
 * pinning is the one a stub cannot hold: that each corridor reads its own
 * columns the right way round. The Lightning SEND leg is the trap — it has no
 * payout column at all, so its intake is the lockup and its outlay is the
 * invoice, the reverse of every sibling — and a stub would happily confirm
 * whichever order the test author assumed.
 */
import { describe, it, expect } from 'vitest'
import { buildAdminApp } from '@arkade-os/solver-app/admin/server.js'
import { SwapStore, type QuoteRecord } from '@arkade-os/solver-corridors/db/swaps.js'
import { ReceiveSwapStore } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import { lightningSendReader, lightningReceiveReader } from '@arkade-os/solver-corridors/corridors/adapters.js'
import { createCorridorReaderSet } from '@arkade-os/solver-core/core/corridor.js'

const NOW = 1_800_000_000

interface PnlBody {
  window: { since: number; until: number; label: string; bucketSeconds: number }
  summary: {
    grossSats: number
    volumeSats: number
    marginBps: number | null
    pricedCount: number
    unpricedCount: number
    realizedCount: number
    failedCount: number
    atRiskSats: number
    openCount: number
  }
  series: { at: number; grossSats: number; cumulativeGrossSats: number; count: number }[]
  corridors: { corridor: string; grossSats: number; marginBps: number | null; atRiskSats: number }[]
  durationBands: { label: string; count: number; marginBps: number | null }[]
  fx: { leg: string; points: { id: string; driftBps: number | null }[] }[]
  coverage: { measured: string[]; unmeasured: string[]; truncated: string[]; basis: string }
}

const sendQuote = (over: Partial<QuoteRecord> = {}): QuoteRecord => ({
  id: 'send-1',
  invoice: 'lnbc5u1p...',
  paymentHash: 'a'.repeat(64),
  amountSats: 100_000,
  invoiceExpiresAt: NOW + 3_600,
  refundLocktime: NOW + 7_200,
  senderPubkey: '01'.repeat(32),
  receiverPubkey: '02'.repeat(32),
  serverPubkey: '03'.repeat(32),
  claimDelay: 605_184,
  refundDelay: 605_696,
  refundWithoutReceiverDelay: 606_208,
  pkScript: '5120' + 'ab'.repeat(32),
  lockupAddress: 'ark1qexample',
  nonInteractiveParameters: true,
  ...over,
})

const receiveQuote = (over: Record<string, unknown> = {}) => ({
  id: 'recv-1',
  paymentHash: 'bb'.repeat(32),
  amountSats: 50_000,
  payoutSats: 49_800,
  invoice: 'lnbcrt50000n1...',
  invoiceExpiresAt: NOW + 600,
  payoutAddress: 'tark1payoutexample',
  payoutPkScript: '11'.repeat(34),
  payoutPubkey: '22'.repeat(32),
  claimPacket: null,
  refundLocktime: NOW + 7_200,
  solverPubkey: '33'.repeat(32),
  serverPubkey: '44'.repeat(32),
  claimDelay: 512,
  refundDelay: 1_024,
  refundWithoutReceiverDelay: 1_536,
  emulatorPubkey: '55'.repeat(33),
  pkScript: '66'.repeat(34),
  lockupAddress: 'tark1lockupexample',
  solverRefundPkScript: '77'.repeat(34),
  nonInteractiveParameters: true,
  ...over,
})

const build = async () => {
  let clock = NOW
  const at = (seconds: number): void => {
    clock = seconds
  }
  const sendStore = await SwapStore.open(':memory:', () => clock)
  const receiveStore = await ReceiveSwapStore.open(':memory:', () => clock)
  const readers = createCorridorReaderSet([lightningSendReader(sendStore), lightningReceiveReader(receiveStore)])
  const services = { readers } as never
  const app = buildAdminApp({ services, startedAt: 1, mode: 'serve', now: () => NOW })
  return { app, sendStore, receiveStore, at }
}

const get = async (app: Awaited<ReturnType<typeof build>>['app'], path = '/api/pnl') => {
  const response = await app.fetch(new Request(`http://admin${path}`))
  return { status: response.status, body: (await response.json()) as PnlBody }
}

/** Quote → funded at `lockupValue` → paid → claimed: the delivered send swap. */
const deliveredSend = async (
  store: SwapStore,
  at: (seconds: number) => void,
  over: { id: string; amountSats: number; lockupValue: number; quotedAt: number; settledAt: number },
) => {
  at(over.quotedAt)
  await store.insertQuote(sendQuote({ id: over.id, amountSats: over.amountSats, paymentHash: over.id.padEnd(64, '0') }))
  await store.transition(over.id, 'quoted', 'funded', {
    lockup_txid: 'cc'.repeat(32),
    lockup_vout: 0,
    lockup_value: over.lockupValue,
  })
  await store.transition(over.id, 'funded', 'paying')
  await store.transition(over.id, 'paying', 'paid', { payment_id: 'p1' })
  await store.transition(over.id, 'paid', 'claiming', { preimage: 'dd'.repeat(32) })
  at(over.settledAt)
  await store.transition(over.id, 'claiming', 'claimed', { claim_ark_txid: 'ee'.repeat(32) })
}

describe('GET /api/pnl: the Lightning send leg reads its own columns the right way round', () => {
  it('takes the LOCKUP as intake and the INVOICE as outlay — not the reverse', async () => {
    const { app, sendStore, at } = await build()
    await deliveredSend(sendStore, at, {
      id: 'send-1',
      amountSats: 100_000,
      lockupValue: 100_300,
      quotedAt: NOW - 600,
      settledAt: NOW - 300,
    })

    const { body } = await get(app)
    expect(body.summary.grossSats).toBe(300)
    expect(body.summary.volumeSats).toBe(100_300)
    expect(body.summary.marginBps).toBe(29)
  })

  it('reports a LOSS as negative rather than as an absolute number', async () => {
    const { app, sendStore, at } = await build()
    await deliveredSend(sendStore, at, {
      id: 'send-1',
      amountSats: 100_000,
      // Underfunded: the solver paid the invoice out of a smaller lockup.
      lockupValue: 99_000,
      quotedAt: NOW - 600,
      settledAt: NOW - 300,
    })

    const { body } = await get(app)
    expect(body.summary.grossSats).toBe(-1_000)
  })
})

describe('GET /api/pnl: what has not settled, and what is gone', () => {
  it('leaves an unfunded quote out of the totals and counts it open', async () => {
    const { app, sendStore, at } = await build()
    at(NOW - 120)
    await sendStore.insertQuote(sendQuote())

    const { body } = await get(app)
    expect(body.summary.grossSats).toBe(0)
    expect(body.summary.pricedCount).toBe(0)
    expect(body.summary.openCount).toBe(1)
  })

  it('reports a stuck swap’s payout as at risk, and never as profit', async () => {
    const { app, sendStore, at } = await build()
    at(NOW - 600)
    await sendStore.insertQuote(sendQuote({ amountSats: 50_151 }))
    await sendStore.transition('send-1', 'quoted', 'funded', { lockup_value: 50_300 })
    await sendStore.transition('send-1', 'funded', 'paying')
    at(NOW - 300)
    await sendStore.fail('send-1', 'paying', 'the backend went dark mid-payment')

    const { body } = await get(app)
    expect(body.summary.atRiskSats).toBe(50_151)
    expect(body.summary.grossSats).toBe(0)
    expect(body.summary.failedCount).toBe(1)
  })
})

describe('GET /api/pnl: across corridors', () => {
  it('splits the book by corridor, each reading its own columns', async () => {
    const { app, sendStore, receiveStore, at } = await build()
    await deliveredSend(sendStore, at, {
      id: 'send-1',
      amountSats: 100_000,
      lockupValue: 100_300,
      quotedAt: NOW - 600,
      settledAt: NOW - 300,
    })
    at(NOW - 500)
    await receiveStore.insertQuote(receiveQuote())
    await receiveStore.transition('recv-1', 'quoted', 'armed')
    await receiveStore.transition('recv-1', 'armed', 'funded')
    await receiveStore.transition('recv-1', 'funded', 'claimed')
    at(NOW - 200)
    await receiveStore.transition('recv-1', 'claimed', 'settled')

    const { body } = await get(app)
    const send = body.corridors.find((c) => c.corridor === 'arkade:BTC->lightning:BTC')!
    const receive = body.corridors.find((c) => c.corridor === 'lightning:BTC->arkade:BTC')!
    expect(send.grossSats).toBe(300)
    expect(receive.grossSats).toBe(200)
    expect(body.summary.grossSats).toBe(500)
  })

  it('names every corridor it measured, so a silent omission is visible', async () => {
    const { app } = await build()
    const { body } = await get(app)
    expect(body.coverage.measured).toEqual(['arkade:BTC->lightning:BTC', 'lightning:BTC->arkade:BTC'])
    expect(body.coverage.unmeasured).toEqual([])
  })

  it('states in the payload itself that the figures are gross', async () => {
    const { body } = await get((await build()).app)
    expect(body.coverage.basis).toBe('gross')
  })
})

describe('GET /api/pnl: a corridor that cannot answer', () => {
  /**
   * The capability is optional, and its absence must read as UNMEASURED. A
   * corridor quietly contributing zero to a profit total is indistinguishable
   * from one that broke even.
   */
  const mute = {
    descriptor: {
      pair: 'arkade:BTC->mute:BTC',
      envStem: 'MUTE',
      payoutRail: 'arkade',
      states: { live: ['quoted'], exposed: [], delivered: ['settled'] },
    },
    statusFor: async () => null,
    findRecoverable: async () => [],
    committedSats: async () => 0,
    page: async () => ({ swaps: [], nextCursor: null }),
    detail: async () => null,
    close: async () => {},
  }

  it('names it rather than averaging it in at nothing', async () => {
    const readers = createCorridorReaderSet([mute])
    const app = buildAdminApp({ services: { readers } as never, startedAt: 1, mode: 'serve', now: () => NOW })
    const { body } = await get(app)
    expect(body.coverage.unmeasured).toEqual(['arkade:BTC->mute:BTC'])
    expect(body.coverage.measured).toEqual([])
  })

  it('reports a corridor whose scan THREW as unmeasured, not as complete', async () => {
    const readers = createCorridorReaderSet([
      {
        ...mute,
        economics: async () => {
          throw new Error('store is gone')
        },
      },
    ])
    const app = buildAdminApp({ services: { readers } as never, startedAt: 1, mode: 'serve', now: () => NOW })
    const { status, body } = await get(app)
    expect(status).toBe(200)
    expect(body.coverage.unmeasured).toEqual(['arkade:BTC->mute:BTC'])
  })
})

describe('GET /api/pnl: the window', () => {
  it('excludes a swap that settled before the window opened', async () => {
    const { app, sendStore, at } = await build()
    await deliveredSend(sendStore, at, {
      id: 'send-1',
      amountSats: 100_000,
      lockupValue: 100_300,
      quotedAt: NOW - 10 * 86_400,
      settledAt: NOW - 9 * 86_400,
    })

    expect((await get(app, '/api/pnl?window=24h')).body.summary.grossSats).toBe(0)
    expect((await get(app, '/api/pnl?window=30d')).body.summary.grossSats).toBe(300)
  })

  it('refuses a window nobody defined rather than silently substituting the default', async () => {
    const { app } = await build()
    const response = await app.fetch(new Request('http://admin/api/pnl?window=forever'))
    expect(response.status).toBe(400)
    expect(((await response.json()) as { message: string }).message).toMatch(/unknown window/)
  })

  it('refuses a since that is not before its until', async () => {
    const { app } = await build()
    const response = await app.fetch(new Request(`http://admin/api/pnl?since=${NOW}&until=${NOW}`))
    expect(response.status).toBe(400)
  })

  it('picks a bucket width from the window, and lets a caller override it', async () => {
    const { app } = await build()
    expect((await get(app, '/api/pnl?window=1h')).body.window.bucketSeconds).toBe(300)
    expect((await get(app, '/api/pnl?window=90d')).body.window.bucketSeconds).toBe(86_400)
    expect((await get(app, '/api/pnl?window=90d&bucket=1h')).body.window.bucketSeconds).toBe(3_600)
  })

  it('refuses a bucket nobody defined', async () => {
    const { app } = await build()
    expect((await app.fetch(new Request('http://admin/api/pnl?bucket=1y'))).status).toBe(400)
  })
})

describe('GET /api/pnl/swaps', () => {
  it('hands back the rows behind the charts, newest settlement first', async () => {
    const { app, sendStore, at } = await build()
    await deliveredSend(sendStore, at, {
      id: 'send-1',
      amountSats: 100_000,
      lockupValue: 100_300,
      quotedAt: NOW - 900,
      settledAt: NOW - 800,
    })
    await deliveredSend(sendStore, at, {
      id: 'send-2',
      amountSats: 100_000,
      lockupValue: 100_400,
      quotedAt: NOW - 600,
      settledAt: NOW - 300,
    })

    const response = await app.fetch(new Request('http://admin/api/pnl/swaps'))
    const body = (await response.json()) as { records: { id: string; grossSats: number }[] }
    expect(body.records.map((r) => r.id)).toEqual(['send-2', 'send-1'])
    expect(body.records[0]!.grossSats).toBe(400)
  })

  it('refuses a corridor nobody serves', async () => {
    const { app } = await build()
    expect((await app.fetch(new Request('http://admin/api/pnl/swaps?corridor=nope'))).status).toBe(400)
  })
})
