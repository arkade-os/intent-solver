import { afterEach, describe, expect, it, vi } from 'vitest'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { betterSqliteDriver } from '@arkade-os/solver-db/driver.js'
import { EvmSendSwapStore, type EvmSendQuoteRecord } from '@arkade-os/solver-corridors-evm/db/evmSendSwaps.js'
import { sendLockFromRow } from '@arkade-os/solver-corridors-evm/evm/lockFromRow.js'
import { EvmSendSwapService, type EvmSendServiceDeps } from '@arkade-os/solver-corridors-evm/send/evmOrchestrator.js'
import {
  payoutFundingBinding,
  type EvmPayoutFundingAdapter,
} from '@arkade-os/solver-corridors-evm/send/evmPayoutFunding.js'

const NOW = 1_800_000_000
const TXID = '0x' + '99'.repeat(32)
const quote = (): EvmSendQuoteRecord => ({
  id: 'swap-1',
  paymentHash: 'aa'.repeat(32),
  amountSats: 50_000,
  payoutSats: 49_500,
  evmAmount: '1000000',
  tokenAddress: '0x' + '11'.repeat(20),
  evmContractAddress: '0x' + '22'.repeat(20),
  evmChainId: 8453,
  evmTimeout: 21_000_000,
  validUntil: NOW + 60,
  minConfirmations: 1,
  minAgeSeconds: 0,
  evmClaimAddress: '0x' + '33'.repeat(20),
  evmRefundAddress: '0x' + '44'.repeat(20),
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

const stores: EvmSendSwapStore[] = []
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
})

const build = async (over: Partial<EvmSendServiceDeps> = {}) => {
  const store = await EvmSendSwapStore.open(betterSqliteDriver(':memory:'), () => NOW)
  stores.push(store)
  await store.insertQuote(quote())
  const evm = {
    isLocked: vi.fn().mockResolvedValue(false),
    isLockedAt: vi.fn().mockResolvedValue(true),
    blockTimestampAt: vi.fn().mockResolvedValue(NOW - 100),
    findClaimPreimage: vi.fn().mockResolvedValue(null),
    findRefund: vi.fn().mockResolvedValue(false),
    transactionOutcome: vi.fn().mockResolvedValue('pending'),
    transactionBlock: vi.fn().mockResolvedValue(19_000_000n),
    allowance: vi.fn().mockResolvedValue(0n),
    lockCalls: vi.fn().mockReturnValue([{ to: new Uint8Array(20), data: new Uint8Array(4) }]),
    refundCall: vi.fn().mockReturnValue({ to: new Uint8Array(20), data: new Uint8Array(4) }),
    claimCall: vi.fn(),
    ...over.evm,
  } as unknown as EvmSendServiceDeps['evm']
  const adapter: EvmPayoutFundingAdapter = {
    identity: 'receiver-funding-v1',
    ensure: vi.fn().mockResolvedValue({}),
    sweepRecovery: vi.fn().mockResolvedValue(undefined),
  }
  const deps: EvmSendServiceDeps = {
    store,
    broadcast: vi.fn().mockResolvedValue(TXID),
    payoutFunding: adapter,
    arkadeLockupFunded: vi.fn().mockResolvedValue(true),
    claimArkade: vi.fn().mockResolvedValue('ark-tx'),
    lockFor: sendLockFromRow,
    blockHeight: vi.fn().mockResolvedValue(20_000_000),
    solverEvmAddress: new Uint8Array(20).fill(0x44),
    arkade: {} as EvmSendServiceDeps['arkade'],
    admission: new AdmissionControl(),
    maxExposedSats: 1_000_000,
    totalCommitted: vi.fn().mockResolvedValue(0),
    markets: new Map(),
    fetchPrice: vi.fn(),
    chain: {
      contractAddress: '0x' + '22'.repeat(20),
      chainId: 8453,
      minConfirmations: 1,
      minAgeSeconds: 0,
      cadence: { fastestSecondsPerBlock: 1, slowestSecondsPerBlock: 2 },
      quoteValiditySeconds: 60,
    },
    now: () => NOW,
    ...over,
    evm,
  }
  return { store, deps, adapter: deps.payoutFunding!, service: new EvmSendSwapService(deps) }
}

