/**
 * The four built-in corridors, expressed as `Corridor` implementations.
 *
 * Deliberately thin. Each one delegates to the orchestrator and store that
 * already exist — the money-path state machines are not touched here, only the
 * thing that calls them. When corridors become packages these adapters absorb
 * their orchestrator rather than wrapping it.
 *
 * Each corridor comes in two halves, mirroring what a deployment actually
 * builds. The READER needs only a store, so it exists for every corridor
 * including ones an operator switched off — the console and the status route
 * read those. The SERVING corridor adds `quote` and `tick`, which need a live
 * service, and `createServices` builds one only when the corridor is enabled.
 *
 * The optional capabilities are declared ONLY where the service really has one.
 * That omission is the contract, not an oversight: `Corridor` follows
 * `ln/port.ts`'s rule that an absent capability means a documented degradation,
 * so a corridor claiming a `claimNow` it cannot honour would be worse than one
 * that says nothing. Today only Lightning-send has `tickHot`, only
 * onchain-receive has `claimNow`, and Lightning-send is the one corridor with
 * no operator-forced refund at all.
 */
import {
  createCorridorReaderSet,
  createCorridorSet,
  parkVia,
  type Corridor,
  type CorridorReader,
  type CorridorReaderSet,
  type CorridorSet,
  type CorridorSwapView,
} from '@arkade-os/solver-core/core/corridor.js'
import { NON_TERMINAL as LN_SEND_LIVE } from '../db/swaps.js'
import { NON_TERMINAL as LN_RECEIVE_LIVE } from '../db/receiveSwaps.js'
import { NON_TERMINAL as ONCHAIN_SEND_LIVE } from '../db/onchainSwaps.js'
import { NON_TERMINAL as ONCHAIN_RECEIVE_LIVE } from '../db/onchainReceiveSwaps.js'
import type { CorridorDescriptor } from '@arkade-os/solver-core/core/corridorDescriptor.js'
import type { CovenantScriptRow } from '@arkade-os/solver-arkade/arkade/covenantRow.js'
import { covenantRowFor } from '../send/onchainOrchestrator.js'
import { receiveCovenantRowFor } from '../receive/orchestrator.js'
import { receiveCovenantRowFor as onchainReceiveCovenantRowFor } from '../receive/onchainOrchestrator.js'
import type { PageOptions } from '@arkade-os/solver-core/core/page.js'
import { LN_SEND, LN_RECEIVE, ONCHAIN_SEND, ONCHAIN_RECEIVE } from './index.js'
import { projectSend, projectReceive, projectOnchainSend, projectOnchainReceive } from './projections.js'
import {
  respondToLightningRfqRequest,
  respondToLightningReceiveRfqRequest,
  respondToOnchainRfqRequest,
  respondToOnchainReceiveRfqRequest,
} from './rfq.js'
import { rfqStatusPayload } from '../wire/payloads.js'
import { lightningReceiveRfqStatusPayload } from '../wire/lightningReceivePayloads.js'
import { onchainRfqStatusPayload } from '../wire/onchainPayloads.js'
import { onchainReceiveRfqStatusPayload } from '../wire/onchainReceivePayloads.js'
import type { SendSwapService } from '../send/orchestrator.js'
import type { ReceiveSwapService } from '../receive/orchestrator.js'
import type { OnchainSendSwapService } from '../send/onchainOrchestrator.js'
import type { OnchainReceiveSwapService } from '../receive/onchainOrchestrator.js'
import type { SwapStore } from '../db/swaps.js'
import type { ReceiveSwapStore } from '../db/receiveSwaps.js'
import type { OnchainSendSwapStore } from '../db/onchainSwaps.js'
import type { OnchainReceiveSwapStore } from '../db/onchainReceiveSwaps.js'

/** The store surface every reader needs, whichever corridor it belongs to. */
interface ReadableStore<Row> {
  findByRfqId(rfqId: string): Promise<Row | null>
  findRecoverable(): Promise<Row[]>
  committedSats(): Promise<number>
  page(options: PageOptions): Promise<{ rows: Row[]; nextCursor: string | null }>
  get(id: string): Promise<Row>
  history(id: string): Promise<{ at: number; from: string | null; to: string; detail: string | null }[]>
  close(): Promise<void>
}

/**
 * The read half, identical for all four but for the row type, the projector and
 * the status payload builder.
 *
 * `detail` answers null on a throw, mirroring the try/catch `detailOf` used in
 * `admin/routes/swaps.ts` before the registry replaced it: a store throws on an
 * id it does not hold, and "this corridor has no such swap" is a routine answer
 * rather than a fault.
 */
