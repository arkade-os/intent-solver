/**
 * The EVM corridors, as `Corridor` implementations — one per served token per
 * direction.
 *
 * Deliberately thin, the same call the four BTC adapters make: the money-path
 * state machines live in `send/evmOrchestrator.ts` and `receive/evmOrchestrator.ts`
 * and are NOT touched here; this module only wraps them so the registry-driven
 * hosts (RFQ ingress, the sweep loop, the console) can reach them like any
 * other corridor.
 *
 * TWO things differ from the built-ins, and both are stated rather than
 * inherited silently:
 *
 * - A corridor exists per TOKEN, not once per family. `arkade:BTC->ethereum:0x…`
 *   carries the token address in the pair, so the registry key is per token and
 *   the env stem is per token per direction (`EVM_SEND_USDC`). `EVM_TOKENS`
 *   being empty means no EVM corridor exists at all — both stores and both
 *   services stay closed, which is why nothing here is registered then.
 * - `statusFor` answers NULL even for the corridor's own ids: the EVM legs have
 *   no status payload builder yet (they never had one — on the pre-registry
 *   wiring the status fall-through simply never reached their stores). A live
 *   EVM swap reads as "no negotiation with this rfq_id" to a status client
 *   until that is built — same answer main gave, stated here rather than
 *   inherited unnoticed.
 */

import {
  parkVia,
  type Corridor,
  type CorridorReader,
  type CorridorSwapView,
} from '@arkade-os/solver-core/core/corridor.js'
import type { CorridorDescriptor } from '@arkade-os/solver-core/core/corridorDescriptor.js'
import type { PageOptions } from '@arkade-os/solver-core/core/page.js'
import { diagnose, phaseOfStates } from '@arkade-os/solver-core/core/swapView.js'
import type { AdminSwap } from '@arkade-os/solver-core/core/swapView.js'
import type { EvmCorridorPolicy, EvmToken } from '@arkade-os/solver-core/core/evmCorridorConfig.js'
import { evmEnvStem } from '@arkade-os/solver-core/core/evmCorridorConfig.js'
import { evmCorridorFor } from '@arkade-os/solver-core/core/corridorPolicy.js'
import {
  EVM_RECEIVE_EXPOSED,
  EVM_RECEIVE_NON_TERMINAL,
  EVM_SEND_EXPOSED,
  EVM_SEND_NON_TERMINAL,
  type EvmReceiveSwapState,
  type EvmSendSwapState,
} from '@arkade-os/solver-core/core/evmSwapState.js'
import { evmReceiveCovenantRowFor, evmSendCovenantRowFor } from '../evm/covenantRow.js'
import type { CovenantScriptRow } from '@arkade-os/solver-arkade/arkade/covenantRow.js'
import type { EvmSendSwapRow, EvmSendSwapStore } from '../db/evmSendSwaps.js'
import type { EvmReceiveSwapRow, EvmReceiveSwapStore } from '../db/evmReceiveSwaps.js'
import type { EvmSendSwapService } from '../send/evmOrchestrator.js'
import type { EvmReceiveSwapService } from '../receive/evmOrchestrator.js'
import { respondToEvmReceiveRfqRequest, respondToEvmSendRfqRequest } from './evmRfq.js'

export const evmSendDescriptor = (token: EvmToken): CorridorDescriptor<EvmSendSwapState> => ({
  pair: evmCorridorFor(token.address, 'send'),
  envStem: evmEnvStem(token, 'send'),
  // The solver pays the token out on the EVM chain. No rail is registered for
  // it today, so the console reads UNKNOWN for this corridor's payout balance —
  // the honest answer, per rail.ts's contract, not zero.
  payoutRail: `ethereum:${token.symbol.toLowerCase()}`,
  states: {
    live: EVM_SEND_NON_TERMINAL,
    exposed: EVM_SEND_EXPOSED,
    // `claimed` and no other terminal: `refunded` is the send leg's safe END,
    // not a delivery — phaseOfStates files it under `failed` beside `refused`,
    // which is the swapView.ts convention for "no harm, no delivery".
    delivered: ['claimed'],
  },
})

export const evmReceiveDescriptor = (token: EvmToken): CorridorDescriptor<EvmReceiveSwapState> => ({
  pair: evmCorridorFor(token.address, 'receive'),
  envStem: evmEnvStem(token, 'receive'),
  // The client is paid in SATS out of the Arkade float on this leg.
  payoutRail: 'arkade',
  states: {
    live: EVM_RECEIVE_NON_TERMINAL,
    exposed: EVM_RECEIVE_EXPOSED,
    delivered: ['claimed'],
  },
})

// The same exception the two send corridors carry: a pushed refund lives as a
// patch column on a `refused` row, so the word an operator should read for it
// is `refunded`. `stuck` is never rewritten — it means we may have paid, and a
// refund landing does not change that.
const presentedState = (state: string, refundOutcome: 'pushed' | 'external' | null): string =>
  state === 'refused' && refundOutcome !== null ? 'refunded' : state

export const projectEvmSend = (row: EvmSendSwapRow): AdminSwap => {
  const state = presentedState(row.state, row.refundOutcome as 'pushed' | 'external' | null)
  return {
    ...diagnose(state, row.failureReason),
    id: row.id,
    corridor: evmCorridorFor(row.tokenAddress, 'send'),
    state,
    phase: phaseOfStates(evmSendDescriptorForStatesOnly.states, state),
    amountSats: row.amountSats,
    payoutSats: row.payoutSats,
    paymentHash: row.paymentHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    failureReason: row.failureReason,
  }
}

