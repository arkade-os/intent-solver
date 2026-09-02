/**
 * Which corridor answers an `rfq_status_request`.
 *
 * `rfq_status_request` carries no `pair`, so the only way to reach a row is the
 * fall-through chain. Before this, it checked the two SEND stores and stopped,
 * so a live receive swap answered "no such negotiation" — indistinguishable
 * from an rfq_id the solver never saw.
 *
 * It now falls through a `CorridorReaderSet` rather than four named stores. The
 * per-corridor payload shapes below are unchanged and are the point: routing
 * through readers must not alter a single wire answer, only widen WHICH
 * corridors can give one.
 */
import { describe, expect, it } from 'vitest'
import { respondToRfqStatus } from '@arkade-os/solver-transport/ingress/rfq.js'
import { readerSetFromDeps, type FlatCorridorDeps } from '../../src/ops/corridorSet.js'
import { createCorridorReaderSet, type CorridorReader } from '@arkade-os/solver-core/core/corridor.js'

const RFQ_ID = 'd'.repeat(64)
const HEX32 = 'a'.repeat(64)

const request = (rfqId: string = RFQ_ID) => ({ v: 1, type: 'rfq_status_request', rfq_id: rfqId })

const miss = { findByRfqId: async () => null } as never

/** A store holding exactly one row, under RFQ_ID. */
const holding = (row: Record<string, unknown>) =>
  ({ findByRfqId: async (id: string) => (id === RFQ_ID ? row : null) }) as never

/**
 * A reader set over the four built-in stores, every one a miss unless
 * overridden. Built through `readerSetFromDeps` — the same path both hosts
 * take — so these tests exercise the real adapters rather than a hand-rolled
 * stand-in that could drift from them.
 */
const readers = (over: Record<string, unknown> = {}) =>
  readerSetFromDeps({
    store: miss,
    onchainStore: miss,
    receiveStore: miss,
    onchainReceiveStore: miss,
    ...over,
  } as unknown as FlatCorridorDeps)

const sendRow = {
  state: 'claimed',
  updatedAt: 1_800_000_000,
  paymentHash: HEX32,
  lockupAddress: 'tark1send',
  claimArkTxid: null,
  refundArkTxid: null,
  failureReason: null,
  refundOutcome: null,
  receiverPkScript: null,
  preimage: null,
}

const onchainSendRow = {
  state: 'claimed',
  updatedAt: 1_800_000_001,
  paymentHash: HEX32,
  lockupAddress: 'tark1onchainsend',
  onchainAddress: 'bcrt1qsend',
  failureReason: null,
  refundOutcome: null,
  preimage: null,
}

const receiveRow = {
  state: 'funded',
  updatedAt: 1_800_000_002,
  paymentHash: HEX32,
  lockupAddress: 'tark1receive',
  refundArkTxid: null,
  failureReason: null,
  preimage: null,
}

const onchainReceiveRow = {
  state: 'funding_arkade',
  updatedAt: 1_800_000_003,
  paymentHash: HEX32,
  lockupAddress: 'tark1onchainreceive',
  onchainAddress: 'bcrt1qreceive',
  fundingTxid: null,
  arkadeClaimTxid: null,
  onchainClaimTxid: null,
  arkadeRefundTxid: null,
  failureReason: null,
  preimage: null,
}

