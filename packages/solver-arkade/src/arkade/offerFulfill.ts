/**
 * Settle an offer: spend the maker's deposit through its fulfill leaf, paying
 * the maker what the covenant obliges, in one Ark transaction.
 *
 * Swap Protocol V1 § 4. The covenant is what makes this trustless for the
 * maker: the fulfill leaf's second key is the emulator's, tweaked by a commitment
 * to `FulfillScript`, so the emulator's signature is only obtainable for a
 * transaction whose outputs satisfy that script. A wrong destination or a short
 * value is refused by the emulator — that is the security model working, not an
 * error to route around.
 *
 * Settles for real on regtest — `test/e2e/assetOffer.e2e.test.ts` publishes an
 * offer and fills it, and arkd accepts the result. Still MONEY PATH and still
 * unreviewed by a human: it spends someone else's deposit against a covenant,
 * and a subtle error does not throw, it produces a transaction that will not
 * confirm or pays the wrong output.
 */
import {
  ArkAddress,
  buildOffchainTx,
  selectVirtualCoins,
  selectCoinsWithAsset,
  createAssetPacket,
  setArkPsbtField,
  PrevArkTxField,
  EmulatorPacket,
  RestEmulatorProvider,
  Transaction,
  type ExtendedVirtualCoin,
  type TapLeafScript,
  type Recipient,
} from '@arkade-os/sdk'
import { offerVtxoScript, type Offer } from '@arkade-os/swap'
import { base64, hex } from '@scure/base'
import { attachEmulatorPackets, EMPTY_RAW_WITNESS, type ArkadeContext } from './wallet.js'
import { offerIsConsistent } from './offerConsistency.js'

/** The dust carrier output[0] takes when the maker is paid in an ASSET, not sats. */
export const ASSET_CARRIER_SATS = 330n

export interface OfferDepositOutpoint {
  txid: string
  vout: number
  value: number
  /**
   * How much of the offer's asset this deposit holds, OBSERVED at the script.
   *
   * Not on `Offer`: the packet has no field for what was deposited, because
   * that is a fact about the chain rather than a claim the maker makes.
   * @see offerFill.ts
   */
  assetAmount?: bigint
}

/**
 * Fulfil one offer and return the settled ark txid.
 *
 * Both directions: an asset-wanting maker is paid through the asset packet with
 * a 330-sat carrier at output[0], and an asset DEPOSIT is routed to us the same
 * way. Exactly one leg names an asset (§ 2.1), and both being set is refused.
 */
