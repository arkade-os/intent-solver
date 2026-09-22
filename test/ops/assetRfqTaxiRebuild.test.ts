/**
 * Rebuilding the quoted graph from the solver's own inputs.
 *
 * Every fixture here is a REAL graph: `buildOffchainTx` builds it, the
 * checkpoints are genuine PSBTs and the digest is `digestJointGraph`'s — so
 * recovery is tested against bytes the production builder wrote, not against a
 * hand-shaped object that would accept anything.
 */

import { describe, it, expect } from 'vitest'
import { base64, hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { buildOffchainTx, CSVMultisigTapscript, DefaultVtxo, Transaction } from '@arkade-os/sdk'
import { digestJointGraph, OFFER_FILL_TEMPLATE, verifyOfferFillPlan } from '@arkade-taxi/client'
import type { AssetRfqSwapRow } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import type { CarrierCoin } from '@arkade-os/solver-app/ops/assetRfqTaxi.js'
import {
  createCarrierFillRebuilder,
  recoverJointFunding,
  sponsorLegFrom,
} from '@arkade-os/solver-app/ops/assetRfqTaxiRebuild.js'

const ASSET = `${'aa'.repeat(31)}bb0100`
const DEPOSIT_TXID = '1'.repeat(64)
const COIN_A = '2'.repeat(64)
const SPONSOR_TXID = '3'.repeat(64)

const xonly = (seed: number): string => hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(seed)))
const SERVER = xonly(9)

const vtxoScript = (seed: number) =>
  new DefaultVtxo.Script({
    pubKey: hex.decode(xonly(seed)),
    serverPubKey: hex.decode(SERVER),
    csvTimelock: { type: 'blocks', value: 144n },
  })

const SERVER_UNROLL = CSVMultisigTapscript.encode({
  timelock: { type: 'blocks', value: 144n },
  pubkeys: [hex.decode(SERVER)],
})

const MAKER = vtxoScript(4).pkScript
const SPONSOR_SCRIPT = vtxoScript(5).pkScript
const PROCEEDS = vtxoScript(6).pkScript

const input = (seed: number, txid: string, vout: number, value: number) => {
  const s = vtxoScript(seed)
  return { txid, vout, value, tapLeafScript: s.forfeit(), tapTree: s.encode() }
}

const DEPOSIT = input(1, DEPOSIT_TXID, 1, 1_000)
const SOLVER = input(2, COIN_A, 0, 2_000)
const SPONSOR = input(3, SPONSOR_TXID, 7, 5_000)

/** `[receiver 330, sponsor-change 1500, solver 6170]` over the three inputs. */
const built = buildOffchainTx(
  [DEPOSIT, SOLVER, SPONSOR],
  [
    { script: MAKER, amount: 330n },
    { script: SPONSOR_SCRIPT, amount: 1_500n },
    { script: PROCEEDS, amount: 6_170n },
  ],
  SERVER_UNROLL,
)

const ARK_TX = base64.encode(built.arkTx.toPSBT())
const CHECKPOINTS = built.checkpoints.map((c) => base64.encode(c.toPSBT()))
const INPUT_OWNERS: readonly (string | null)[] = [null, 'solver', 'sponsor']
const GRAPH_ID = digestJointGraph(
  { arkTx: ARK_TX, checkpoints: CHECKPOINTS, inputOwners: INPUT_OWNERS },
  OFFER_FILL_TEMPLATE,
)

type Wire = Parameters<typeof recoverJointFunding>[0]

const wire = (over: Partial<Wire> = {}): Wire =>
  ({
    arkTx: ARK_TX,
    checkpoints: [...CHECKPOINTS],
    graphId: GRAPH_ID,
    template: 'taxi-fill/1',
    inputs: [
      { owner: 'offer-covenant', txid: DEPOSIT_TXID, vout: 1 },
      { owner: 'solver', txid: COIN_A, vout: 0 },
      { owner: 'sponsor', txid: SPONSOR_TXID, vout: 7 },
    ],
    outputs: [
      { role: 'receiver', vout: 0, script: hex.encode(MAKER), sats: '330', assets: [] },
      { role: 'sponsor-change', vout: 1, script: hex.encode(SPONSOR_SCRIPT), sats: '1500', assets: [] },
      { role: 'solver', vout: 2, script: hex.encode(PROCEEDS), sats: '6170', assets: [] },
    ],
    ...over,
  }) as Wire

const row = (over: Partial<AssetRfqSwapRow> = {}): AssetRfqSwapRow =>
  ({
    id: 'swap-1',
    depositTxid: DEPOSIT_TXID,
    depositVout: 1,
    toAssetId: ASSET,
    toAmount: 10n,
    makerPkScript: hex.encode(MAKER),
    ...over,
  }) as AssetRfqSwapRow

