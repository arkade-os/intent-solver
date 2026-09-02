/**
 * A fleet of independent client wallets, and the one cheap way to fund them.
 *
 * The corridor e2e tests all play both roles out of ONE Arkade wallet, which is
 * fine when the question is "does this corridor work". It is the wrong shape
 * for a load test: a hundred swaps out of a single wallet contend on that
 * wallet's coin selection rather than on the solver, and the number that falls
 * out measures the wrong thing. So this stands up a hundred SEPARATE wallets —
 * separate mnemonics AND separate SQLite files, because two wallets on one
 * mnemonic tear each other's backend connection down (docs/runbook.md), and two
 * on one database file are simply the same wallet twice.
 *
 * WHY THE MNEMONICS ARE DERIVED AND NOT RANDOM. A run that generated fresh
 * mnemonics would strand every sat it fanned out: the wallet holding them would
 * be unreachable on the next run, and a hundred wallets' worth of dust would
 * accumulate on the regtest stack forever. Deriving them from a fixed label
 * means run N+1 opens the SAME hundred wallets, sees whatever run N left behind,
 * and tops up only the difference. It also makes a failed run debuggable: the
 * wallet that misbehaved still exists tomorrow, with its balance intact.
 *
 * WHY FAN-OUT, AND NOT BOARDING PER WALLET. `scripts/regtest-fund.mjs`'s
 * boarding -> faucet -> mine -> settle is the only way to bring OUTSIDE money
 * into Arkade, and it costs two mined blocks and a batch round per wallet. A
 * hundred of those is not a setup step, it is the test. An ordinary offchain
 * `wallet.send` from an already-funded wallet needs neither: measured against
 * the live stack at ~350ms each, and — the part that actually decides it — the
 * recipient sees the result as `available` IMMEDIATELY, with no settle. The
 * SDK's balance counts `preconfirmed` inside `available` (observed: a recipient
 * reading `{preconfirmed: 2400, available: 2400}` on the first read after the
 * send returned), so a fanned-out coin is spendable at once. That makes funding
 * the fleet a sequential minute rather than an hour of batch rounds.
 *
 * The fan-out is SEQUENTIAL on purpose even though everything else here is
 * parallel: every send spends the funder's change from the one before it, so
 * firing them at once means a hundred spends of the same outpoint and
 * `VTXO_ALREADY_SPENT` for all but one. Concurrency belongs to the swaps, not
 * to their setup.
 */