export const fulfillOffer = async (
  ctx: ArkadeContext,
  emulatorUrl: string,
  offer: Offer,
  deposit: OfferDepositOutpoint,
): Promise<string> => {
  const serverPubkey = ctx.wallet.arkServerPublicKey
  if (!offerIsConsistent(offer, serverPubkey)) {
    // § 5.1: a taker MUST abort on mismatch. Checked again here rather than
    // trusted from the caller, because this is the function that spends.
    throw new Error('offer inconsistency: the script does not encode the stated terms')
  }
  if (offer.wantAsset !== undefined && offer.offerAsset !== undefined) {
    throw new Error('an offer names an asset on exactly one leg, not both')
  }

  const script = offerVtxoScript(offer, serverPubkey)
  const fulfill = script.functionByName('fulfill')
  if (!fulfill?.arkadeScript) throw new Error('the offer script has no fulfill function to spend')

  // What the covenant obliges output[0] to carry, and the whole reason the
  // emulator will co-sign.
  const wantAmount = offer.wantAmount

  // Our own coins fund the maker payment; the deposit itself comes back to us.
  const wantedAssetId = offer.wantAsset?.toString()
  const depositAssetId = offer.offerAsset?.toString()
  const spendable = (await ctx.wallet.getVtxos()) as ExtendedVirtualCoin[]

  // What output[0] must carry in SATS. An asset-wanting maker is paid through
  // the asset packet, so its BTC leg is only the dust carrier (§ 4.1).
  const makerSats = wantedAssetId === undefined ? wantAmount : ASSET_CARRIER_SATS

  // Coins that carry the wanted ASSET when there is one, otherwise coins that
  // carry enough sats. Either way this is what funds the maker.
  let funding: ExtendedVirtualCoin[]
  try {
    if (wantedAssetId === undefined) {
      funding = selectVirtualCoins(spendable, Number(makerSats)).inputs ?? []
    } else {
      // Only the coins are taken from the helper. The surplus it gathered above
      // `wantAmount` is ours, and `buildAssetPacket` routes it back by deriving
      // the taker's side from the carried totals — a second subtraction here
      // would be a caller-side duplicate of a job already discharged there.
      funding = selectCoinsWithAsset(spendable, wantedAssetId, wantAmount).selected
    }
  } catch (error) {
    const held = spendable.reduce((total, coin) => total + BigInt(coin.value), 0n)
    throw new Error(
      `no spendable coins to pay the maker ${wantAmount} ${wantedAssetId ?? 'sats'} (holding ${held} sats): ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (funding.length === 0) throw new Error(`no spendable coins to pay the maker ${wantAmount} sats`)

  const inputs = [
    // vin 0 is the swap VTXO, spent through the fulfill leaf.
    {
      txid: deposit.txid,
      vout: deposit.vout,
      value: deposit.value,
      tapLeafScript: fulfill.tapLeafScript as TapLeafScript,
      tapTree: script.encode(),
    },
    ...funding.map((coin) => ({
      txid: coin.txid,
      vout: coin.vout,
      value: coin.value,
      tapLeafScript: coin.forfeitTapLeafScript,
      tapTree: coin.tapTree,
    })),
  ]

  // § 4.1. output[0] is the maker's, and its value and script are exactly what
  // the emulator checks. Everything else — the deposit plus our change — merges
  // into output[1] rather than becoming sub-dust outputs.
  const funded = funding.reduce((total, coin) => total + BigInt(coin.value), 0n)
  const change = funded + BigInt(deposit.value) - makerSats
  if (change < 0n) throw new Error(`selected ${funded} sats plus the deposit cannot pay ${makerSats}`)

  const takerPkScript = ArkAddress.decode(await ctx.wallet.getAddress()).pkScript
  const outputs = [
    { script: offer.makerPkScript, amount: makerSats },
    ...(change > 0n ? [{ script: takerPkScript, amount: change }] : []),
  ]

  const { arkTx, checkpoints } = buildOffchainTx(inputs, outputs, ctx.wallet.serverUnrollScript)

  // Each input must prove its prevout, the same way refundSwapScript does.
  const txids = [...new Set(inputs.map((input) => input.txid))]
  const { txs } = await ctx.wallet.indexerProvider.getVirtualTxs(txids)
  const byTxid = new Map<string, Uint8Array>()
  for (const raw of txs) {
    const tx = Transaction.fromPSBT(base64.decode(raw))
    byTxid.set(tx.id, tx.toBytes(true))
  }
  inputs.forEach((input, vin) => {
    const source = byTxid.get(input.txid)
    if (!source) throw new Error(`indexer produced no virtual tx for ${input.txid}: cannot prove the prevout`)
    setArkPsbtField(arkTx, vin, PrevArkTxField, source)
  })

  // § 4.2: the emulator is told which input is gated by which Arkade-script, so
  // it can evaluate the covenant before co-signing. Only vin 0 is.
  const packets: Parameters<typeof attachEmulatorPackets>[1] = [
    EmulatorPacket.create([{ vin: 0, script: fulfill.arkadeScript, witness: EMPTY_RAW_WITNESS }]),
  ]

  // EVERY asset on EVERY input, not just the two the swap is about. arkd
  // refuses with ASSET_NOT_FOUND when a coin carries an asset the packet does
  // not declare, and coin selection picks for sats or for the wanted asset —
  // whatever else those coins happen to hold comes along.
  const carried = new Map<number, { assetId: string; amount: bigint }[]>()
  if (depositAssetId !== undefined && (deposit.assetAmount ?? 0n) > 0n) {
    carried.set(0, [{ assetId: depositAssetId, amount: deposit.assetAmount! }])
  }
  funding.forEach((coin, index) => {
    const assets = assetsOn(coin)
    if (assets.length > 0) carried.set(index + 1, assets)
  })

  const assetPacket = buildAssetPacket({ wantedAssetId, wantAmount, inputAssets: carried })
  if (assetPacket) packets.push(assetPacket)

  attachEmulatorPackets(arkTx, packets)

  // Signed AFTER the packets, which change the output set: a signature over the
  // pre-packet outputs would not match the transaction submitted. We sign our
  // own funding inputs and nothing on vin 0 — the fulfill leaf is the signer's
  // and the emulator's.
  const signedArkTx = await ctx.identity.sign(arkTx)
  const signedCheckpoints = await Promise.all(
    checkpoints.map(async (checkpoint) => {
      try {
        return await ctx.identity.sign(checkpoint, [0])
      } catch (error) {
        // The swap VTXO's checkpoint has no leaf of ours; leaving it untouched
        // is the same "sign what's ours, skip the rest" refundSwapScript needs.
        if (error instanceof Error && error.message.includes('No taproot scripts signed')) return checkpoint
        throw error
      }
    }),
  )

  const emulator = new RestEmulatorProvider(emulatorUrl)
  const result = await emulator.submitTx(
    base64.encode(signedArkTx.toPSBT()),
    signedCheckpoints.map((checkpoint) => base64.encode(checkpoint.toPSBT())),
  )
  const returned = Transaction.fromPSBT(base64.decode(result.signedArkTx))
  // Witnesses cannot change a txid, so a different one means a misrouted or
  // forged response — recording it as the fill would bury that.
  if (returned.id !== arkTx.id) {
    throw new Error(`emulator returned ark tx ${returned.id}, expected ${arkTx.id}`)
  }
  return returned.id
}

/** The maker's script, hex, for logging a fill against its offer. */
export const makerScriptHex = (offer: Offer): string => hex.encode(offer.makerPkScript)

/**
 * Assets a coin carries, normalised.
 *
 * `getVtxos` reports asset amounts as STRINGS while the contract manager
 * reports bigints, and an asset amount is 256-bit — so the string form is the
 * one that must not go near a `number`.
 */
const assetsOn = (coin: ExtendedVirtualCoin): { assetId: string; amount: bigint }[] => {
  const assets = (coin as unknown as { assets?: { assetId: string; amount: bigint | string }[] }).assets ?? []
  return assets
    .map((entry) => ({ assetId: entry.assetId, amount: BigInt(entry.amount) }))
    .filter((entry) => entry.amount > 0n)
}

/**
 * The asset packet for a fill, or null when no asset moves.
 *
 * TWO RULES, both learned from arkd refusing a real fill:
 *
 * 1. EVERY asset on EVERY input must appear, or arkd answers ASSET_NOT_FOUND.
 *    Coin selection picks for sats or for the wanted asset; whatever else those
 *    coins happen to hold comes along and must still be accounted for.
 * 2. THE WANTED ASSET MUST BE GROUP 0 (§ 4.2), because the fulfill script's
 *    `OP_INSPECTOUTASSETLOOKUP` uses `lookup_index = 0`. `createAssetPacket`
 *    orders groups by the order ids are first SEEN in `assetInputs`, a `Map`,
 *    so insertion order decides it — verified by building a packet both ways.
 *
 * Everything not owed to the maker goes back to us: an asset present on an
 * input and absent from the outputs is burned.
 */
export const buildAssetPacket = (args: {
  wantedAssetId?: string
  wantAmount: bigint
  /** Every asset on every input, keyed by input index. */
  inputAssets: ReadonlyMap<number, { assetId: string; amount: bigint }[]>
}): ReturnType<typeof createAssetPacket> | null => {
  const { wantedAssetId, wantAmount, inputAssets } = args
  if (inputAssets.size === 0) return null

  // Rebuilt so the WANTED asset is the first id seen — rule 2. Both the entry
  // order and the order WITHIN an entry matter, because one coin can carry the
  // wanted asset second.
  const ordered = new Map<number, { assetId: string; amount: bigint }[]>()
  const holder = [...inputAssets].find(([, assets]) => assets.some((a) => a.assetId === wantedAssetId))
  if (holder) {
    const [vin, assets] = holder
    ordered.set(vin, [
      ...assets.filter((a) => a.assetId === wantedAssetId),
      ...assets.filter((a) => a.assetId !== wantedAssetId),
    ])
  }
  for (const [vin, assets] of inputAssets) if (!ordered.has(vin)) ordered.set(vin, assets)

  // Totals in, so the taker's side is simply "everything, minus the maker's".
  const totals = new Map<string, bigint>()
  for (const assets of ordered.values()) {
    for (const entry of assets) totals.set(entry.assetId, (totals.get(entry.assetId) ?? 0n) + entry.amount)
  }

  const maker =
    wantedAssetId === undefined ? { assets: [] } : { assets: [{ assetId: wantedAssetId, amount: wantAmount }] }
  const taker = {
    assets: [...totals]
      .map(([assetId, amount]) => ({ assetId, amount: assetId === wantedAssetId ? amount - wantAmount : amount }))
      .filter((entry) => entry.amount > 0n),
  }
  // `ordered` is passed UNCAST: the SDK's `Asset` is `{ assetId: string; amount:
  // bigint }`, which is exactly what this builds, so the compiler checks it.
  //
  // The receivers still need one, and it is worth naming what it hides.
  // `Recipient.address` is REQUIRED by the SDK's type and is not supplied here,
  // because `createAssetPacket` addresses outputs POSITIONALLY — receivers[0] is
  // output 0, receivers[1] is output 1 — and the scripts are set on the
  // transaction itself. The previous `as never` said nothing and would have
  // swallowed any parameter change on a money path; this names the target, so a
  // rename upstream breaks the build, and states the one field being elided.
  return createAssetPacket(ordered, [maker, taker] as Recipient[])
}
