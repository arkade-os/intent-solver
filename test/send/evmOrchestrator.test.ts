/**
 * The two CRASH orderings the shell owns.
 *
 * The planner decides what to do; this module decides in what order the row and
 * the world are changed. Both orderings below exist because a crash between the
 * two halves must not lose money, and neither is visible to the planner's tests.
 */

import { describe, it, expect, vi } from 'vitest'
import { EvmSendSwapService, type EvmSendServiceDeps } from '@arkade-os/solver-corridors-evm/send/evmOrchestrator.js'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { EvmSendSwapStore, type EvmSendQuoteRecord } from '@arkade-os/solver-corridors-evm/db/evmSendSwaps.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'

const NOW = 1_800_000_000
const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

const quote = (): EvmSendQuoteRecord => ({
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
  rfqId: 'rfq-1',
})

/**
 * The two calls a lock costs, distinguishable by their calldata.
 *
 * The orchestrator broadcasts whatever list `lockCalls` hands back and records
 * the LAST txid as the lock's. That is only checkable if the fake's calls are
 * telling apart from each other, so these carry the real selectors and a fake
 * broadcaster below turns each into its own txid.
 */
const APPROVE_CALL = { to: new Uint8Array(20), data: Uint8Array.of(0x09, 0x5e, 0xa7, 0xb3) }
const LOCK_CALL = { to: new Uint8Array(20), data: Uint8Array.of(0xcd, 0x41, 0x30, 0x44) }

