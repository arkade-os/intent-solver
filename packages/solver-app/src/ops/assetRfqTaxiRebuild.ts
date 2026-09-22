/**
 * Rebuilding the quoted fill graph from the solver's own inputs.
 *
 * The sponsor's coins are the operator's to pick and the structured wire names
 * only their outpoints — but every quoted CHECKPOINT PSBT carries the whole
 * `ArkTxInput` its input was built from, tap tree and leaf included, because
 * that is what `buildCheckpointTx` writes. So the sponsor leg is read back out
 * of the quote's own bytes while the solver leg stays the solver's, and the
 * `graphId` the caller then compares is what proves the assembly over both is
 * the canonical one rather than the operator's word for it.
 */

import { base64, hex } from '@scure/base'
import { asset, getArkPsbtFields, Transaction, VtxoTaprootTree, type IWallet, type TapLeafScript } from '@arkade-os/sdk'
import { buildOfferFillPlan, type JointGraph, type TaxiClient } from '@arkade-taxi/client'
import type { CarrierFillRebuildRequest } from './assetRfqTaxiSettle.js'
import type { CarrierCoin } from './assetRfqTaxi.js'

type SwapFillGraphWire = Parameters<TaxiClient['submitSwapFill']>[1]
type SwapFillGraphInputWire = SwapFillGraphWire['inputs'][number]

/** Exactly `ArkTxInput`: what the SDK needs to spend a coin it does not hold. */
export interface CarrierJointFunding {
  txid: string
  vout: number
  value: number
  tapLeafScript: TapLeafScript
  tapTree: Uint8Array
}

export interface CarrierSponsorLeg {
  fund: CarrierJointFunding[]
  netContributionSats: bigint
  changeScript: Uint8Array
  fare?: { assetId?: string; amount?: bigint; script: Uint8Array; sats: bigint }
}

const MAX_SATS = BigInt(Number.MAX_SAFE_INTEGER)

const fundingFromCheckpoint = (psbt: string, claimed: SwapFillGraphInputWire, label: string): CarrierJointFunding => {
  const checkpoint = Transaction.fromPSBT(base64.decode(psbt))
  if (checkpoint.inputsLength !== 1) {
    throw new Error(`${label} checkpoint spends ${checkpoint.inputsLength} inputs, not the one it is for`)
  }
  const input = checkpoint.getInput(0)
  const txid = input.txid === undefined ? '' : hex.encode(input.txid)
  if (txid !== claimed.txid.toLowerCase() || input.index !== claimed.vout) {
    throw new Error(`${label} checkpoint spends ${txid}:${String(input.index)}, not ${claimed.txid}:${claimed.vout}`)
  }
  const leaves = input.tapLeafScript ?? []
  if (leaves.length !== 1) throw new Error(`${label} checkpoint carries ${leaves.length} tap leaves, not one`)
  const trees = getArkPsbtFields(checkpoint, 0, VtxoTaprootTree)
  if (trees.length !== 1) throw new Error(`${label} checkpoint carries ${trees.length} taptrees, not one`)
  const amount = input.witnessUtxo?.amount
  if (amount === undefined) throw new Error(`${label} checkpoint declares no witness utxo to value its input`)
  if (amount < 0n || amount > MAX_SATS) throw new Error(`${label} checkpoint values its input at ${amount} sats`)
  return { txid, vout: input.index!, value: Number(amount), tapLeafScript: leaves[0]!, tapTree: trees[0]! }
}

export const recoverJointFunding = (wire: SwapFillGraphWire, label: string): readonly CarrierJointFunding[] => {
  if (wire.checkpoints.length !== wire.inputs.length) {
    throw new Error(`${label} quotes ${wire.inputs.length} inputs against ${wire.checkpoints.length} checkpoints`)
  }
  return wire.inputs.map((claimed, i) => fundingFromCheckpoint(wire.checkpoints[i]!, claimed, `${label} input ${i}`))
}

/** Taxi carries the genesis txid in INTERNAL byte order; the swap builder takes
 * the display-order string. */
const swapAssetIdFrom = (id: { txid: string; groupIndex: number }, label: string): string => {
  if (!/^[0-9a-f]{64}$/.test(id.txid)) throw new Error(`${label} names a non-canonical asset genesis`)
  return asset.AssetId.create(hex.encode(Uint8Array.from(hex.decode(id.txid)).reverse()), id.groupIndex).toString()
}