export const projectEvmReceive = (row: EvmReceiveSwapRow): AdminSwap => ({
  ...diagnose(row.state, row.failureReason),
  id: row.id,
  corridor: evmCorridorFor(row.tokenAddress, 'receive'),
  state: row.state,
  phase: phaseOfStates(evmReceiveDescriptorForStatesOnly.states, row.state),
  amountSats: row.amountSats,
  payoutSats: row.payoutSats,
  paymentHash: row.paymentHash,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  failureReason: row.failureReason,
})

// phaseOfStates needs the three state lists, which are direction-constant —
// the token's address in a descriptor is irrelevant to bucketing, so the
// projectors share one standing instance rather than minting one per call.
const evmSendDescriptorForStatesOnly = {
  states: { live: EVM_SEND_NON_TERMINAL, exposed: EVM_SEND_EXPOSED, delivered: ['claimed' as const] },
}
const evmReceiveDescriptorForStatesOnly = {
  states: { live: EVM_RECEIVE_NON_TERMINAL, exposed: EVM_RECEIVE_EXPOSED, delivered: ['claimed' as const] },
}

/** What both EVM stores share: every live row, one page at a time. */
interface EvmReadableStore<Row extends { id: string; pkScript: string }> {
  findLive(): Promise<Row[]>
  findByRfqId(rfqId: string): Promise<Row | null>
  committedSats(): Promise<number>
  page(options: PageOptions): Promise<{ rows: Row[]; nextCursor: string | null }>
  get(id: string): Promise<Row>
  history(id: string): Promise<{ at: number; from: string | null; to: string; detail: string | null }[]>
  close(): Promise<void>
}

const evmReaderFor = <Row extends { id: string; pkScript: string }>(
  descriptor: CorridorDescriptor,
  store: EvmReadableStore<Row>,
  project: (row: Row) => CorridorSwapView,
  toCovenantRow: (row: Row) => CovenantScriptRow,
): CorridorReader => ({
  descriptor,
  // findLive rather than findRecoverable, which the EVM stores do not carry:
  // the EVM row vocabulary is non-terminal = live, and every live row's pkScript
  // is the covenant to watch. Same answer the four built-ins give, one query
  // shape down.
  liveLockups: async () => (await store.findLive()).map(toCovenantRow),
  // NULL even for this corridor's own rows — the EVM legs have no status
  // payload builder; see the module comment. Better a stated gap than a status
  // route answering for a swap it cannot describe.
  statusFor: async () => null,
  findRecoverable: async () => (await store.findLive()).map((row) => ({ id: row.id, pkScript: row.pkScript })),
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

export const evmSendReader = (descriptor: CorridorDescriptor, store: EvmSendSwapStore): CorridorReader =>
  evmReaderFor(descriptor, store, projectEvmSend, evmSendCovenantRowFor)

export const evmReceiveReader = (descriptor: CorridorDescriptor, store: EvmReceiveSwapStore): CorridorReader =>
  evmReaderFor(descriptor, store, projectEvmReceive, evmReceiveCovenantRowFor)

/**
 * The serving corridor for one token. Registered only when the policy is
 * ENABLED and the service exists — a disabled policy answers `unsupported_pair`
 * by omission, exactly like a switched-off built-in.
 *
 * `refundSweep` on the send leg is the non-interactive covenant refund of
 * refused rows' lockups; the receive leg has no unattended refund to push (its
 * refund of the solver's own lockup is planner-driven at the deadline), so it
 * declares none — absent capability, documented degradation, the interface's
 * rule.
 */
export const evmSendCorridor = (
  policy: EvmCorridorPolicy,
  service: EvmSendSwapService,
  store: EvmSendSwapStore,
): Corridor => ({
  ...evmSendReader(evmSendDescriptor(policy.token), store),
  quote: (payload, options) => respondToEvmSendRfqRequest(service, payload, options),
  tick: async (id) => {
    await service.tick(id)
  },
  tickAll: async () => (await service.tickAll()).length,
  // One parked state, not the BTC pair: these stores' `fail` transitions to
  // `stuck` whatever the row was doing, because an EVM lock is on a chain
  // somebody else confirms — there is no leg where the solver can say for itself
  // that nothing of its own was exposed.
  park: (id, reason) => parkVia(store, { live: EVM_SEND_NON_TERMINAL, parked: ['stuck'] }, id, reason),
  refundSweep: () => service.refundSweep(),
})

export const evmReceiveCorridor = (
  policy: EvmCorridorPolicy,
  service: EvmReceiveSwapService,
  store: EvmReceiveSwapStore,
): Corridor => ({
  ...evmReceiveReader(evmReceiveDescriptor(policy.token), store),
  quote: (payload, options) => respondToEvmReceiveRfqRequest(service, payload, options),
  tick: async (id) => {
    await service.tick(id)
  },
  tickAll: async () => (await service.tickAll()).length,
  park: (id, reason) => parkVia(store, { live: EVM_RECEIVE_NON_TERMINAL, parked: ['stuck'] }, id, reason),
})