const build = async (over: Partial<EvmSendServiceDeps> = {}) => {
  const store = await EvmSendSwapStore.open(betterSqliteDriver(':memory:'), () => NOW)
  await store.insertQuote(quote())
  const deps: EvmSendServiceDeps = {
    store,
    evm: {
      isLocked: vi.fn().mockResolvedValue(false),
      findClaimPreimage: vi.fn().mockResolvedValue(null),

      isLockedAt: vi.fn().mockResolvedValue(true),
      blockTimestampAt: vi.fn().mockResolvedValue(0),
      transactionOutcome: vi.fn().mockResolvedValue('pending'),
      allowance: vi.fn().mockResolvedValue(0n),
      lockCalls: vi.fn().mockReturnValue([APPROVE_CALL, LOCK_CALL]),
      approveCall: vi.fn(),
      lockCall: vi.fn().mockReturnValue({ to: new Uint8Array(20), data: new Uint8Array(4) }),
      refundCall: vi.fn().mockReturnValue({ to: new Uint8Array(20), data: new Uint8Array(4) }),
      claimCall: vi.fn(),
      lockPrepayCall: vi.fn(),
    } as unknown as EvmSendServiceDeps['evm'],
    broadcast: vi.fn().mockResolvedValue('0xtx'),
    arkadeLockupFunded: vi.fn().mockResolvedValue(true),
    claimArkade: vi.fn().mockResolvedValue('ark-txid'),
    lockFor: vi.fn().mockReturnValue({}) as unknown as EvmSendServiceDeps['lockFor'],
    blockHeight: vi.fn().mockResolvedValue(20_000_000),
    // Quote-time deps. Every test in this file drives `tick`, which reads none
    // of them — they are here so the fixture satisfies the type, and are
    // deliberately inert so a tick test that started depending on one would
    // fail loudly rather than quietly pick up a plausible default.
    arkade: {
      providerPubkey: 'aa'.repeat(32),
      serverPubkey: 'bb'.repeat(32),
      emulatorPubkey: 'ff'.repeat(32),
      receiverPkScript: '5120' + '22'.repeat(32),
      hrp: 'tark',
      delays: {
        unilateralClaimDelay: 24 * 3600,
        unilateralRefundDelay: 24 * 3600,
        unilateralRefundWithoutReceiverDelay: 24 * 3600,
      },
    } as unknown as EvmSendServiceDeps['arkade'],
    solverEvmAddress: new Uint8Array(20).fill(0x42),
    maxExposedSats: 100_000_000,
    admission: new AdmissionControl(),
    totalCommitted: vi.fn().mockResolvedValue(0),
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
  return { store, deps, service: new EvmSendSwapService(deps) }
}

describe('the row enters the exposed state BEFORE the lock is broadcast', () => {
  it('is already locking_evm by the time broadcast is called', async () => {
    // A crash between the two must not leave a lock nobody knows about. Better
    // to re-observe a row claiming to be locking and find no lock, than to have
    // locked tokens against a row still reading `funded`.
    let stateAtBroadcast: string | null = null
    const { store, service } = await build({
      broadcast: vi.fn().mockImplementation(async () => {
        stateAtBroadcast = (await store.get('swap-1')).state
        return '0xtx'
      }),
    })
    await service.tick('swap-1')
    expect(stateAtBroadcast).toBe('locking_evm')
  })

  it('records the lock txid without writing a bogus state change', async () => {
    // `patch`, not `transition`: recording a txid is not a state change, and a
    // self-transition would make the history claim the row moved when it did not.
    const { store, service } = await build()
    await service.tick('swap-1')
    expect((await store.get('swap-1')).evmLockTxid).toBe('0xtx')
    expect((await store.history('swap-1')).map((e) => e.to)).toEqual(['quoted', 'locking_evm'])
  })
})

describe('the lock is approved before it is broadcast', () => {
  // `ERC20Swap.lock` moves the tokens with `transferFrom`, so without a standing
  // allowance it REVERTS — and `planEvmSend` cannot tell a revert from a lock
  // that has not landed, so it waits out `evmTimeout` and then refunds a lock
  // that never existed. No money lost, no swap ever completed, nothing logged.
  const txidOf = (call: { data: Uint8Array }) => `0x${call.data[0]!.toString(16)}`
  const broadcastPerCall = () => vi.fn().mockImplementation(async (call: { data: Uint8Array }) => txidOf(call))

  it('broadcasts every call lockCalls asks for, approval first', async () => {
    const broadcast = broadcastPerCall()
    const { service } = await build({ broadcast })
    await service.tick('swap-1')
    expect(broadcast.mock.calls.map(([call]) => call)).toEqual([APPROVE_CALL, LOCK_CALL])
  })

  it('records the LOCK txid, not the approval’s', async () => {
    // The row's `evm_lock_txid` is what an operator follows to see their own
    // money. An approval txid there points at a transaction that moved nothing,
    // and it is the FIRST one broadcast — so a loop that recorded eagerly rather
    // than last would look entirely plausible.
    const { store, service } = await build({ broadcast: broadcastPerCall() })
    await service.tick('swap-1')
    expect((await store.get('swap-1')).evmLockTxid).toBe(txidOf(LOCK_CALL))
  })

  it('reads the allowance for the token being locked, held by the SOLVER', async () => {
    // Both arguments are 20-byte values with no type to tell them apart, and
    // getting either wrong reads a reliable zero — which looks like "no
    // allowance", triggers an approval that succeeds, and costs only an extra
    // transaction. It would survive every happy path.
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
      } as unknown as EvmSendServiceDeps['evm'],
      lockFor: vi.fn().mockReturnValue({ tokenAddress: token, amount: 1_000_000n }) as never,
      solverEvmAddress: new Uint8Array(20).fill(0x42),
    })
    await service.tick('swap-1')
    expect(allowance).toHaveBeenCalledWith(token, new Uint8Array(20).fill(0x42))
  })

  it('hands lockCalls the allowance it actually read', async () => {
    // A stale approval left by a reverted lock is the case the zero-first
    // sequence exists for. Passing a hardcoded zero instead of the real reading
    // would skip it, and the retry would revert on exactly the tokens (USDT)
    // most worth serving.
    const lockCalls = vi.fn().mockReturnValue([LOCK_CALL])
    const lock = { tokenAddress: new Uint8Array(20), amount: 1_000_000n }
    const { service } = await build({
      evm: {
        isLocked: vi.fn().mockResolvedValue(false),
        findClaimPreimage: vi.fn().mockResolvedValue(null),

        isLockedAt: vi.fn().mockResolvedValue(true),
        blockTimestampAt: vi.fn().mockResolvedValue(0),
        transactionOutcome: vi.fn().mockResolvedValue('pending'),
        allowance: vi.fn().mockResolvedValue(999n),
        lockCalls,
      } as unknown as EvmSendServiceDeps['evm'],
      lockFor: vi.fn().mockReturnValue(lock) as never,
    })
    await service.tick('swap-1')
    expect(lockCalls).toHaveBeenCalledWith(lock, 999n)
  })

  it('is already locking_evm before the FIRST call goes out', async () => {
    // The existing ordering guarantee, restated against the approval: the row
    // must be exposed before anything at all is broadcast, and the approval now
    // goes first.
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
})

