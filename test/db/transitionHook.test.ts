// The hook inherits the compare-and-swap's once-per-transition guarantee.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SwapStore } from '@arkade-os/solver-corridors/db/swaps.js'
import { EvmSendSwapStore } from '@arkade-os/solver-corridors-evm/db/evmSendSwaps.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'

let store: SwapStore
let seen: { id: string; from: string | null; to: string }[]

const NOW = 1_800_000_000

const quote = () => ({
  id: 'swap-1',
  invoice: 'lnbc1',
  paymentHash: 'aa'.repeat(32),
  amountSats: 1_000,
  invoiceExpiresAt: NOW + 3600,
  refundLocktime: NOW + 86_400,
  senderPubkey: 'bb'.repeat(32),
  receiverPubkey: 'bb'.repeat(32),
  serverPubkey: 'cc'.repeat(32),
  claimDelay: 512,
  refundDelay: 1024,
  refundWithoutReceiverDelay: 1536,
  pkScript: '5120' + 'dd'.repeat(32),
  lockupAddress: 'ark1lockup',
  refundPkScript: '5120' + 'ee'.repeat(32),
  emulatorPubkey: 'ff'.repeat(32),
  clientRefundPubkey: '11'.repeat(32),
  receiverPkScript: '5120' + '22'.repeat(32),
  nonInteractiveParameters: true,
})

beforeEach(async () => {
  seen = []
  store = await SwapStore.open(':memory:', () => NOW)
  store.onTransition = (event) => seen.push(event)
  await store.insertQuote(quote())
})
afterEach(() => store.close())

describe('SwapStore.onTransition', () => {
  it('fires on a won transition, with both states', async () => {
    await store.transition('swap-1', 'quoted', 'funded', {})
    expect(seen).toEqual([{ id: 'swap-1', from: 'quoted', to: 'funded' }])
  })

  it('does NOT fire when the compare-and-swap loses', async () => {
    expect(await store.transition('swap-1', 'funded', 'paying', {})).toBe(false)
    expect(seen).toEqual([])
  })

  it('fires once per transition, not once per tick', async () => {
    await store.transition('swap-1', 'quoted', 'funded', {})
    await store.transition('swap-1', 'quoted', 'funded', {}).catch(() => {})
    expect(seen).toHaveLength(1)
  })

  it('fires for a fail(), which is how a swap reaches a terminal state', async () => {
    await store.fail('swap-1', 'quoted', 'lockup timeout')
    expect(seen).toEqual([{ id: 'swap-1', from: 'quoted', to: 'refused' }])
  })

  // A hook that threw would abort a money-path transition after the row moved.
  it('a throwing hook does not break the transition', async () => {
    store.onTransition = () => {
      throw new Error('notifier exploded')
    }
    await expect(store.transition('swap-1', 'quoted', 'funded', {})).resolves.toBe(true)
    expect((await store.get('swap-1')).state).toBe('funded')
  })

  it('is inert when nothing is wired', async () => {
    const bare = await SwapStore.open(':memory:', () => NOW)
    await bare.insertQuote(quote())
    await expect(bare.transition('swap-1', 'quoted', 'funded', {})).resolves.toBe(true)
    await bare.close()
  })
})

describe('EvmSendSwapStore.onTransition', () => {
  // Their own copy of `transition`, so this needs proving separately.
  it('fires on a won transition', async () => {
    const evm = await EvmSendSwapStore.open(betterSqliteDriver(':memory:'), () => NOW)
    const fired: { id: string; from: string | null; to: string }[] = []
    evm.onTransition = (event) => fired.push(event)
    await evm.insertQuote({
      id: 'evm-1',
      paymentHash: 'aa'.repeat(32),
      amountSats: 50_000,
      payoutSats: 49_500,
      evmAmount: '1000000',
      tokenAddress: '0x' + 'ab'.repeat(20),
      evmContractAddress: '0x' + '11'.repeat(20),
      evmChainId: 8453,
      evmTimeout: 21_000_000,
      validUntil: NOW + 60,
      minConfirmations: 1,
      minAgeSeconds: 0,
      evmClaimAddress: '0x' + '22'.repeat(20),
      evmRefundAddress: '0x' + '33'.repeat(20),
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
    await evm.transition('evm-1', 'quoted', 'funded')
    expect(fired).toEqual([{ id: 'evm-1', from: 'quoted', to: 'funded' }])
    await evm.close()
  })
})
