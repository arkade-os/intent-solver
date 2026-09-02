/**
 * The EVM corridors' own RFQ handling: validate a request against ITS schema,
 * and issue or refuse terms.
 *
 * The EVM half of what `corridors/rfq.ts` holds for the BTC corridors, split
 * out with the rest of this package so an EVM-only deployment compiles without
 * a line of Lightning in it. Same discipline: these return core's
 * `CorridorRfqOutcome`, every refusal reason comes from the closed RFQ set,
 * and the ingress re-checks the wire contract on the way out.
 */
import { evmTokenOf } from '@arkade-os/solver-core/core/corridorPolicy.js'
import type { CorridorRfqOutcome as RfqOutcome } from '@arkade-os/solver-core/core/corridor.js'
import { extractRfqId, rfqRefusalPayload } from '@arkade-os/solver-core/core/rfqProtocol.js'
import type { EvmSendSwapService } from '../send/evmOrchestrator.js'
import type { EvmReceiveSwapService } from '../receive/evmOrchestrator.js'
import {
  EvmReceiveRfqRequest,
  EvmSendRfqRequest,
  evmReceiveRfqQuotePayload,
  evmSendRfqQuotePayload,
} from '../wire/evmPayloads.js'

/**
 * `arkade:BTC->ethereum:<token>`.
 *
 * The token is read back OUT of the pair rather than taken from the profile:
 * the pair is what the client asked for and what the market key is derived
 * from, so a profile field naming a second token could disagree with it. One
 * source, and the orchestrator decides whether it is served.
 */
export const respondToEvmSendRfqRequest = async (
  service: EvmSendSwapService,
  payload: unknown,
  /** The transport's requester identity, for quote admission control. */
  options?: { requesterKey?: string },
): Promise<RfqOutcome> => {
  const parsed = EvmSendRfqRequest.safeParse(payload)
  if (!parsed.success) {
    return { kind: 'invalid', payload: rfqRefusalPayload(extractRfqId(payload), 'unsupported_payload') }
  }
  const request = parsed.data
  const token = evmTokenOf(request.pair as never)
  if (token === null) {
    return { kind: 'invalid', payload: rfqRefusalPayload(request.rfq_id, 'unsupported_pair') }
  }
  const outcome = await service.quote({
    paymentHash: request.profile.payment_hash,
    tokenAddress: token,
    amountSats: request.amount,
    evmClaimAddress: request.profile.evm_claim_address,
    refundAddress: request.profile.refund_address,
    clientRefundPubkey: request.profile.client_refund_pubkey,
    requesterKey: options?.requesterKey,
    rfqId: request.rfq_id,
  })
  if (outcome.accepted) {
    // The quote window the spec §5 asks for on cross-asset pairs — seconds, not
    // the refund locktime hours out. The row snapshotted it at quote time; what
    // the wire carries IS what the planner enforces.
    return {
      kind: 'quote',
      payload: evmSendRfqQuotePayload(outcome.swap, outcome.swap.validUntil, request.rfq_id),
    }
  }
  return { kind: 'refused', payload: rfqRefusalPayload(request.rfq_id, outcome.reason) }
}

/** `ethereum:<token>->arkade:BTC`. The amount lives in the profile — it is the token's, not sats. */
export const respondToEvmReceiveRfqRequest = async (
  service: EvmReceiveSwapService,
  payload: unknown,
  /** The transport's requester identity, for quote admission control. */
  options?: { requesterKey?: string },
): Promise<RfqOutcome> => {
  const parsed = EvmReceiveRfqRequest.safeParse(payload)
  if (!parsed.success) {
    return { kind: 'invalid', payload: rfqRefusalPayload(extractRfqId(payload), 'unsupported_payload') }
  }
  const request = parsed.data
  const token = evmTokenOf(request.pair as never)
  if (token === null) {
    return { kind: 'invalid', payload: rfqRefusalPayload(request.rfq_id, 'unsupported_pair') }
  }
  const outcome = await service.quote({
    paymentHash: request.profile.payment_hash,
    tokenAddress: token,
    evmAmount: request.profile.evm_amount,
    evmTimeout: request.profile.evm_timeout_block,
    evmRefundAddress: request.profile.evm_refund_address,
    payoutAddress: request.profile.payout_address,
    payoutPubkey: request.profile.payout_pubkey,
    requesterKey: options?.requesterKey,
    rfqId: request.rfq_id,
  })
  if (outcome.accepted) {
    return {
      kind: 'quote',
      payload: evmReceiveRfqQuotePayload(outcome.swap, outcome.swap.validUntil, request.rfq_id),
    }
  }
  return { kind: 'refused', payload: rfqRefusalPayload(request.rfq_id, outcome.reason) }
}
