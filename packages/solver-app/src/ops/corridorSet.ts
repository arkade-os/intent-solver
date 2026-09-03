/**
 * Which corridors THIS deployment serves, assembled from its own services and
 * stores.
 *
 * Composition-root work: naming every corridor a deployment might register is
 * the property of the thing that configures it. Each corridor package still
 * owns its own adapters — only the roll-call lives here, which is what lets
 * `@arkade-os/solver-transport` compile against `@arkade-os/solver-core` alone.
 */
import {
  createCorridorReaderSet,
  createCorridorSet,
  type Corridor,
  type CorridorReader,
  type CorridorReaderSet,
  type CorridorSet,
} from '@arkade-os/solver-core/core/corridor.js'
import type { EvmCorridorPolicy } from '@arkade-os/solver-core/core/evmCorridorConfig.js'
import {
  lightningSendCorridor,
  lightningReceiveCorridor,
  onchainSendCorridor,
  onchainReceiveCorridor,
  lightningSendReader,
  lightningReceiveReader,
  onchainSendReader,
  onchainReceiveReader,
} from '@arkade-os/solver-corridors/corridors/adapters.js'
import {
  evmReceiveCorridor,
  evmReceiveDescriptor,
  evmReceiveReader,
  evmSendCorridor,
  evmSendDescriptor,
  evmSendReader,
} from '@arkade-os/solver-corridors-evm/corridors/evmCorridors.js'
import type { SendSwapService } from '@arkade-os/solver-corridors/send/orchestrator.js'
import type { ReceiveSwapService } from '@arkade-os/solver-corridors/receive/orchestrator.js'
import type { OnchainSendSwapService } from '@arkade-os/solver-corridors/send/onchainOrchestrator.js'
import type { OnchainReceiveSwapService } from '@arkade-os/solver-corridors/receive/onchainOrchestrator.js'
import type { SwapStore } from '@arkade-os/solver-corridors/db/swaps.js'
import type { ReceiveSwapStore } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import type { OnchainSendSwapStore } from '@arkade-os/solver-corridors/db/onchainSwaps.js'
import type { OnchainReceiveSwapStore } from '@arkade-os/solver-corridors/db/onchainReceiveSwaps.js'
import type { EvmSendSwapStore } from '@arkade-os/solver-corridors-evm/db/evmSendSwaps.js'
import type { EvmReceiveSwapStore } from '@arkade-os/solver-corridors-evm/db/evmReceiveSwaps.js'
import type { EvmSendSwapService } from '@arkade-os/solver-corridors-evm/send/evmOrchestrator.js'
import type { EvmReceiveSwapService } from '@arkade-os/solver-corridors-evm/receive/evmOrchestrator.js'
import {
  assetRfqCorridor,
  assetRfqDescriptor,
  assetRfqReader,
  type AssetRfqDirection,
} from '@arkade-os/solver-corridors/corridors/assetRfq.js'
import type { AssetRfqMarket, AssetRfqSwapService } from '@arkade-os/solver-corridors/asset/assetRfqOrchestrator.js'
import type { AssetRfqSwapStore } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'

/**
 * Both directions of every asset market, always in this order.
 *
 * A market is a market in both directions (`core/assetOffer.ts` says so of the
 * packet path), but a PAIR is directional — so one configured market registers
 * two corridors. A direction an operator closed with `max: 0n` still registers
 * and refuses by amount, which is the honest answer: the pair IS served, at no
 * size, and darkening it entirely would answer `unsupported_pair` about a pair
 * the registry card still advertises.
 */
const ASSET_RFQ_DIRECTIONS: readonly AssetRfqDirection[] = ['sell_base', 'buy_base']

/** The flat service+store shape both transports and `Services` already carry. */
export interface FlatCorridorDeps {
  service?: SendSwapService
  store: SwapStore
  onchainService?: OnchainSendSwapService
  onchainStore: OnchainSendSwapStore
  receiveService?: ReceiveSwapService
  receiveStore?: ReceiveSwapStore
  onchainReceiveService?: OnchainReceiveSwapService
  onchainReceiveStore?: OnchainReceiveSwapStore
  /**
   * The EVM family: one store and one service per DIRECTION (both absent when
   * no chain is configured), and the per-token policies they serve. A corridor
   * exists per token, so the list is what turns one shared service into
   * corridors the registry can dispatch by pair.
   */
  evmSendService?: EvmSendSwapService | null
  evmSendStore?: EvmSendSwapStore | null
  evmReceiveService?: EvmReceiveSwapService | null
  evmReceiveStore?: EvmReceiveSwapStore | null
  evmCorridors?: readonly EvmCorridorPolicy[]
  /**
   * The atomic class: ONE store and ONE service for every asset market, and the
   * markets they serve. A corridor exists per market per direction, so the list
   * is what turns one service into corridors the registry can dispatch by pair.
   */
  assetRfqService?: AssetRfqSwapService | null
  assetRfqStore?: AssetRfqSwapStore | null
  assetRfqMarkets?: readonly AssetRfqMarket[]
}

