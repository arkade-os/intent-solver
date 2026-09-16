/**
 * The ERC20 corridors' economics, through their real readers.
 *
 * Two properties, and both are ones a stub would confirm whichever way round
 * the author guessed:
 *
 * 1. THE LEGS ARE NOT SYMMETRIC. Send takes sats and delivers a token; receive
 *    takes a token and delivers sats. A projector that copied its sibling would
 *    produce a rate that is the reciprocal of the truth.
 * 2. THE SPREAD IS NOT THE LEGS. Neither direction can subtract its two legs
 *    from one another, so both hand `economicsOf` the sats figure the store
 *    already persists — and a stuck row's loss is that same sats notional
 *    rather than a token amount nothing can add up.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EvmSendSwapStore, type EvmSendQuoteRecord } from '@arkade-os/solver-corridors-evm/db/evmSendSwaps.js'
import { EvmReceiveSwapStore, type EvmReceiveQuoteRecord } from '@arkade-os/solver-corridors-evm/db/evmReceiveSwaps.js'
import {
  evmSendReader,
  evmReceiveReader,
  evmSendDescriptor,
  evmReceiveDescriptor,
} from '@arkade-os/solver-corridors-evm/corridors/evmCorridors.js'

const NOW = 1_800_000_000
const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const OTHER_TOKEN = '0x6b175474e89094c44da98b954eedeac495271d0f'
const TOKEN_META = { address: TOKEN, symbol: 'USDC', decimals: 6 }
const WINDOW = { since: NOW - 86_400, until: NOW + 86_400, limit: 1_000 }

let clock = NOW
const at = (seconds: number): void => {
  clock = seconds
}

const sendQuote = (over: Partial<EvmSendQuoteRecord> = {}): EvmSendQuoteRecord => ({
  id: 'send-1',
  paymentHash: 'aa'.repeat(32),
  amountSats: 50_000,
  payoutSats: 49_500,
  evmAmount: '25000000',
  tokenAddress: TOKEN,
  evmContractAddress: '0x1111111111111111111111111111111111111111',
  evmChainId: 8453,
  evmTimeout: 21_000_000,
  validUntil: NOW + 60,
  minConfirmations: 5,
  minAgeSeconds: 720,
  evmClaimAddress: '0x2222222222222222222222222222222222222222',
  evmRefundAddress: '0x3333333333333333333333333333333333333333',
  refundLocktime: NOW + 90_000,
  providerPubkey: 'bb'.repeat(32),
  serverPubkey: 'cc'.repeat(32),
  claimDelay: 512,
  refundDelay: 1_024,
  refundWithoutReceiverDelay: 1_536,
  pkScript: '5120' + 'dd'.repeat(32),
  lockupAddress: 'tark1lockup',
  refundPkScript: '5120' + 'ee'.repeat(32),
  emulatorPubkey: 'ff'.repeat(32),
  clientRefundPubkey: '11'.repeat(32),
  receiverPkScript: '5120' + '22'.repeat(32),
  nonInteractiveParameters: true,
  rfqId: 'rfq-1',
  ...over,
})

const receiveQuote = (over: Partial<EvmReceiveQuoteRecord> = {}): EvmReceiveQuoteRecord => ({
  ...(sendQuote(over as Partial<EvmSendQuoteRecord>) as unknown as EvmReceiveQuoteRecord),
  payoutPubkey: '33'.repeat(32),
  ...over,
})

let sendStore: EvmSendSwapStore
let receiveStore: EvmReceiveSwapStore

beforeEach(async () => {
  clock = NOW
  sendStore = await EvmSendSwapStore.open(':memory:', () => clock)
  receiveStore = await EvmReceiveSwapStore.open(':memory:', () => clock)
})

afterEach(async () => {
  await sendStore.close()
  await receiveStore.close()
})

describe('the EVM send leg: sats in, token out', () => {
  it('books the persisted sats spread, which its two legs cannot express', async () => {
    await sendStore.insertQuote(sendQuote())
    const [record] = (await evmSendReader(evmSendDescriptor(TOKEN_META), sendStore).economics!(WINDOW)).records
    expect(record!.grossSats).toBe(500)
    expect(record!.grossBps).toBe(100)
  })

  it('carries the rate as TOKEN per SAT, the direction the trade actually ran', async () => {
    await sendStore.insertQuote(sendQuote())
    const [record] = (await evmSendReader(evmSendDescriptor(TOKEN_META), sendStore).economics!(WINDOW)).records
    expect(record!.rate).toEqual({ numerator: '25000000', denominator: '50000' })
    expect(record!.inbound.assetId).toBeNull()
    expect(record!.outbound.assetId).toBe(TOKEN)
  })

  /**
   * The sats notional, NOT the token amount. Without `exposureSats` the
   * outbound leg here is an ERC20 figure, and a loss reported in token base
   * units would either be added to a sats total as a wildly wrong number or
   * dropped as null — a stuck row reporting no loss at all.
   *
   * This store's `fail()` parks every failure as `stuck` whatever the row's
   * exposure, unlike its four BTC siblings — so this number is an upper bound
   * on the EVM family. @see evmEconomics.ts
   */
  it('reports a stuck row’s loss as the sats notional, never as a token amount', async () => {
    await sendStore.insertQuote(sendQuote())
    await sendStore.transition('send-1', 'quoted', 'funded')
    await sendStore.fail('send-1', 'funded', 'the ERC20 lock could not be claimed')
    const [record] = (await evmSendReader(evmSendDescriptor(TOKEN_META), sendStore).economics!(WINDOW)).records
    expect(record!.state).toBe('stuck')
    expect(record!.atRiskSats).toBe(49_500)
  })

  it('never reports another token’s rows as its own', async () => {
    await sendStore.insertQuote(sendQuote())
    await sendStore.insertQuote(
      sendQuote({ id: 'send-2', tokenAddress: OTHER_TOKEN, paymentHash: 'bb'.repeat(32), rfqId: 'rfq-2' }),
    )
    const ledger = await evmSendReader(evmSendDescriptor(TOKEN_META), sendStore).economics!(WINDOW)
    expect(ledger.records.map((r) => r.id)).toEqual(['send-1'])
  })
})

