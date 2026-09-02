// Reference client: what "send to Lightning" means from the trader's side,
// built on the trader library (examples/lib/swap-client.mjs — integration
// guide: docs/integration-js.md, protocol: docs/rfq-protocol.md).
//
//   node --experimental-eventsource examples/send-client.mjs <providerUrl> <bolt11>
//
// The library performs the six-step protocol:
//
//   1. decode the invoice YOURSELF
//   2. send an rfq_request (pair arkade:BTC->lightning:BTC, your own rfq_id)
//   3. trust only the quote's BINDING fields (solver_pubkey, refund_locktime,
//      valid_until, from/to_amount)
//   4. derive the swap script LOCALLY; refuse to fund on any address mismatch
//   5. gate (invoice live, ≥90min headroom, before valid_until), fund your
//      own derivation
//   6. done — filling is NON-INTERACTIVE from here: the solver observes the
//      funding on-chain and claims; you may go offline. Status is optional.
//
// The trader's security model in one line: the solver chooses only WHO gets
// paid on the Arkade side (its own key) and WHEN your refund opens — every
// other parameter of the script is yours, so a wrong or malicious solver can
// only produce an address you refuse, never an address that traps your sats.
//
// Env: ARK_MNEMONIC, ARK_SERVER_URL, EMULATOR_URL (your own view of both
// services — never taken from the provider), SWAP_NETWORK.

import { createArkadeContext, loadConfig } from '../dist/index.js'
import { httpTransport, pollStatus, sendToLightning } from './lib/swap-client.mjs'

const [providerUrl, bolt11] = process.argv.slice(2)
if (!providerUrl || !bolt11) {
  console.error('usage: send-client.mjs <providerUrl> <bolt11>')
  process.exit(1)
}

const config = loadConfig()
const arkade = await createArkadeContext(config.arkade)
const transport = httpTransport(providerUrl)

let swap
try {
  swap = await sendToLightning({
    transport,
    arkade,
    emulatorUrl: config.emulatorUrl,
    bolt11,
    onEvent: (name, data) => {
      if (name === 'decoded') console.log(`sending ${data.amountSats} sats to payment hash ${data.paymentHash}`)
      if (name === 'verified') console.log(`derivation matches solver's address: ${data.address}`)
      if (name === 'funded') console.log(`funded ${data.amountSats} sats at own derivation, arkTxid ${data.fundTxid}`)
    },
  })
} catch (error) {
  if (error.name === 'AddressMismatch') {
    console.error('REFUSING TO FUND: solver address does not match local derivation')
    console.error('  mine:  ', error.derived)
    console.error('  theirs:', error.quoted)
    process.exit(3)
  }
  if (error.name === 'SwapRefusal') {
    console.error('solver refused:', error.reason)
    process.exit(2)
  }
  throw error
}

// Optional: watch by YOUR rfq_id — receipts appear only in `settled`.
const status = await pollStatus(transport, swap.rfqId, {
  onStatus: (s) => console.log('state:', s.state),
})
if (status?.state === 'settled') {
  console.log('paid over Lightning; preimage (your receipt):', status.profile.preimage)
} else if (status && status.state !== 'quoted' && status.state !== 'funded') {
  console.log(`swap did not complete (${status.profile.failure_reason}); the covenant refund`)
  console.log(`returns the lockup to ${swap.refundAddress} after ${swap.quote.refund_locktime} — nothing for you to do`)
}

arkade.close()
process.exit(0)
