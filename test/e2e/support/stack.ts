/**
 * Real adapters, real wallets, real regtest — the pieces every corridor test
 * assembles its service out of.
 *
 * This is deliberately the same construction `packages/solver-app/src/cli.ts`'s `createServices`
 * performs, minus the CLI: the same `createArkadeContext`, the same
 * `RestEmulatorProvider` key fetch, the same adapter classes. Two corridors
 * (`lightning:BTC->arkade:BTC` and `onchain:BTC->arkade:BTC`) have no CLI
 * command and no RFQ ingress yet, so for those there is nothing to shell out
 * to and the service object IS the thing under test; the send corridors are
 * built the same way here so all four read alike.
 *
 * Two deliberate deviations from `createServices`, both about not damaging the
 * machine the tests run on:
 *
 *  - **Swap stores go to a fresh temp directory**, never the configured
 *    `SWAP_DB_PATH`. A test run must not deposit rows in the operator's own
 *    swap database, and a per-run store means a rerun is never confused by a
 *    previous run's rows. The ARKADE WALLET database (`ARK_DB_PATH`) is used
 *    as configured, because that one is the wallet's own vtxo state — a temp
 *    copy would be an empty, unfunded wallet.
 *  - **Wallets are initialised sequentially**, for the reason `createServices`
 *    documents: two backend wallets brought up concurrently in one process
 *    tear each other's connection down.
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RestEmulatorProvider } from '@arkade-os/sdk'
import { base64 } from '@scure/base'
import { createArkadeContext, type ArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { arkDbPath } from '@arkade-os/solver-app/config.js'
import { resolveLimits, type Limits } from '@arkade-os/solver-core/core/limits.js'
import { NETWORKS, isSwapNetwork, type NetworkProfile, type SwapNetwork } from '@arkade-os/solver-core/core/networks.js'
import { ONCHAIN_SECONDS_PER_BLOCK } from '@arkade-os/solver-core/core/onchainReceive.js'
import { LndOnchainAdapter } from '@arkade-os/solver-rails-lnd/onchain/lnd/adapter.js'
import type { OnchainSendBackend } from '@arkade-os/solver-core/ports/onchain.js'
import { FakeLightningBackend } from '@arkade-os/solver-rails-fake/ln/fake/backend.js'
import { LndLightningBackendAdapter } from '@arkade-os/solver-rails-lnd/ln/lnd/adapter.js'
import { createCovclaimdClient, type CovclaimdClient } from '@arkade-os/solver-corridors/receive/covclaimd.js'
import type { EmulatorInfo } from '@arkade-os/solver-corridors/send/arkadeOps.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import { nodeBlockHeight, solverInvoice, SOLVER_CONTAINER } from './counterparty.js'
import { covclaimdUrl, esploraUrl, loadE2eEnv } from './preflight.js'

/**
 * Wall-clock budgets. E2E swaps wait on a real chain, a real indexer and a
 * real emulator, so vitest's 5s default would fail every one of these before
 * anything went wrong. Exported so each test states its own budget out loud.
 */
export const SWAP_TIMEOUT_MS = 10 * 60_000
export const SETUP_TIMEOUT_MS = 3 * 60_000

const required = (name: string): string => {
  const value = process.env[name]
  if (!value)
    throw new Error(`${name} is not set — e2e env came from ${process.env.E2E_ENV_FILE ?? '.env.regtest.lnd'}`)
  return value
}

/**
 * A credential given either inline or as a path to read and base64-encode.
 *
 * The same either/or `packages/solver-app/src/config.ts` accepts for `LND_CERT`/`LND_MACAROON`, so
 * an existing `.env.regtest.lnd` works here unchanged. Shared by the onchain
 * and Lightning LND adapters, which are two connections to the SAME node and
 * must never drift onto different credentials.
 */
const secret = (name: string): string => {
  const inline = process.env[name]?.trim()
  const path = process.env[`${name}_PATH`]?.trim()
  if (inline && path) throw new Error(`set only one of ${name} or ${name}_PATH, not both`)
  if (inline) return inline
  if (path) return base64.encode(readFileSync(path))
  throw new Error(`one of ${name} or ${name}_PATH must be set (see .env.regtest.lnd.example)`)
}

/** The network under test. Guarded: these tests move real money on any non-regtest network. */
export const e2eNetwork = (): SwapNetwork => {
  loadE2eEnv()
  const raw = process.env.SWAP_NETWORK ?? 'regtest'
  if (!isSwapNetwork(raw)) throw new Error(`SWAP_NETWORK must be a known network, got ${raw}`)
  if (raw !== 'regtest' && process.env.E2E_ALLOW_NON_REGTEST !== 'yes') {
    throw new Error(
      `refusing to run e2e on ${raw}: these tests fund lockups and broadcast claims with real value. ` +
        'Set E2E_ALLOW_NON_REGTEST=yes only if you mean it.',
    )
  }
  return raw
}

/** A private directory for this run's swap stores. */
export const tempStoreDir = (): string => mkdtempSync(join(tmpdir(), 'lnswap-e2e-'))

