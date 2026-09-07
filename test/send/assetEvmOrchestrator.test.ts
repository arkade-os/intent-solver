/**
 * The orderings the shell owns, on the corridor with no BTC leg.
 *
 * `planEvmSend` decides WHAT to do and is unit-tested on its own; this file is
 * about the order in which the row and the world are changed, because a crash
 * between the two halves must not lose money. Reused unchanged from the sats
 * leg, so the point of asserting it again here is that this orchestrator is a
 * second copy of the shell — the planner's tests cannot see a step that records
 * after it acts.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  AssetEvmSendSwapService,
  type AssetEvmSendServiceDeps,
} from '@arkade-os/solver-corridors-evm/send/assetEvmOrchestrator.js'
import {
  AssetEvmSendSwapStore,
  type AssetEvmSendQuoteRecord,
} from '@arkade-os/solver-corridors-evm/db/assetEvmSendSwaps.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'

const NOW = 1_800_000_000
const ASSET = '11'.repeat(32) + '0000'
const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

const quote = (): AssetEvmSendQuoteRecord => ({
  id: 'swap-1',
  paymentHash: 'aa'.repeat(32),
  assetId: ASSET,
  assetDecimals: 8,
  assetUnits: '1000000',
  payoutUnits: '990000',
  evmAmount: '9900',
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
  rfqId: 'rfq-1',
})

/** The two calls a lock costs, told apart by their real selectors. */
const APPROVE_CALL = { to: new Uint8Array(20), data: Uint8Array.of(0x09, 0x5e, 0xa7, 0xb3) }
const LOCK_CALL = { to: new Uint8Array(20), data: Uint8Array.of(0xcd, 0x41, 0x30, 0x44) }

const build = async (over: Partial<AssetEvmSendServiceDeps> = {}) => {
  const store = await AssetEvmSendSwapStore.open(betterSqliteDriver(':memory:'), () => NOW)
  await store.insertQuote(quote())
  const deps: AssetEvmSendServiceDeps = {
    store,
    evm: {
      isLocked: vi.fn().mockResolvedValue(false),
      findClaimPreimage: vi.fn().mockResolvedValue(null),
      findRefund: vi.fn().mockResolvedValue(false),
      isLockedAt: vi.fn().mockResolvedValue(true),
      blockTimestampAt: vi.fn().mockResolvedValue(0),
      transactionOutcome: vi.fn().mockResolvedValue('pending'),
      allowance: vi.fn().mockResolvedValue(0n),
      lockCalls: vi.fn().mockReturnValue([APPROVE_CALL, LOCK_CALL]),
      refundCall: vi.fn().mockReturnValue({ to: new Uint8Array(20), data: new Uint8Array(4) }),
    } as unknown as AssetEvmSendServiceDeps['evm'],
    broadcast: vi.fn().mockResolvedValue('0xtx'),
    arkadeLockupFunded: vi.fn().mockResolvedValue(true),
    claimArkade: vi.fn().mockResolvedValue('ark-txid'),
    lockFor: vi.fn().mockReturnValue({}) as unknown as AssetEvmSendServiceDeps['lockFor'],
    blockHeight: vi.fn().mockResolvedValue(20_000_000),
    solverEvmAddress: new Uint8Array(20).fill(0x42),
    // Quote-time deps. No test here calls `quote`, so these are deliberately
    // inert: one that started reading a plausible default would pass wrongly.
    arkade: {
      providerPubkey: 'aa'.repeat(32),
      serverPubkey: 'bb'.repeat(32),
      emulatorPubkey: 'ff'.repeat(32),
      receiverPkScript: '5120' + '22'.repeat(32),
      hrp: 'tark',
      delays: {
        unilateralClaimDelay: 86_528,
        unilateralRefundDelay: 86_528,
        unilateralRefundWithoutReceiverDelay: 86_528,
      },
    } as unknown as AssetEvmSendServiceDeps['arkade'],
    markets: new Map(),
    fetchPrice: vi.fn().mockRejectedValue(new Error('no price in a tick test')),
    chain: {
      contractAddress: '0x' + 'de'.repeat(20),
      chainId: 8453,
      minConfirmations: 12,
      minAgeSeconds: 780,
      cadence: { fastestSecondsPerBlock: 12, slowestSecondsPerBlock: 15 },
      quoteValiditySeconds: 60,
    },
    now: () => NOW,
    ...over,
  }
  return { store, deps, service: new AssetEvmSendSwapService(deps) }
}

