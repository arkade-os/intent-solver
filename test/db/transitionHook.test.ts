// The hook inherits the compare-and-swap's once-per-transition guarantee.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SwapStore } from '@arkade-os/solver-corridors/db/swaps.js'
import { EvmSendSwapStore } from '@arkade-os/solver-corridors-evm/db/evmSendSwaps.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { OfferFillStore } from '@arkade-os/solver-corridors/db/offerFills.js'
import { AssetRfqSwapStore } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'

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

// Both carry their own `transition`, so both need proving separately.
describe('the asset stores announce their transitions', () => {
  it('OfferFillStore fires on a won transition', async () => {
    const store = await OfferFillStore.open(betterSqliteDriver(':memory:'), () => NOW)
    const fired: { id: string; from: string | null; to: string }[] = []
    store.onTransition = (event) => fired.push(event)
    await store.insertIntent({
      id: 'fill-1',
      offerTxid: 'a'.repeat(64),
      offerVout: 0,
      offerPkScript: '5120' + 'dd'.repeat(32),
      wantAssetId: null,
      wantAmount: 1_000n,
      offerAssetId: 'asset-1',
      offerAmount: 2_000n,
    })
    await store.transition('fill-1', 'fillable', 'filling')
    expect(fired).toEqual([{ id: 'fill-1', from: 'fillable', to: 'filling' }])
    await store.close()
  })

  it('AssetRfqSwapStore fires on a won transition', async () => {
    const store = await AssetRfqSwapStore.open(betterSqliteDriver(':memory:'), () => NOW)
    const fired: { id: string; from: string | null; to: string }[] = []
    store.onTransition = (event) => fired.push(event)
    await store.insertQuote({
      id: 'rfq-1',
      rfqId: 'corr-1',
      pair: 'arkade:BTC->arkade:asset-1',
      fromAssetId: null,
      fromAmount: 1_000n,
      toAssetId: 'asset-1',
      toAmount: 2_000n,
      makerPkScript: '5120' + 'aa'.repeat(32),
      makerPublicKey: 'bb'.repeat(32),
      offerPkScript: '5120' + 'cc'.repeat(32),
      offerAddress: 'tark1offer',
      solverPubkey: 'dd'.repeat(32),
      validUntil: NOW + 60,
    })
    await store.transition('rfq-1', 'quoted', 'funded')
    expect(fired).toEqual([{ id: 'rfq-1', from: 'quoted', to: 'funded' }])
    await store.close()
  })
})

// A hook that is never wired is worse than no hook: the source reads as though
// those swaps emit events and they silently do not. Both asset stores shipped
// that way in review here.
describe('every store carrying the hook is WIRED on the shipped daemon', () => {
  const servicesSource = readFileSync(
    fileURLToPath(new URL('../../packages/solver-app/src/ops/services.ts', import.meta.url)),
    'utf8',
  )

  it.each([
    ['store', 'LN_SEND.pair'],
    ['onchainStore', 'ONCHAIN_SEND.pair'],
    ['receiveStore', 'LN_RECEIVE.pair'],
    ['onchainReceiveStore', 'ONCHAIN_RECEIVE.pair'],
    ['evmSendStore', "'arkade:BTC->ethereum'"],
    ['evmReceiveStore', "'ethereum->arkade:BTC'"],
    ['offerStore', "'arkade offer fill'"],
    ['assetRfqStore', "'arkade asset RFQ'"],
  ])('%s announces as %s', (storeName, label) => {
    expect(servicesSource).toContain(`announceOutcomes(${storeName}, ${label},`)
  })
})
