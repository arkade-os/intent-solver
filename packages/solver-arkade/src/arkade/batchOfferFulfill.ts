import {
  ArkAddress,
  arkade,
  asset,
  isVtxoSpent,
  RestEmulatorProvider,
  Transaction,
  type VirtualCoin,
} from '@arkade-os/sdk'
import {
  ASSET_SWAP_DIRECTED,
  ASSET_SWAP_DIRECTED_NONCE,
  bindingFromOffer,
  bindingProgram,
  type FillFunding,
  type Offer,
} from '@arkade-os/swap/protocol'
import { base64, hex } from '@scure/base'
import { vtxoPages } from './indexerPaging.js'
import { outpointKey } from './lockupFunding.js'
import { OfferNotSubmittedError, type OfferDepositOutpoint } from './offerFulfill.js'
import type { ArkadeContext } from './wallet.js'

export interface BatchOfferFill {
  offer: Offer
  deposit: OfferDepositOutpoint
}

export interface BatchOfferSubmitOptions {
  /**
   * Atomically claim every fill row and record the candidate txid just before the emulator request.
   * Returning false stops submission. A thrown callback leaves its database outcome unknown.
   */
  markSubmitting?: (txid: string) => Promise<boolean>
}

class BatchEmulatorProvider extends RestEmulatorProvider {
  constructor(
    url: string,
    private readonly markSubmitting?: BatchOfferSubmitOptions['markSubmitting'],
  ) {
    super(url)
  }

  override async submitTx(arkTx: string, checkpoints: string[]) {
    if (this.markSubmitting && !(await this.markSubmitting(Transaction.fromPSBT(base64.decode(arkTx)).id))) {
      throw new OfferNotSubmittedError('another attempt already holds the batch fill')
    }
    return super.submitTx(arkTx, checkpoints)
  }
}

const maxAssetAmount = (1n << 64n) - 1n
const maxSats = BigInt(Number.MAX_SAFE_INTEGER)

const keyOf = ({ txid, vout }: { txid: string; vout: number }): string => outpointKey(txid.toLowerCase(), vout)

const amountsOn = (coin: FillFunding | VirtualCoin): Map<string, bigint> => {
  const amounts = new Map<string, bigint>()
  for (const entry of coin.assets ?? []) {
    const id = asset.AssetId.fromString(entry.assetId).toString()
    if (typeof entry.amount === 'number' && !Number.isSafeInteger(entry.amount)) {
      throw new Error(`invalid amount for asset ${id} on ${keyOf(coin)}`)
    }
    const amount = BigInt(entry.amount)
    if (amount < 0n || amount > maxAssetAmount || amounts.has(id)) {
      throw new Error(`invalid asset balance for ${id} on ${keyOf(coin)}`)
    }
    amounts.set(id, amount)
  }
  return amounts
}

/**
 * Spend exact directed deposits in one transaction, pairing deposit input i with maker output i.
 * The caller chooses a group that fits the operator's transaction limits and single change output.
 */