describe('alternate EVM payout funding', () => {
  it('persists exposure before dispatch and leaves HTLC authority with the chain', async () => {
    const { store, deps, adapter, service } = await build()
    const ensure = vi.mocked(adapter.ensure).mockImplementation(async (context, mode) => {
      expect((await store.get(context.binding.intentId)).state).toBe('locking_evm')
      expect(context.binding.amount).toBe('1000000')
      expect(context.binding.contractAddress).toBe(quote().evmContractAddress)
      return mode === 'start' ? { activationTxid: TXID } : {}
    })
    expect((await service.tick('swap-1')).state).toBe('locking_evm')
    expect((await store.get('swap-1')).evmLockTxid).toBe(TXID)
    expect(ensure.mock.calls.map(([, mode]) => mode)).toEqual(['start', 'reconcile'])
    expect(deps.evm.allowance).not.toHaveBeenCalled()
    expect(deps.broadcast).not.toHaveBeenCalled()
    expect(deps.claimArkade).not.toHaveBeenCalled()
  })

  it('reconciles after a dispatch crash without another start', async () => {
    const { store, adapter, service, deps } = await build()
    vi.mocked(adapter.ensure).mockRejectedValueOnce(new Error('uncertain provider submission'))
    await expect(service.tick('swap-1')).rejects.toThrow('uncertain')
    expect((await store.get('swap-1')).state).toBe('locking_evm')
    await new EvmSendSwapService(deps).tick('swap-1')
    expect(vi.mocked(adapter.ensure).mock.calls.map(([, mode]) => mode)).toEqual(['start', 'reconcile'])
  })

  it('waits for exact lock presence and finality, then learns the preimage from the chain', async () => {
    const { store, deps, service } = await build()
    await service.tick('swap-1')
    vi.mocked(deps.evm.isLocked).mockResolvedValue(true)
    vi.mocked(deps.evm.isLockedAt).mockResolvedValue(false)
    expect((await service.tick('swap-1')).state).toBe('locking_evm')
    vi.mocked(deps.evm.isLockedAt).mockResolvedValue(true)
    expect((await service.tick('swap-1')).state).toBe('awaiting_claim')
    expect(deps.claimArkade).not.toHaveBeenCalled()
    vi.mocked(deps.evm.findClaimPreimage).mockResolvedValue(new Uint8Array(32).fill(0x55))
    expect((await service.tick('swap-1')).state).toBe('claimed')
    expect((await store.get('swap-1')).preimage).toBe('55'.repeat(32))
  })

  it('claims a chain-revealed preimage even while the provider is unavailable', async () => {
    const { service, deps, adapter, store } = await build()
    await service.tick('swap-1')
    vi.mocked(adapter.ensure).mockRejectedValue(new Error('provider unavailable'))
    vi.mocked(deps.evm.findClaimPreimage).mockResolvedValue(new Uint8Array(32).fill(0x55))
    expect((await service.tick('swap-1')).state).toBe('claimed')
    expect((await store.get('swap-1')).preimage).toBe('55'.repeat(32))
  })

  it('accepts finalized HTLC evidence even while the provider is unavailable', async () => {
    const { service, deps, adapter } = await build()
    await service.tick('swap-1')
    vi.mocked(adapter.ensure).mockRejectedValue(new Error('provider unavailable'))
    vi.mocked(deps.evm.isLocked).mockResolvedValue(true)
    expect((await service.tick('swap-1')).state).toBe('awaiting_claim')
  })

  it('recovers an absent payout after timeout without refunding a nonexistent HTLC', async () => {
    const { store, deps, adapter, service } = await build()
    await service.tick('swap-1')
    vi.mocked(deps.blockHeight).mockResolvedValue(quote().evmTimeout)
    expect((await service.tick('swap-1')).state).toBe('locking_evm')
    expect(vi.mocked(adapter.ensure).mock.calls.at(-1)?.[1]).toBe('recover')
    expect(deps.evm.refundCall).not.toHaveBeenCalled()
    expect((await store.get('swap-1')).evmRefundTxid).toBeNull()
  })

  it('sweeps provider recovery after the customer row becomes terminal', async () => {
    const { store, adapter, service } = await build()
    await store.transition('swap-1', 'quoted', 'refused')
    await service.tickAll()
    expect(adapter.sweepRecovery).toHaveBeenCalledTimes(1)
    expect(adapter.ensure).not.toHaveBeenCalled()
  })

  it('rejects substituted lock binding before committing any funding', async () => {
    const { store, adapter, service } = await build({
      lockFor: (row) => ({ ...sendLockFromRow(row), refundAddress: new Uint8Array(20) }),
    })
    await expect(service.tick('swap-1')).rejects.toThrow('does not match')
    expect((await store.get('swap-1')).state).toBe('quoted')
    expect(adapter.ensure).not.toHaveBeenCalled()
  })

  it('rejects a provider order ID disguised as activation evidence', async () => {
    const { adapter, service, store } = await build()
    vi.mocked(adapter.ensure).mockResolvedValue({ activationTxid: 'provider-order-123' })
    await expect(service.tick('swap-1')).rejects.toThrow('activation transaction hash')
    expect((await store.get('swap-1')).evmLockTxid).toBeNull()
  })

  it('stops new intake while existing reconciliation continues', async () => {
    const { service, adapter } = await build({ acceptingQuotes: () => false })
    const result = await service.quote({} as Parameters<EvmSendSwapService['quote']>[0])
    expect(result).toEqual({ accepted: false, reason: 'provider_at_capacity' })
    await service.tick('swap-1')
    expect(adapter.ensure).toHaveBeenCalled()
  })

  it('retains the original direct EOA funding path when the seam is omitted', async () => {
    const { deps, service } = await build({ payoutFunding: undefined })
    await service.tick('swap-1')
    expect(deps.evm.allowance).toHaveBeenCalledTimes(1)
    expect(deps.broadcast).toHaveBeenCalledTimes(1)
  })
})

describe('immutable funding bindings', () => {
  it.each(['amount', 'preimageHash', 'tokenAddress', 'claimAddress', 'refundAddress', 'timelock'] as const)(
    'rejects a substituted %s',
    async (field) => {
      const { store } = await build()
      const row = await store.get('swap-1')
      const lock = sendLockFromRow(row)
      if (field === 'amount' || field === 'timelock') lock[field] += 1n
      else lock[field] = new Uint8Array(lock[field].length)
      expect(() => payoutFundingBinding('funding-v1', row, lock)).toThrow('does not match')
    },
  )

  it('preserves a uint256-sized fixed payout as canonical decimal text', async () => {
    const { store } = await build()
    const row = { ...(await store.get('swap-1')), evmAmount: ((1n << 255n) + 1n).toString() }
    expect(payoutFundingBinding('funding-v1', row, sendLockFromRow(row)).amount).toBe(row.evmAmount)
  })
})