describe('the preimage is found AFTER the lock is gone', () => {
  it('scans for the Claim even though isLocked is false', async () => {
    // THE WINDOW IS THE POINT. `ERC20Swap` deletes its `swaps` flag on claim, so
    // `isLocked` is false from the instant a Claim event exists. While the lock
    // IS present there is no Claim to find; once there is one, the lock is gone.
    // Gating the scan on presence therefore closes the only window in which the
    // preimage can ever be read.
    //
    // The cost is the whole swap: the client takes the tokens, the solver never
    // learns the secret, and the Arkade lockup it could have claimed sits until
    // the client's own refund opens. The client ends up with both sides.
    const findClaimPreimage = vi.fn().mockResolvedValue(Uint8Array.from(Buffer.from('cd'.repeat(32), 'hex')))
    const { store, service } = await build({
      evm: {
        // Claimed and deleted — exactly the state a successful client claim leaves.
        isLocked: vi.fn().mockResolvedValue(false),
        findClaimPreimage,
        allowance: vi.fn().mockResolvedValue(0n),
        lockCalls: vi.fn().mockReturnValue([LOCK_CALL]),
        refundCall: vi.fn().mockReturnValue({ to: new Uint8Array(20), data: new Uint8Array(4) }),
      } as unknown as EvmSendServiceDeps['evm'],
    })
    await store.transition('swap-1', 'quoted', 'locking_evm')
    await store.patch('swap-1', { evm_lock_txid: '0xtx' })
    await store.transition('swap-1', 'locking_evm', 'awaiting_claim')

    await service.tick('swap-1')
    expect(findClaimPreimage, 'never scanned: the lock was already gone').toHaveBeenCalled()
    expect((await store.get('swap-1')).preimage).toBe('cd'.repeat(32))
  })

  it('does not scan before anything has been locked', async () => {
    // What the old guard was reaching for, and the part worth keeping: a Claim
    // cannot precede the lock it spends, so scanning before `evm_lock_txid`
    // exists is a guaranteed-empty request on every tick.
    const findClaimPreimage = vi.fn().mockResolvedValue(null)
    const { service } = await build({
      evm: {
        isLocked: vi.fn().mockResolvedValue(false),
        findClaimPreimage,
        allowance: vi.fn().mockResolvedValue(0n),
        lockCalls: vi.fn().mockReturnValue([LOCK_CALL]),
      } as unknown as EvmSendServiceDeps['evm'],
      arkadeLockupFunded: vi.fn().mockResolvedValue(false),
    })
    await service.tick('swap-1')
    expect(findClaimPreimage).not.toHaveBeenCalled()
  })
})

describe('a preimage scan the node refuses must not strand the solver’s tokens', () => {
  it('still reaches the EVM refund once the timeout has matured', async () => {
    // A range-capped provider makes `findClaimPreimage` throw every tick.
    // Unhandled, that leaves `observe` before the planner runs, so the row
    // reaches neither `claim_arkade` nor — the expensive one — `refund_evm`.
    const errors: unknown[] = []
    const findClaimPreimage = vi.fn().mockRejectedValue(new Error('query returned more than 10000 results'))
    const { store, service } = await build({
      evm: {
        isLocked: vi.fn().mockResolvedValue(true),
        findClaimPreimage,
        isLockedAt: vi.fn().mockResolvedValue(true),
        blockTimestampAt: vi.fn().mockResolvedValue(0),
        refundCall: vi.fn().mockReturnValue({ to: new Uint8Array(20), data: new Uint8Array(4) }),
      } as unknown as EvmSendServiceDeps['evm'],
      // At the quote's `evmTimeout`, so RULE 3 is live and refund is what a
      // reached planner decides.
      blockHeight: vi.fn().mockResolvedValue(21_000_000),
      broadcast: vi.fn().mockResolvedValue('0xrefund'),
      onTickError: (_id, error) => void errors.push(error),
    })
    await store.transition('swap-1', 'quoted', 'funded')
    await store.transition('swap-1', 'funded', 'locking_evm', { evm_lock_txid: '0xtx' })
    await store.transition('swap-1', 'locking_evm', 'awaiting_claim')

    await service.tick('swap-1')

    const row = await store.get('swap-1')
    expect(row.state, 'the failed scan aborted the tick and stranded the lock').toBe('refunded')
    expect(row.evmRefundTxid).toBe('0xrefund')
    // Silent degradation would make a provider misconfiguration look like a slow
    // swap; a stall needs a cause an operator can read.
    expect(errors, 'the scan failure never reached the operator log').toHaveLength(1)
  })
})

