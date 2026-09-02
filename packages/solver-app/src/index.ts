/**
 * Library surface.
 *
 * The CLI (`src/cli.ts`) and any future HTTP layer are thin hosts over exactly
 * these exports; the money path lives behind {@link SendSwapService} and nowhere
 * else.
 */

export {
  SendSwapService,
  type ArkadeOps,
  type QuoteOutcome,
  type QuoteRefusal,
  type SendServiceDeps,
} from '@arkade-os/solver-corridors/send/orchestrator.js'
export {
  arkadeOpsFromContext,
  covenantScriptFromRow,
  type EmulatorInfo,
} from '@arkade-os/solver-corridors/send/arkadeOps.js'
export {
  SwapStore,
  type SendSwapRow,
  type SendSwapState,
  type QuoteRecord,
} from '@arkade-os/solver-corridors/db/swaps.js'
export { betterSqliteDriver, d1Driver, type SqlDriver, type D1Like } from '@arkade-os/solver-corridors/db/driver.js'
export {
  createArkadeContext,
  findLockups,
  claimSwapScript,
  refundSwapScript,
  type ArkadeContext,
  type ClaimableScript,
  type FundedOutput,
} from '@arkade-os/solver-arkade/arkade/wallet.js'
export { scriptHashFromPaymentHash } from '@arkade-os/solver-core/core/preimage.js'
export {
  CovenantSwapScript,
  enforcePayTo,
  preimageCondition,
  type CovenantSwapParams,
} from '@arkade-os/solver-arkade/arkade/covenant.js'
export {
  decodeInvoice,
  InvalidInvoice,
  type DecodedInvoice,
  type DroppedHint,
  type InvoiceRejection,
} from '@arkade-os/solver-core/invoice/decode.js'
export {
  evaluateSendAcceptance,
  evaluateSendPayment,
  refundLocktimeFor,
  type SendAcceptanceDecision,
  type SendPaymentDecision,
} from '@arkade-os/solver-core/core/send.js'
export { deriveUnilateralDelays, type UnilateralDelays } from '@arkade-os/solver-core/core/timelocks.js'
export { resolveLimits, maxRoutingFeeSats, type Limits } from '@arkade-os/solver-core/core/limits.js'
export { NETWORKS, type SwapNetwork, type NetworkProfile } from '@arkade-os/solver-core/core/networks.js'
export { loadConfig, type Config } from './config.js'
export { buildApp, type HttpDeps } from '@arkade-os/solver-transport/http/server.js'
export {
  RFQ_PAIR_SEND,
  RfqRequest,
  RfqStatusRequest,
  rfqQuotePayload,
  rfqRefusalPayload,
  rfqStatusPayload,
  rfqStateFromRow,
  toRfqReason,
  type RfqRefusalReason,
  type RfqState,
} from '@arkade-os/solver-corridors/wire/payloads.js'
/**
 * What a corridor's own `quote` needs to refuse a payload it cannot parse:
 * the rfq_id off an unparseable request, and a readable schema detail.
 */