describe('the row enters the exposed state BEFORE the lock is broadcast', () => {
  it('is already locking_evm by the time the FIRST call goes out', async () => {
    // A crash between the two must leave a row claiming to be locking and no
    // lock, never a lock nobody knows about against a row still reading funded.
    let stateAtFirst: string | null = null
    const { store, service } = await build({
      broadcast: vi.fn().mockImplementation(async () => {
        stateAtFirst ??= (await store.get('swap-1')).state
        return '0xtx'
      }),
    })
    await service.tick('swap-1')
    expect(stateAtFirst).toBe('locking_evm')
  })

  it('records the lock txid without writing a bogus state change', async () => {
    const { store, service } = await build()
    await service.tick('swap-1')
    expect((await store.get('swap-1')).evmLockTxid).toBe('0xtx')
    expect((await store.history('swap-1')).map((e) => e.to)).toEqual(['quoted', 'locking_evm'])
  })
})

describe('the lock is approved before it is broadcast', () => {
  const txidOf = (call: { data: Uint8Array }) => `0x${call.data[0]!.toString(16)}`
  const broadcastPerCall = () => vi.fn().mockImplementation(async (call: { data: Uint8Array }) => txidOf(call))

  it('broadcasts every call lockCalls asks for, approval first', async () => {
    // Without a standing allowance `lock` reverts on `transferFrom`, and the
    // planner cannot tell a revert from a lock that has not landed.
    const broadcast = broadcastPerCall()
    const { service } = await build({ broadcast })
    await service.tick('swap-1')
    expect(broadcast.mock.calls.map(([call]) => call)).toEqual([APPROVE_CALL, LOCK_CALL])
  })

  it('records the LOCK txid, not the approval`s', async () => {
    const { store, service } = await build({ broadcast: broadcastPerCall() })
    await service.tick('swap-1')
    expect((await store.get('swap-1')).evmLockTxid).toBe(txidOf(LOCK_CALL))
  })

  it('reads the allowance for the token being locked, held by the SOLVER', async () => {
    // Both arguments are untyped 20-byte values, and either one wrong reads a
    // reliable zero — which looks like "no allowance" and survives every happy
    // path at the cost of one extra transaction.
    const allowance = vi.fn().mockResolvedValue(0n)
    const token = Uint8Array.from({ length: 20 }, (_, i) => i)
    const { service } = await build({
      evm: {
        isLocked: vi.fn().mockResolvedValue(false),
        findClaimPreimage: vi.fn().mockResolvedValue(null),
        isLockedAt: vi.fn().mockResolvedValue(true),
        blockTimestampAt: vi.fn().mockResolvedValue(0),
        transactionOutcome: vi.fn().mockResolvedValue('pending'),
        allowance,
        lockCalls: vi.fn().mockReturnValue([LOCK_CALL]),
      } as unknown as AssetEvmSendServiceDeps['evm'],
      lockFor: vi.fn().mockReturnValue({ tokenAddress: token, amount: 9_900n }) as never,
    })
    await service.tick('swap-1')
    expect(allowance).toHaveBeenCalledWith(token, new Uint8Array(20).fill(0x42))
  })

  it('hands lockCalls the allowance it actually read', async () => {
    const lockCalls = vi.fn().mockReturnValue([LOCK_CALL])
    const lock = { tokenAddress: new Uint8Array(20), amount: 9_900n }
    const { service } = await build({
      evm: {
        isLocked: vi.fn().mockResolvedValue(false),
        findClaimPreimage: vi.fn().mockResolvedValue(null),
        isLockedAt: vi.fn().mockResolvedValue(true),
        blockTimestampAt: vi.fn().mockResolvedValue(0),
        transactionOutcome: vi.fn().mockResolvedValue('pending'),
        allowance: vi.fn().mockResolvedValue(999n),
        lockCalls,
      } as unknown as AssetEvmSendServiceDeps['evm'],
      lockFor: vi.fn().mockReturnValue(lock) as never,
    })
    await service.tick('swap-1')
    expect(lockCalls).toHaveBeenCalledWith(lock, 999n)
  })

  it('refuses to record an empty lock id when lockCalls returns nothing', async () => {
    // The row is already `locking_evm` by then, so a silent empty txid would
    // leave it exposed while naming a transaction that does not exist.
    const broadcast = vi.fn()
    const { store, service } = await build({
      evm: {
        isLocked: vi.fn().mockResolvedValue(false),
        isLockedAt: vi.fn().mockResolvedValue(true),
        blockTimestampAt: vi.fn().mockResolvedValue(0),
        findClaimPreimage: vi.fn().mockResolvedValue(null),
        allowance: vi.fn().mockResolvedValue(0n),
        lockCalls: vi.fn().mockReturnValue([]),
      } as never,
      broadcast,
    })
    await store.transition('swap-1', 'quoted', 'funded')
    await expect(service.tick('swap-1')).rejects.toThrow(/the lock call is never optional/)
    expect(broadcast).not.toHaveBeenCalled()
    expect((await store.get('swap-1')).evmLockTxid).toBeNull()
  })
})

