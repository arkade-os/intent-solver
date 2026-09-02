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
import { corridorSetFromDeps } from '../../src/ops/corridorSet.js'
import type { CorridorSet } from '@arkade-os/solver-core/core/corridor.js'
import type { SendSwapService } from '@arkade-os/solver-corridors/send/orchestrator.js'
import type { OnchainSendSwapService } from '@arkade-os/solver-corridors/send/onchainOrchestrator.js'
import type { ReceiveSwapService } from '@arkade-os/solver-corridors/receive/orchestrator.js'
import type { OnchainReceiveSwapService } from '@arkade-os/solver-corridors/receive/onchainOrchestrator.js'
import type { SwapStore } from '@arkade-os/solver-corridors/db/swaps.js'
import type { OnchainSendSwapStore } from '@arkade-os/solver-corridors/db/onchainSwaps.js'
import type { ReceiveSwapStore } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import type { OnchainReceiveSwapStore } from '@arkade-os/solver-corridors/db/onchainReceiveSwaps.js'

/**
 * The four built-in corridors as these tests name them, each optional. A test
 * vocabulary: it expresses a deployment as "which services exist", which is the
 * rule `setFrom` below turns into a registration.
 */
export interface RfqServices {
  send?: SendSwapService
  onchainSend?: OnchainSendSwapService
  receive?: ReceiveSwapService
  onchainReceive?: OnchainReceiveSwapService
}

export interface TestStores {
  store?: SwapStore
  onchainStore?: OnchainSendSwapStore
  receiveStore?: ReceiveSwapStore
  onchainReceiveStore?: OnchainReceiveSwapStore
}

export const setFrom = (services: RfqServices, stores: TestStores = {}): CorridorSet =>
  corridorSetFromDeps({
    service: services.send,
    onchainService: services.onchainSend,
    receiveService: services.receive,
    onchainReceiveService: services.onchainReceive,
    store: stores.store ?? ({} as never),
    onchainStore: stores.onchainStore ?? ({} as never),
    receiveStore: stores.receiveStore ?? ({} as never),
    onchainReceiveStore: stores.onchainReceiveStore ?? ({} as never),
  })
