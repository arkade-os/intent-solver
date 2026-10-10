/** Build from verified receive-quote funding and enforce the solver's own economics. */

import { base64, hex } from '@scure/base'
import { Extension, ExtensionNotFoundError, Transaction, VtxoScript, type IWallet } from '@arkade-os/sdk'
import { buildOfferFillPlan, type JointGraph } from '@arkade-os/swap'
import { messageOf } from '@arkade-os/solver-core/util/poll.js'
import type { AssetRfqSwapRow } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import type { CarrierFillRebuildRequest } from './assetRfqTaxiSettle.js'
import { canonicalDecimal, type CarrierCoin } from './assetRfqTaxi.js'

export interface CarrierAuthorisedSats {
  physicalSats: bigint
  contributionSats: bigint
  maxFareSats: bigint
}

/** Measure net solver sats, including folded fares, rather than trusting output role labels. */
export const assertSolverSatsFloor = (
  flow: { depositValue: bigint; solverInputsSum: bigint; solverPayout: bigint },
  authorised: CarrierAuthorisedSats,
  label: string,
): void => {
  const net = flow.solverPayout - flow.solverInputsSum
  const floor = flow.depositValue + authorised.contributionSats - authorised.physicalSats - authorised.maxFareSats
  if (net < floor) {
    throw new Error(
      `${label} nets the solver ${net} sats, under the ${floor} its authorised terms guarantee ` +
        `(deposit ${flow.depositValue} + contribution ${authorised.contributionSats} ` +
        `- carrier ${authorised.physicalSats} - fare cap ${authorised.maxFareSats})`,
    )
  }
}

export interface CarrierFillRebuildDeps {
  wallet: IWallet
  arkServerUrl: string
}

const solverFunding = (coin: CarrierCoin, label: string) => {
  if (coin.tapTree === undefined || coin.forfeitTapLeafScript === undefined) {
    throw new Error(`${label} input ${coin.txid}:${coin.vout} carries no taproot evidence to spend it with`)
  }
  return {
    txid: coin.txid,
    vout: coin.vout,
    value: coin.value,
    tapTree: coin.tapTree,
    tapLeafScript: coin.forfeitTapLeafScript,
    // Preserve all input assets, not just the recycled asset.
    assets: (coin.assets ?? []).map((held) => ({ assetId: held.assetId, amount: BigInt(held.amount) })),
  }
}

