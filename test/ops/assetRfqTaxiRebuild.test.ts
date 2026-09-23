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

/** The BUILT graph nets 4170 against a floor of 1000 + 3500 - 330 - 4 = 4166. */
const AUTHORISED = { physicalSats: 330n, contributionSats: 3_500n, maxFareSats: 4n }

const rebuildRequest = (over: Record<string, unknown> = {}) => ({
  row: row(),
  offerHex: 'abcd',
  inputs: [solverCoin()],
  proceedsScript: PROCEEDS,
  ...AUTHORISED,
  quotedGraph: wire(),
  ...over,
})

const priced = (over: { carrier?: string; fare?: string; change?: string; payout?: string }): Partial<Wire> =>
  ({
    outputs: [
      { role: 'receiver', vout: 0, script: hex.encode(MAKER), sats: over.carrier ?? '330', assets: [] },
      ...(over.fare === undefined
        ? []
        : [{ role: 'sponsor-fare', vout: 1, script: hex.encode(SPONSOR_SCRIPT), sats: over.fare, assets: [] }]),
      { role: 'sponsor-change', vout: 2, script: hex.encode(SPONSOR_SCRIPT), sats: over.change ?? '1500', assets: [] },
      { role: 'solver', vout: 3, script: hex.encode(PROCEEDS), sats: over.payout ?? '6170', assets: [] },
    ],
  }) as Partial<Wire>

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

  it('builds the leg on the authorised contribution, having compared the quote to it', () => {
    const leg = sponsorLegFrom(wire(), recoverJointFunding(wire(), 'x'), 'x', AUTHORISED)

    expect(leg?.netContributionSats).toBe(3_500n)
    expect(leg?.fund.map((c) => c.txid)).toEqual([SPONSOR_TXID])
    expect(hex.encode(leg!.changeScript)).toBe(hex.encode(SPONSOR_SCRIPT))
    expect(leg?.fare).toBeUndefined()
  })

  it('refuses a fare carrying an asset, which is the whole offered leg to take', () => {
    const fared = wire({
      outputs: [
        { role: 'receiver', vout: 0, script: hex.encode(MAKER), sats: '330', assets: [] },
        {
          role: 'sponsor-fare',
          vout: 1,
          script: hex.encode(SPONSOR_SCRIPT),
          sats: '4',
          assets: [{ assetId: { txid: `${'bb'.repeat(1)}${'aa'.repeat(31)}`, groupIndex: 1 }, units: '10' }],
        },
        { role: 'sponsor-change', vout: 2, script: hex.encode(SPONSOR_SCRIPT), sats: '1500', assets: [] },
        { role: 'solver', vout: 3, script: hex.encode(PROCEEDS), sats: '6166', assets: [] },
      ],
    } as Partial<Wire>)

    expect(() => sponsorLegFrom(fared, recoverJointFunding(fared, 'x'), 'x', AUTHORISED)).toThrow(/carrying assets/)
  })

  it('refuses a fare over the cap before it can be built with', () => {
    const greedy = wire(priced({ fare: '10', payout: '6160' }))

    expect(() => sponsorLegFrom(greedy, recoverJointFunding(greedy, 'x'), 'x', AUTHORISED)).toThrow(/over the 4/)
  })

  it('answers no sponsor leg at all when the operator funds none', () => {
    const alone = wire({
      inputs: [
        { owner: 'offer-covenant', txid: DEPOSIT_TXID, vout: 1 },
        { owner: 'solver', txid: COIN_A, vout: 0 },
      ],
      checkpoints: [CHECKPOINTS[0]!, CHECKPOINTS[1]!],
    } as Partial<Wire>)

    expect(sponsorLegFrom(alone, recoverJointFunding(alone, 'x'), 'x', AUTHORISED)).toBeUndefined()
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

  it('builds with the sats it authorised, never the ones the quote priced itself at', async () => {
    const { seen, build } = capture()
    const rebuild = createCarrierFillRebuilder({ wallet: {} as never, arkServerUrl: 'http://ark', build })

    await rebuild(rebuildRequest({ physicalSats: 330n, contributionSats: 3_500n }) as never)

    // Both come from the request; an agreeing quote is consistent, not a source.
    expect(seen[0]!.assetCarrierSats).toBe(330n)
    expect((seen[0]!.sponsor as { netContributionSats: bigint }).netContributionSats).toBe(3_500n)
  })
})

/** Every quote here names the right parties and would hash to its own id, and
 * moves the wrong sats. */
