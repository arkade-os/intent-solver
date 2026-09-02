// Fund the provider's regtest Arkade wallet from the arkade-regtest stack:
// boarding address -> faucet BTC -> mine -> settle into a vtxo.
//
//   node --env-file=.env.regtest scripts/regtest-fund.mjs <path-to-arkade-regtest> [amountBtc]
//
// Requires the stack to be up (arkd + bitcoin + miner). Prints the settled
// balance at the end; afterwards `cli send` / `cli test-refund` just work.
import { execFileSync } from 'node:child_process'
import { loadConfig } from '../packages/solver-app/dist/config.js'
import { createArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'

const [stackPath, amountBtc = '0.001'] = process.argv.slice(2)
if (!stackPath) {
  console.error('usage: regtest-fund.mjs <path-to-arkade-regtest> [amountBtc]')
  process.exit(1)
}
const stack = (...args) => execFileSync('node', [`${stackPath}/regtest.mjs`, ...args], { stdio: 'inherit' })

const config = loadConfig()
const arkade = await createArkadeContext(config.arkade)

const boarding = await arkade.wallet.getBoardingAddress()
console.log('boarding address:', boarding)
stack('faucet', boarding, amountBtc)
stack('mine', '2')

console.log('settling boarded funds into a vtxo (this talks to arkd)...')
const txid = await arkade.wallet.settle()
console.log('settled, txid', txid)
stack('mine', '1')

console.log('arkade balance:', JSON.stringify(await arkade.wallet.getBalance(), (_k, v) => (typeof v === 'bigint' ? Number(v) : v)))
console.log('arkade address:', await arkade.wallet.getAddress())
arkade.close()
process.exit(0)
