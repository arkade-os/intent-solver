import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MultisigTapscript, VtxoScript } from '@arkade-os/sdk'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { buildOfferFillPlan } from '@arkade-os/swap'
import { createCarrierFillRebuilder } from '@arkade-os/solver-app/ops/assetRfqTaxiRebuild.js'
import type { CarrierFillRebuildRequest } from '@arkade-os/solver-app/ops/assetRfqTaxiSettle.js'

vi.mock('@arkade-os/swap', async (load) => ({
  ...(await load<typeof import('@arkade-os/swap')>()),
  buildOfferFillPlan: vi.fn(async () => {
    throw new Error('planner reached')
  }),
}))

const tree = new VtxoScript([
  MultisigTapscript.encode({ pubkeys: [schnorr.getPublicKey(new Uint8Array(32).fill(2))] }).script,
])
const txid = 'ab'.repeat(32)
const request = (spendLeaf: string): CarrierFillRebuildRequest =>
  ({
    row: { id: 'leaf-check' },
    physicalSats: 1n,
    contributionSats: 1n,
    maxFareSats: 0n,
    inputs: [],
    quote: {
      descriptor: { physicalSats: 1n },
      params: { topup: 1n },
      quote: {
        fare: { currency: 'sats', units: '0' },
        operatorScript: hex.encode(tree.pkScript),
        operatorInputs: [{ txid, vout: 3, value: '10', tapTree: hex.encode(tree.encode()), spendLeaf }],
      },
    },
  }) as unknown as CarrierFillRebuildRequest

beforeEach(() => vi.clearAllMocks())

describe('Taxi funding spend-leaf admission', () => {
  it('names the outpoint and missing leaf before invoking the planner', async () => {
    const rebuild = createCarrierFillRebuilder({ wallet: {} as never, arkServerUrl: 'http://unused' })
    await expect(rebuild(request('51'))).rejects.toThrow(`Taxi input ${txid}:3 spend leaf 51 is not in its tap tree`)
    expect(buildOfferFillPlan).not.toHaveBeenCalled()
  })

  it('passes the actual matching tapleaf to the planner', async () => {
    const rebuild = createCarrierFillRebuilder({ wallet: {} as never, arkServerUrl: 'http://unused' })
    await expect(rebuild(request(hex.encode(tree.scripts[0]!)))).rejects.toThrow('planner reached')
    expect(buildOfferFillPlan).toHaveBeenCalledOnce()
    expect(vi.mocked(buildOfferFillPlan).mock.calls[0]![3]?.sponsor?.fund[0]?.tapLeafScript).toEqual(
      tree.findLeaf(hex.encode(tree.scripts[0]!)),
    )
  })
})