export const createCarrierFillRebuilder =
  (deps: CarrierFillRebuildDeps) =>
  async (request: CarrierFillRebuildRequest): Promise<JointGraph> => {
    const label = `carrier fill ${request.row.id}`
    const { quote, params, descriptor } = request.quote
    if (descriptor.physicalSats !== request.physicalSats || params.topup !== request.contributionSats) {
      throw new Error(`${label} receive quote changed its authorised carrier or loan`)
    }
    if (quote.fare.currency !== 'sats') throw new Error(`${label} authorises only a sats fare`)
    const fare = canonicalDecimal(quote.fare.units, `${label} fare`)
    if (fare > request.maxFareSats) throw new Error(`${label} fare exceeds its authorised cap`)
    const changeScript = hex.decode(quote.operatorScript)
    const sponsor = {
      fund: quote.operatorInputs.map((input, index) => {
        const value = canonicalDecimal(input.value, `${label} Taxi input ${index}`)
        if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} invalid Taxi input value`)
        if (input.assetPacket !== undefined) throw new Error(`${label} Taxi funding carries assets`)
        const tree = VtxoScript.decode(hex.decode(input.tapTree))
        return {
          txid: input.txid,
          vout: input.vout,
          value: Number(value),
          tapTree: tree.encode(),
          tapLeafScript: tree.findLeaf(input.spendLeaf),
        }
      }),
      netContributionSats: params.topup,
      changeScript,
      ...(fare === 0n ? {} : { fare: { script: changeScript, sats: fare }, combineSatsFareWithChange: true }),
    }
    const built = await buildOfferFillPlan(deps.wallet, deps.arkServerUrl, request.offerHex, {
      fund: request.inputs.map((coin) => solverFunding(coin, label)),
      payoutScript: request.proceedsScript,
      fundingOutpoint: { txid: request.row.depositTxid!, vout: request.row.depositVout! },
      assetCarrierSats: request.physicalSats,
      sponsor,
    })

    assertBuiltGraph(built, request, label)
    return built
  }

/** Conserve assets to the maker or solver: the sats floor cannot detect diverted units. */
export const assertAssetPayouts = (
  finalTx: Transaction,
  proceeds: string,
  row: Pick<AssetRfqSwapRow, 'toAssetId' | 'toAmount'>,
  label: string,
): void => {
  // Require a positive asset amount or paid === toAmount === 0 would pass.
  if (row.toAmount <= 0n) throw new Error(`${label} sells ${row.toAmount} of ${row.toAssetId}, which is nothing to pay`)
  const outputs = Array.from({ length: finalTx.outputsLength }, (_, i) => finalTx.getOutput(i))
  const groups = assetGroupsOf(finalTx, label)
  for (const group of groups) {
    const assetId = group.assetId?.toString() ?? 'an issuance'
    for (const output of group.outputs) {
      if (output.amount <= 0n) continue
      const script = outputs[output.vout]?.script
      const where = script === undefined ? 'nowhere' : hex.encode(script)
      if (output.vout !== 0 && where !== proceeds) {
        throw new Error(`${label} pays ${output.amount} of ${assetId} to ${where}, which is not ours`)
      }
    }
  }
  const toMaker = groups
    .flatMap((group) => group.outputs.map((output) => ({ assetId: group.assetId?.toString(), output })))
    .filter((entry) => entry.output.vout === 0 && entry.output.amount > 0n)
  const wanted = toMaker.filter((entry) => entry.assetId === row.toAssetId)
  const paid = wanted.reduce((total, entry) => total + entry.output.amount, 0n)
  if (paid !== row.toAmount || toMaker.length !== wanted.length) {
    throw new Error(`${label} does not pay the maker ${row.toAmount} of ${row.toAssetId} and nothing else`)
  }
}

const assetGroupsOf = (tx: Transaction, label: string) => {
  try {
    return Extension.fromTx(tx).getAssetPacket()?.groups ?? []
  } catch (error) {
    if (error instanceof ExtensionNotFoundError) return []
    const message = messageOf(error)
    throw new Error(`${label} could not decode its asset packet: ${message}`, { cause: error })
  }
}

const valueSpentBy = (checkpoint: Transaction, label: string): bigint => {
  const amount = checkpoint.getInput(0).witnessUtxo?.amount
  if (amount === undefined) throw new Error(`${label} declares no witness utxo to value its input`)
  return amount
}

/** Share the flow calculation and caller-selected deposit index with reconciliation. */
export const solverSatsFlow = (
  finalTx: Transaction,
  checkpoints: readonly Transaction[],
  inputOwners: readonly (string | null)[],
  depositIndex: number,
  proceedsScript: Uint8Array,
  label: string,
): { depositValue: bigint; solverInputsSum: bigint; solverPayout: bigint } => {
  if (inputOwners[depositIndex] !== null) throw new Error(`${label} names no offer deposit at input ${depositIndex}`)
  const proceeds = hex.encode(proceedsScript).toLowerCase()
  return {
    depositValue: valueSpentBy(checkpoints[depositIndex]!, `${label} deposit checkpoint`),
    solverInputsSum: inputOwners.reduce(
      (total, owner, i) =>
        owner === 'solver' ? total + valueSpentBy(checkpoints[i]!, `${label} checkpoint ${i}`) : total,
      0n,
    ),
    solverPayout: Array.from({ length: finalTx.outputsLength }, (_, i) => finalTx.getOutput(i)).reduce(
      (total, output) =>
        output?.script !== undefined && hex.encode(output.script) === proceeds ? total + (output.amount ?? 0n) : total,
      0n,
    ),
  }
}

/** The canonical assembler puts the deposit at input 0 as the only null owner. */
const assertBuiltGraph = (graph: JointGraph, request: CarrierFillRebuildRequest, label: string): void => {
  const finalTx = Transaction.fromPSBT(base64.decode(graph.arkTx))
  const checkpoints = graph.checkpoints.map((psbt) => Transaction.fromPSBT(base64.decode(psbt)))
  assertSolverSatsFloor(
    solverSatsFlow(finalTx, checkpoints, graph.inputOwners, 0, request.proceedsScript, label),
    request,
    label,
  )
  assertAssetPayouts(finalTx, hex.encode(request.proceedsScript).toLowerCase(), request.row, label)
}
