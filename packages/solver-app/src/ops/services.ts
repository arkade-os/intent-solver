/**
 * The service stack every long-lived mode and every operator command runs on.
 *
 * Separate from `cli.ts` so `src/ops/` can name it without importing the CLI
 * entrypoint, and so the admin console is handed the SAME object the money-mover uses:
 * Arkade coin reservations live in a process-local ledger, so anything that spends has
 * to run inside the process holding them.
 *
 * Owns both the shape and its construction. `createServices` cannot live in
 * `cli.ts`: that module runs `main()` on import, so re-exporting it would run
 * the CLI and exit the consumer's process.
 */

import { TickErrorTracker } from './tickErrors.js'
import type { OnchainSendBackend } from '@arkade-os/solver-core/ports/onchain.js'
import type { CorridorSet, CorridorReaderSet } from '@arkade-os/solver-core/core/corridor.js'
/** Aliased: `Corridor` in this file is corridorPolicy's closed union of pair names. */
import type { Corridor as CorridorPlugin } from '@arkade-os/solver-core/core/corridor.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { resolveDbLayout } from '@arkade-os/solver-corridors/db/layout.js'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { ArkAddress, RestEmulatorProvider } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { Transaction, SigHash, p2tr, Address, OutScript } from '@scure/btc-signer'
import { corridorSetFromDeps, readerSetFromDeps } from './corridorSet.js'
import { loadConfig, swapDbPath, type Config } from '../config.js'
import type { PricingStrategy } from '@arkade-os/solver-core/core/pricing.js'
import { onchainCorridorPricing, onchainFeeRateSampler } from './onchainPricing.js'
import { claimSpendVsize, fundingTxVsize } from '@arkade-os/solver-rails/onchain/sizing.js'
import { esploraChainTip } from '@arkade-os/solver-rails/onchain/chainTip.js'
import { createEsploraClient } from '@arkade-os/solver-rails-esplora/esplora.js'
import type { Corridor } from '@arkade-os/solver-core/core/corridorPolicy.js'
import { SwapStore, type SendSwapRow } from '@arkade-os/solver-corridors/db/swaps.js'
import { OnchainSendSwapStore, type OnchainSendSwapRow } from '@arkade-os/solver-corridors/db/onchainSwaps.js'
import { EvmSendSwapStore } from '@arkade-os/solver-corridors-evm/db/evmSendSwaps.js'
import { EvmReceiveSwapStore } from '@arkade-os/solver-corridors-evm/db/evmReceiveSwaps.js'
import { loadEvmChainConfig } from '@arkade-os/solver-rails-evm/evm/config.js'
import { createJsonRpc } from '@arkade-os/solver-rails-evm/evm/rpc.js'
import { createEvmHtlcBackend } from '@arkade-os/solver-rails-evm/evm/backend.js'
import { createEvmBroadcaster, nonceSourceFor } from '@arkade-os/solver-rails-evm/evm/broadcast.js'
import { createPriceFeed } from '@arkade-os/solver-core/price/feed.js'
import { addressFromPrivateKey } from '@arkade-os/solver-rails-evm/evm/transaction.js'
import { EvmSendSwapService } from '@arkade-os/solver-corridors-evm/send/evmOrchestrator.js'
import { EvmReceiveSwapService } from '@arkade-os/solver-corridors-evm/receive/evmOrchestrator.js'
import { evmSendArkadeDeps } from '@arkade-os/solver-corridors-evm/send/evmArkadeDeps.js'
import { evmReceiveArkadeDeps } from '@arkade-os/solver-corridors-evm/receive/evmArkadeDeps.js'
import {
  createArkadeContext,
  findClaimPreimage,
  findLockupOutpoints,
  findLockups,
  refundSwapScript,
  type ArkadeContext,
} from '@arkade-os/solver-arkade/arkade/wallet.js'
import type { LightningBackend, SendBackend } from '@arkade-os/solver-core/ports/lightning.js'
import { FakeLightningBackend } from '@arkade-os/solver-rails-fake/ln/fake/backend.js'
import { LndLightningBackendAdapter } from '@arkade-os/solver-rails-lnd/ln/lnd/adapter.js'
import { FakeOnchainBackend } from '@arkade-os/solver-rails-fake/onchain/fake/backend.js'
import { LndOnchainAdapter } from '@arkade-os/solver-rails-lnd/onchain/lnd/adapter.js'
import { lightningRailFor, type LightningRail } from './rails.js'
import { buildOnchainHtlc, ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'
import { arkadeOpsFromContext } from '@arkade-os/solver-corridors/send/arkadeOps.js'
import { SendSwapService } from '@arkade-os/solver-corridors/send/orchestrator.js'
import { OnchainSendSwapService } from '@arkade-os/solver-corridors/send/onchainOrchestrator.js'
import { ReceiveSwapStore } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import { OnchainReceiveSwapStore } from '@arkade-os/solver-corridors/db/onchainReceiveSwaps.js'
import { AdminStore } from '../admin/db.js'
import {
  assetMarketPolicy,
  type AssetMarketPair,
  type AssetMarketPricingView,
} from '@arkade-os/solver-core/core/assetMarketConfig.js'
import { applyOverrides } from '../admin/settings.js'
import { ReceiveSwapService } from '@arkade-os/solver-corridors/receive/orchestrator.js'
import { OnchainReceiveSwapService } from '@arkade-os/solver-corridors/receive/onchainOrchestrator.js'
import { createCovclaimdClient } from '@arkade-os/solver-corridors/receive/covclaimd.js'
import { receiveArkadeOpsFromContext } from '@arkade-os/solver-corridors/receive/arkadeOps.js'
import { onchainReceiveArkadeOpsFromContext } from '@arkade-os/solver-corridors/receive/onchainArkadeOps.js'
import { GiveUp, json, log, nowSeconds, poll, sleep } from '@arkade-os/solver-core/util/poll.js'
import { poolPlan, mintPool, committedAcrossCorridors } from './pool.js'
import { OfferFillStore } from '@arkade-os/solver-corridors/db/offerFills.js'
import { assertMarketsPriced, AssetOfferService } from './assetOffers.js'
import { offerOutputsAt } from '@arkade-os/solver-arkade/arkade/offerOutputs.js'
import { offerSettleFor } from '@arkade-os/solver-arkade/arkade/offerSettle.js'

export interface Services {
  /**
   * The ENVIRONMENT's configuration, exactly as `loadConfig()` read it.
   *
   * Deliberately not the effective policy — see {@link Services.policy}. This
   * is the ceiling `validateOverride` measures against, so an override can
   * always be relaxed back toward what the environment permits.
   */
  config: Config
  /**
   * What this process actually quotes: {@link Services.config} narrowed by the
   * console's stored overrides, resolved once at startup.
   *
   * The services were constructed from these values and nothing re-reads them,
   * which is why a settings change needs a restart. Anything that must AGREE
   * with what gets quoted — the ingress corridor gate, the open-RFQ bidder,
   * the registry card — reads this rather than `config`, or it would advertise
   * terms the corridor then refuses.
   */
  policy: Config
  /**
   * The Arkade asset markets this process trades, resolved once at startup from
   * the console's stored rows.
   *
   * Both halves together, and never one without the other — @see
   * `core/assetMarketConfig.ts`'s `assetMarketPolicy`, which derives them from
   * one filter for exactly that reason. `assetMarketPairs` empty refuses every
   * offer; `assetMarkets` empty means "this deployment has not opted into price
   * gating" and fills at whatever a maker asks.
   *
   * EMPTY on a deployment that has configured none, which is the default and the
   * whole of the additive claim: no market rows means both lists are empty, the
   * offer path serves no pair, and the solver behaves exactly as it did before
   * markets could be configured at all.
   */
  assetMarkets: readonly AssetMarketPricingView[]
  assetMarketPairs: readonly AssetMarketPair[]
  store: SwapStore
  onchainStore: OnchainSendSwapStore
  receiveStore: ReceiveSwapStore
  onchainReceiveStore: OnchainReceiveSwapStore
  /**
   * The EVM corridors' stores, or NULL when this deployment serves no token.
   *
   * Nullable rather than always-open, unlike the four BTC stores. Those are
   * opened unconditionally because every deployment has them; opening these
   * unconditionally would create two SQLite files on every solver that has
   * never heard of an ERC20, which is a visible change to a deployment that
   * asked for nothing. `config.evmCorridors` being empty is the signal.
   *
   * One store per DIRECTION, not per token: `token_address` is a column, so all
   * of a deployment's tokens share these two.
   */
  evmSendStore: EvmSendSwapStore | null
  evmReceiveStore: EvmReceiveSwapStore | null
  /**
   * The EVM corridors' orchestrators, or NULL on a deployment serving no token.
   *
   * `null` rather than `undefined`, unlike the four BTC services above. Those
   * are optional because each is independently switched off by
   * `corridorEnabled`; these two exist or do not TOGETHER, on whether a chain
   * is configured at all — the same condition their stores turn on. Matching
   * the stores' nullability keeps "does this deployment serve EVM?" one
   * question with one answer.
   *
   * One service per DIRECTION, not per token, for the reason the stores are:
   * a deployment has one `ERC20Swap` contract and every token it serves locks
   * inside it.
   */
  evmSendService: EvmSendSwapService | null
  evmReceiveService: EvmReceiveSwapService | null
  /**
   * The offer-packet path, or NULL when this deployment serves no market
   * (`OFFER_MARKETS` unset, which is the default).
   *
   * NOT a corridor, and absent from `corridors`/`readers` rather than missing
   * from them: both legs are on Arkade and the maker's covenant obliges the fill
   * to pay them, so there is no HTLC, no deadline and no refund for a corridor's
   * machinery to drive. @see ops/assetOffers.ts
   *
   * Nullable together with its store on one condition, the way the EVM pair is:
   * a deployment serving no market would otherwise get an `offer_fill` table it
   * never asked for and a subscription to a stream it has no use for.
   */
  offerStore: OfferFillStore | null
  assetOffers: AssetOfferService | null
  /**
   * Settings overrides and the action audit log, in their own database. Open
   * whether or not the console is running: operator actions are auditable from
   * the CLI too.
   */
  adminStore: AdminStore
  arkade: ArkadeContext
  /**
   * Per-swap failure state: what is failing, how often, and which swaps are held off.
   * On Services because the watch loop clears it and the console reads it, and neither
   * is inside createServices.
   */
  tickErrors: TickErrorTracker
  /**
   * The BTC rail's two legs, or NULL on a deployment that serves no BTC corridor.
   *
   * Both, not just `SendBackend`: the receive corridor needs the hold-invoice half
   * (`createHoldInvoice`/`getHoldState`/`settleHold`).
   *
   * Nullable together, because they are one wallet (@see ops/rails.ts) and one
   * knob selects them — `config.lnBackend === null`, which `loadConfig` permits
   * only while all four BTC corridors are disabled. Nothing that runs on such a
   * deployment legitimately reads either; `requireLn`/`requireOnchain` are what
   * an accidental read gets, and they say which deployment this is rather than
   * reporting a zero balance.
   */
  ln: LightningBackend | null
  onchain: OnchainSendBackend | null
  /**
   * Present iff the corridor is enabled (`corridorEnabled`). Absent means the
   * pair is refused as unsupported at the ingress — what a solver that does
   * not serve it should say — and the watch loop simply has nothing to drive.
   *
   * Still named individually because `src/ops/` reaches specific corridors for
   * specific operator actions (`reclaimOnchainHtlc`, `settleRefundDeposits`,
   * `refundNow`), and those are per-corridor by nature rather than something
   * the registry generalises. The registry below is what every CORRIDOR-AGNOSTIC
   * caller uses; these four are the deliberate exception, not a leftover.
   */
  service?: SendSwapService
  onchainService?: OnchainSendSwapService
  receiveService?: ReceiveSwapService
  onchainReceiveService?: OnchainReceiveSwapService
  /**
   * The corridors this deployment SERVES, keyed by pair.
   *
   * Exactly the enabled ones, because a corridor is registered only when its
   * service exists. The sweep drives this and the transports quote through it.
   *
   * Deliberately NOT the set the console reads — see {@link Services.readers},
   * which is wider by exactly the corridors an operator switched off.
   */
  corridors: CorridorSet
  /**
   * What the console and `rfq_status_request` read. Wider than
   * {@link Services.corridors}: a corridor an operator switched off keeps its
   * in-flight swaps listed and its negotiations answerable.
   */
  readers: CorridorReaderSet
  /** Emulator signer key (compressed hex), fetched once at startup. */
  emulatorPubkey: string
  /** Provider x-only pubkey (hex) — the relay address clients send offers to. */
  providerPubkey: string
  close(): Promise<void>
}

/**
 * Open the BTC rail `config.lnBackend` names — BOTH legs, from one place.
 *
 * ONE switch, where there used to be two mirrored ones: a Lightning selector
 * and an onchain selector over the same knob, with the same cases, which had to
 * agree case for case and had no way to enforce that they did. A rail is a
 * wallet, and a wallet answers both ports.
 *
 * The built-ins are answered here rather than through the registry so a
 * consumer's rail can never shadow them; `registerLightningRail` refuses those
 * two names as well, and the pair of guards is cheap.
 *
 * An unregistered name reaching here means `loadConfig` accepted a rail that has
 * since gone missing — registration happens at import time and validation reads
 * the registry, so the only way to get here is a consumer registering AFTER the
 * config was loaded. Named as that, rather than as an unknown backend.
 */
const createRail = async (config: Config): Promise<LightningRail> => {
  if (config.lnBackend === 'fake') {
    return {
      ln: new FakeLightningBackend(config.fakeLnStatePath, config.profile.invoicePrefix),
      onchain: new FakeOnchainBackend(5, 0, ONCHAIN_NETWORKS[config.network]),
    }
  }
  if (config.lnBackend === 'lnd') {
    // loadConfig() only produces lnBackend: 'lnd' together with a populated lnd config.
    return {
      ln: await LndLightningBackendAdapter.create(config.lnd!),
      onchain: await LndOnchainAdapter.create(config.lnd!),
    }
  }
  // Non-null: the caller only reaches this for a configured rail.
  const rail = lightningRailFor(config.lnBackend!)
  if (rail === undefined) {
    throw new Error(
      `no lightning rail is registered as '${config.lnBackend}' — registerLightningRail must run before loadConfig`,
    )
  }
  return rail.create(config)
}

/**
 * Build the full service stack.
 *
 * The Lightning and Arkade wallets are initialised SEQUENTIALLY on purpose: two
 * Lightning-backend wallets in one process tear each other down when brought up
 * concurrently, and keeping every init serial means no command can ever hit
 * that, whatever combination of wallets it needs.
 *
 * Only ENABLED corridors get a service (`<CORRIDOR>_ENABLED`; see
 * `corridorEnabled` in src/config.ts): a disabled one is refused by name at
 * the ingress rather than quoted and failed per swap. The stores stay open
 * regardless — rows a corridor wrote while it was enabled stay readable, and
 * its own refund tooling keeps working (`opts.allCorridors`, used by the
 * one-shot operator commands that unwind EXISTING rows and never open an
 * ingress; disabling a corridor must not strand the tools that refund it).
 *
 * `opts.corridors` registers consumer corridors beside the built-ins: same
 * sweep, same ingress, same status route. They are not subject to
 * `corridorEnabled`, which is keyed by the closed union of built-in pairs — a
 * consumer passes the corridors it wants served.
 */
export const createServices = async (
  config: Config,
  opts?: { allCorridors?: boolean; corridors?: readonly CorridorPlugin[] },
): Promise<Services> => {
  // One file on a fresh install, the five it already has on an existing one —
  // see src/db/layout.ts for why nothing ever moves rows between them.
  const layout = resolveDbLayout(config.swapDbPath)
  // The swap file is opened in BOTH layouts: consolidated it holds every
  // corridor, split it still holds the Lightning send tables AND the EVM ones
  // (src/db/layout.ts explains why a corridor with no previous release has no
  // legacy file to preserve). One driver for it either way, so the EVM stores
  // never open a second connection to a file this process already has open.
  const swapFile = betterSqliteDriver(config.swapDbPath)
  // Consolidated, every store shares ONE connection. Safe because no two
  // stores name the same table or index, and the only `driver.transaction()`
  // in the codebase runs inside `open()`, which is awaited store by store — so
  // no two of them are ever mid-transaction on this handle at the same time.
  // Each store still gets its own `close()`; better-sqlite3's is a no-op after
  // the first, and `Services.close()` isolates each step anyway.
  const shared = layout.consolidated ? swapFile : undefined
  const store = await SwapStore.open(swapFile)
  const onchainStore = await OnchainSendSwapStore.open(shared ?? layout.onchainSend)
  const receiveStore = await ReceiveSwapStore.open(shared ?? layout.receive)
  const onchainReceiveStore = await OnchainReceiveSwapStore.open(shared ?? layout.onchainReceive)
  // NOT opened unconditionally, unlike the four above. A deployment serving no
  // token would otherwise get EVM tables it never asked for, which is a visible
  // change for a solver that has never heard of an ERC20. One store per
  // DIRECTION rather than per token — `token_address` is a column.
  const servesEvm = config.evmCorridors.length > 0
  const evmSendStore = servesEvm ? await EvmSendSwapStore.open(swapFile) : null
  const evmReceiveStore = servesEvm ? await EvmReceiveSwapStore.open(swapFile) : null
  // Opened unconditionally, even when the console is off: the audit log is
  // written by operator actions the CLI can run too, and a store that exists
  // only sometimes is a branch every caller would have to think about.
  const adminStore = await AdminStore.open(shared ?? layout.admin)
  // The READER set: a corridor an operator switched off still has in-flight
  // swaps, and those are still exposure the cap must count.
  const totalCommitted = () =>
    committedAcrossCorridors(readerSetFromDeps({ store, onchainStore, receiveStore, onchainReceiveStore }))
  /**
   * ONE control for every corridor, deliberately. Each service would happily
   * make its own, and that still bounds a corridor against itself — but the
   * cap is global (#96), so two corridors quoting at once must contend for the
   * same headroom or the bound is only ever per-corridor again.
   */
  const admission = new AdmissionControl()
  /**
   * ONE tracker for every corridor: the backoff exists so a FAILING BACKEND is
   * not hammered, and the corridors share their backends.
   */
  const tickErrors = new TickErrorTracker()
  /**
   * What this process will ACTUALLY quote: the environment, narrowed by any
   * overrides the console has stored.
   *
   * Read once, here, and never again — the services below are handed their
   * policy at construction and nothing re-reads it, which is exactly why a
   * settings change needs a restart to take effect.
   *
   * `config` stays the ENVIRONMENT's values and is what `Services.config`
   * carries. The distinction is load-bearing: `validateOverride` uses it as
   * the ceiling an override may not widen past, so if it were the already
   * narrowed policy an operator could only ever ratchet limits downward and
   * could never restore what the environment actually allows.
   *
   * `applyOverrides` is pure and can only narrow limits and the exposure cap,
   * cannot enable a corridor the environment disabled, and bounds fees to the
   * same range `config.ts` validates — so this can lower the amount at risk
   * but never raise it above what the deployment already permitted.
   */
  const policy = applyOverrides(config, await adminStore.getOverrides())
  /**
   * The asset markets, read once from the same store and validated HERE.
   *
   * THROWS on a stored market that no longer validates, and that is the
   * opposite treatment `applyOverrides` gives a bad override — where skipping is
   * right, because refusing to start would take a solver down over a preference.
   * A market is not a preference, and the asymmetry is a fund-loss one:
   *
   * `AssetOfferService.withinTolerance` reads an EMPTY pricing list as "this
   * deployment has not opted into price gating" and returns true for every
   * offer — it fills at whatever a maker names. So a startup that dropped bad
   * markets one at a time could empty the list and, in doing so, silently turn
   * the price gate OFF on a deployment that had configured it on. Refusing to
   * start is loud, is recoverable from the console, and cannot mislead.
   *
   * NO FEED PROBE. Whether the URL answers today is deliberately not a boot
   * condition: it was checked when the market was written, the runtime already
   * fails closed on a read that fails, and making a solver's startup depend on a
   * third party's uptime would take four unrelated BTC corridors down with a
   * price API. @see admin/routes/markets.ts
   */
  const assetMarkets = assetMarketPolicy(await adminStore.listMarkets())
  // NULL exactly when `config.lnBackend` is, which `loadConfig` permits only
  // while all four BTC corridors are disabled — a deployment serving EVM or
  // asset flow alone, which has no use for a Lightning node and is not made to
  // stand one up. Nothing below constructs a BTC corridor without it.
  const rail = config.lnBackend === null ? null : await createRail(config)
  const arkade = await createArkadeContext(config.arkade)
  // The emulator key is read at startup and snapshotted per swap; a rotation
  // only affects new quotes, never the reconstruction of funded scripts.
  const emulatorInfo = await new RestEmulatorProvider(config.emulatorUrl).getInfo()
  const arkadeOps = await arkadeOpsFromContext(arkade, { url: config.emulatorUrl, pubkey: emulatorInfo.signerPubkey })

  /**
   * The offer-packet path. Off unless a market is named, like the EVM pair, and
   * in the swap file for the reason `db/layout.ts` gives about the EVM tables:
   * `offer_fill` has no previous release and so no legacy split file to preserve.
   *
   * The solver is always the TAKER here, and nothing in this construction can
   * publish an offer — there is no maker seam to configure.
   *
   * Read off `policy`, not `config`, by the rule this file states for anything
   * that decides what gets served. No override touches these three today, so the
   * two carry the same values — reading `policy` is what keeps that true if one
   * is ever added, rather than something to remember at that point.
   */
  const servesOffers = policy.offerMarkets.length > 0
  // BEFORE the store is opened, so a deployment that cannot price what it serves
  // does not come up at all. `withinTolerance` returns TRUE on an empty pricing
  // list, so a market without one is not gated leniently — it is not gated. The
  // two halves arrived by different routes (`OFFER_MARKETS` from the
  // environment, the feed from the console's market rows) and nothing until now
  // required them to meet.
  if (servesOffers) assertMarketsPriced(policy.offerMarkets, assetMarkets.pricing)
  const offerStore = servesOffers ? await OfferFillStore.open(swapFile) : null
  const assetOffers = offerStore
    ? new AssetOfferService({
        store: offerStore,
        markets: policy.offerMarkets,
        // The console's market rows, in the shape this service consumes. The
        // assertion above is what guarantees this covers every served market;
        // without both, `withinTolerance` waves every offer through.
        pricing: assetMarkets.pricing,
        // Same reader the EVM corridors price from — the market config
        // deliberately speaks `evmCorridorConfig.ts`'s feed-plus-pointer dialect
        // so one implementation serves both.
        fetchPrice: createPriceFeed(),
        minFillAmount: policy.offerMinFillAmount,
        maxFillAmount: policy.offerMaxFillAmount,
        // AVAILABLE, never total, and read fresh per decision. @see offerInventory.ts
        balance: () => arkade.wallet.getBalance(),
        outputsAt: (offerPkScript) => offerOutputsAt(arkade, offerPkScript),
        // Swap Protocol V1 § 5.1 is a MUST, and the key it needs is one this
        // process already holds — so it is passed rather than left optional.
        // Absent, `consider()` documents itself as skipping that check.
        serverPubkey: arkade.wallet.arkServerPublicKey,
        // THE SPEND. Wired here because this is where the wallet and the
        // emulator meet; every guard on it lives in `arkade/offerSettle.ts`.
        settle: offerSettleFor({ ctx: arkade, emulatorUrl: config.emulatorUrl }),
        onError: (id, error) => log(`offer ${id} failed:`, error instanceof Error ? error.message : String(error)),
      })
    : null

  /**
   * Whether to build a BTC corridor's service — its own switch, and a rail to
   * run on.
   *
   * The rail half is not a second policy: all four take both their legs from it,
   * so with `LN_BACKEND` unset there is nothing to construct them against.
   * `opts.allCorridors` deliberately does NOT override that — it exists so a
   * one-shot command can unwind rows of a corridor an operator switched off,
   * and no amount of asking makes a wallet exist. Those commands already refuse
   * by name when a service is absent (`src/ops/refunds.ts`).
   *
   * `rail!` below is read off this: every construction sits inside a branch this
   * predicate guarded, and the predicate is false without a rail.
   */
  const enabled = (corridor: Corridor): boolean =>
    rail !== null && (opts?.allCorridors === true || policy.corridorEnabled[corridor])

  /**
   * Whether to wire the coupled self-payment refresh, decided ONCE for both
   * legs. It takes both Lightning corridors — the client quotes one, then the
   * other against the bolt11 it was handed — so with either disabled there is
   * no flow to serve.
   *
   * Read once and used on both services on purpose: wiring the receive half
   * alone would let this solver fund a payout it has no path to collect on.
   */
  const selfPaymentCoupling = enabled('arkade:BTC->lightning:BTC') && enabled('lightning:BTC->arkade:BTC')

  /**
   * ONE sampled sats/vbyte reading, shared by BOTH onchain corridors, and null
   * unless a corridor asked for live pricing — which is the default.
   *
   * Sampled rather than read per quote because `PricingStrategy` is synchronous
   * on purpose: see `core/pricing.ts` on why a quote must not become an
   * upstream call a taker can trigger. The cadence comes from `config` rather
   * than `policy` because it is not a console-editable knob and must not become
   * one by riding along in the overrides object.
   */
  const onchainFeeRate =
    rail === null
      ? null
      : onchainFeeRateSampler({
          bounds: policy.corridorNetworkFees,
          estimateFeeRate: () => rail.onchain.estimateFeeRate(),
          refreshAfterMs: config.onchainFeeRateRefreshMs,
          staleAfterMs: config.onchainFeeRateStaleMs,
        })

  /** This corridor's pricing, or undefined to leave it exactly as it was. @see ops/onchainPricing.ts */
  const onchainPricingFor = (corridor: Corridor, vsize: number): PricingStrategy | undefined =>
    onchainCorridorPricing({
      bounds: policy.corridorNetworkFees[corridor],
      base: policy.corridorFees[corridor],
      feeRate: onchainFeeRate,
      vsize,
    })

  /**
   * Where to read the chain tip, for a deployment whose timelocks count blocks.
   *
   * Built once and shared by both Lightning services so every swap in a tick resolves
   * its deadlines against ONE height — two swaps in a tick deciding against different
   * heights is how one refund gets pushed and its neighbour does not.
   *
   * Undefined on a seconds-typed deployment, which never asks for a height. The
   * orchestrators throw a named error rather than guessing if a block-typed row ever
   * reaches them without one.
   */
  const chainTip = config.chainTipEsploraUrl
    ? esploraChainTip(createEsploraClient(config.chainTipEsploraUrl))
    : undefined

  const service = enabled('arkade:BTC->lightning:BTC')
    ? new SendSwapService({
        store,
        chainTip,
        ln: rail!.ln,
        arkade: arkadeOps,
        backendName: config.lnBackend ?? undefined,
        limits: policy.corridorLimits['arkade:BTC->lightning:BTC'],
        fee: policy.corridorFees['arkade:BTC->lightning:BTC'],
        invoicePrefix: config.profile.invoicePrefix,
        maxExposedSats: policy.maxExposedSats,
        totalCommitted,
        admission,
        sweepConcurrency: config.sweepConcurrency,
        lockupTimeout: config.lockupTimeoutSeconds,
        sendHintScidDenylist: config.sendHintScidDenylist,
        // Every other corridor's store, so a hash that is live anywhere is
        // spoken for here too.
        //
        // `receiveStore` moves OUT of this list exactly when coupling is on,
        // because it is then passed below instead: a live row there becomes
        // the one cross-corridor hit that can be legitimate, and this loop
        // cannot tell that case apart — it answers `unknown`. In both places
        // at once, the loop would re-refuse every coupling. In neither, the
        // duplicate check against that store would silently disappear, so with
        // coupling off it stays here, exactly as it always was.
        peerStores: selfPaymentCoupling
          ? [onchainStore, onchainReceiveStore]
          : [onchainStore, receiveStore, onchainReceiveStore],
        // Recognise-and-collect, wired as one unit: the store that spots a
        // coupling, plus the two indexer reads that later recover `P` from the
        // client's claim on our payout. Half of this would mean accepting
        // couplings we could never collect on.
        coupling: selfPaymentCoupling
          ? {
              receiveStore,
              findLockupOutpoints: (pkScriptHex) => findLockupOutpoints(arkade, pkScriptHex),
              findClaimPreimage: (outpoints, paymentHashHex) => findClaimPreimage(arkade, outpoints, paymentHashHex),
            }
          : undefined,
      })
    : undefined
  if (service) {
    service.onTickError = (id, error) => {
      const { line } = tickErrors.record(id, error)
      if (line) log(`tick ${id} failed:`, line)
    }
    service.onTickSuccess = (id) => tickErrors.clear(id)
    // The denylist's only trace outside a config file. Logged at quote time,
    // where the number it changes (the refund deadline) is being decided.
    service.onDroppedRouteHints = ({ paymentHash, dropped, worstRouteHintCltvBlocks }) => {
      const listed = dropped.map((hint) => `scid ${hint.scid}, ${hint.cltv} blocks`).join('; ')
      log(
        `quote ${paymentHash}: dropped ${dropped.length} denylisted route hint(s) (${listed});` +
          ` pricing the worst surviving hint at ${worstRouteHintCltvBlocks} blocks`,
      )
    }
    service.shouldSkipTick = (id) => tickErrors.shouldSkip(id)
  }

  // The solver's own destination for reclaimed onchain HTLC funds — an address
  // on the SAME onchain backend that funded the HTLC, so a reclaim lands back
  // in the wallet the money left and is reusable straight away. NOT an Arkade
  // boarding address: that money never came from Arkade, and routing it there
  // forces an onboard now and an offboard again before the next HTLC can be
  // funded. Resolved once here (not per-refund), same as the emulator key.
  //
  // Hoisted out of the constructor call because the funding transaction's
  // SIZE depends on it: this is the solver's own script, and so the best
  // evidence available of what its wallet's change output will look like.
  // Still resolved only when the corridor is on — a disabled corridor must not
  // put an address request to a backend nothing is going to use.
  const onchainRefundDestinationScript = enabled('arkade:BTC->onchain:BTC')
    ? OutScript.encode(Address(ONCHAIN_NETWORKS[config.network]).decode(await rail!.onchain.newReceiveAddress()))
    : null

  const onchainService = enabled('arkade:BTC->onchain:BTC')
    ? new OnchainSendSwapService({
        store: onchainStore,
        onchain: rail!.onchain,
        arkade: arkadeOps,
        limits: policy.corridorLimits['arkade:BTC->onchain:BTC'],
        fee: policy.corridorFees['arkade:BTC->onchain:BTC'],
        // The transaction this corridor's solver broadcasts is the FUNDING of
        // the client's HTLC. The client pays for its own claim, so pricing this
        // side off a claim's vbytes would bill for a spend the solver never
        // makes.
        pricing: onchainPricingFor(
          'arkade:BTC->onchain:BTC',
          fundingTxVsize({
            network: ONCHAIN_NETWORKS[config.network],
            changeScript: onchainRefundDestinationScript!,
          }),
        ),
        network: config.network,
        maxExposedSats: policy.maxExposedSats,
        totalCommitted,
        admission,
        signer: { sign: (tx, inputIndexes) => arkade.identity.sign(tx, inputIndexes) },
        refundDestinationScript: onchainRefundDestinationScript!,
        peerStores: [store, receiveStore, onchainReceiveStore],
      })
    : undefined
  if (onchainService) {
    onchainService.onTickError = (id, error) => {
      const { line } = tickErrors.record(id, error)
      if (line) log(`onchain tick ${id} failed:`, line)
    }
    onchainService.onTickSuccess = (id) => tickErrors.clear(id)
    onchainService.shouldSkipTick = (id) => tickErrors.shouldSkip(id)
  }

  // The receive legs. Their Arkade ops are built from the SAME context and
  // emulator info as the send legs' — the difference between the two is which
  // covenant role the solver plays (funder here, receiver there), which the
  // ops factories encode, not a second wallet.
  //
  // `covclaimd` is left unset on purpose. It is optional by design, and
  // `covclaimd:v0.0.1-rc.1` accepts a reveal with HTTP 200 and then silently
  // never claims (observed on regtest 2026-08-07). Absent, the client claims
  // its own lockup holding the covenant's receiver key, which costs only the
  // client being online — so wiring a component that fails silently would be
  // strictly worse than not wiring it. See both orchestrators' `covclaimd` docs.
  // Hoisted rather than built inline, because the EVM receive leg below needs
  // the SAME ops. Two calls would derive two identical objects from the same
  // context, which works and gives the corridors two places to drift apart.
  // Wired when the deployment names a covclaimd (COVCLAIMD_URL). The receive legs
  // reveal each funded lockup's sealed claim packet to it so offline clients get
  // claimed; unset keeps the client-claims-its-own-lockup default.
  const covclaimd = config.covclaimdUrl ? createCovclaimdClient(config.covclaimdUrl) : undefined
  const receiveOps = await receiveArkadeOpsFromContext(arkade, {
    url: config.emulatorUrl,
    pubkey: emulatorInfo.signerPubkey,
  })
  const receiveService = enabled('lightning:BTC->arkade:BTC')
    ? new ReceiveSwapService({
        store: receiveStore,
        chainTip,
        ln: rail!.ln,
        arkade: receiveOps,
        limits: policy.corridorLimits['lightning:BTC->arkade:BTC'],
        fee: policy.corridorFees['lightning:BTC->arkade:BTC'],
        // From `config`, not `policy`: this is not a console-editable knob and
        // must not become one by riding along in the overrides object. Accepting
        // a loss is a deployment decision with a restart behind it, not a dial
        // an unauthenticated admin port can turn.
        acceptUnilateralGap: config.lnReceiveAcceptUnilateralGap,
        maxExposedSats: policy.maxExposedSats,
        totalCommitted,
        admission,
        covclaimd,
        // The send store leaves this list on exactly the same condition, and
        // for the same reason, as `receiveStore` leaves the send corridor's:
        // with coupling on, a live send row on our hash is the coupled leg,
        // not a conflict, and refusing it here would kill the flow at the
        // quote that creates it.
        peerStores: selfPaymentCoupling
          ? [onchainStore, onchainReceiveStore]
          : [store, onchainStore, onchainReceiveStore],
        // Gated on the SAME value the send corridor's `coupling` is, so the
        // pay half can never be wired without the collect half.
        coupledSendStore: selfPaymentCoupling ? store : undefined,
      })
    : undefined
  if (receiveService) {
    receiveService.onTickError = (id, error) => {
      const { line } = tickErrors.record(id, error)
      if (line) log(`receive tick ${id} failed:`, line)
    }
    receiveService.onTickSuccess = (id) => tickErrors.clear(id)
    receiveService.shouldSkipTick = (id) => tickErrors.shouldSkip(id)
  }

  // Its own address, not the send leg's refund destination. The two are the
  // same wallet and reusing one script would work, but they are opposite flows
  // — money coming IN off a client's HTLC versus money coming BACK off our own
  // — and giving each its own output keeps them separable in the wallet's
  // history when reconciling. Resolved once at startup, like the refund
  // destination above, and hoisted for the same reason: it is the claim
  // spend's only variable-size field, so this corridor's cost depends on it.
  const onchainClaimDestinationScript = enabled('onchain:BTC->arkade:BTC')
    ? OutScript.encode(Address(ONCHAIN_NETWORKS[config.network]).decode(await rail!.onchain.newReceiveAddress()))
    : null

  const onchainReceiveService = enabled('onchain:BTC->arkade:BTC')
    ? new OnchainReceiveSwapService({
        store: onchainReceiveStore,
        onchain: rail!.onchain,
        arkade: await onchainReceiveArkadeOpsFromContext(arkade, {
          url: config.emulatorUrl,
          pubkey: emulatorInfo.signerPubkey,
        }),
        limits: policy.corridorLimits['onchain:BTC->arkade:BTC'],
        fee: policy.corridorFees['onchain:BTC->arkade:BTC'],
        // Here the CLIENT funds the HTLC and the solver claims it, so the
        // transaction this corridor pays for is that claim — which
        // `solver-rails` sizes exactly, down to this deployment's own
        // destination script.
        pricing: onchainPricingFor(
          'onchain:BTC->arkade:BTC',
          claimSpendVsize({
            network: ONCHAIN_NETWORKS[config.network],
            destinationScript: onchainClaimDestinationScript!,
          }),
        ),
        network: config.network,
        maxExposedSats: policy.maxExposedSats,
        totalCommitted,
        admission,
        signer: { sign: (tx, inputIndexes) => arkade.identity.sign(tx, inputIndexes) },
        claimDestinationScript: onchainClaimDestinationScript!,
        peerStores: [store, onchainStore, receiveStore],
        covclaimd,
      })
    : undefined
  if (onchainReceiveService) {
    onchainReceiveService.onTickError = (id, error) => {
      const { line } = tickErrors.record(id, error)
      if (line) log(`onchain receive tick ${id} failed:`, line)
    }
    onchainReceiveService.onTickSuccess = (id) => tickErrors.clear(id)
    onchainReceiveService.shouldSkipTick = (id) => tickErrors.shouldSkip(id)
  }

  // The EVM corridors. BOTH LEGS OR NEITHER, unlike the four above: each of
  // those is switched off independently by `corridorEnabled`, whereas these two
  // share one chain, one contract, one signing key and — critically — one nonce
  // sequence, so there is nothing to turn off separately.
  //
  // A HALF-CONFIGURED chain is refused rather than degraded. Tokens named with
  // no `EVM_RPC_URL` still populate `config.evmCorridors` and still open both
  // stores, so the ingress would quote `ethereum:<token>->arkade:BTC` and accept
  // a client's ERC20 lock that no orchestrator exists to answer: the client's
  // money locked against a corridor this process cannot drive. That is the same
  // failure `evm/config.ts` refuses one level down — "a half-configured chain
  // must not start, because the missing half is always a safety knob."
  const evmChain = loadEvmChainConfig()
  if (servesEvm && evmChain === null) {
    throw new Error(
      'EVM_TOKENS names corridors but EVM_RPC_URL is not set — ' +
        'the ingress would quote swaps no orchestrator exists to drive',
    )
  }
  let evmSendService: EvmSendSwapService | null = null
  let evmReceiveService: EvmReceiveSwapService | null = null
  if (evmChain !== null && evmSendStore !== null && evmReceiveStore !== null) {
    const rpc = createJsonRpc({ url: evmChain.rpcUrl })
    const evm = createEvmHtlcBackend({ contractAddress: evmChain.contractAddress, rpc })
    // Number, not bigint, because that is what both orchestrators' deps take.
    // Safe for as long as block heights stay under 2^53 — nine orders of
    // magnitude away on every chain this could serve.
    const blockHeight = async (): Promise<number> => Number(await evm.currentBlock())
    // ONE broadcaster across both legs, and the nonce source is why. It is
    // per-ACCOUNT, not per-corridor: both legs sign with the same key, so two
    // sources would hand out the same nonce twice and one of the two
    // transactions would be dropped by the node with no error either leg could
    // see. @see evm/nonce.ts
    const broadcast = createEvmBroadcaster({
      rpc,
      privateKey: evmChain.privateKey,
      chainId: evmChain.chainId,
      nonces: nonceSourceFor(rpc),
      gasLimit: evmChain.gasLimit,
      maxFeeCeilingPerGas: evmChain.maxFeeCeilingPerGas,
      headroomSeconds: evmChain.headroomSeconds,
      fastestSecondsPerBlock: evmChain.cadence.fastestSecondsPerBlock,
      // Logged, never swallowed. The ceiling binding means the corridor is
      // bidding below what the chain currently wants, so the transaction may sit
      // unmined until the base fee falls — an operator needs to know that from
      // the log rather than infer it from swaps that stop settling.
      onCappedByPolicy: (call) =>
        log(`evm fee capped by policy on a call to ${call.to} — raise EVM_MAX_FEE_PER_GAS_CEILING or wait`),
    })
    // EVERY corridor's exposure, the EVM pair included. The cap bounds the
    // HOUSE, so a reading that left out two corridors would let them spend it
    // again — the same hole `committedAcrossCorridors` closed for the other
    // four. Built here rather than reused from `ops/pool.ts` because that helper
    // takes the assembled `Services`, which does not exist yet at construction.
    const totalCommitted = async (): Promise<number> => {
      const totals = await Promise.all([
        store.committedSats(),
        onchainStore.committedSats(),
        receiveStore.committedSats(),
        onchainReceiveStore.committedSats(),
        evmSendStore.committedSats(),
        evmReceiveStore.committedSats(),
      ])
      return totals.reduce((sum, value) => sum + value, 0)
    }
    // Keyed by token address: one store per DIRECTION serves every token, so one
    // service does too. @see EvmSendServiceDeps.markets
    const sendMarkets = new Map(
      policy.evmCorridors
        .filter((c) => c.direction === 'send' && c.enabled)
        .flatMap((c) => {
          const market = config.evmMarkets.find((m) => m.token.address === c.token.address)
          // A served corridor with no market cannot be priced. `loadConfig`
          // refuses that at startup, so reaching here means the two lists
          // disagree — skip rather than quote against a guess.
          return market
            ? [
                [
                  c.token.address,
                  { token: c.token, market, limits: c.limits, tokenLimits: c.tokenLimits, fee: c.fee },
                ] as const,
              ]
            : []
        }),
    )
    evmSendService = new EvmSendSwapService({
      store: evmSendStore,
      evm,
      broadcast,
      blockHeight,
      ...evmSendArkadeDeps(arkadeOps),
      arkade: arkadeOps,
      // The account the broadcaster signs from, so the allowance read below
      // describes the same account the contract will pull from.
      solverEvmAddress: addressFromPrivateKey(evmChain.privateKey),
      maxExposedSats: policy.maxExposedSats,
      totalCommitted,
      // The SAME control the other four corridors hold. A private one would
      // bound this corridor alone, which is not what the cap means.
      admission,
      markets: sendMarkets,
      fetchPrice: createPriceFeed(),
      chain: {
        contractAddress: hex.encode(evmChain.contractAddress),
        chainId: evmChain.chainId,
        minConfirmations: evmChain.minConfirmations,
        minAgeSeconds: evmChain.minAgeSeconds,
        cadence: evmChain.cadence,
        quoteValiditySeconds: evmChain.quoteValiditySeconds,
      },
      peerStores: [store, onchainStore, receiveStore, onchainReceiveStore],
      onTickError: (id, error) =>
        log(`evm send tick ${id} failed:`, error instanceof Error ? error.message : String(error)),
    })
    const receiveMarkets = new Map(
      policy.evmCorridors
        .filter((c) => c.direction === 'receive' && c.enabled)
        .flatMap((c) => {
          const m = config.evmMarkets.find((x) => x.token.address === c.token.address)
          return m
            ? [
                [
                  c.token.address,
                  { token: c.token, market: m, limits: c.limits, tokenLimits: c.tokenLimits, fee: c.fee },
                ] as const,
              ]
            : []
        }),
    )
    evmReceiveService = new EvmReceiveSwapService({
      store: evmReceiveStore,
      evm,
      broadcast,
      blockHeight,
      ...evmReceiveArkadeDeps(receiveOps),
      arkade: receiveOps,
      markets: receiveMarkets,
      fetchPrice: createPriceFeed(),
      // Where the SOLVER claims the client's tokens to. Derived from the same
      // key that signs the claim, so the contract pays the account that asked.
      evmClaimAddress: '0x' + hex.encode(addressFromPrivateKey(evmChain.privateKey)),
      chain: {
        contractAddress: hex.encode(evmChain.contractAddress),
        chainId: evmChain.chainId,
        minConfirmations: evmChain.minConfirmations,
        minAgeSeconds: evmChain.minAgeSeconds,
        cadence: evmChain.cadence,
        quoteValiditySeconds: evmChain.quoteValiditySeconds,
      },
      maxExposedSats: policy.maxExposedSats,
      totalCommitted,
      // The SAME control the other four corridors hold. A private one would
      // bound this corridor alone, which is not what the cap means.
      admission,
      peerStores: [store, onchainStore, receiveStore, onchainReceiveStore],
      onTickError: (id, error) =>
        log(`evm receive tick ${id} failed:`, error instanceof Error ? error.message : String(error)),
    })
  }

  // Shared by both sets so they cannot drift: the readers' extra width (stores
  // outlive their service) must be the only difference.
  const corridorDeps = {
    service,
    store,
    onchainService,
    onchainStore,
    receiveService,
    receiveStore,
    onchainReceiveService,
    onchainReceiveStore,
    // The EVM family registers per token: one corridor per enabled policy,
    // and only when its leg's service exists (a chain is configured).
    evmSendService,
    evmSendStore,
    evmReceiveService,
    evmReceiveStore,
    evmCorridors: policy.evmCorridors,
  }

  return {
    config,
    policy,
    assetMarkets: assetMarkets.pricing,
    assetMarketPairs: assetMarkets.pairs,
    store,
    onchainStore,
    receiveStore,
    onchainReceiveStore,
    evmSendStore,
    evmReceiveStore,
    evmSendService,
    evmReceiveService,
    offerStore,
    assetOffers,
    adminStore,
    arkade,
    ln: rail?.ln ?? null,
    onchain: rail?.onchain ?? null,
    service,
    onchainService,
    receiveService,
    onchainReceiveService,
    // Built once, here, from the services just constructed. A corridor is in
    // the set iff its service exists, which is iff `enabled()` said so — so
    // the registry IS the corridor-enablement decision, made in one place
    // instead of re-derived at every dispatch.
    corridors: corridorSetFromDeps(corridorDeps, opts?.corridors ?? []),
    // Built here, not per call site: a consumer's corridor has no store on
    // `Services` for a re-derivation to find.
    readers: readerSetFromDeps(corridorDeps, opts?.corridors ?? []),
    tickErrors,
    emulatorPubkey: emulatorInfo.signerPubkey,
    providerPubkey: arkadeOps.providerPubkey,
    close: async () => {
      // Each step isolated: one resource's close() throwing must never skip
      // the rest — ln/onchain matter most (an open gRPC channel left
      // dangling through a forced process.exit() crashes on Windows), and a
      // sequential await chain with no isolation would skip both if
      // store.close() (first, and least likely to matter) threw first.
      const steps: Array<[string, () => Promise<void> | void]> = [
        ['store', () => store.close()],
        ['onchainStore', () => onchainStore.close()],
        ['receiveStore', () => receiveStore.close()],
        ['onchainReceiveStore', () => onchainReceiveStore.close()],
        ['offerStore', () => offerStore?.close()],
        ['adminStore', () => adminStore.close()],
        ['arkade', () => arkade.close()],
        ['ln', () => rail?.ln.close?.()],
        ['onchain', () => rail?.onchain.close?.()],
      ]
      for (const [name, step] of steps) {
        try {
          await step()
        } catch (error) {
          log(`close(${name}) failed:`, error instanceof Error ? error.message : String(error))
        }
      }
    },
  }
}