describe('the preimage is persisted BEFORE the Arkade claim is attempted', () => {
  it('has the preimage on disk by the time claimArkade runs', async () => {
    // It is the money. A crash after claiming but before recording it loses the
    // one secret that makes the lockup spendable, and no chain read recovers it
    // once the Claim event has aged out of the scan window.
    let preimageAtClaim: string | null = null
    const { store, service } = await build({
      evm: {
        isLocked: vi.fn().mockResolvedValue(true),
        findClaimPreimage: vi.fn().mockResolvedValue(Uint8Array.from(Buffer.from('ab'.repeat(32), 'hex'))),

        isLockedAt: vi.fn().mockResolvedValue(true),
        blockTimestampAt: vi.fn().mockResolvedValue(0),
        lockCall: vi.fn().mockReturnValue({ to: new Uint8Array(20), data: new Uint8Array(4) }),
        refundCall: vi.fn(),
        claimCall: vi.fn(),
        lockPrepayCall: vi.fn(),
      } as unknown as EvmSendServiceDeps['evm'],
      claimArkade: vi.fn().mockImplementation(async () => {
        preimageAtClaim = (await store.get('swap-1')).preimage
        return 'ark-txid'
      }),
    })
    await store.transition('swap-1', 'quoted', 'funded')
    await store.transition('swap-1', 'funded', 'locking_evm', { evm_lock_txid: '0xtx' })
    await store.transition('swap-1', 'locking_evm', 'awaiting_claim')
    await service.tick('swap-1')
    expect(preimageAtClaim).toBe('ab'.repeat(32))
    expect((await store.get('swap-1')).state).toBe('claimed')
  })
})