/**
 * The corridors this deployment can QUOTE.
 *
 * Registered iff BOTH the service and the store are present, which reproduces
 * the dispatch this replaced exactly: `createServices` builds a service only for
 * an ENABLED corridor, so an absent service means the pair is refused by name as
 * `unsupported_pair`.
 *
 * Registration order is the fall-through order for `statusFor`: the two send
 * legs first (the busier profiles, and the order this had before the receive
 * legs existed), then Lightning-receive, then onchain-receive. `rfq_id`
 * identifies at most one negotiation, so the order is a latency choice rather
 * than a correctness one.
 */
export const corridorSetFromDeps = (deps: FlatCorridorDeps, extra: readonly Corridor[] = []): CorridorSet => {
  const corridors: Corridor[] = []
  if (deps.service) corridors.push(lightningSendCorridor(deps.service, deps.store))
  if (deps.onchainService) corridors.push(onchainSendCorridor(deps.onchainService, deps.onchainStore))
  if (deps.receiveService && deps.receiveStore) {
    corridors.push(lightningReceiveCorridor(deps.receiveService, deps.receiveStore))
  }
  if (deps.onchainReceiveService && deps.onchainReceiveStore) {
    corridors.push(onchainReceiveCorridor(deps.onchainReceiveService, deps.onchainReceiveStore))
  }
  // EVM last, after the four built-ins: one corridor per ENABLED policy, and a
  // corridor registers only when its leg's service exists — absent means the
  // pair is refused by name as `unsupported_pair`, the same rule as above.
  for (const policy of deps.evmCorridors ?? []) {
    if (!policy.enabled) continue
    if (policy.direction === 'send' && deps.evmSendService && deps.evmSendStore) {
      corridors.push(evmSendCorridor(policy, deps.evmSendService, deps.evmSendStore))
    }
    if (policy.direction === 'receive' && deps.evmReceiveService && deps.evmReceiveStore) {
      corridors.push(evmReceiveCorridor(policy, deps.evmReceiveService, deps.evmReceiveStore))
    }
  }
  // The atomic class, on the same rule as the EVM family: a corridor per market
  // per DIRECTION, registered only when both the service and the store exist.
  // No service means no market was configured, and every asset pair then
  // refuses by name as `unsupported_pair`.
  if (deps.assetRfqService && deps.assetRfqStore) {
    for (const market of deps.assetRfqMarkets ?? []) {
      for (const direction of ASSET_RFQ_DIRECTIONS) {
        corridors.push(
          assetRfqCorridor(assetRfqDescriptor(market, direction), deps.assetRfqService, deps.assetRfqStore),
        )
      }
    }
  }
  // Consumer corridors go THROUGH createCorridorSet, so a pair or stem
  // colliding with a built-in is refused at composition rather than shadowing
  // it at dispatch. Last, so they never delay a built-in's status answer.
  return createCorridorSet([...corridors, ...extra])
}

/**
 * Every corridor this deployment has a STORE for — wider than
 * {@link corridorSetFromDeps} by exactly the corridors an operator switched off.
 *
 * That width is the point. `createServices` opens all four stores regardless of
 * `corridorEnabled`, and both the admin console and the status route depend on
 * it: a disabled corridor's in-flight swaps must stay listed and its
 * negotiations answerable, or an operator who turned a corridor off would watch
 * its live swaps disappear from the only screen that shows them.
 */
export const readerSetFromDeps = (deps: FlatCorridorDeps, extra: readonly CorridorReader[] = []): CorridorReaderSet => {
  const readers: CorridorReader[] = [lightningSendReader(deps.store), onchainSendReader(deps.onchainStore)]
  if (deps.receiveStore) readers.push(lightningReceiveReader(deps.receiveStore))
  if (deps.onchainReceiveStore) readers.push(onchainReceiveReader(deps.onchainReceiveStore))
  // A READER for every EVM corridor with a store, enabled or not — the same
  // width argument as above: a token corridor switched off keeps its in-flight
  // swaps, and the console and the status route must keep answering for them.
  for (const policy of deps.evmCorridors ?? []) {
    if (policy.direction === 'send' && deps.evmSendStore) {
      readers.push(evmSendReader(evmSendDescriptor(policy.token), deps.evmSendStore))
    }
    if (policy.direction === 'receive' && deps.evmReceiveStore) {
      readers.push(evmReceiveReader(evmReceiveDescriptor(policy.token), deps.evmReceiveStore))
    }
  }
  // A READER per asset market per direction wherever the STORE exists, service
  // or not — the same width argument as above: a market an operator switched
  // off keeps its in-flight negotiations listed and answerable.
  if (deps.assetRfqStore) {
    for (const market of deps.assetRfqMarkets ?? []) {
      for (const direction of ASSET_RFQ_DIRECTIONS) {
        readers.push(assetRfqReader(assetRfqDescriptor(market, direction), deps.assetRfqStore))
      }
    }
  }
  // `Corridor` extends `CorridorReader`, so the same objects serve here. Omit
  // them and an injected corridor is quotable but invisible to
  // `rfq_status_request` and the console.
  return createCorridorReaderSet([...readers, ...extra])
}