describe('the solver`s own lock must be BURIED before the swap advances', () => {
  const deepBuild = async (isLockedAt: boolean) =>
    build({
      evm: {
        isLocked: vi.fn().mockResolvedValue(true),
        isLockedAt: vi.fn().mockResolvedValue(isLockedAt),
        blockTimestampAt: vi.fn().mockResolvedValue(0),
        findClaimPreimage: vi.fn().mockResolvedValue(null),
        allowance: vi.fn().mockResolvedValue(0n),
        lockCalls: vi.fn().mockReturnValue([]),
      } as never,
    })

  it.each([
    ['does not advance while the lock is not proven deep', false, 'locking_evm'],
    ['advances once the lock is proven that deep', true, 'awaiting_claim'],
  ])('%s', async (_why, provenAt, expected) => {
    const { store, service } = await deepBuild(provenAt as boolean)
    await store.transition('swap-1', 'quoted', 'funded')
    await store.transition('swap-1', 'funded', 'locking_evm')
    await service.tick('swap-1')
    expect((await store.get('swap-1')).state).toBe(expected)
  })
})

describe('the preimage is found AFTER the lock is gone', () => {
  const claimed = Uint8Array.from(Buffer.from('cd'.repeat(32), 'hex'))

  it('scans for the Claim even though isLocked is false', async () => {
    // The contract deletes its flag on claim, so `isLocked` is false from the
    // instant a Claim event exists. Gating the scan on presence closes the only
    // window in which the preimage can ever be read, and the client ends up
    // with both sides.
    const findClaimPreimage = vi.fn().mockResolvedValue(claimed)
    const { store, service } = await build({
      evm: {
        isLocked: vi.fn().mockResolvedValue(false),
        findClaimPreimage,
        isLockedAt: vi.fn().mockResolvedValue(false),
        blockTimestampAt: vi.fn().mockResolvedValue(0),
        refundCall: vi.fn().mockReturnValue({ to: new Uint8Array(20), data: new Uint8Array(4) }),
      } as never,
    })
    await store.transition('swap-1', 'quoted', 'locking_evm', { evm_lock_txid: '0xtx' })
    await store.transition('swap-1', 'locking_evm', 'awaiting_claim')

    await service.tick('swap-1')
    expect(findClaimPreimage, 'never scanned: the lock was already gone').toHaveBeenCalled()
    expect((await store.get('swap-1')).preimage).toBe('cd'.repeat(32))
  })

  it('does not scan before the row has entered an exposed state', async () => {
    const findClaimPreimage = vi.fn().mockResolvedValue(null)
    const { service } = await build({
      evm: {
        isLocked: vi.fn().mockResolvedValue(false),
        findClaimPreimage,
        isLockedAt: vi.fn().mockResolvedValue(false),
        blockTimestampAt: vi.fn().mockResolvedValue(0),
        allowance: vi.fn().mockResolvedValue(0n),
        lockCalls: vi.fn().mockReturnValue([LOCK_CALL]),
      } as never,
      arkadeLockupFunded: vi.fn().mockResolvedValue(false),
    })
    await service.tick('swap-1')
    expect(findClaimPreimage).not.toHaveBeenCalled()
  })

  it('still reaches the EVM refund when the node refuses the scan', async () => {
    // Unhandled, the rejection leaves `observe` before the planner runs, so the
    // row reaches neither `claim_arkade` nor the expensive one, `refund_evm`.
    const errors: unknown[] = []
    const { store, service } = await build({
      evm: {
        isLocked: vi.fn().mockResolvedValue(true),
        findClaimPreimage: vi.fn().mockRejectedValue(new Error('query returned more than 10000 results')),
        isLockedAt: vi.fn().mockResolvedValue(true),
        blockTimestampAt: vi.fn().mockResolvedValue(0),
        refundCall: vi.fn().mockReturnValue({ to: new Uint8Array(20), data: new Uint8Array(4) }),
      } as never,
      blockHeight: vi.fn().mockResolvedValue(21_000_000),
      broadcast: vi.fn().mockResolvedValue('0xrefund'),
      onTickError: (_id, error) => void errors.push(error),
    })
    await store.transition('swap-1', 'quoted', 'locking_evm', { evm_lock_txid: '0xtx' })
    await store.transition('swap-1', 'locking_evm', 'awaiting_claim')

    await service.tick('swap-1')
    const row = await store.get('swap-1')
    expect(row.state, 'the failed scan aborted the tick and stranded the lock').toBe('refunding_evm')
    expect(row.evmRefundTxid).toBe('0xrefund')
    expect(errors, 'the scan failure never reached the operator log').toHaveLength(1)
  })
})