const readerFor = <Row extends { id: string; pkScript: string }>(
  descriptor: CorridorDescriptor,
  store: ReadableStore<Row>,
  project: (row: Row) => CorridorSwapView,
  statusPayload: (row: Row, rfqId: string) => Record<string, unknown>,
  /**
   * This corridor's row → the Arkade covenant row shape.
   *
   * Each corridor already had one of these; they lived in `vtxoLifecycle.ts`'s
   * import list, which is what made `src/arkade/` depend on all four corridors.
   * Supplying it here is the inversion: the corridor knows how to describe its
   * own lockup, and the settlement layer only asks.
   */
  toCovenantRow: (row: Row) => CovenantScriptRow,
): CorridorReader => ({
  descriptor,
  liveLockups: async () => (await store.findRecoverable()).map(toCovenantRow),
  statusFor: async (rfqId) => {
    const row = await store.findByRfqId(rfqId)
    return row ? statusPayload(row, rfqId) : null
  },
  findRecoverable: () => store.findRecoverable(),
  committedSats: () => store.committedSats(),
  page: async (options) => {
    const { rows, nextCursor } = await store.page(options)
    return { swaps: rows.map(project), nextCursor }
  },
  detail: async (id) => {
    try {
      const raw = await store.get(id)
      return { raw, swap: project(raw), history: await store.history(id) }
    } catch {
      return null
    }
  },
  close: () => store.close(),
})

export const lightningSendReader = (store: SwapStore): CorridorReader =>
  readerFor(LN_SEND, store, projectSend, rfqStatusPayload, (row) => row)

export const lightningReceiveReader = (store: ReceiveSwapStore): CorridorReader =>
  readerFor(LN_RECEIVE, store, projectReceive, lightningReceiveRfqStatusPayload, receiveCovenantRowFor)

export const onchainSendReader = (store: OnchainSendSwapStore): CorridorReader =>
  readerFor(ONCHAIN_SEND, store, projectOnchainSend, onchainRfqStatusPayload, covenantRowFor)

export const onchainReceiveReader = (store: OnchainReceiveSwapStore): CorridorReader =>
  readerFor(ONCHAIN_RECEIVE, store, projectOnchainReceive, onchainReceiveRfqStatusPayload, onchainReceiveCovenantRowFor)

/**
 * Where a parked row lands, for all four BTC corridors.
 *
 * One constant because all four stores declare the same
 * `failStates: { exposed: 'stuck', clean: 'refused' }` — see each store's shape.
 * A corridor that renamed either word would need its own list, which is exactly
 * why `parkVia` takes it rather than assuming these two.
 */
const BTC_PARKED = ['stuck', 'refused'] as const

export const lightningSendCorridor = (service: SendSwapService, store: SwapStore): Corridor => ({
  ...lightningSendReader(store),
  quote: (payload, options) => respondToLightningRfqRequest(service, store, payload, options),
  tick: async (id) => {
    await service.tick(id)
  },
  tickAll: async () => (await service.tickAll()).length,
  tickHot: async () => {
    await service.tickHot()
  },
  park: (id, reason) => parkVia(store, { live: LN_SEND_LIVE, parked: BTC_PARKED }, id, reason),
  refundSweep: () => service.refundSweep(),
})

export const lightningReceiveCorridor = (service: ReceiveSwapService, store: ReceiveSwapStore): Corridor => ({
  ...lightningReceiveReader(store),
  quote: (payload) => respondToLightningReceiveRfqRequest(service, payload),
  tick: async (id) => {
    await service.tick(id)
  },
  tickAll: async () => (await service.tickAll()).length,
  park: (id, reason) => parkVia(store, { live: LN_RECEIVE_LIVE, parked: BTC_PARKED }, id, reason),
  refundNow: (id) => service.refundNow(id),
})

export const onchainSendCorridor = (service: OnchainSendSwapService, store: OnchainSendSwapStore): Corridor => ({
  ...onchainSendReader(store),
  quote: (payload) => respondToOnchainRfqRequest(service, store, payload),
  tick: async (id) => {
    await service.tick(id)
  },
  tickAll: async () => (await service.tickAll()).length,
  park: (id, reason) => parkVia(store, { live: ONCHAIN_SEND_LIVE, parked: BTC_PARKED }, id, reason),
  refundSweep: () => service.refundSweep(),
  refundNow: (id) => service.refundNow(id),
})

export const onchainReceiveCorridor = (
  service: OnchainReceiveSwapService,
  store: OnchainReceiveSwapStore,
): Corridor => ({
  ...onchainReceiveReader(store),
  quote: (payload) => respondToOnchainReceiveRfqRequest(service, payload),
  tick: async (id) => {
    await service.tick(id)
  },
  tickAll: async () => (await service.tickAll()).length,
  park: (id, reason) => parkVia(store, { live: ONCHAIN_RECEIVE_LIVE, parked: BTC_PARKED }, id, reason),
  claimNow: (id) => service.claimNow(id),
  refundNow: (id) => service.refundNow(id),
})
