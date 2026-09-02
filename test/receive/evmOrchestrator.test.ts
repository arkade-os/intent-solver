/**
 * The receive shell's two crash orderings. Different money from the send leg's.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  EvmReceiveSwapService,
  type EvmReceiveServiceDeps,
} from '@arkade-os/solver-corridors-evm/receive/evmOrchestrator.js'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { EvmReceiveSwapStore, type EvmReceiveQuoteRecord } from '@arkade-os/solver-corridors-evm/db/evmReceiveSwaps.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'

const NOW = 1_800_000_000
const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

const quote = (over: Partial<EvmReceiveQuoteRecord> = {}): EvmReceiveQuoteRecord => ({
  id: 'swap-1',
  paymentHash: 'aa'.repeat(32),
  amountSats: 50_000,
  payoutSats: 49_500,
  evmAmount: '1000000',
  tokenAddress: TOKEN,
  evmContractAddress: '0x1111111111111111111111111111111111111111',
  evmChainId: 8453,
  evmTimeout: 21_000_000,
  validUntil: NOW + 60,
  minConfirmations: 1,
  minAgeSeconds: 0,
  evmClaimAddress: '0x2222222222222222222222222222222222222222',
  evmRefundAddress: '0x3333333333333333333333333333333333333333',
  refundLocktime: NOW + 86_400,
  providerPubkey: 'bb'.repeat(32),
  serverPubkey: 'cc'.repeat(32),
  claimDelay: 512,
  refundDelay: 1024,
  refundWithoutReceiverDelay: 1536,
  pkScript: '5120' + 'dd'.repeat(32),
  lockupAddress: 'tark1lockup',
  refundPkScript: '5120' + 'ee'.repeat(32),
  emulatorPubkey: 'ff'.repeat(32),
  clientRefundPubkey: '11'.repeat(32),
  receiverPkScript: '5120' + '22'.repeat(32),
  nonInteractiveParameters: true,
  payoutPubkey: '33'.repeat(32),
  rfqId: 'rfq-1',
  ...over,
})

const evmFake = () =>
  ({
    isLocked: vi.fn().mockResolvedValue(true),
    findClaimPreimage: vi.fn().mockResolvedValue(null),

    isLockedAt: vi.fn().mockResolvedValue(true),
    blockTimestampAt: vi.fn().mockResolvedValue(0),
    claimCall: vi.fn().mockReturnValue({ to: new Uint8Array(20), data: new Uint8Array(4) }),
    lockCall: vi.fn(),
    refundCall: vi.fn(),
    lockPrepayCall: vi.fn(),
  }) as unknown as EvmReceiveServiceDeps['evm']

const build = async (over: Partial<EvmReceiveServiceDeps> = {}) => {
  const store = await EvmReceiveSwapStore.open(betterSqliteDriver(':memory:'), () => NOW)
  await store.insertQuote(quote())
  const deps: EvmReceiveServiceDeps = {
    store,
    evm: evmFake(),
    broadcast: vi.fn().mockResolvedValue('0xclaimtx'),
    fundArkade: vi.fn().mockResolvedValue('ark-fund-txid'),
    refundArkade: vi.fn().mockResolvedValue('ark-refund-txid'),
    arkadeLockupFunded: vi.fn().mockResolvedValue(false),
    arkadePreimage: vi.fn().mockResolvedValue(null),
    lockFor: vi.fn().mockReturnValue({}) as unknown as EvmReceiveServiceDeps['lockFor'],
    blockHeight: vi.fn().mockResolvedValue(20_000_000),
    // Quote-time deps. Every test here drives `tick`, which reads none of them;
    // they are inert on purpose, so a tick test that started depending on one
    // would fail rather than pick up a plausible default.
    arkade: {
      solverPubkey: 'aa'.repeat(32),
      serverPubkey: 'bb'.repeat(32),
      emulatorPubkey: 'ff'.repeat(32),
      solverRefundPkScript: '5120' + '22'.repeat(32),
      hrp: 'tark',
      delays: {
        unilateralClaimDelay: 169 * 512,
        unilateralRefundDelay: 169 * 512,
        unilateralRefundWithoutReceiverDelay: 169 * 512,
      },
    } as unknown as EvmReceiveServiceDeps['arkade'],
    markets: new Map(),
    fetchPrice: vi.fn().mockRejectedValue(new Error('no price in a tick test')),
    evmClaimAddress: '0x' + '99'.repeat(20),
    chain: {
      contractAddress: '0x' + 'de'.repeat(20),
      chainId: 8453,
      minConfirmations: 12,
      minAgeSeconds: 780,
      cadence: { fastestSecondsPerBlock: 12, slowestSecondsPerBlock: 15 },
      quoteValiditySeconds: 60,
    },
    maxExposedSats: 100_000_000,
    admission: new AdmissionControl(),
    totalCommitted: vi.fn().mockResolvedValue(0),
    now: () => NOW,
    ...over,
  }
  return { store, deps, service: new EvmReceiveSwapService(deps) }
}

describe('the row is exposed BEFORE the sats go out', () => {
  it('is already funding_arkade by the time fundArkade is called', async () => {
    // A crash between the two must not leave a funded lockup against a row that
    // still reads `locked` - it would be invisible to both the exposure
    // accounting and the refund sweep.
    let stateAtFund: string | null = null
    const { store, service } = await build({
      fundArkade: vi.fn().mockImplementation(async () => {
        stateAtFund = (await store.get('swap-1')).state
        return 'ark-fund-txid'
      }),
    })
    await service.tick('swap-1')
    expect(stateAtFund).toBe('funding_arkade')
    expect((await store.get('swap-1')).fundArkTxid).toBe('ark-fund-txid')
  })
})

describe('the preimage is persisted BEFORE the ERC20 claim', () => {
  it('has it on disk by the time the claim is broadcast', async () => {
    // On this leg the preimage is the solver's ONLY means of payment: the sats
    // have already gone out, so losing it costs the swap's whole value.
    let preimageAtBroadcast: string | null = null
    const { store, service } = await build({
      arkadeLockupFunded: vi.fn().mockResolvedValue(true),
      arkadePreimage: vi.fn().mockResolvedValue('ab'.repeat(32)),
      broadcast: vi.fn().mockImplementation(async () => {
        preimageAtBroadcast = (await store.get('swap-1')).preimage
        return '0xclaimtx'
      }),
    })
    await store.transition('swap-1', 'quoted', 'awaiting_lock')
    await store.transition('swap-1', 'awaiting_lock', 'locked')
    await store.transition('swap-1', 'locked', 'funding_arkade')
    await store.transition('swap-1', 'funding_arkade', 'awaiting_claim')
    await service.tick('swap-1')
    expect(preimageAtBroadcast).toBe('ab'.repeat(32))
    const row = await store.get('swap-1')
    expect(row.state).toBe('claimed')
    expect(row.evmClaimTxid).toBe('0xclaimtx')
  })
})

describe('the unclaimed path', () => {
  it('refunds the solver own sats and records the txid', async () => {
    const { store, service } = await build({
      arkadeLockupFunded: vi.fn().mockResolvedValue(true),
      now: () => NOW + 86_400,
    })
    await store.transition('swap-1', 'quoted', 'awaiting_lock')
    await store.transition('swap-1', 'awaiting_lock', 'locked')
    await store.transition('swap-1', 'locked', 'funding_arkade')
    await store.transition('swap-1', 'funding_arkade', 'awaiting_claim')
    await service.tick('swap-1')
    const row = await store.get('swap-1')
    expect(row.state).toBe('refunded')
    expect(row.refundArkTxid).toBe('ark-refund-txid')
  })
})

/**
 * The depth gate is the only thing between a client's lock and the solver's own
 * sats on this leg, and it was a no-op: `observe()` fed the row's own
 * `minConfirmations` back as the observation, so the planner's
 * `>= minConfirmations` check passed the instant any block carried the lock.
 *
 * The loss it opened: client locks → the solver funds the Arkade lockup at
 * depth one → the client reorgs the lock away → the client claims the sats →
 * the solver's token claim finds nothing to claim.
 */
