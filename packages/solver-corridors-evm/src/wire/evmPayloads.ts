/**
 * The wire shapes for the two EVM corridors.
 *
 * Unlike every sibling module here, these carry NO pair constant. An EVM pair
 * names its token — `arkade:BTC->ethereum:0x…` — so the constant that the four
 * BTC corridors dispatch on cannot exist. The ingress matches the pair with
 * `evmDirectionOf` and the schemas below validate only its shape, exactly as
 * they do for every other corridor: whether the pair is SERVED is the
 * orchestrator's answer (`unsupported_token`), not the schema's.
 *
 * THE TOKEN AMOUNT IS A STRING, and that is not a style choice. An ERC20 amount
 * is 256-bit; a JSON number is a double, exact only to 2^53 - 1, which at 18
 * decimals is 0.009 tokens. The rounding would happen inside `JSON.parse`,
 * before any validator here could see it. `evm_amount` is therefore a canonical
 * decimal string, matching `docs/rfq-protocol.md` § 2.1 and the `evm_amount`
 * TEXT column it ends up in.
 *
 * The sats amounts stay JSON numbers for now, matching the sibling modules on
 * this branch. § 2.1 makes them strings too and that change is in flight
 * separately; it is a migration for four existing corridors rather than a new
 * shape, so it is not bundled here.
 */

import { z } from 'zod'
import { MAX_PAIR_LENGTH } from '@arkade-os/solver-core/core/marketKey.js'
import type { EvmSendSwapRow } from '../db/evmSendSwaps.js'
import type { EvmReceiveSwapRow } from '../db/evmReceiveSwaps.js'
import { rfqRefusalPayload } from '@arkade-os/solver-core/core/rfqProtocol.js'

const RFQ_ID = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/)
const HEX32 = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/)
const XONLY_HEX = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/)

/** `0x` then 40 hex. Case-insensitive on the wire — EIP-55 checksums are mixed case. */
const EVM_ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/)

/**
 * An EVM address as {@link EVM_ADDRESS} spells it, from a stored value that may
 * not be prefixed.
 *
 * The two EVM addresses on a send row reach it by different routes and do not
 * agree on this: `evmClaimAddress` is echoed from a request that already
 * matched `EVM_ADDRESS`, while `evmRefundAddress` is written as
 * `hex.encode(solverEvmAddress)` and carries no prefix. Nothing internal
 * noticed, because `lockFromRow`'s `bytesFromHex` strips an optional `0x` — the
 * wire is the first reader that cares, and it is anchored.
 *
 * Idempotent rather than prefix-always, so it is correct whichever route the
 * value took and stays correct if the write side is ever normalised.
 */
const prefixed = (address: string): string => {
  // Named rather than left to `undefined.startsWith`. A row that reached the
  // quote without the solver's address is a broken invariant, and the two ways
  // of being quiet about it are both worse than throwing: emitting the value
  // raw would put `"0xundefined"` on the wire, and omitting the field would
  // ship exactly the quote this field was added to prevent — one that parses,
  // funds, and cannot be claimed.
  if (typeof address !== 'string' || address.length === 0) {
    throw new Error(`evm refund address missing from the row; a client cannot address the lock without it`)
  }
  return address.startsWith('0x') ? address : `0x${address}`
}

/**
 * Atomic units of the token, as a canonical decimal string.
 *
 * No sign, no point, no exponent, no leading zero. Anchored, so `1e18` is
 * refused rather than partially matched — three spellings of exponent notation
 * exist and quietly reading one wrong misprices by eight orders of magnitude.
 */
const TOKEN_AMOUNT = z.string().regex(/^(0|[1-9][0-9]*)$/)

/**
 * `arkade:BTC->ethereum:<token>` — the client locks sats, the solver pays
 * tokens.
 *
 * EXACT-IN ONLY. `amount_side` is pinned to `from`: the `to` leg is a different
 * asset, so exact-out would mean inverting a fetched, rounded, directional rate.
 * Refused at the schema rather than accepted and then refused deeper, so the
 * client hears about it before it builds anything.
 */
export const EvmSendRfqRequest = z
  .object({
    v: z.literal(1),
    type: z.literal('rfq_request'),
    rfq_id: RFQ_ID,
    pair: z.string().min(1).max(MAX_PAIR_LENGTH),
    amount_side: z.literal('from'),
    amount: z.number().int().positive(),
    profile: z
      .object({
        payment_hash: HEX32,
        /** Where the CLIENT claims the tokens. */
        evm_claim_address: EVM_ADDRESS,
        /** The client's Arkade refund destination. */
        refund_address: z.string().min(1).max(200),
        client_refund_pubkey: XONLY_HEX,
      })
      .strict(),
  })
  .strict()

/**
 * `ethereum:<token>->arkade:BTC` — the client locks tokens, the solver pays
 * sats.
 *
 * The amount lives in the PROFILE here, not the envelope, because it is
 * denominated in the token rather than sats and the envelope's `amount` is a
 * JSON number. `amount_side` is still `from` — the client names what it gives —
 * and `amount` is omitted, which the strict object enforces by its absence.
 *
 * `evm_timeout_block` is the CLIENT's, because the client locks first and
 * carries the deadline. The solver validates it and derives its own from it.
 */