describe('the EVM receive leg: token in, sats out', () => {
  it('runs the legs the OTHER way round from its sibling', async () => {
    await receiveStore.insertQuote(receiveQuote())
    const [record] = (await evmReceiveReader(evmReceiveDescriptor(TOKEN_META), receiveStore).economics!(WINDOW)).records
    expect(record!.inbound.assetId).toBe(TOKEN)
    expect(record!.outbound.assetId).toBeNull()
    expect(record!.rate).toEqual({ numerator: '49500', denominator: '25000000' })
  })

  it('books the same persisted sats spread, and refuses to call it a basis point of a token intake', async () => {
    await receiveStore.insertQuote(receiveQuote())
    const [record] = (await evmReceiveReader(evmReceiveDescriptor(TOKEN_META), receiveStore).economics!(WINDOW)).records
    expect(record!.grossSats).toBe(500)
    expect(record!.grossBps).toBeNull()
  })
})

describe('the ledger window', () => {
  it('excludes a row whose last movement fell outside it', async () => {
    at(NOW - 10 * 86_400)
    await sendStore.insertQuote(sendQuote())
    const ledger = await evmSendReader(evmSendDescriptor(TOKEN_META), sendStore).economics!(WINDOW)
    expect(ledger.records).toHaveLength(0)
  })

  it('says so when the cap bit, rather than presenting part of the book as all of it', async () => {
    for (const index of [0, 1, 2]) {
      await sendStore.insertQuote(
        sendQuote({ id: `send-${index}`, paymentHash: String(index).repeat(64).slice(0, 64), rfqId: `rfq-${index}` }),
      )
    }
    const ledger = await evmSendReader(evmSendDescriptor(TOKEN_META), sendStore).economics!({ ...WINDOW, limit: 2 })
    expect(ledger.records).toHaveLength(2)
    expect(ledger.truncated).toBe(true)
  })
})