describe('the client lock must be BURIED before the sats go out', () => {
  it('does not fund while the lock is not deep enough', async () => {
    // `isLockedAt` false = the lock was NOT there `minConfirmations` blocks ago.
    const fundArkade = vi.fn()
    const { store, service } = await build({
      evm: {
        isLocked: vi.fn().mockResolvedValue(true),
        isLockedAt: vi.fn().mockResolvedValue(false),
        blockTimestampAt: vi.fn().mockResolvedValue(0),
        findClaimPreimage: vi.fn().mockResolvedValue(null),
        allowance: vi.fn().mockResolvedValue(0n),
        lockCalls: vi.fn().mockReturnValue([]),
        claimCall: vi.fn().mockReturnValue({ to: new Uint8Array(20), data: new Uint8Array() }),
        refundCall: vi.fn().mockReturnValue({ to: new Uint8Array(20), data: new Uint8Array() }),
      } as never,
      fundArkade,
    })
    await store.insertQuote(
      quote({ id: 'deep', paymentHash: 'cc'.repeat(32), minConfirmations: 12, rfqId: 'rfq-deep' }),
    )
    await service.tick('deep')
    expect(fundArkade).not.toHaveBeenCalled()
  })

  it('asks about the lock at the depth the operator configured, not at the tip', async () => {
    // The probe height IS the policy: tip - minConfirmations + 1. Asking at the
    // tip would answer the question `isLocked` already answers.
    const isLockedAt = vi.fn().mockResolvedValue(true)
    const { store, service } = await build({
      evm: {
        isLocked: vi.fn().mockResolvedValue(true),
        isLockedAt,
        blockTimestampAt: vi.fn().mockResolvedValue(0),
        findClaimPreimage: vi.fn().mockResolvedValue(null),
        allowance: vi.fn().mockResolvedValue(0n),
        lockCalls: vi.fn().mockReturnValue([]),
        claimCall: vi.fn().mockReturnValue({ to: new Uint8Array(20), data: new Uint8Array() }),
        refundCall: vi.fn().mockReturnValue({ to: new Uint8Array(20), data: new Uint8Array() }),
      } as never,
    })
    await store.insertQuote(
      quote({ id: 'deep', paymentHash: 'cc'.repeat(32), minConfirmations: 12, rfqId: 'rfq-deep' }),
    )
    await service.tick('deep')
    // 12 deep, so the probe is 11 blocks BEHIND the tip — asking at the tip
    // would be a different question, and the one isLocked already answers.
    const [, askedAt] = isLockedAt.mock.calls[0] ?? []
    expect(askedAt).toBe(20_000_000n - 12n + 1n)
  })
})