import { mkdirSync } from 'node:fs'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8 } from '@scure/base'
import { entropyToMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { createArkadeContext, type ArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { poll } from '@arkade-os/solver-core/util/poll.js'
import type { E2eArkade } from '../../e2e/support/stack.js'

/**
 * Where the fleet's wallet databases live.
 *
 * `.benchdata/` rather than `.data/`: it is already gitignored for exactly this
 * ("scratch probes and benchmark scratch"), and keeping it out of `.data/`
 * means a `rm -rf` of the fleet can never take the operator's own wallet with
 * it.
 */
const FLEET_DIR = '.benchdata'

/**
 * The label the fleet's mnemonics are derived from.
 *
 * Versioned so a future change to the derivation is a NEW fleet rather than a
 * silent reinterpretation of the old one's keys — the sats sitting in the v1
 * wallets stay reachable by checking out the v1 code.
 */
const FLEET_LABEL = 'lnswap-perf/v1'

/** Deterministic, valid BIP39 for wallet `index`. */
export const fleetMnemonic = (index: number): string =>
  entropyToMnemonic(sha256(utf8.decode(`${FLEET_LABEL}/${index}`)), wordlist)

/** One client wallet, with everything a corridor asks a client for. */
export interface FleetWallet {
  index: number
  ctx: ArkadeContext
  /** The wallet's own Arkade address — every corridor's payout or refund destination. */
  address: string
  /** Its x-only key, hex — the covenant's `receiver` on both receive corridors. */
  pubkey: string
}

export interface Fleet {
  wallets: readonly FleetWallet[]
  close(): void
}

/**
 * Open `size` client wallets, concurrently.
 *
 * Concurrent is safe here and nowhere else in this file: `Wallet.create` is a
 * read of the server's info plus a local schema migration, and each wallet
 * touches only its own database. Measured at ~45ms per wallet either way, so
 * the whole fleet stands up in about four and a half seconds instead of four
 * and a half minutes.
 */
export const openFleet = async (arkade: E2eArkade, size: number): Promise<Fleet> => {
  mkdirSync(FLEET_DIR, { recursive: true })
  const wallets = await Promise.all(
    Array.from({ length: size }, async (_unused, index): Promise<FleetWallet> => {
      const ctx = await createArkadeContext({
        mnemonic: fleetMnemonic(index),
        arkServerUrl: process.env.ARK_SERVER_URL ?? 'http://localhost:7070',
        databasePath: `${FLEET_DIR}/wallet-${index}.sqlite`,
        isMainnet: arkade.profile.isMainnet,
        arkadeHrp: arkade.profile.arkadeHrp,
        // Same guard the solver and the e2e stack use (#58): every wallet here
        // refuses an arkd reporting a different network. A fleet is a hundred
        // chances to point at the wrong server by accident, so it is worth more
        // here than anywhere, not less.
        expectedArkdNetwork: arkade.profile.arkdNetwork,
      })
      return {
        index,
        ctx,
        address: await ctx.wallet.getAddress(),
        pubkey: Buffer.from(await ctx.identity.xOnlyPublicKey()).toString('hex'),
      }
    }),
  )
  return {
    wallets,
    close: () => {
      for (const wallet of wallets) wallet.ctx.close()
    },
  }
}

/** What a top-up actually did, so the report can say whether funding was free this run. */
export interface TopUpResult {
  /** Wallets that already held enough and were left alone. */
  skipped: number
  /** Wallets that were sent sats. */
  funded: number
  satsSent: number
  ms: number
}

/**
 * Bring every wallet in `targets` up to at least `needSats`, from the solver's
 * own float.
 *
 * TOPS UP RATHER THAN TOPS OFF: a wallet that still holds enough from a
 * previous run is skipped entirely, which is what makes a second run of the
 * benchmark cost nothing in setup. Only the shortfall (plus the margin below)
 * is sent, so a fleet that spent half its balance last run pays for half a
 * fan-out this run.
 *
 * The balance read is `available`, not `total`, for the reason
 * `assertArkadeSpendable` documents at length: a regtest wallet's coins age out
 * of `available` into `recoverable`, which still reads as a healthy non-zero
 * total right up until the spend fails. A wallet in that state is topped up
 * here rather than left to fail mid-swap.
 */
export const topUpFleet = async (
  arkade: E2eArkade,
  targets: readonly FleetWallet[],
  needSats: number,
): Promise<TopUpResult> => {
  const started = performance.now()
  const balances = await Promise.all(
    targets.map(async (wallet) => Number((await wallet.ctx.wallet.getBalance()).available ?? 0)),
  )

  let funded = 0
  let satsSent = 0
  const sent: FleetWallet[] = []
  for (const [position, wallet] of targets.entries()) {
    const have = balances[position] ?? 0
    if (have >= needSats) continue
    // A MARGIN, not the exact shortfall. Topping up to precisely the swap
    // amount leaves no room for the sat-level discrepancies a wallet
    // accumulates across runs, and the failure it produces is maximally
    // confusing: a wallet reporting 999 against a 1000-sat lockup refuses the
    // spend with "Insufficient funds" while looking, to every log line, fully
    // funded. Observed exactly that way — twenty wallets topped up for 1000
    // each and every one of them a single sat short at spend time. A real
    // client does not fund a lockup with a balance equal to the lockup either.
    const short = needSats + margin(needSats) - have
    // Sequential: each send spends the change of the one before it.
    await arkade.ctx.wallet.send({ address: wallet.address, amount: short })
    sent.push(wallet)
    funded += 1
    satsSent += short
  }

  // VERIFIED FROM THE RECIPIENT'S SIDE, not assumed from the sender's. A send
  // returning means arkd accepted it, which is not the same as the receiving
  // wallet being able to select the coin — that view arrives over the
  // recipient's own subscription, and under this much concurrent load it lags.
  // Without this wait a client that had just been funded still failed its
  // lockup with "Insufficient funds", once, on the wallet earliest in the plan
  // and so with the least time to catch up. Waiting here turns a mid-run swap
  // failure into either a slightly longer setup or a setup failure that names
  // the wallet, which are both better than a benchmark result with a hole in it.
  await Promise.all(
    sent.map((wallet) =>
      poll(
        async () => {
          const available = Number((await wallet.ctx.wallet.getBalance()).available ?? 0)
          return available >= needSats ? available : null
        },
        {
          attempts: FUNDING_VISIBLE_ATTEMPTS,
          intervalMs: FUNDING_VISIBLE_INTERVAL_MS,
          whenExhausted:
            `fleet wallet ${wallet.index} never saw enough of its top-up to fund a ${needSats}-sat lockup ` +
            `(sent ${needSats + margin(needSats)}, address ${wallet.address})`,
        },
      ),
    ),
  )

  return { skipped: targets.length - funded, funded, satsSent, ms: Math.round(performance.now() - started) }
}

/** How long a topped-up wallet gets to see its own coin before setup gives up on it. */
const FUNDING_VISIBLE_ATTEMPTS = 60
const FUNDING_VISIBLE_INTERVAL_MS = 1000

/** Headroom over the swap amount, so a sat of drift cannot starve a wallet. */
const margin = (needSats: number): number => Math.max(50, Math.ceil(needSats * 0.02))

/**
 * Split the solver's own float into at least `coins` separate vtxos.
 *
 * A DIAGNOSTIC THAT RECORDS A NEGATIVE RESULT, kept because it is the first
 * thing anyone will reach for and it does not work.
 *
 * The hypothesis was reasonable: on the two RECEIVE corridors the solver funds
 * the lockup out of its own pocket, and `fundLockup` (src/receive/fundLockup.ts)
 * pins the coins it selects in the reservation ledger, so a float in ONE lump
 * looks like it should admit exactly one funding at a time and queue the rest
 * behind `insufficient_unreserved_balance`.
 *
 * MEASURED, IT CHANGES NOTHING. Twenty concurrent receive swaps against the
 * live stack: a median of 32.0s from "the HTLC is held" to "the lockup is
 * funded" with the float in ONE coin, and 33.1s with it split into twenty-five
 * — and not a single `insufficient_unreserved_balance` refusal logged in
 * either run, so the contention this was built to relieve never actually
 * happened.
 *
 * The real limit is upstream of coin selection: ONE Arkade wallet cannot issue
 * concurrent offchain sends. Measured directly, on a wallet holding 39
 * spendable vtxos — so never short of unreserved coins — twenty concurrent
 * `wallet.send` calls took 59.3s wall, p50 32.9s each, an effective 0.34
 * sends/sec. The same twenty spread over twenty SEPARATE wallets run at about
 * 8.5 sends/sec, so it is neither arkd nor the network: it is per-wallet.
 *
 * Left in and defaulted OFF (`PERF_SOLVER_FLOAT_COINS=1`) so re-measuring is
 * one environment variable rather than an afternoon. It costs no sats when it
 * does run — the money only ever moves to the wallet's own address — but it is
 * slow, for exactly the reason it fails to help.
 */
export const splitSolverFloat = async (
  arkade: E2eArkade,
  coins: number,
  perCoinSats: number,
): Promise<{ before: number; after: number; ms: number }> => {
  const started = performance.now()
  // `getSpendableVtxos`, the same GATED read `fundLockup` itself uses — counting
  // coins the funder cannot actually select would report a split that does not
  // exist.
  const held = async (): Promise<number> =>
    (await arkade.ctx.wallet.getSpendableVtxos()).filter((vtxo) => Number(vtxo.value) >= perCoinSats).length
  const before = await held()
  const address = await arkade.ctx.wallet.getAddress()
  for (let made = before; made < coins; made += 1) {
    await arkade.ctx.wallet.send({ address, amount: perCoinSats })
  }
  return { before, after: await held(), ms: Math.round(performance.now() - started) }
}

/**
 * Send every client's remaining balance back to the solver.
 *
 * WITHOUT THIS THE BENCHMARK IS NOT REPEATABLE. The two RECEIVE corridors move
 * sats permanently OUT of the solver's float and into a client's wallet — that
 * is what a receive swap is — so each run leaves the solver poorer by the whole
 * receive-side volume and the fleet richer by the same amount. After a handful
 * of runs the solver cannot fund a lockup and the benchmark starts failing for
 * a reason that has nothing to do with the code. Sweeping the fleet back closes
 * the loop, and the money that circulates is the same money every time.
 *
 * PARALLEL, unlike {@link topUpFleet}, and for the reason that makes the
 * difference: here each wallet spends a coin only IT holds, so there is no
 * shared change to contend over. The fan-out has to be sequential precisely
 * because it is one wallet spending its own change a hundred times in a row.
 *
 * Best-effort per wallet. A wallet whose sats are still sitting in an unclaimed
 * lockup has nothing to send and must not fail the sweep for the other
 * ninety-nine — a failed swap is reported by the benchmark's own assertion, not
 * by its teardown.
 */
export const reclaimFleet = async (
  arkade: E2eArkade,
  targets: readonly FleetWallet[],
  dustSats = 1,
): Promise<{ swept: number; satsReturned: number; failed: number; ms: number }> => {
  const started = performance.now()
  const solverAddress = await arkade.ctx.wallet.getAddress()
  const results = await Promise.all(
    targets.map(async (wallet) => {
      try {
        const available = Number((await wallet.ctx.wallet.getBalance()).available ?? 0)
        if (available < dustSats) return { sats: 0, failed: false }
        await wallet.ctx.wallet.send({ address: solverAddress, amount: available })
        return { sats: available, failed: false }
      } catch {
        return { sats: 0, failed: true }
      }
    }),
  )
  return {
    swept: results.filter((r) => r.sats > 0).length,
    satsReturned: results.reduce((sum, r) => sum + r.sats, 0),
    failed: results.filter((r) => r.failed).length,
    ms: Math.round(performance.now() - started),
  }
}