describe('the preimage is persisted BEFORE the Arkade claim is attempted', () => {
  it('has the preimage on disk by the time claimArkade runs', async () => {
    // It is the money. A crash after claiming but before recording it loses the
    // one secret that makes the asset lockup spendable.
    let preimageAtClaim: string | null = null
    const { store, service } = await build({
      evm: {
        isLocked: vi.fn().mockResolvedValue(true),
        findClaimPreimage: vi.fn().mockResolvedValue(Uint8Array.from(Buffer.from('ab'.repeat(32), 'hex'))),
        isLockedAt: vi.fn().mockResolvedValue(true),
        blockTimestampAt: vi.fn().mockResolvedValue(0),
      } as never,
      claimArkade: vi.fn().mockImplementation(async () => {
        preimageAtClaim = (await store.get('swap-1')).preimage
        return 'ark-txid'
      }),
    })
    await store.transition('swap-1', 'quoted', 'locking_evm', { evm_lock_txid: '0xtx' })
    await store.transition('swap-1', 'locking_evm', 'awaiting_claim')
    await service.tick('swap-1')
    expect(preimageAtClaim).toBe('ab'.repeat(32))
    expect((await store.get('swap-1')).state).toBe('claimed')
  })

  it('claims the row as it stands on disk, not the one the tick started with', async () => {
    // `claimArkade` rebuilds the covenant from the row it is handed. Passing the
    // pre-transition copy would hand it one whose `preimage` is still null.
    const seen: (string | null)[] = []
    const { store, service } = await build({
      evm: {
        isLocked: vi.fn().mockResolvedValue(true),
        findClaimPreimage: vi.fn().mockResolvedValue(Uint8Array.from(Buffer.from('ab'.repeat(32), 'hex'))),
        isLockedAt: vi.fn().mockResolvedValue(true),
        blockTimestampAt: vi.fn().mockResolvedValue(0),
      } as never,
      claimArkade: vi.fn().mockImplementation(async (row: { preimage: string | null }) => {
        seen.push(row.preimage)
        return 'ark-txid'
      }),
    })
    await store.transition('swap-1', 'quoted', 'locking_evm', { evm_lock_txid: '0xtx' })
    await store.transition('swap-1', 'locking_evm', 'awaiting_claim')
    await service.tick('swap-1')
    expect(seen).toEqual(['ab'.repeat(32)])
  })
})