export { extractRfqId, zodDetail, isRfqRefusalReason } from '@arkade-os/solver-core/core/rfqProtocol.js'
/** The SHARED exposure cap. A corridor that builds its own is uncapped against the rest. */
export { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
export {
  respondToRfqRequest,
  respondToRfqStatus,
  type RfqOutcome,
  type RfqStatusOutcome,
} from '@arkade-os/solver-transport/ingress/rfq.js'
export type { SwapIngress } from '@arkade-os/solver-transport/ingress/port.js'
export { RelayIngress, type RelayIngressDeps } from '@arkade-os/solver-transport/ingress/relay.js'
export {
  webSocketRelayConnection,
  encodeFrame,
  decodeFrame,
  matchesFilter,
  eventId,
  type RelayConnection,
  type RelayEvent,
  type RelayFilter,
  type RelayFrame,
  type RelaySubscription,
} from '@arkade-os/solver-transport/relay/connection.js'
export {
  buildWorker,
  makeWorkerEntry,
  type DriveJob,
  type MessageBatchLike,
  type QueueLike,
  type QueueMessageLike,
  type Worker,
  type WorkerDeps,
} from './worker.js'
export type {
  LightningBackend,
  SendBackend,
  ReceiveBackend,
  PaymentResult,
  PayInvoiceParams,
} from '@arkade-os/solver-core/ports/lightning.js'
export { LndLightningBackendAdapter } from '@arkade-os/solver-rails-lnd/ln/lnd/adapter.js'
export {
  OnchainSendSwapService,
  type OnchainArkadeOps,
  type OnchainQuoteRequest,
  type OnchainSendServiceDeps,
  type QuoteOutcome as OnchainQuoteOutcome,
  type QuoteRefusal as OnchainQuoteRefusal,
} from '@arkade-os/solver-corridors/send/onchainOrchestrator.js'
export {
  OnchainSendSwapStore,
  type OnchainSendSwapRow,
  type OnchainSendSwapState,
  type OnchainQuoteRecord,
} from '@arkade-os/solver-corridors/db/onchainSwaps.js'
export {
  buildOnchainHtlc,
  ONCHAIN_NETWORKS,
  type OnchainHtlc,
  type OnchainHtlcParams,
} from '@arkade-os/solver-rails/onchain/htlc.js'
export type { OnchainSendBackend, FundedOnchainOutput, OnchainBalance } from '@arkade-os/solver-core/ports/onchain.js'
export { FakeOnchainBackend } from '@arkade-os/solver-rails-fake/onchain/fake/backend.js'
export { LndOnchainAdapter } from '@arkade-os/solver-rails-lnd/onchain/lnd/adapter.js'
export { createEsploraClient, type EsploraClient, type EsploraTx } from '@arkade-os/solver-rails-esplora/esplora.js'
export {
  RFQ_PAIR_ONCHAIN_SEND,
  OnchainRfqRequest,
  onchainRfqQuotePayload,
  onchainRfqStatusPayload,
  onchainRfqStateFromRow,
} from '@arkade-os/solver-corridors/wire/onchainPayloads.js'
export {
  createCovclaimdClient,
  CovclaimdError,
  type CovclaimdClient,
  type CovclaimdPubKeys,
  type RevealParams,
} from '@arkade-os/solver-corridors/receive/covclaimd.js'

// Discovery: the git-reviewed registry card and the kind-38859 ad are
// different documents with different audiences, but both are indicative
// rendezvous data rather than terms. `AdPublishMode` is exported because the
// exported `Config` now carries one, so a consumer reading `nostrAdPublish`
// would otherwise have no way to name its type.
export {
  buildSolverAd,
  type SolverAd,
  type SolverAdInputs,
  type SolverAdPair,
} from '@arkade-os/solver-core/core/solverAd.js'
export {
  AdPublisher,
  type AdPublishMode,
  type AdPublishState,
  type AdPublisherOptions,
} from '@arkade-os/solver-transport/relay/adPublisher.js'

// The wallet's Nostr identity — BIP86 at m/86'/{0|1}'/0'/0/0, the same key
// the registry card advertises as `discovery_pubkey`. Exported because a
// relay CLIENT needs exactly this to sign its own events, and re-deriving
// BIP86 in a second place is how the two silently stop matching.
export {
  deriveNostrIdentity,
  NOSTR_KIND_DIRECTED,
  NOSTR_KIND_BROADCAST,
} from '@arkade-os/solver-transport/relay/nostr.js'

// --------------------------------------------------------------------------
// The solver SDK surface: everything needed to WRITE a corridor, and to swap
// the four policy decisions a solver operator owns.
//
// Exported deliberately and as a group. `src/index.ts` is the library surface —
// the CLI is a thin host over exactly these exports — so a type absent here is
// a type a consumer cannot name, however public it looks inside the tree. Every
// piece below was built to be implemented from outside; leaving them
// unexported would have made "anyone can build their own solver" false at the
// package boundary while looking true from within it.
// --------------------------------------------------------------------------

/** Write a corridor: implement `Corridor`, describe it, register it. */
export {
  createCorridorSet,
  createCorridorReaderSet,
  type Corridor,
  type CorridorReader,
  type CorridorSet,
  type CorridorReaderSet,
  type CorridorRfqOutcome,
  type CorridorSwapView,
  type CorridorPhase,
  type QuoteOptions,
} from '@arkade-os/solver-core/core/corridor.js'
export {
  createCorridorRegistry,
  type CorridorDescriptor,
  type CorridorRegistry,
  type PayoutRail,
} from '@arkade-os/solver-core/core/corridorDescriptor.js'

/** Persist one: the generic store the four built-in corridors share. */
export { BaseSwapStore, type StoreShape, type RawRow } from '@arkade-os/solver-corridors/db/baseSwapStore.js'

/** Settle one on Arkade: the covenant row shape its script is rebuilt from. */
export type { CovenantScriptRow } from '@arkade-os/solver-arkade/arkade/covenantRow.js'

/** Project one for the console. */
export { phaseOfStates, diagnose, type AdminSwap, type AdminPhase } from '@arkade-os/solver-core/core/swapView.js'

/** The four policy decisions an operator owns. Each defaults to today's behaviour. */
export { fixedFeePricing, type PricingStrategy } from '@arkade-os/solver-core/core/pricing.js'
export type { AdmissionStrategy, AdmissionRequest } from '@arkade-os/solver-core/core/admissionStrategy.js'
export { defaultBidding, type BiddingStrategy } from '@arkade-os/solver-core/core/openRfq.js'
export {
  readRails,
  balanceOfRail,
  type Rail,
  type RailId,
  type RailBalance,
  type RailBalances,
} from '@arkade-os/solver-core/core/rail.js'

/**
 * The service stack. `createServices(config, { corridors: [mine] })` registers
 * consumer corridors beside the built-ins, so the shipped sweep, ingress and
 * status route all serve them.
 */
export { createServices, type Services } from './ops/services.js'
/**
 * Bring your own BTC backend: `registerLightningRail('mine', module)` before
 * the entrypoint runs, then `LN_BACKEND=mine`.
 *
 * A registry rather than an option on `createServices`, because `src/cli.ts`
 * calls that at sixteen sites and runs `main()` at module load — an option
 * could only reach the shipped daemon through a fork of the CLI. The rail is a
 * PAIR (Lightning plus onchain) because all four BTC corridors take both their
 * legs from one wallet. @see ops/rails.ts
 */
export {
  registerLightningRail,
  lightningRailNames,
  lightningRailFor,
  type LightningRail,
  type LightningRailModule,
} from './ops/rails.js'
/**
 * Arkade asset-swap offers — asset↔BTC and asset↔asset. Not a corridor: both
 * legs are on Arkade and the maker's covenant obliges the fill, so there is no
 * HTLC, deadline or refund. Discovery and settlement are injected.
 */
export {
  AssetOfferService,
  parseAssetMarkets,
  type AssetOfferDeps,
  type AssetMarket,
  type DiscoveredOffer,
} from './ops/assetOffers.js'
export { corridorSetFromDeps, readerSetFromDeps, type FlatCorridorDeps } from './ops/corridorSet.js'