describe('rfq status dispatch — all four corridors', () => {
  it('answers from the lightning send store', async () => {
    const outcome = await respondToRfqStatus(readers({ store: holding(sendRow) }), request())
    expect(outcome.kind).toBe('status')
    expect(outcome.payload).toMatchObject({ state: 'settled', profile: { lockup_address: 'tark1send' } })
  })

  it('answers from the onchain send store', async () => {
    const outcome = await respondToRfqStatus(readers({ onchainStore: holding(onchainSendRow) }), request())
    expect(outcome.kind).toBe('status')
    expect(outcome.payload).toMatchObject({ profile: { htlc_address: 'bcrt1qsend' } })
  })

  it('answers from the lightning receive store', async () => {
    const outcome = await respondToRfqStatus(readers({ receiveStore: holding(receiveRow) }), request())
    expect(outcome.kind).toBe('status')
    // `funded` on this leg is the solver's Arkade lockup being spent, which the
    // wire reports as filling — see lightningReceiveRfqStateFromRow.
    expect(outcome.payload).toMatchObject({ state: 'filling', profile: { lockup_address: 'tark1receive' } })
  })

  it('answers from the onchain receive store', async () => {
    const outcome = await respondToRfqStatus(readers({ onchainReceiveStore: holding(onchainReceiveRow) }), request())
    expect(outcome.kind).toBe('status')
    expect(outcome.payload).toMatchObject({ state: 'filling', profile: { htlc_address: 'bcrt1qreceive' } })
  })

  it('falls through every corridor before answering unknown', async () => {
    const outcome = await respondToRfqStatus(readers(), request())
    expect(outcome.kind).toBe('unknown')
    expect(outcome.payload).toMatchObject({ reason: 'unsupported_payload' })
  })

  /**
   * A deployment without the receive stores (src/worker.ts) must answer for the
   * corridors it does serve rather than throw into the transport. With readers
   * the absent legs are simply not registered, so there is nothing to skip.
   */
  it('skips an absent receive corridor instead of throwing', async () => {
    const set = readerSetFromDeps({ store: miss, onchainStore: holding(onchainSendRow) } as unknown as FlatCorridorDeps)
    const outcome = await respondToRfqStatus(set, request())
    expect(outcome.kind).toBe('status')
  })

  it('answers unknown when the receive corridors are absent and no send row matches', async () => {
    const set = readerSetFromDeps({ store: miss, onchainStore: miss } as unknown as FlatCorridorDeps)
    const outcome = await respondToRfqStatus(set, request())
    expect(outcome.kind).toBe('unknown')
  })

  it('rejects a malformed request before touching any corridor', async () => {
    const boom = { findByRfqId: async () => throwing() } as never
    const outcome = await respondToRfqStatus(
      readers({ store: boom, onchainStore: boom, receiveStore: boom, onchainReceiveStore: boom }),
      { v: 1, type: 'rfq_status_request', rfq_id: 'not-hex' },
    )
    expect(outcome.kind).toBe('invalid')
    expect(outcome.payload).toMatchObject({ reason: 'unsupported_payload' })
  })
})

/**
 * The gap this rewrite closed, raised in review of #215.
 *
 * A corridor registered through `CorridorSet` could be QUOTED — `respondToRfqRequest`
 * already routed through the registry — while `respondToRfqStatus` fell through
 * four hardcoded stores it could never appear in. So a client that quoted
 * against a custom corridor and then asked for status was told "no negotiation
 * with this rfq_id" about a swap that plainly existed: wrong, and actionable in
 * the wrong direction.
 */
describe('status for a corridor this build never compiled against', () => {
  const custom = (answer: Record<string, unknown> | null): CorridorReader =>
    ({
      descriptor: {
        pair: 'arkade:BTC->example:BTC',
        envStem: 'EXAMPLE',
        payoutRail: 'arkade',
        states: { live: [], exposed: [], delivered: [] },
      },
      statusFor: async (rfqId: string) => (rfqId === RFQ_ID ? answer : null),
    }) as unknown as CorridorReader

  it('answers from a plugged-in corridor', async () => {
    const outcome = await respondToRfqStatus(
      createCorridorReaderSet([custom({ v: 1, type: 'rfq_status', state: 'filling' })]),
      request(),
    )
    expect(outcome.kind).toBe('status')
    expect(outcome.payload).toMatchObject({ state: 'filling' })
  })

  it('still answers unknown for an rfq_id that corridor does not hold', async () => {
    const outcome = await respondToRfqStatus(createCorridorReaderSet([custom(null)]), request('e'.repeat(64)))
    expect(outcome.kind).toBe('unknown')
  })
})

const throwing = (): never => {
  throw new Error('no store should be reached')
}