export const EvmReceiveRfqRequest = z
  .object({
    v: z.literal(1),
    type: z.literal('rfq_request'),
    rfq_id: RFQ_ID,
    pair: z.string().min(1).max(MAX_PAIR_LENGTH),
    amount_side: z.literal('from'),
    profile: z
      .object({
        payment_hash: HEX32,
        /** Atomic units of the token the client locks. */
        evm_amount: TOKEN_AMOUNT,
        /**
         * Block height after which the CLIENT may take its tokens back. The
         * `_block` suffix is load-bearing: every other deadline here is unix
         * seconds, and reading this one that way yields a recourse window of
         * centuries.
         */
        evm_timeout_block: z.number().int().positive(),
        /** Where the client's own EVM refund goes. */
        evm_refund_address: EVM_ADDRESS,
        payout_address: z.string().min(1).max(200),
        payout_pubkey: XONLY_HEX,
      })
      .strict(),
  })
  .strict()

/**
 * The quote for a send swap.
 *
 * `from_amount` and `to_amount` are in DIFFERENT ASSETS on this corridor — sats
 * in, token base units out — so they are not comparable as numbers and the
 * spread between them is not the fee alone. `to_amount` is a string for the
 * same reason the request's is.
 */
export const evmSendRfqQuotePayload = (
  row: EvmSendSwapRow,
  validUntil: number,
  rfqId: string,
): Record<string, unknown> => ({
  v: 1,
  type: 'rfq_quote',
  rfq_id: rfqId,
  pair: `arkade:BTC->ethereum:${row.tokenAddress}`,
  from_amount: row.amountSats,
  to_amount: row.evmAmount,
  solver_pubkey: row.providerPubkey,
  valid_until: validUntil,
  refund_locktime: row.refundLocktime,
  profile: {
    payment_hash: row.paymentHash,
    lockup_address: row.lockupAddress,
    /**
     * Compare-only, and the client cannot do without it. The covenant's merkle
     * root spans EVERY leaf, so a client reconstructing the script locally must
     * fill in `nonInteractiveClaim` — whose destination is the solver's own
     * claim pkScript and known to nobody else. Omit it and the client cannot
     * derive the address it is being asked to fund, leaving it to trust
     * `lockup_address` on the solver's word, which is the one thing
     * derive-locally exists to avoid. It carries none of `lockup_address`'s
     * trust weight itself: a wrong value here only makes that one leaf unusable
     * for the solver.
     */
    receiver_pk_script: row.receiverPkScript,
    /**
     * The deadline the SOLVER's own lock carries — a block height, the
     * contract's unit. Do NOT diff it against `refund_locktime`, which sits
     * beside it and is unix seconds.
     */
    evm_timeout_block: row.evmTimeout,
    /**
     * The SOLVER's EVM address, and the client cannot settle this corridor
     * without it.
     *
     * `evm_refund_address` names whoever the CONTRACT refunds, which on this
     * leg is the solver — it locks, so it holds the refund role. That is the
     * mirror of the receive leg, where the client locks and sends its own
     * `evm_refund_address` in the REQUEST. The asymmetry is why this field was
     * missing: the name reads as "the client's" on both legs until you notice
     * it tracks the role rather than the party.
     *
     * TWO distinct uses, and neither is optional:
     *
     * 1. It is the sixth field of `hashValues`, which is the contract's whole
     *    key for the lock. With five of six the client cannot compute the key,
     *    so it cannot check `swaps(key)` and cannot prove the solver ever
     *    locked before it parts with the preimage.
     * 2. `claim(bytes32,uint256,address,address,uint256)` takes it as an
     *    EXPLICIT argument — the caller is the claimer, so the contract reads
     *    `claimAddress` from `msg.sender` and must be told the other side.
     *    Without it the client cannot construct the claim call at all.
     *
     * Normalised to `0x` here rather than passed through. The row's own two
     * addresses do not agree: `evmClaimAddress` arrives from the wire already
     * prefixed, while this one is written as `hex.encode(solverEvmAddress)`,
     * which emits bare hex. Nothing internal noticed, because `bytesFromHex`
     * accepts either — but the wire's `EVM_ADDRESS` is anchored on `0x`, so
     * passing the row value straight out would emit a value this schema's own
     * clients must reject.
     */
    evm_refund_address: prefixed(row.evmRefundAddress),
    evm_contract_address: row.evmContractAddress,
    evm_chain_id: row.evmChainId,
    min_confirmations: row.minConfirmations,
    min_age_seconds: row.minAgeSeconds,
  },
})

/** The quote for a receive swap. `from_amount` is the token, `to_amount` the sats payout. */
export const evmReceiveRfqQuotePayload = (
  row: EvmReceiveSwapRow,
  validUntil: number,
  rfqId: string,
): Record<string, unknown> => ({
  v: 1,
  type: 'rfq_quote',
  rfq_id: rfqId,
  pair: `ethereum:${row.tokenAddress}->arkade:BTC`,
  from_amount: row.evmAmount,
  to_amount: row.payoutSats,
  solver_pubkey: row.providerPubkey,
  valid_until: validUntil,
  refund_locktime: row.refundLocktime,
  profile: {
    payment_hash: row.paymentHash,
    lockup_address: row.lockupAddress,
    /**
     * The mirror of the send leg's `receiver_pk_script`, and needed for the same
     * reason: the roles are exchanged here, so the leaf the client cannot supply
     * for itself is the SOLVER's refund destination. Without it the client
     * cannot rebuild the merkle root, so it cannot check `lockup_address` — and
     * on this leg it is the client's payout sitting behind that address. Named
     * as the Lightning receive leg names it.
     */
    solver_refund_pk_script: row.refundPkScript,
    /** Where the client must send the tokens, and who may claim them. */
    evm_contract_address: row.evmContractAddress,
    evm_chain_id: row.evmChainId,
    evm_claim_address: row.evmClaimAddress,
    min_confirmations: row.minConfirmations,
    min_age_seconds: row.minAgeSeconds,
  },
})

export { rfqRefusalPayload }