export const sponsorLegFrom = (
  wire: SwapFillGraphWire,
  funding: readonly CarrierJointFunding[],
  label: string,
): CarrierSponsorLeg | undefined => {
  const fund = wire.inputs.flatMap((input, i) => (input.owner === 'sponsor' ? [funding[i]!] : []))
  if (fund.length === 0) return undefined
  const change = wire.outputs.find((output) => output.role === 'sponsor-change')
  const fare = wire.outputs.find((output) => output.role === 'sponsor-fare')
  // The sponsor pays its fare and its change to one script, which is what lets
  // the quote label two outputs that are otherwise identical.
  const script = change?.script ?? fare?.script
  if (script === undefined) throw new Error(`${label} quotes a sponsor leg that keeps neither a fare nor change`)
  const contribution = fund.reduce((total, coin) => total + BigInt(coin.value), 0n) - BigInt(change?.sats ?? '0')
  if (contribution <= 0n) throw new Error(`${label} quotes a sponsor contributing ${contribution} sats`)
  return {
    fund,
    netContributionSats: contribution,
    changeScript: hex.decode(script),
    ...(fare === undefined ? {} : { fare: fareFrom(fare, label) }),
  }
}

const fareFrom = (
  output: SwapFillGraphWire['outputs'][number],
  label: string,
): NonNullable<CarrierSponsorLeg['fare']> => {
  const assets = output.assets ?? []
  if (assets.length > 1) throw new Error(`${label} quotes a fare in ${assets.length} assets at once`)
  const held = assets[0]
  return {
    ...(held === undefined
      ? {}
      : { assetId: swapAssetIdFrom(held.assetId, `${label} fare`), amount: BigInt(held.units) }),
    script: hex.decode(output.script),
    sats: BigInt(output.sats),
  }
}

export interface CarrierFillRebuildDeps {
  wallet: IWallet
  arkServerUrl: string
  /** Seam for the tests that cannot reach an Arkade server. */
  build?: typeof buildOfferFillPlan
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
    // EVERY asset, not just the recycled one: arkd refuses a spend whose packet
    // omits an asset one of its inputs owns.
    assets: (coin.assets ?? []).map((held) => ({ assetId: held.assetId, amount: BigInt(held.amount) })),
  }
}

/**
 * What the quote is allowed to decide, checked before any of it is believed:
 * the covenant input must be the deposit THIS row recorded, and the inputs the
 * quote calls the solver's must be exactly the ones this call selected. Without
 * that, an operator could relabel a solver coin as its own and the rebuild
 * would faithfully reproduce a graph over money it never meant to lend.
 */
const assertQuotedOwnership = (wire: SwapFillGraphWire, request: CarrierFillRebuildRequest, label: string): void => {
  const covenant = wire.inputs[0]
  if (covenant?.owner !== 'offer-covenant') throw new Error(`${label} was quoted no offer deposit to spend`)
  if (covenant.txid.toLowerCase() !== request.row.depositTxid || covenant.vout !== request.row.depositVout) {
    throw new Error(`${label} was quoted the deposit ${covenant.txid}:${covenant.vout}, not the one the row recorded`)
  }
  const quoted = wire.inputs.flatMap((input) =>
    input.owner === 'solver' ? [`${input.txid.toLowerCase()}:${input.vout}`] : [],
  )
  const selected = request.inputs.map((coin) => `${coin.txid.toLowerCase()}:${coin.vout}`)
  if (quoted.join(',') !== selected.join(',')) {
    throw new Error(`${label} was quoted solver inputs ${quoted.join(',')}, not the ${selected.join(',')} it selected`)
  }
}

export const createCarrierFillRebuilder =
  (deps: CarrierFillRebuildDeps) =>
  async (request: CarrierFillRebuildRequest): Promise<JointGraph> => {
    const label = `carrier fill ${request.row.id}`
    const wire = request.quotedGraph
    assertQuotedOwnership(wire, request, label)
    const receiver = wire.outputs[0]
    if (receiver?.role !== 'receiver') throw new Error(`${label} was quoted no receiver output to pay the maker`)
    const sponsor = sponsorLegFrom(wire, recoverJointFunding(wire, label), label)
    return await (deps.build ?? buildOfferFillPlan)(deps.wallet, deps.arkServerUrl, request.offerHex, {
      fund: request.inputs.map((coin) => solverFunding(coin, label)),
      payoutScript: request.proceedsScript,
      fundingOutpoint: { txid: request.row.depositTxid!, vout: request.row.depositVout! },
      // The maker's output IS the carrier when the offer wants an asset, so the
      // quote states this rather than the default being assumed to match.
      assetCarrierSats: BigInt(receiver.sats),
      ...(sponsor === undefined ? {} : { sponsor }),
    })
  }
