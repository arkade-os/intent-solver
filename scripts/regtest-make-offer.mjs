// Publish one Arkade swap offer, so the taker path has something real to see.
//
//   node --experimental-eventsource --env-file=.env.regtest.lnd \
//     scripts/regtest-make-offer.mjs <wantAssetId> <wantAmount> <depositSats>
//
// REGTEST ONLY. This makes the wallet a MAKER, which the solver never is in
// production: an offer is a standing commitment with no expiry, so publishing
// one writes a free option that a counterparty fills once the market has moved
// against you. It exists to generate traffic for `streamOfferTxs` and, later,
// to give a fill something to settle.
//
// `--experimental-eventsource` is required for the same reason regtest-settle
// gives: without it the SDK's ContractWatcher throws out of its listen loop.
import { loadConfig } from '../packages/solver-app/dist/config.js'
import { createArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { createOffer } from '@arkade-os/swap'
import { asset } from '@arkade-os/sdk'

const [wantAssetId, wantAmountRaw, depositRaw] = process.argv.slice(2)
if (!wantAssetId || !wantAmountRaw) {
  console.error('usage: regtest-make-offer.mjs <wantAssetId> <wantAmount> [depositSats]')
  process.exit(1)
}
const wantAmount = BigInt(wantAmountRaw)
const depositSats = Number(depositRaw ?? 1000)

const config = loadConfig()
const arkade = await createArkadeContext(config.arkade)

const balance = await arkade.wallet.getBalance()
console.log('available sats:', balance.available)
console.log(
  'assets       :',
  JSON.stringify(balance.availableAssets ?? [], (_k, v) => (typeof v === 'bigint' ? String(v) : v)),
)

// Deposit sats, want an asset — the direction that needs no asset inventory to
// publish, so it works on any funded regtest wallet.
const offer = await createOffer(arkade.wallet, config.arkade.arkServerUrl, {
  wantAmount,
  wantAsset: asset.AssetId.fromString(wantAssetId),
})
console.log('offer address:', offer.address)

const txid = await arkade.wallet.send({
  address: offer.address,
  amount: depositSats,
  extensions: [offer.extension],
})
console.log('funded, txid:', txid)
console.log('offer hex   :', typeof offer.offerHex === 'string' ? offer.offerHex.slice(0, 64) + '…' : '(none)')

// The SDK's contract watcher keeps the loop alive once the offer is registered,
// so a script that only publishes never exits on its own.
process.exit(0)
