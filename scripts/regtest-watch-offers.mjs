// Watch regtest arkd for Arkade swap offers, through the shipped stream.
//
//   node scripts/regtest-watch-offers.mjs
//
// Pairs with regtest-make-offer.mjs: publish in one shell, watch in another.
// REGTEST ONLY -- it points at localhost:7070.
import { streamOfferTxs } from '../packages/solver-arkade/dist/arkade/offerStream.js'

const signal = AbortSignal.timeout(45_000)
console.log('watching http://localhost:7070 for offer packets…')
try {
  for await (const tx of streamOfferTxs({
    arkdUrl: 'http://localhost:7070',
    signal,
    onError: (e) => console.log('  stream error:', e.message),
  })) {
    console.log(`  EVENT txid=${tx.txid} txLen=${tx.tx.length}`)
    console.log('  tx head:', tx.tx.slice(0, 60))
  }
} catch (e) {
  console.log('ended:', e.name)
}
console.log('watch finished')