describe('a lock transaction that reverted is not a lock that has not landed', () => {
  const revertedRow = async (over: Partial<AssetEvmSendServiceDeps> = {}) => {
    const built = await build({
      evm: {
        isLocked: vi.fn().mockResolvedValue(false),
        isLockedAt: vi.fn().mockResolvedValue(false),
        blockTimestampAt: vi.fn().mockResolvedValue(0),
        findClaimPreimage: vi.fn().mockResolvedValue(null),
        transactionOutcome: vi.fn().mockResolvedValue('reverted'),
        refundCall: vi.fn().mockReturnValue({ to: new Uint8Array(20), data: new Uint8Array(4) }),
      } as never,
      ...over,
    })
    await built.store.transition('swap-1', 'quoted', 'locking_evm', { evm_lock_txid: '0xlock' })
    return built
  }

  it('stops on the revert instead of waiting out evmTimeout', async () => {
    const { store, service } = await revertedRow()
    await service.tick('swap-1')
    const row = await store.get('swap-1')
    expect(row.state).toBe('stuck')
    expect(row.failureReason).toMatch(/revert/i)
  })

  it('reads the receipt for the txid the row recorded', async () => {
    const transactionOutcome = vi.fn().mockResolvedValue('reverted')
    const { service } = await revertedRow({
      evm: {
        isLocked: vi.fn().mockResolvedValue(false),
        isLockedAt: vi.fn().mockResolvedValue(false),
        blockTimestampAt: vi.fn().mockResolvedValue(0),
        findClaimPreimage: vi.fn().mockResolvedValue(null),
        transactionOutcome,
      } as never,
    })
    await service.tick('swap-1')
    expect(transactionOutcome).toHaveBeenCalledWith('0xlock')
  })

  it('never broadcasts a refund for a lock that was never created', async () => {
    const broadcast = vi.fn().mockResolvedValue('0xrefund')
    const { store, service } = await revertedRow({
      broadcast,
      blockHeight: vi.fn().mockResolvedValue(21_000_000),
    })
    await service.tick('swap-1')
    expect(broadcast).not.toHaveBeenCalled()
    expect((await store.get('swap-1')).evmRefundTxid).toBeNull()
  })

  it('treats a receipt the node refuses to serve as no answer, not as a revert', async () => {
    const errors: unknown[] = []
    const { store, service } = await revertedRow({
      evm: {
        isLocked: vi.fn().mockResolvedValue(false),
        isLockedAt: vi.fn().mockResolvedValue(false),
        blockTimestampAt: vi.fn().mockResolvedValue(0),
        findClaimPreimage: vi.fn().mockResolvedValue(null),
        transactionOutcome: vi.fn().mockRejectedValue(new Error('rpc down')),
      } as never,
      onTickError: (_id, error) => void errors.push(error),
    })
    await service.tick('swap-1')
    expect((await store.get('swap-1')).state).toBe('locking_evm')
    expect(errors, 'the failed receipt read never reached the operator log').toHaveLength(1)
  })

  it('does not read a receipt it has no txid for', async () => {
    const transactionOutcome = vi.fn().mockResolvedValue('reverted')
    const { store, service } = await build({
      evm: {
        isLocked: vi.fn().mockResolvedValue(false),
        isLockedAt: vi.fn().mockResolvedValue(false),
        blockTimestampAt: vi.fn().mockResolvedValue(0),
        findClaimPreimage: vi.fn().mockResolvedValue(null),
        transactionOutcome,
      } as never,
    })
    await store.transition('swap-1', 'quoted', 'locking_evm')
    await service.tick('swap-1')
    expect(transactionOutcome).not.toHaveBeenCalled()
    expect((await store.get('swap-1')).state).toBe('locking_evm')
  })
})

