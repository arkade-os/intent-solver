import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { createAssetPacket, CSVMultisigTapscript, DefaultVtxo, Extension } from '@arkade-os/sdk'
import type { AssetRfqCarrierTerms } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'

export const ASSET = `${'aa'.repeat(31)}bb0100`
export const DEPOSIT_TXID = '1'.repeat(64)
export const COIN_A = '2'.repeat(64)
export const SPONSOR_TXID = '3'.repeat(64)

export const RECYCLE: AssetRfqCarrierTerms = {
  mode: 'recycle',
  quoteId: 'q-1',
  physicalSats: 330n,
  loanSats: 329n,
  receiptSats: 1n,
  serviceFareSats: 4n,
  pricedSats: 5n,
  expiresAt: 9_000,
}

export const xonly = (seed: number): string => hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(seed)))
export const SERVER = xonly(9)

export const vtxoScript = (seed: number) =>
  new DefaultVtxo.Script({
    pubKey: hex.decode(xonly(seed)),
    serverPubKey: hex.decode(SERVER),
    csvTimelock: { type: 'blocks', value: 144n },
  })

export const SERVER_UNROLL = CSVMultisigTapscript.encode({
  timelock: { type: 'blocks', value: 144n },
  pubkeys: [hex.decode(SERVER)],
})

export const MAKER = vtxoScript(4).pkScript
export const SPONSOR_SCRIPT = vtxoScript(5).pkScript
export const PROCEEDS = vtxoScript(6).pkScript

export const coinInput = (seed: number, txid: string, vout: number, value: number) => {
  const s = vtxoScript(seed)
  return { txid, vout, value, tapLeafScript: s.forfeit(), tapTree: s.encode() }
}

export const DEPOSIT = coinInput(1, DEPOSIT_TXID, 1, 1_000)
export const SOLVER = coinInput(2, COIN_A, 0, 2_000)

/** Input 1 (the solver coin) carries the asset; output 0 pays it to the maker. */
export const ASSET_EXT = Extension.create([
  createAssetPacket(new Map([[1, [{ assetId: ASSET, amount: 10n }]]]), [
    { address: '', assets: [{ assetId: ASSET, amount: 10n }] },
  ]),
]).txOut()
