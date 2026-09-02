// Fund the provider's regtest Arkade wallet from the arkade-regtest stack:
// boarding address -> faucet BTC -> mine -> settle into a vtxo.
//
//   node --experimental-eventsource --env-file=.env.regtest \
//     scripts/regtest-fund.mjs <path-to-arkade-regtest> [amountBtc]
//
// `--experimental-eventsource` is required, not optional, for the reason
// scripts/regtest-settle.mjs gives at length: without it the SDK's
// ContractWatcher throws out of its listen loop before the settle lands and the
// script exits having changed nothing.
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

// Retried, because settling straight after mining loses a race that reports
// itself as a fact. `getBalance()` reads the EXPLORER and shows the boarding
// sats the moment the block lands; `settle()` needs ARKD to acknowledge the
// same input, and arkd is a separate service with its own sync lag. In that
// window the SDK throws
//
//   Error: No inputs found
//
// on a wallet that is, by its own balance, funded — so the script died
// claiming there was nothing to settle while printing 200000 confirmed
// boarding sats. Running the same settle by hand a minute later always
// worked, which is what gave the race away.
const settleWhenArkdSees = async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await arkade.wallet.settle()
    } catch (error) {
      const message = error?.message ?? String(error)
      // Only this one. Anything else is a real failure and must not be
      // retried into a timeout that hides it.
      if (!message.includes('No inputs found') || attempt >= 15) throw error
      if (attempt === 1) console.log('  arkd has not seen the deposit yet; retrying...')
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
}
const txid = await settleWhenArkdSees()
console.log('settled, txid', txid)
stack('mine', '1')

console.log('arkade balance:', JSON.stringify(await arkade.wallet.getBalance(), (_k, v) => (typeof v === 'bigint' ? Number(v) : v)))
console.log('arkade address:', await arkade.wallet.getAddress())
arkade.close()
process.exit(0)
