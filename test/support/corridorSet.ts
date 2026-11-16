/**
 * Build a `CorridorSet` from the shape the ingress tests already construct.
 *
 * These tests predate the corridor registry and express a deployment as an
 * `RfqServices` plus whichever stores the path under test actually reaches —
 * usually `{} as never`, because the QUOTE path never touches a store. This
 * keeps that: a corridor is registered iff its SERVICE is present, which is
 * exactly the rule the `if (pair === …)` chain applied before the registry
 * replaced it.
 *
 * The dummy stores are honest here rather than a shortcut. If a quote path ever
 * did reach one, the test would crash on `{}` instead of passing quietly — which
 * is the information you want.
 */
import { corridorSetFromDeps } from '@arkade-os/solver-app/ops/corridorSet.js'
import type { CorridorSet } from '@arkade-os/solver-core/core/corridor.js'
import type { SendSwapService } from '@arkade-os/solver-corridors/send/orchestrator.js'
import type { OnchainSendSwapService } from '@arkade-os/solver-corridors/send/onchainOrchestrator.js'
import type { ReceiveSwapService } from '@arkade-os/solver-corridors/receive/orchestrator.js'
import type { SwapStore } from '@arkade-os/solver-corridors/db/swaps.js'
import type { OnchainSendSwapStore } from '@arkade-os/solver-corridors/db/onchainSwaps.js'
import type { ReceiveSwapStore } from '@arkade-os/solver-corridors/db/receiveSwaps.js'

/**
 * The three built-in corridors as these tests name them, each optional. A test
 * vocabulary: it expresses a deployment as "which services exist", which is the
 * rule `setFrom` below turns into a registration.
 */
export interface RfqServices {
  send?: SendSwapService
  onchainSend?: OnchainSendSwapService
  receive?: ReceiveSwapService
}

export interface TestStores {
  store?: SwapStore
  onchainStore?: OnchainSendSwapStore
  receiveStore?: ReceiveSwapStore
}

export const setFrom = (services: RfqServices, stores: TestStores = {}): CorridorSet =>
  corridorSetFromDeps({
    service: services.send,
    onchainService: services.onchainSend,
    receiveService: services.receive,
    store: stores.store ?? ({} as never),
    onchainStore: stores.onchainStore ?? ({} as never),
    receiveStore: stores.receiveStore ?? ({} as never),
  })
