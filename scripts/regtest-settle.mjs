// Settle any unusable Arkade balance into confirmed vtxos, without funding.
//
//   node --experimental-eventsource --env-file=.env.regtest.lnd scripts/regtest-settle.mjs
//
// `--experimental-eventsource` is required, not optional. Without it the SDK's
// ContractWatcher throws out of its listen loop before the settle lands, and the
// script exits having changed nothing — observed against a live stack: identical
// balance before and after, only a `ContractWatcher.listenLoop` stack trace on
// stderr to show for it. `vitest.e2e.config.ts` carries the same warning for the
// suite itself.
//
// Used before `pnpm test:e2e`: unsettled (preconfirmed) funds make the
// per-fork startup balance check racy.
//
// `recoverable` counts as unusable too, and is the reason this script exists in
// the first place. A wallet whose batch expired sits at `available: 0` with the
// whole balance in `recoverable`, which fails every corridor's funding
// precondition — the exact state a pre-run settle is supposed to clear. Guarding
// on `preconfirmed || available` alone skipped it, so the script no-oped on the
// one state that most reliably breaks a run. Observed on a stack idle overnight:
// `available: 0 / recoverable: 258112`.
//
// REGTEST ONLY, and deliberately blunt: a no-argument `settle()` sweeps
// everything the wallet can select, which on a wallet holding live swap lockups
// would spend them too. That is fine here — this runs against a test wallet
// between e2e runs, never against one mid-swap — but it is why this lives in
// `scripts/` and not in the service.
import { loadConfig } from '../dist/config.js'
import { createArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'

const config = loadConfig()
const arkade = await createArkadeContext(config.arkade)

const asNumber = (v) => (typeof v === 'bigint' ? Number(v) : v)
const before = await arkade.wallet.getBalance()
console.log('balance before:', JSON.stringify(before, (_k, v) => asNumber(v)))

// Only the buckets that are NOT yet spendable. `available` is deliberately not
// counted: settling it is not free and not a no-op, which is easy to assume and
// wrong. A settlement pays the operator's intent fee on every input, so
// re-settling an already-healthy wallet burns that fee for nothing — observed
// on a 1%-fee stack, `available: 233338` -> `231004`, 2334 sats gone with no
// state change. The original trigger included `available` and had this bug; the
// point of the script is to make unusable funds usable, so that is what it asks.
//
// `boarding.confirmed` counts for the same reason `recoverable` does: an onchain
// deposit that has confirmed but not yet been onboarded leaves the wallet at
// `available: 0` with the money one settle away, and a no-argument `settle()`
// takes boarding inputs — the SDK's own periodic settle passes
// `[...boarding, ...vtxos]`. Leaving it out made this script no-op immediately
// after a fund, which is the moment it is most likely to be run: observed as
// boarding confirmed, `available` unchanged, and the fund script re-run for
// nothing. `confirmed` rather than `total` because `unconfirmed` is not yet
// eligible, so counting it would only call `settle()` to no effect.
const unsettled =
  asNumber(before.preconfirmed ?? 0) + asNumber(before.recoverable ?? 0) + asNumber(before.boarding?.confirmed ?? 0)

if (unsettled > 0) {
  try {
    const txid = await arkade.wallet.settle()
    console.log('settled, txid', txid)
  } catch (error) {
    console.log('settle skipped:', error?.message ?? String(error))
  }
}

console.log('balance after:', JSON.stringify(await arkade.wallet.getBalance(), (_k, v) => asNumber(v)))
arkade.close()
process.exit(0)