describe('a refund that was broadcast is not a refund that landed', () => {
  const REFUND_TXID = '0xrefund'

  /** A row at `awaiting_claim` with the timeout matured — one tick from `refund_evm`. */
  const dueForRefund = async (evm: Record<string, unknown>, over: Partial<AssetEvmSendServiceDeps> = {}) => {
    const built = await build({
      evm: {
        isLockedAt: vi.fn().mockResolvedValue(true),
        blockTimestampAt: vi.fn().mockResolvedValue(0),
        findClaimPreimage: vi.fn().mockResolvedValue(null),
        findRefund: vi.fn().mockResolvedValue(false),
        refundCall: vi.fn().mockReturnValue({ to: new Uint8Array(20), data: new Uint8Array(4) }),
        ...evm,
      } as never,
      blockHeight: vi.fn().mockResolvedValue(21_000_000),
      broadcast: vi.fn().mockResolvedValue(REFUND_TXID),
      ...over,
    })
    await built.store.transition('swap-1', 'quoted', 'locking_evm', { evm_lock_txid: '0xlock' })
    await built.store.transition('swap-1', 'locking_evm', 'awaiting_claim')
    return built
  }

  it('is already refunding_evm by the time the refund is broadcast', async () => {
    let stateAtBroadcast: string | null = null
    const built = await dueForRefund({
      isLocked: vi.fn().mockResolvedValue(true),
      transactionOutcome: vi.fn().mockResolvedValue('pending'),
    })
    built.deps.broadcast = vi.fn(async () => {
      stateAtBroadcast = (await built.store.get('swap-1')).state
      return REFUND_TXID
    })
    await built.service.tick('swap-1')
    expect(stateAtBroadcast).toBe('refunding_evm')
  })

  it('records the txid without closing the books', async () => {
    // Terminal is what makes it unrecoverable: the sweep stops returning the
    // row, so a later revert is never noticed.
    const { store, service } = await dueForRefund({
      isLocked: vi.fn().mockResolvedValue(true),
      transactionOutcome: vi.fn().mockResolvedValue('pending'),
    })
    await service.tick('swap-1')
    const row = await store.get('swap-1')
    expect(row.state).toBe('refunding_evm')
    expect(row.evmRefundTxid).toBe(REFUND_TXID)
    expect((await store.findLive()).map((r) => r.id)).toContain('swap-1')
  })

  it('reaches `refunded` only once the receipt says the refund mined', async () => {
    const transactionOutcome = vi.fn().mockResolvedValue('pending')
    const { store, service } = await dueForRefund({
      isLocked: vi.fn().mockResolvedValue(true),
      transactionOutcome,
    })
    await service.tick('swap-1')
    transactionOutcome.mockResolvedValue('success')
    await service.tick('swap-1')
    expect(transactionOutcome).toHaveBeenCalledWith(REFUND_TXID)
    expect((await store.get('swap-1')).state).toBe('refunded')
  })

  it('never says `refunded` when the client claimed the tokens instead', async () => {
    const transactionOutcome = vi.fn().mockResolvedValue('pending')
    const findClaimPreimage = vi.fn().mockResolvedValue(null)
    const { store, service } = await dueForRefund({
      isLocked: vi.fn().mockResolvedValue(true),
      findClaimPreimage,
      transactionOutcome,
    })
    await service.tick('swap-1')
    transactionOutcome.mockResolvedValue('reverted')
    findClaimPreimage.mockResolvedValue(Uint8Array.from(Buffer.from('cd'.repeat(32), 'hex')))
    await service.tick('swap-1')
    const row = await store.get('swap-1')
    expect(row.state, 'the reverted refund was recorded as money returned').toBe('claimed')
    expect(row.preimage).toBe('cd'.repeat(32))
  })

  it('sticks when the revert left the lock still funded', async () => {
    const transactionOutcome = vi.fn().mockResolvedValue('pending')
    const { store, service } = await dueForRefund({
      isLocked: vi.fn().mockResolvedValue(true),
      transactionOutcome,
    })
    await service.tick('swap-1')
    transactionOutcome.mockResolvedValue('reverted')
    await service.tick('swap-1')
    const row = await store.get('swap-1')
    expect(row.state).toBe('stuck')
    expect(row.failureReason).toMatch(/revert/i)
  })

  it('re-sends a refund the row never recorded, once, and then waits', async () => {
    // Rule 8: a `pending` read on a null txid is for want of a question, not a
    // refund in flight. The crash window between the broadcast and the patch.
    const { store, service, deps } = await dueForRefund({
      isLocked: vi.fn().mockResolvedValue(true),
      transactionOutcome: vi.fn().mockResolvedValue('pending'),
    })
    await store.transition('swap-1', 'awaiting_claim', 'refunding_evm')
    await service.tick('swap-1')
    await service.tick('swap-1')
    const row = await store.get('swap-1')
    expect(row.evmRefundTxid, 'the stranded refund was never re-sent').toBe(REFUND_TXID)
    expect(deps.broadcast, 'the resend fired again over a refund already on record').toHaveBeenCalledTimes(1)
    expect(
      (await store.history('swap-1')).filter((e) => e.from === 'refunding_evm'),
      'the resend logged a move the row never made',
    ).toHaveLength(0)
  })

  it('does not read a receipt it has no txid for', async () => {
    // The other half of that crash window. A receipt asked for a null txid
    // could answer `success` and close the books on a refund never sent — the
    // row would read `refunded` with the solver's tokens still in the contract.
    const transactionOutcome = vi.fn().mockResolvedValue('success')
    const { store, service } = await dueForRefund({
      isLocked: vi.fn().mockResolvedValue(true),
      transactionOutcome,
    })
    await store.transition('swap-1', 'awaiting_claim', 'refunding_evm')
    await service.tick('swap-1')
    expect(transactionOutcome).not.toHaveBeenCalled()
    expect((await store.get('swap-1')).state).toBe('refunding_evm')
  })

  it('sends nothing when the lock is gone, so a claimed swap is not chased', async () => {
    const { store, service, deps } = await dueForRefund({
      isLocked: vi.fn().mockResolvedValue(false),
      transactionOutcome: vi.fn().mockResolvedValue('pending'),
    })
    await store.transition('swap-1', 'awaiting_claim', 'refunding_evm')
    await service.tick('swap-1')
    expect(deps.broadcast).not.toHaveBeenCalled()
    expect((await store.get('swap-1')).evmRefundTxid).toBeNull()
  })

  it('reports a resend that lost the claim rather than overwriting it', async () => {
    // Overwriting would leave the row waiting on the receipt of the LOSING
    // transaction while the winner's tokens came back unrecorded.
    const errors: unknown[] = []
    const built = await dueForRefund(
      { isLocked: vi.fn().mockResolvedValue(true), transactionOutcome: vi.fn().mockResolvedValue('pending') },
      { onTickError: (_id, error) => void errors.push(error) },
    )
    const { store, service } = built
    await store.transition('swap-1', 'awaiting_claim', 'refunding_evm')
    built.deps.broadcast = vi.fn(async () => {
      await store.claimRefundTxid('swap-1', 'other-instance')
      return REFUND_TXID
    })
    await service.tick('swap-1')
    expect((await store.get('swap-1')).evmRefundTxid, 'the loser overwrote the recorded txid').toBe('other-instance')
    expect(errors, 'the lost claim left no trace of the second broadcast').toHaveLength(1)
  })
})