describe('the rebuild refuses a quote priced against the solver', () => {
  const rebuilder = () =>
    createCarrierFillRebuilder({
      wallet: {} as never,
      arkServerUrl: 'http://ark',
      build: (async () => ({
        arkTx: ARK_TX,
        checkpoints: [...CHECKPOINTS],
        graphId: GRAPH_ID,
        inputOwners: [...INPUT_OWNERS],
      })) as never,
    })

  it('refuses a carrier the operator sized for itself', async () => {
    const quote = wire(priced({ carrier: '331', payout: '6169' }))

    await expect(rebuilder()(rebuildRequest({ quotedGraph: quote }) as never)).rejects.toThrow(/sat carrier/)
  })

  it('refuses a sponsor contributing less than the quote it was authorised for', async () => {
    const quote = wire(priced({ change: '1510', payout: '6160' }))

    await expect(rebuilder()(rebuildRequest({ quotedGraph: quote }) as never)).rejects.toThrow(/contributing 3490/)
  })

  it('refuses a fare over the cap taken straight out of the payout', async () => {
    // Contribution untouched at 3500: the ten sats come from the solver alone.
    const quote = wire(priced({ fare: '10', payout: '6160' }))

    await expect(rebuilder()(rebuildRequest({ quotedGraph: quote }) as never)).rejects.toThrow(/over the 4/)
  })

  it('refuses an inflated fare that declares a payout to match, which no byte checks', async () => {
    // A floor measured on the WIRE passes here while the built graph pays 10.
    const quote = wire(priced({ fare: '10' }))

    await expect(rebuilder()(rebuildRequest({ quotedGraph: quote }) as never)).rejects.toThrow(/nets the solver|fare/)
  })

  it('refuses a fare carrying an asset, which moves no sats for a floor to see', async () => {
    const quote = wire({
      outputs: [
        { role: 'receiver', vout: 0, script: hex.encode(MAKER), sats: '330', assets: [] },
        {
          role: 'sponsor-fare',
          vout: 1,
          script: hex.encode(SPONSOR_SCRIPT),
          sats: '4',
          assets: [{ assetId: { txid: `${'bb'.repeat(1)}${'aa'.repeat(31)}`, groupIndex: 1 }, units: '10' }],
        },
        { role: 'sponsor-change', vout: 2, script: hex.encode(SPONSOR_SCRIPT), sats: '1500', assets: [] },
        { role: 'solver', vout: 3, script: hex.encode(PROCEEDS), sats: '6166', assets: [] },
      ],
    } as Partial<Wire>)

    await expect(rebuilder()(rebuildRequest({ quotedGraph: quote }) as never)).rejects.toThrow(/carrying assets/)
  })

  it('admits a fare inside the cap, which is what the cap is for', async () => {
    const quote = wire(priced({ fare: '4', payout: '6166' }))

    await expect(rebuilder()(rebuildRequest({ quotedGraph: quote }) as never)).resolves.toMatchObject({
      graphId: GRAPH_ID,
    })
  })

  it('measures the graph it BUILT, so a short payout fails even with a clean quote', async () => {
    // The quote passes every wire comparison; only the built bytes are short.
    const short = buildOffchainTx(
      [DEPOSIT, SOLVER, SPONSOR],
      [
        { script: MAKER, amount: 330n },
        { script: SPONSOR_SCRIPT, amount: 1_500n },
        { script: PROCEEDS, amount: 6_160n },
      ],
      SERVER_UNROLL,
    )
    const rebuild = createCarrierFillRebuilder({
      wallet: {} as never,
      arkServerUrl: 'http://ark',
      build: (async () => ({
        arkTx: base64.encode(short.arkTx.toPSBT()),
        checkpoints: short.checkpoints.map((c) => base64.encode(c.toPSBT())),
        graphId: GRAPH_ID,
        inputOwners: [...INPUT_OWNERS],
      })) as never,
    })

    await expect(rebuild(rebuildRequest() as never)).rejects.toThrow(/nets the solver 4160/)
  })
})

describe('a rebuild over tampered funding cannot reach the quoted digest', () => {
  it('produces a different graph id when one sponsor value is moved by a sat', () => {
    const recovered = recoverJointFunding(wire(), 'carrier fill swap-1')
    const tampered = recovered.map((coin, i) => (i === 2 ? { ...coin, value: coin.value + 1 } : coin))
    const again = buildOffchainTx(
      tampered.map(({ txid, vout, value, tapLeafScript, tapTree }) => ({ txid, vout, value, tapLeafScript, tapTree })),
      [
        { script: MAKER, amount: 330n },
        { script: SPONSOR_SCRIPT, amount: 1_500n },
        { script: PROCEEDS, amount: 6_170n },
      ],
      SERVER_UNROLL,
    )
    const arkTx = base64.encode(again.arkTx.toPSBT())
    const checkpoints = again.checkpoints.map((c) => base64.encode(c.toPSBT()))

    expect(digestJointGraph({ arkTx, checkpoints, inputOwners: INPUT_OWNERS }, OFFER_FILL_TEMPLATE)).not.toBe(GRAPH_ID)
  })
})