describe('tickAll', () => {
  it('does not let one failing row stop the others', async () => {
    // Shared loop with every other corridor: one stuck swap taking the sweep
    // down would stall all of them.
    const { store, deps } = await build()
    await store.insertQuote({ ...quote(), id: 'swap-2', paymentHash: 'bb'.repeat(32), rfqId: 'rfq-2' })
    let calls = 0
    const service = new EvmSendSwapService({
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
    // The outcome, not the call count: the healthy row got its lock recorded
    // and the failing one did not. A raw total would encode how many
    // transactions a lock costs, which is `lockCalls`' business, not this
    // test's — it went from 2 to 3 the day the approval was added.
    expect((await store.get('swap-1')).evmLockTxid).toBe(null)
    expect((await store.get('swap-2')).evmLockTxid).toBe('0xtx')
    expect(calls).toBeGreaterThan(1)
  })
})

/**
 * The send leg's depth gate had the same defect as the receive leg's:
 * `observe()` handed the planner the row's OWN `minConfirmations` back as the
 * observation, so `>= minConfirmations` was true the instant any block carried
 * the lock, whatever the operator configured.
 *
 * Less costly here than on the receive side — the lock is the solver's own, so
 * a reorg loses a swap rather than the sats — but the setting still read as
 * enforced while enforcing nothing, and a client watching the state advance
 * would see `awaiting_claim` on a lock that had not settled.
 */
describe('the solver`s own lock must be BURIED before the swap advances', () => {
  const deepRow = { ...quote(), id: 'deep', paymentHash: 'dd'.repeat(32), minConfirmations: 12, rfqId: 'rfq-deep' }

  it('does not advance while the lock is not deep enough', async () => {
    const { store, service } = await build({
      evm: {
        isLocked: vi.fn().mockResolvedValue(true),
        // Not there 12 blocks ago.
        isLockedAt: vi.fn().mockResolvedValue(false),
        blockTimestampAt: vi.fn().mockResolvedValue(0),
        findClaimPreimage: vi.fn().mockResolvedValue(null),
        allowance: vi.fn().mockResolvedValue(0n),
        lockCalls: vi.fn().mockReturnValue([]),
      } as never,
    })
    await store.insertQuote(deepRow)
    await store.transition('deep', 'quoted', 'funded')
    await store.transition('deep', 'funded', 'locking_evm')
    await service.tick('deep')
    expect((await store.get('deep')).state).toBe('locking_evm')
  })

  it('advances once the lock is proven that deep', async () => {
    const { store, service } = await build({
      evm: {
        isLocked: vi.fn().mockResolvedValue(true),
        isLockedAt: vi.fn().mockResolvedValue(true),
        blockTimestampAt: vi.fn().mockResolvedValue(0),
        findClaimPreimage: vi.fn().mockResolvedValue(null),
        allowance: vi.fn().mockResolvedValue(0n),
        lockCalls: vi.fn().mockReturnValue([]),
      } as never,
    })
    await store.insertQuote(deepRow)
    await store.transition('deep', 'quoted', 'funded')
    await store.transition('deep', 'funded', 'locking_evm')
    await service.tick('deep')
    expect((await store.get('deep')).state).toBe('awaiting_claim')
  })
})

/** A revert leaves no lock, so only the receipt separates it from pending. */
describe('a lock transaction that reverted is not a lock that has not landed', () => {
  const revertedRow = async (over: Partial<EvmSendServiceDeps> = {}) => {
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
    await built.store.transition('swap-1', 'quoted', 'funded')
    await built.store.transition('swap-1', 'funded', 'locking_evm', { evm_lock_txid: '0xlock' })
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

  it('keeps waiting while the node cannot say yet', async () => {
    const { store, service } = await revertedRow({
      evm: {
        isLocked: vi.fn().mockResolvedValue(false),
        isLockedAt: vi.fn().mockResolvedValue(false),
        blockTimestampAt: vi.fn().mockResolvedValue(0),
        findClaimPreimage: vi.fn().mockResolvedValue(null),
        transactionOutcome: vi.fn().mockResolvedValue('pending'),
      } as never,
    })
    await service.tick('swap-1')
    expect((await store.get('swap-1')).state).toBe('locking_evm')
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
    await store.transition('swap-1', 'quoted', 'funded')
    await store.transition('swap-1', 'funded', 'locking_evm')
    await service.tick('swap-1')
    expect(transactionOutcome).not.toHaveBeenCalled()
    expect((await store.get('swap-1')).state).toBe('locking_evm')
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
})

describe('the lock call is never optional', () => {
  it('refuses to record an empty lock id when lockCalls returns nothing', async () => {
    // Cannot happen while `lockCalls` always ends with the lock — but the
    // failure if it ever did is silent and expensive: the loop leaves `txid`
    // empty, the row records an EMPTY `evm_lock_txid`, and that reads
    // downstream as "we locked, and here is where" pointing at nothing. The
    // row is already `locking_evm` by then, so it would sit in the exposed
    // state naming a transaction that does not exist.
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
      onTickError: () => {},
    })
    await store.transition('swap-1', 'quoted', 'funded')
    // Loudly: the tick fails rather than recording a lock that is not there.
    await expect(service.tick('swap-1')).rejects.toThrow(/the lock call is never optional/)
    expect(broadcast).not.toHaveBeenCalled()
    expect((await store.get('swap-1')).evmLockTxid).toBeNull()
  })
})

describe('refundSweep', () => {
  const sweepableArkade = (over: Record<string, unknown> = {}) =>
    ({
      findLockups: vi.fn().mockResolvedValue([{ txid: 'aa'.repeat(32), vout: 0, value: 50_000 }]),
      lockupProvablySpent: vi.fn().mockResolvedValue(false),
      refund: vi.fn().mockResolvedValue('ark-refund-txid'),
      ...over,
    }) as unknown as EvmSendServiceDeps['arkade']

  it('pushes the non-interactive refund for a refused row with funds at the script', async () => {
    const { store, service } = await build({ arkade: sweepableArkade() })
    await store.transition('swap-1', 'quoted', 'refused')

    const pushed = await service.refundSweep()
    expect(pushed).toEqual(['swap-1'])
    const row = await store.get('swap-1')
    expect(row.refundOutcome).toBe('pushed')
    expect(row.refundArkTxid).toBe('ark-refund-txid')
  })

  it('keeps looking when the script reads empty and nothing proves a spend', async () => {
    // One empty read is NOT evidence of a spend — recording "external" on it
    // would report a refunded swap whose sats still sit at the script.
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
    const row = await store.get('swap-1')
    expect(row.refundOutcome).toBe('external')
    expect(row.refundArkTxid).toBeNull()
  })

  it('does not touch rows that are not refused', async () => {
    const { service } = await build({ arkade: sweepableArkade() })
    // swap-1 is still `quoted` — the sweep must leave it alone.
    expect(await service.refundSweep()).toEqual([])
  })
})
