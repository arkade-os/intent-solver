// Issue one Arkade asset into this wallet, so the offer path has something to
// trade.
//
//   node --experimental-eventsource --env-file=.env.regtest.lnd \
//     scripts/regtest-mint-asset.mjs [amount] [ticker]
//
// `--experimental-eventsource` is required for the same reason
// regtest-settle.mjs gives at length: without it the SDK's ContractWatcher
// throws out of its listen loop before the issuance lands.
//
// REGTEST ONLY. It exists because `test/e2e/assetOffer.e2e.test.ts` asserts a
// PRECONDITION it cannot create — it needs an asset the wallet already holds,
// and skipping straight to `this wallet holds no asset; mint one` told an
// operator what was wrong without telling them how to fix it. Nothing else in
// the repo issues one: `mintPool` is the sats DENOMINATION pool and shares
// nothing with this but a verb.
//
// AN ASSET IN A SOLVER WALLET IS NOT FREE. Asset coins and sats coins live in
// the same wallet, and a no-argument `settle()` sweeps every coin it can
// select — so issuing into a wallet that is also serving corridors changes
// what its float looks like. That is fine for a test wallet between runs, and
// is why this lives in `scripts/` rather than anywhere the service can reach.
import { loadConfig } from '../packages/solver-app/dist/config.js'
import { createArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'

const [amountArg = '1000', ticker = 'TEST'] = process.argv.slice(2)
const amount = BigInt(amountArg)
if (amount <= 0n) {
  console.error('usage: regtest-mint-asset.mjs [amount] [ticker] — amount must be positive')
  process.exit(1)
}

const config = loadConfig()
const arkade = await createArkadeContext(config.arkade)

const asNumber = (v) => (typeof v === 'bigint' ? Number(v) : v)
const before = await arkade.wallet.getBalance()
console.log('balance before:', JSON.stringify(before, (_k, v) => asNumber(v)))

// Issuance spends sats: the asset rides on a vtxo that still has to pay for
// itself. A wallet with everything in `boarding` or `recoverable` reads as
// funded and cannot issue — run regtest-settle.mjs first.
if (asNumber(before.available ?? 0) <= 0) {
  console.error('no spendable sats: run scripts/regtest-settle.mjs first (available is 0)')
  process.exit(1)
}

console.log(`issuing ${amount} ${ticker}...`)
const result = await arkade.wallet.assetManager.issue({ amount, metadata: { ticker, decimals: 0 } })
console.log('issued')
console.log('  assetId:', result.assetId)
console.log('  arkTxId:', result.arkTxId)

// Reads as a FAILURE and is not one: `assets` is still empty here, and the
// sats look spent — 890000 available before, 369000 after, with the balance
// showing no asset to account for the difference. Issuance leaves the wallet
// mid-restructure; a settle resolves it, and only then do both the asset and
// the sats appear. Not done here, because settling is a decision about the
// whole wallet — `settle()` takes no filter and sweeps every coin it can
// select — and this script is not the one that should be making it.
const after = await arkade.wallet.getBalance()
console.log('balance after:', JSON.stringify(after, (_k, v) => asNumber(v)))
if ((after.availableAssets ?? []).length === 0) {
  console.log('')
  console.log('The asset is not in the balance YET, and the sats look short. Both are')
  console.log('the same unsettled issuance. Run:')
  console.log('  node --experimental-eventsource --env-file=<env> scripts/regtest-settle.mjs')
}
arkade.close()
process.exit(0)