/**
 * The `row.state !== 'claiming'` guard around the preimage-persist transition
 * is NOT dead code, though it reads like it.
 *
 * `planEvmReceive` returns `claim_evm` from its preimage check, which runs
 * BEFORE the state switch — so once a preimage exists the planner re-emits it
 * on every tick regardless of what state the row is in. On a retry the row is
 * already `claiming`, and this store's `transition()` is a compare-and-swap
 * with no legal-edge table, so `claiming -> claiming` would succeed rather than
 * throw.
 *
 * What it would cost is the state trail: `transition()` writes a
 * `receive_evm_swap_event` row on every call, so a claim that retried fifty
 * times would bury its real history under fifty identical entries — in the
 * table `history()` exists to read.
 */
describe('a retried claim does not rewrite the state trail', () => {
  it('records claiming ONCE however many times the claim is retried', async () => {
    const { store, service } = await build({
      arkadeLockupFunded: vi.fn().mockResolvedValue(true),
      arkadePreimage: vi.fn().mockResolvedValue('ab'.repeat(32)),
      broadcast: vi.fn().mockRejectedValue(new Error('rpc down')),
      onTickError: () => {},
    })
    await store.transition('swap-1', 'quoted', 'awaiting_lock')
    await store.transition('swap-1', 'awaiting_lock', 'locked')
    await store.transition('swap-1', 'locked', 'funding_arkade')
    await store.transition('swap-1', 'funding_arkade', 'awaiting_claim')

    // Three ticks, each failing at the broadcast so the row stays in claiming.
    for (let i = 0; i < 3; i++) await service.tick('swap-1').catch(() => {})

    const entered = (await store.history('swap-1')).filter((h) => h.to === 'claiming')
    expect(entered).toHaveLength(1)
    expect((await store.get('swap-1')).state).toBe('claiming')
  })
})