describe('tickAll', () => {
  it('does not let one failing row stop the others', async () => {
    const { store, deps } = await build()
    await store.insertQuote({ ...quote(), id: 'swap-2', paymentHash: 'bb'.repeat(32), rfqId: 'rfq-2' })
    let calls = 0
    const service = new AssetEvmSendSwapService({
      ...deps,
      broadcast: vi.fn().mockImplementation(async () => {
        calls += 1
        if (calls === 1) throw new Error('rpc down')
        return '0xtx'
      }),
      onTickError: () => {},
    })
    const rows = await service.tickAll()
    expect(rows).toHaveLength(2)
    expect((await store.get('swap-1')).evmLockTxid).toBeNull()
    expect((await store.get('swap-2')).evmLockTxid).toBe('0xtx')
  })
})

describe('refundSweep', () => {
  const sweepableArkade = (over: Record<string, unknown> = {}) =>
    ({
      findLockups: vi.fn().mockResolvedValue([{ txid: 'aa'.repeat(32), vout: 0, value: 1_000 }]),
      lockupProvablySpent: vi.fn().mockResolvedValue(false),
      refund: vi.fn().mockResolvedValue('ark-refund-txid'),
      ...over,
    }) as unknown as AssetEvmSendServiceDeps['arkade']

  it('refunds against the ASSET covenant, not the BTC one', async () => {
    // Without the asset id the builder rebuilds the BTC script, whose pkScript
    // is a different address entirely — so the refund is pushed against a
    // lockup that holds nothing while the client's asset stays locked.
    const arkade = sweepableArkade()
    const { store, service } = await build({ arkade })
    await store.transition('swap-1', 'quoted', 'refused')

    expect(await service.refundSweep()).toEqual(['swap-1'])
    const [covenantRow] = (arkade.refund as ReturnType<typeof vi.fn>).mock.calls[0] as [{ assetId?: string }]
    expect(covenantRow.assetId).toBe(ASSET)
    const row = await store.get('swap-1')
    expect(row.refundOutcome).toBe('pushed')
    expect(row.refundArkTxid).toBe('ark-refund-txid')
  })

  it('keeps looking when the script reads empty and nothing proves a spend', async () => {
    // One empty read is NOT evidence of a spend: recording `external` on it
    // would report a refunded swap whose asset still sits at the script.
    const { store, service } = await build({
      arkade: sweepableArkade({ findLockups: vi.fn().mockResolvedValue([]) }),
    })
    await store.transition('swap-1', 'quoted', 'refused')

    expect(await service.refundSweep()).toEqual([])
    const row = await store.get('swap-1')
    expect(row.refundOutcome).toBeNull()
    expect(row.refundArkTxid).toBeNull()
  })

  it('records an external spend only on proof', async () => {
    const { store, service } = await build({
      arkade: sweepableArkade({
        findLockups: vi.fn().mockResolvedValue([]),
        lockupProvablySpent: vi.fn().mockResolvedValue(true),
      }),
    })
    await store.transition('swap-1', 'quoted', 'refused')

    expect(await service.refundSweep()).toEqual([])
    expect((await store.get('swap-1')).refundOutcome).toBe('external')
  })

  it('does not touch rows that are not refused', async () => {
    const { service } = await build({ arkade: sweepableArkade() })
    expect(await service.refundSweep()).toEqual([])
  })
})