const solverCoin = (over: Partial<CarrierCoin> = {}): CarrierCoin => ({
  txid: COIN_A,
  vout: 0,
  value: 2_000,
  expiresAtHeight: 1_200_000,
  assets: [{ assetId: ASSET, amount: 10n }],
  tapTree: SOLVER.tapTree,
  forfeitTapLeafScript: SOLVER.tapLeafScript,
  ...over,
})

const rebuildRequest = (over: Record<string, unknown> = {}) => ({
  row: row(),
  offerHex: 'abcd',
  inputs: [solverCoin()],
  proceedsScript: PROCEEDS,
  contributionSats: 329n,
  quotedGraph: wire(),
  ...over,
})

describe('recovering the sponsor leg from the quoted graph itself', () => {
  it('reads every input back out of the checkpoint that spends it, byte for byte', () => {
    const recovered = recoverJointFunding(wire(), 'carrier fill swap-1')

    expect(recovered).toHaveLength(3)
    for (const [i, original] of [DEPOSIT, SOLVER, SPONSOR].entries()) {
      expect(recovered[i]!.txid).toBe(original.txid)
      expect(recovered[i]!.vout).toBe(original.vout)
      expect(recovered[i]!.value).toBe(original.value)
      expect(hex.encode(recovered[i]!.tapTree)).toBe(hex.encode(original.tapTree))
      expect(hex.encode(recovered[i]!.tapLeafScript[1])).toBe(hex.encode(original.tapLeafScript[1]))
    }
  })

  it('rebuilds the identical graph from what it recovered, which is the whole claim', () => {
    const recovered = recoverJointFunding(wire(), 'carrier fill swap-1')
    const again = buildOffchainTx(
      recovered.map(({ txid, vout, value, tapLeafScript, tapTree }) => ({ txid, vout, value, tapLeafScript, tapTree })),
      [
        { script: MAKER, amount: 330n },
        { script: SPONSOR_SCRIPT, amount: 1_500n },
        { script: PROCEEDS, amount: 6_170n },
      ],
      SERVER_UNROLL,
    )
    const arkTx = base64.encode(again.arkTx.toPSBT())
    const checkpoints = again.checkpoints.map((c) => base64.encode(c.toPSBT()))

    expect(arkTx).toBe(ARK_TX)
    expect(checkpoints).toEqual(CHECKPOINTS)
    expect(digestJointGraph({ arkTx, checkpoints, inputOwners: INPUT_OWNERS }, OFFER_FILL_TEMPLATE)).toBe(GRAPH_ID)
    expect(verifyOfferFillPlan({ arkTx, checkpoints, graphId: GRAPH_ID, inputOwners: [...INPUT_OWNERS] })).toBe(true)
  })

  it('refuses a checkpoint that spends an outpoint the wire does not claim', () => {
    const lying = wire({
      inputs: [
        { owner: 'offer-covenant', txid: DEPOSIT_TXID, vout: 1 },
        { owner: 'solver', txid: COIN_A, vout: 4 },
        { owner: 'sponsor', txid: SPONSOR_TXID, vout: 7 },
      ],
    } as Partial<Wire>)

    expect(() => recoverJointFunding(lying, 'carrier fill swap-1')).toThrow(/spends/)
  })

  it('refuses a checkpoint carrying no taproot tree to spend with', () => {
    const bare = new Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true })
    bare.addInput({ txid: SPONSOR_TXID, index: 7 })
    bare.addOutput({ script: PROCEEDS, amount: 5_000n })
    const stripped = wire({ checkpoints: [CHECKPOINTS[0]!, CHECKPOINTS[1]!, base64.encode(bare.toPSBT())] })

    expect(() => recoverJointFunding(stripped, 'carrier fill swap-1')).toThrow(/taptree|tap leaves|witness utxo/)
  })

  it('derives the contribution as the sponsor inputs less the change it is quoted', () => {
    const leg = sponsorLegFrom(wire(), recoverJointFunding(wire(), 'x'), 'x')

    expect(leg?.netContributionSats).toBe(3_500n)
    expect(leg?.fund.map((c) => c.txid)).toEqual([SPONSOR_TXID])
    expect(hex.encode(leg!.changeScript)).toBe(hex.encode(SPONSOR_SCRIPT))
    expect(leg?.fare).toBeUndefined()
  })

  it('carries an asset fare across, in the id form the builder takes', () => {
    const fared = wire({
      outputs: [
        { role: 'receiver', vout: 0, script: hex.encode(MAKER), sats: '330', assets: [] },
        {
          role: 'sponsor-fare',
          vout: 1,
          script: hex.encode(SPONSOR_SCRIPT),
          sats: '330',
          assets: [{ assetId: { txid: `${'bb'.repeat(1)}${'aa'.repeat(31)}`, groupIndex: 1 }, units: '4' }],
        },
        { role: 'sponsor-change', vout: 2, script: hex.encode(SPONSOR_SCRIPT), sats: '1170', assets: [] },
        { role: 'solver', vout: 3, script: hex.encode(PROCEEDS), sats: '6170', assets: [] },
      ],
    } as Partial<Wire>)

    const leg = sponsorLegFrom(fared, recoverJointFunding(fared, 'x'), 'x')

    expect(leg?.netContributionSats).toBe(3_830n)
    expect(leg?.fare?.assetId).toBe(ASSET)
    expect(leg?.fare?.amount).toBe(4n)
    expect(leg?.fare?.sats).toBe(330n)
  })

  it('answers no sponsor leg at all when the operator funds none', () => {
    const alone = wire({
      inputs: [
        { owner: 'offer-covenant', txid: DEPOSIT_TXID, vout: 1 },
        { owner: 'solver', txid: COIN_A, vout: 0 },
      ],
      checkpoints: [CHECKPOINTS[0]!, CHECKPOINTS[1]!],
    } as Partial<Wire>)

    expect(sponsorLegFrom(alone, recoverJointFunding(alone, 'x'), 'x')).toBeUndefined()
  })
})