export interface E2eArkade {
  ctx: ArkadeContext
  emulator: EmulatorInfo
  network: SwapNetwork
  profile: NetworkProfile
  limits: Limits
  /** Cap passed to every service — generous, so a shared regtest wallet's other rows never refuse a test quote. */
  maxExposedSats: number
  close(): void
}

/**
 * The Arkade wallet and the emulator key — everything all four corridors
 * share. The emulator key is fetched once here exactly as `createServices`
 * fetches it once at startup.
 */
export const openArkade = async (): Promise<E2eArkade> => {
  loadE2eEnv()
  const network = e2eNetwork()
  const profile = NETWORKS[network]
  const ctx = await createArkadeContext({
    mnemonic: required('ARK_MNEMONIC'),
    arkServerUrl: required('ARK_SERVER_URL'),
    // The service's own resolution, not a copy of it: this suite is only
    // meaningful against the same wallet database the service opens.
    databasePath: arkDbPath(),
    isMainnet: profile.isMainnet,
    arkadeHrp: profile.arkadeHrp,
    expectedArkdNetwork: profile.arkdNetwork,
  })
  // The same rule the service applies: no network profile ships an emulator, so
  // whoever runs this suite supplies one.
  const emulatorUrl = process.env.EMULATOR_URL
  if (!emulatorUrl) throw new Error('EMULATOR_URL is not set')
  const info = await new RestEmulatorProvider(emulatorUrl).getInfo()
  const limits = resolveLimits(network)
  return {
    ctx,
    emulator: { url: emulatorUrl, pubkey: info.signerPubkey },
    network,
    profile,
    limits,
    maxExposedSats: limits.maxSats * 100,
    close: () => ctx.close(),
  }
}

/**
 * Refuse to start a swap the wallet cannot pay for, with the fix in the message.
 *
 * A regtest Arkade wallet goes unspendable on its own over time — vtxos age
 * out of `available` into `recoverable`, which reads as a healthy-looking
 * non-zero total right up until `send()` fails with something about missing
 * inputs. Checking `available` specifically turns that into one legible line
 * before any money moves.
 *
 * RETRIED, not read once. A test that has just spent leaves the wallet's whole
 * balance riding on a CHANGE vtxo, and there is a window between the spend
 * being accepted and that change becoming selectable in which `available`
 * reads 0 — a wallet holding hundreds of thousands of sats reporting `total:
 * 0`. Read once, that window fails the NEXT test in the file for a reason
 * belonging to the previous one, which is exactly the flake class
 * `docs/runbook.md` tells operators to settle before a run to avoid. The
 * budget is deliberately short: a genuinely empty wallet still fails inside a
 * minute with the funding command in the message, rather than burning the
 * caller's whole swap timeout.
 */
export const assertArkadeSpendable = async (arkade: E2eArkade, needSats: number): Promise<void> => {
  let balance = await arkade.ctx.wallet.getBalance()
  for (let attempt = 0; attempt < BALANCE_SETTLE_ATTEMPTS; attempt += 1) {
    if (Number(balance.available ?? 0) >= needSats) return
    await new Promise((resolve) => setTimeout(resolve, BALANCE_SETTLE_INTERVAL_MS))
    balance = await arkade.ctx.wallet.getBalance()
  }
  const available = Number(balance.available ?? 0)
  if (available >= needSats) return
  throw new Error(
    [
      `Arkade wallet has ${available} spendable sats, needs ${needSats}.`,
      `(recoverable: ${Number(balance.recoverable ?? 0)}, total: ${Number(balance.total ?? 0)} — recoverable is NOT spendable until settled.)`,
      `Still true after ${BALANCE_SETTLE_ATTEMPTS} reads over ${(BALANCE_SETTLE_ATTEMPTS * BALANCE_SETTLE_INTERVAL_MS) / 1000}s, so this is not change in flight.`,
      'Fund and settle it:',
      `  node --experimental-eventsource --env-file=${process.env.E2E_ENV_FILE ?? '.env.regtest.lnd'} scripts/regtest-fund.mjs ../arkade-regtest`,
      `  node --experimental-eventsource --env-file=${process.env.E2E_ENV_FILE ?? '.env.regtest.lnd'} scripts/regtest-settle.mjs`,
    ].join('\n'),
  )
}

const BALANCE_SETTLE_ATTEMPTS = 20
const BALANCE_SETTLE_INTERVAL_MS = 3000

/**
 * The solver's own Bitcoin L1 wallet, via boltz-lnd.
 *
 * LND for the same reason `docs/runbook.md`'s onchain walkthrough uses it: it
 * is the only shipped rail with a real onchain wallet on arkade-regtest's own
 * local chain, rather than on a hosted one it cannot reach. `LndOnchainAdapter`
 * satisfies both `OnchainSendBackend` and `OnchainReceiveBackend`, so one
 * instance serves the send corridor's `fund()` and the receive corridor's
 * watching and claiming.
 *
 * `esploraUrl` is passed for the RECEIVE corridor's sake: `findOutputs` reads
 * address history from Esplora because LND's own chain view is wallet-scoped
 * and carries no per-output values (see that method in
 * `src/onchain/lnd/adapter.ts`). `createServices` gets it for free by handing
 * `config.lnd` over whole; this builds the config by hand, so it has to be
 * named here or the receive corridor throws on its first `findOutputs`. The
 * default matches {@link esploraUrl}, the same endpoint `requireStack` already
 * probes as the `esplora` dependency this corridor declares.
 */
