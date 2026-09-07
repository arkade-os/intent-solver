/**
 * The `arkade:<asset>->lightning:BTC` orchestrator at its one irreversible act:
 * the step where the backend can commit against the hash before it answers.
 */

import { describe, it, expect } from 'vitest'
import { LnAssetSendSwapStore } from '@arkade-os/solver-corridors/db/lnAssetSendSwaps.js'
import { LnAssetSendSwapService, type LnAssetSendDeps } from '@arkade-os/solver-corridors/lnasset/sendOrchestrator.js'

const ASSET = `${'aa'.repeat(32)}0100`
const NOW = 1_700_000_000

const market = {
  assetId: ASSET,
  symbol: 'USDA',
  decimals: 6,
  feeBps: 50,
  limits: { minSats: 1_000, maxSats: 1_000_000 },
  inventoryCeiling: null,
  feedUrl: 'https://feed.example/btc',
  pricePath: 'price',
}

const quote = {
  id: 's1',
  paymentHash: '11'.repeat(32),
  pair: `arkade:${ASSET}->lightning:BTC`,
  invoice: 'lnbcrt1...',
  invoiceExpiresAt: NOW + 3_600,
  payoutSats: 50_000,
  assetId: ASSET,
  assetDecimals: 6,
  lockupAssetAmount: 500_000n,
  lockupDeadline: NOW + 900,
  refundLocktime: NOW + 2_000_000,
  solverPubkey: 'dd'.repeat(32),
  serverPubkey: 'ee'.repeat(32),
  claimDelay: 512,
  refundDelay: 1024,
  refundWithoutReceiverDelay: 2048,
  emulatorPubkey: 'ff'.repeat(33),
  pkScript: '51'.repeat(17),
  lockupAddress: 'ark1qlockup',
  refundPkScript: '51'.repeat(17),
  solverReceiverPkScript: '52'.repeat(17),
  clientRefundPubkey: 'cc'.repeat(32),
  rfqId: null,
}

const harness = async (payInvoice: LnAssetSendDeps['ln']['payInvoice']) => {
  const store = await LnAssetSendSwapStore.open(':memory:', () => NOW)
  const errors: unknown[] = []
  const deps = {
    store,
    market,
    arkade: {
      providerPubkey: 'dd'.repeat(32),
      serverPubkey: 'ee'.repeat(32),
      emulatorPubkey: 'ff'.repeat(33),
      receiverPkScript: '52'.repeat(17),
      delays: { unilateralClaimDelay: 512, unilateralRefundDelay: 1024, unilateralRefundWithoutReceiverDelay: 2048 },
      hrp: 'ark',
      findLockups: async () => [
        { txid: 'ab'.repeat(32), vout: 0, value: 330, assets: [{ assetId: ASSET, amount: 500_000n }] },
      ],
      claim: async () => 'cd'.repeat(32),
      assetBalance: async () => 10n ** 18n,
    },
    ln: {
      routeCltvBudgetBlocks: 400,
      enforcesRouteCltv: true,
      payInvoice,
      getPayment: async () => null,
    },
    buildCovenant: () => ({ pkScript: '51'.repeat(17), lockupAddress: 'ark1qlockup' }),
    decodeInvoice: () => ({
      invoice: quote.invoice,
      paymentHash: quote.paymentHash,
      amountSats: quote.payoutSats,
      expiresAt: quote.invoiceExpiresAt,
      network: 'bcrt',
      minFinalCltvBlocks: 80,
      worstRouteHintCltvBlocks: 0,
      bestRouteHintCltvBlocks: 0,
    }),
    fetchPrice: async () => ({ mantissa: 100_000n, scale: 0 }),
    providerNetwork: 'bcrt',
    maxRoutingFeeSats: 100,
    maxExposedSats: 10_000_000,
    totalCommitted: async () => 0,
    admission: { admit: async () => ({ release: () => {} }) },
    onError: (_id: string, error: unknown) => errors.push(error),
    now: () => NOW,
  } as unknown as LnAssetSendDeps

  await store.insertQuote(quote)
  await store.transition('s1', 'quoted', 'funded', {})
  return { store, errors, service: new LnAssetSendSwapService(deps) }
}

describe('LnAssetSendSwapService — the payment call', () => {
  it('records the id a successful call returns', async () => {
    const { store, service } = await harness(async () => ({ id: 'pay-1', status: 'in_flight' }))
    await service.tick('s1')
    expect(await store.get('s1')).toMatchObject({ state: 'paying', paymentId: 'pay-1' })
    await store.close()
  })

  it('sticks a payment that threw with no id, rather than waiting on a receipt it cannot fetch', async () => {
    const { store, errors, service } = await harness(async () => {
      throw new Error('backend refused the call')
    })
    await service.tick('s1')
    const row = await store.get('s1')
    expect(row.state).toBe('stuck')
    expect(row.paymentId).toBeNull()
    expect(row.failureReason).toMatch(/outcome is unknown/)
    expect(errors).toHaveLength(1)
    await store.close()
  })
})