describe('the rebuild takes the operator only for what it cannot know', () => {
  const capture = () => {
    const seen: Record<string, unknown>[] = []
    const build = (async (_wallet: unknown, _url: unknown, _offer: unknown, opts: Record<string, unknown>) => {
      seen.push(opts)
      return { arkTx: ARK_TX, checkpoints: [...CHECKPOINTS], graphId: GRAPH_ID, inputOwners: [...INPUT_OWNERS] }
    }) as never
    return { seen, build }
  }

  it('funds the solver leg from its OWN coins and the sponsor leg from the quote', async () => {
    const { seen, build } = capture()
    const rebuild = createCarrierFillRebuilder({ wallet: {} as never, arkServerUrl: 'http://ark', build })

    await rebuild(rebuildRequest() as never)

    const opts = seen[0]!
    expect((opts.fund as { txid: string }[]).map((c) => c.txid)).toEqual([COIN_A])
    expect(hex.encode(opts.payoutScript as Uint8Array)).toBe(hex.encode(PROCEEDS))
    expect(opts.fundingOutpoint).toEqual({ txid: DEPOSIT_TXID, vout: 1 })
    expect(opts.assetCarrierSats).toBe(330n)
    expect((opts.sponsor as { netContributionSats: bigint }).netContributionSats).toBe(3_500n)
  })

  it('refuses a quote whose deposit is not the one the row recorded', async () => {
    const { build } = capture()
    const rebuild = createCarrierFillRebuilder({ wallet: {} as never, arkServerUrl: 'http://ark', build })
    const elsewhere = wire({
      inputs: [
        { owner: 'offer-covenant', txid: '9'.repeat(64), vout: 1 },
        { owner: 'solver', txid: COIN_A, vout: 0 },
        { owner: 'sponsor', txid: SPONSOR_TXID, vout: 7 },
      ],
    } as Partial<Wire>)

    await expect(rebuild(rebuildRequest({ quotedGraph: elsewhere }) as never)).rejects.toThrow(/deposit/)
  })

  it('refuses a quote that relabels one of the solver coins as the sponsor', async () => {
    const { build } = capture()
    const rebuild = createCarrierFillRebuilder({ wallet: {} as never, arkServerUrl: 'http://ark', build })
    const stolen = wire({
      inputs: [
        { owner: 'offer-covenant', txid: DEPOSIT_TXID, vout: 1 },
        { owner: 'sponsor', txid: COIN_A, vout: 0 },
        { owner: 'sponsor', txid: SPONSOR_TXID, vout: 7 },
      ],
    } as Partial<Wire>)

    await expect(rebuild(rebuildRequest({ quotedGraph: stolen }) as never)).rejects.toThrow(/solver inputs/)
  })

  it('refuses a solver coin that carries no taproot evidence to spend it with', async () => {
    const { build } = capture()
    const rebuild = createCarrierFillRebuilder({ wallet: {} as never, arkServerUrl: 'http://ark', build })
    const blind = solverCoin({ tapTree: undefined, forfeitTapLeafScript: undefined })

    await expect(rebuild(rebuildRequest({ inputs: [blind] }) as never)).rejects.toThrow(/taproot evidence/)
  })
})