export const openOnchainBackend = async (): Promise<OnchainSendBackend & { close?(): Promise<void> }> => {
  loadE2eEnv()
  return LndOnchainAdapter.create({
    socket: required('LND_SOCKET'),
    cert: secret('LND_CERT'),
    macaroon: secret('LND_MACAROON'),
    esploraUrl: process.env.LND_ESPLORA_URL ?? esploraUrl(),
  })
}

/**
 * The SOLVER's own Lightning node — the real, shipped LND adapter.
 *
 * The same `LndLightningBackendAdapter` `createServices` builds when
 * `LN_BACKEND=lnd`, against the same `LND_SOCKET` (boltz-lnd), sharing the
 * credentials {@link openOnchainBackend} already uses for that node. So the
 * code exercised by a corridor built on this IS the production Lightning path,
 * not a double of it.
 *
 * The party on the OTHER side of every payment is arkade-regtest's second LND
 * node, driven from `support/counterparty.ts`.
 */
export const openSolverLightning = async (): Promise<LndLightningBackendAdapter> => {
  loadE2eEnv()
  return LndLightningBackendAdapter.create({
    socket: required('LND_SOCKET'),
    cert: secret('LND_CERT'),
    macaroon: secret('LND_MACAROON'),
  })
}

/**
 * `E` for a held HTLC, read INDEPENDENTLY of the adapter under test.
 *
 * This goes to LND the other way round — `lncli lookupinvoice` over docker,
 * reading `htlcs[].expiry_height` directly — where the adapter goes through the
 * `lightning` package and reads the same quantity under that package's own name
 * for it (`payments[].timeout`). Two different transports onto one number, so a
 * test can check the adapter's answer against something it did not compute.
 *
 * It converts at the NOMINAL 600s/block (`ONCHAIN_SECONDS_PER_BLOCK`), not at
 * the deliberately-fast `HTLC_SECONDS_PER_BLOCK` the adapter uses. That
 * difference is the point rather than an inconsistency: the adapter must never
 * report a LATER deadline than a nominal-rate reading of the same height, since
 * over-stating the time left is the direction that costs money
 * (`src/core/receive.ts`). This is the upper bound that assertion is made
 * against.
 */
export const holdSettleDeadline = async (paymentHash: string): Promise<number> => {
  const invoice = await solverInvoice(paymentHash)
  const held = invoice.htlcs.find((htlc) => htlc.state === 'ACCEPTED')
  if (!held) throw new Error(`no accepted HTLC on the solver's hold invoice for ${paymentHash}`)
  const height = await nodeBlockHeight(SOLVER_CONTAINER)
  // Blocks to seconds at the repo's own constant, the same conversion
  // `htlcLocktimeFor` (src/core/onchainReceive.ts) makes for the sibling corridor.
  return nowSeconds() + (held.expiry_height - height) * ONCHAIN_SECONDS_PER_BLOCK
}

/**
 * The file-backed fake Lightning backend.
 *
 * NO LONGER THE DEFAULT FOR THE LIGHTNING CORRIDORS. Both of them now run
 * against the real `LndLightningBackendAdapter` with arkade-regtest's second
 * LND node as the counterparty — see {@link openSolverLightning} and
 * `support/counterparty.ts`. (This comment used to claim "arkade-regtest
 * exposes no scriptable Lightning payer to this repo". That was wrong: the
 * stack runs two LND nodes with a live channel between them precisely so
 * Lightning payments can be tested for real.)
 *
 * It is kept, and still used, where DETERMINISM matters more than realism —
 * chiefly `armHold`, which lets a test choose the HTLC's `E` exactly. The
 * funding-safety gates in `evaluateReceiveFunding` are functions of `E`, so
 * the edge scenarios that prove those gates refuse (`settle_window_too_short`,
 * `refund_deadline_too_late`) need an `E` picked to the second. A real payer
 * cannot be asked for one: its HTLC deadline is whatever the route's CLTV
 * deltas make it. It also remains the right double for the unit suite.
 *
 * State goes to `dir` so a run never touches the operator's own
 * `FAKE_LN_STATE_PATH` map.
 */
export const openFakeLightning = (dir: string, network: SwapNetwork): FakeLightningBackend =>
  new FakeLightningBackend(join(dir, 'fake-ln.json'), NETWORKS[network].invoicePrefix)

/** covclaimd, at `COVCLAIMD_URL`. Only the receive corridors need it. */
export const openCovclaimd = (): CovclaimdClient => createCovclaimdClient(covclaimdUrl())