export const fulfillOffers = async (
  ctx: ArkadeContext,
  emulatorUrl: string,
  fills: readonly BatchOfferFill[],
  funding: readonly FillFunding[],
  options?: BatchOfferSubmitOptions,
): Promise<string> => {
  if (fills.length < 2 || funding.length === 0) {
    throw new OfferNotSubmittedError('a batch fill needs at least two offers and wallet funding')
  }
  const deposits = fills.map(({ deposit }) => deposit)
  const inputs = [...deposits, ...funding]
  const reservations = ctx.reservations.reserved()
  const seen = new Set<string>()
  for (const input of inputs) {
    const key = keyOf(input)
    if (
      !/^[0-9a-f]{64}$/i.test(input.txid) ||
      !Number.isInteger(input.vout) ||
      input.vout < 0 ||
      input.vout > 0xffffffff
    ) {
      throw new Error(`invalid batch input outpoint ${key}`)
    }
    if (!Number.isSafeInteger(input.value) || input.value <= 0) {
      throw new Error(`invalid batch input value at ${key}`)
    }
    if (seen.has(key)) throw new Error(`duplicate batch fill input ${key}`)
    if (reservations.has(key)) throw new OfferNotSubmittedError(`batch fill input ${key} is reserved`)
    seen.add(key)
  }
  const release = ctx.reservations.reserve(inputs.map(({ txid, vout }) => ({ txid: txid.toLowerCase(), vout })))
  try {
    const { wallet } = ctx
    const minOutputSats = ctx.dustSats > ctx.vtxoMinSats ? ctx.dustSats : ctx.vtxoMinSats
    const emulatorKeys = new Set<string>()
    const bound = fills.map(({ offer, deposit }) => {
      if (offer.makerPkScript[0] !== 0x51 || offer.makerPkScript[1] !== 0x20 || offer.makerPkScript.length !== 34) {
        throw new Error('batch fills require a Taproot maker output')
      }
      const binding = bindingFromOffer(offer, wallet.arkServerPublicKey)
      if (binding.version !== ASSET_SWAP_DIRECTED && binding.version !== ASSET_SWAP_DIRECTED_NONCE) {
        throw new Error(`batch filling requires a directed covenant, got ${binding.version}`)
      }
      emulatorKeys.add(hex.encode(binding.emulatorPublicKey))
      return { offer, deposit, binding, contract: bindingProgram(binding) }
    })
    if (emulatorKeys.size !== 1) {
      throw new Error('batch offers must share an emulator key')
    }

    const [operatorInfo, address] = await Promise.all([wallet.arkProvider.getInfo(), wallet.getAddress()])
    const client = await arkade.Arkade.connect({
      arkade: { getInfo: async () => operatorInfo },
      indexer: wallet.indexerProvider,
      identity: wallet.identity,
      emulator: new BatchEmulatorProvider(emulatorUrl, options?.markSubmitting),
    })
    const maxOutputSats = operatorInfo.vtxoMaxAmount
    const userKey = client.userKey && hex.encode(client.userKey)
    if (hex.encode(client.serverKey) !== hex.encode(wallet.arkServerPublicKey)) {
      throw new Error('the operator signer changed since the wallet was opened')
    }
    if (bound.some(({ binding: { taker } }) => !taker || hex.encode(taker) !== userKey)) {
      throw new OfferNotSubmittedError('a batch offer was directed to a different taker')
    }

    const coins = new Map<string, VirtualCoin>()
    for await (const page of vtxoPages(wallet.indexerProvider, {
      outpoints: deposits.map(({ txid, vout }) => ({ txid: txid.toLowerCase(), vout })),
    })) {
      for (const coin of page) coins.set(keyOf(coin), coin)
    }
    const groups = new Map<string, arkade.AssetSpec>()
    const groupFor = (id: string): arkade.AssetSpec => {
      const group = groups.get(id) ?? { assetId: id, inputs: [], outputs: [] }
      groups.set(id, group)
      return group
    }
    const addAssets = (vin: number, amounts: ReadonlyMap<string, bigint>) => {
      for (const [id, amount] of amounts) {
        if (amount > 0n) groupFor(id).inputs.push({ vin, amount })
      }
    }
    const builder = client.transaction()
    let makerSats = 0n
    let depositSats = 0n
    for (const [
      index,
      {
        deposit,
        offer,
        contract: { program, args, keys },
      },
    ] of bound.entries()) {
      const contract = new arkade.ArkadeContract(client, program, args, keys)
      const key = keyOf(deposit)
      const coin = coins.get(key)
      if (!coin || isVtxoSpent(coin) || coin.isUnrolled || coin.isSwept) {
        throw new OfferNotSubmittedError(`batch deposit ${key} is no longer spendable`)
      }
      if (coin.script.toLowerCase() !== hex.encode(offer.swapPkScript) || coin.value !== deposit.value) {
        throw new Error(`batch deposit ${key} no longer matches its recorded script and value`)
      }
      const amounts = amountsOn(coin)
      if (offer.offerAsset) {
        const held = amounts.get(offer.offerAsset.toString()) ?? 0n
        if (held <= 0n || (deposit.assetAmount !== undefined && held < deposit.assetAmount)) {
          throw new Error(`batch deposit ${key} does not hold its recorded asset amount`)
        }
      }
      const wantedAsset = offer.wantAsset?.toString()
      const sats = wantedAsset === undefined ? offer.wantAmount : ctx.dustSats
      if (sats <= 0n || sats < minOutputSats || sats > maxSats) {
        throw new Error(`invalid maker output sats for batch deposit ${key}`)
      }
      if (maxOutputSats >= 0n && sats > maxOutputSats) {
        throw new OfferNotSubmittedError(`maker output for batch deposit ${key} exceeds the operator's VTXO limit`)
      }
      if (wantedAsset !== undefined) {
        if (offer.wantAmount <= 0n || offer.wantAmount > maxAssetAmount) {
          throw new Error(`invalid maker asset amount for batch deposit ${key}`)
        }
        groupFor(wantedAsset).outputs.push({ vout: index, amount: offer.wantAmount })
      }

      const unlock = contract.unlock.fulfill
      if (!unlock) throw new Error('directed batch offer has no fulfill leaf')
      // The covenant at input i checks the maker payment at output i.
      builder.from(coin, unlock()).to(offer.makerPkScript, sats)
      addAssets(index, amounts)
      makerSats += sats
      depositSats += BigInt(coin.value)
    }

    let fundingSats = 0n
    const fundingAssets = new Map<string, bigint>()
    for (const [index, coin] of funding.entries()) {
      fundingSats += BigInt(coin.value)
      const amounts = amountsOn(coin)
      addAssets(fills.length + index, amounts)
      for (const [id, amount] of amounts) fundingAssets.set(id, (fundingAssets.get(id) ?? 0n) + amount)
    }
    const changeSats = fundingSats + depositSats - makerSats
    if (fundingSats < makerSats || changeSats < minOutputSats) {
      throw new OfferNotSubmittedError('batch funding does not cover maker payouts and a solver change output')
    }
    if (maxOutputSats >= 0n && changeSats > maxOutputSats) {
      throw new OfferNotSubmittedError("batch change exceeds the operator's VTXO limit")
    }
    if (fundingSats + depositSats > maxSats) throw new Error('batch input total exceeds the safe integer domain')
    builder.fund([...funding]).to(ArkAddress.decode(address).pkScript, changeSats)
    for (const [id, group] of groups) {
      const paid = group.outputs.reduce((sum, output) => sum + BigInt(output.amount), 0n)
      if ((fundingAssets.get(id) ?? 0n) < paid) {
        throw new OfferNotSubmittedError(`batch funding does not cover the maker payouts in ${id}`)
      }
      const remainder = group.inputs.reduce((sum, input) => sum + BigInt(input.amount), 0n) - paid
      if (remainder > maxAssetAmount) throw new Error(`batch asset change in ${id} exceeds the amount limit`)
      if (remainder > 0n) group.outputs.push({ vout: fills.length, amount: remainder })
      builder.withAsset(group)
    }
    return (await builder.send()).txid
  } finally {
    release()
  }
}
