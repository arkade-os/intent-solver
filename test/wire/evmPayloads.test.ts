/**
 * Can a client rebuild the covenant from what the quote actually sends?
 *
 * Every HTLC-class profile in this protocol turns on the client deriving the
 * contract itself and treating the solver's `lockup_address` as compare-only.
 * That property is not a property of the covenant code — it is a property of
 * the QUOTE: the covenant's merkle root spans every leaf, so one leaf the
 * client cannot fill in makes the whole address underivable, and the client is
 * reduced to funding whatever address the solver names.
 *
 * Exactly one leaf per direction is knowable only to the solver, and it is a
 * different leaf each way because the roles are exchanged:
 *
 * - SEND: `nonInteractiveClaim` pays the SOLVER, so the client needs
 *   `receiver_pk_script`.
 * - RECEIVE: the refund leaves pay the SOLVER, so the client needs
 *   `solver_refund_pk_script`.
 *
 * Both tests below rebuild from the PAYLOAD OBJECT and nothing else — never
 * from the row the payload was built out of, which would pass whether or not
 * the field ever reached the wire. Drop either field from its builder and the
 * matching test stops being able to derive the address at all.
 */

import { describe, it, expect } from 'vitest'
import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { scriptHashFromPaymentHash } from '@arkade-os/solver-core/core/preimage.js'
import { evmSendRfqQuotePayload, evmReceiveRfqQuotePayload } from '@arkade-os/solver-corridors-evm/wire/evmPayloads.js'
import { sendLockFromRow } from '@arkade-os/solver-corridors-evm/evm/lockFromRow.js'
import { swapKey } from '@arkade-os/solver-rails-evm/evm/erc20Swap.js'
import type { EvmSendSwapRow } from '@arkade-os/solver-corridors-evm/db/evmSendSwaps.js'
import type { EvmReceiveSwapRow } from '@arkade-os/solver-corridors-evm/db/evmReceiveSwaps.js'

const NOW = 1_800_000_000
const HRP = 'tark'
const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

/** Valid x-only points. A repeated byte is not one, and the covenant refuses it. */
const key = (fill: number): string => hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(fill)))

/**
 * The parameters a client already holds without asking the solver: the
 * operator's own keys and delays, published with the Arkade Service.
 */
const OPERATOR = {
  serverPubkey: key(2),
  emulatorPubkey: key(3),
  claimDelay: 512,
  refundDelay: 1024,
  refundWithoutReceiverDelay: 1536,
}

/** What the client itself chose, and therefore never has to be told. */
const CLIENT = {
  paymentHash: 'aa'.repeat(32),
  refundPubkey: key(0x11),
  payoutPubkey: key(0x44),
  payoutPkScript: '5120' + '44'.repeat(32),
  refundPkScript: '5120' + '55'.repeat(32),
}

/** Solver-side values. `solverPubkey` rides the envelope; the two pkScripts do not. */
const SOLVER = {
  pubkey: key(0x22),
  claimPkScript: '5120' + '66'.repeat(32),
  refundPkScript: '5120' + '77'.repeat(32),
}

const REFUND_LOCKTIME = NOW + 86_400

const common = {
  id: 'swap-1',
  state: 'quoted',
  createdAt: NOW,
  updatedAt: NOW,
  paymentHash: CLIENT.paymentHash,
  tokenAddress: TOKEN,
  evmContractAddress: '0x1111111111111111111111111111111111111111',
  evmChainId: 8453,
  evmTimeout: 21_000_000,
  minConfirmations: 3,
  minAgeSeconds: 900,
  evmClaimAddress: '0x2222222222222222222222222222222222222222',
  evmRefundAddress: '0x3333333333333333333333333333333333333333',
  refundLocktime: REFUND_LOCKTIME,
  serverPubkey: OPERATOR.serverPubkey,
  claimDelay: OPERATOR.claimDelay,
  refundDelay: OPERATOR.refundDelay,
  refundWithoutReceiverDelay: OPERATOR.refundWithoutReceiverDelay,
  emulatorPubkey: OPERATOR.emulatorPubkey,
  evmLockTxid: null,
  evmRefundTxid: null,
  evmClaimTxid: null,
  preimage: null,
  claimArkTxid: null,
  refundArkTxid: null,
  rfqId: 'rfq-1',
  failureReason: null,
}

/**
 * The address a payload's reader can get to, using only the fields the payload
 * carries plus what the reader already knew. `receiverPkScript` and
 * `refundPkScript` are passed in from the PROFILE by each caller, so a missing
 * field arrives here as `undefined` rather than being quietly backfilled.
 */
const deriveAddress = (params: {
  receiverPubkey: string
  clientPubkey: string
  receiverPkScript: string
  refundPkScript: string
  refundLocktime: number
}): string => {
  const server = hex.decode(OPERATOR.serverPubkey)
  const script = new CovenantSwapScript({
    receiver: hex.decode(params.receiverPubkey),
    server,
    preimageHash: scriptHashFromPaymentHash(CLIENT.paymentHash),
    refundLocktime: params.refundLocktime,
    claimDelay: OPERATOR.claimDelay,
    client: hex.decode(params.clientPubkey),
    clientRefundDelay: OPERATOR.refundWithoutReceiverDelay,
    refundWithoutServerDelay: OPERATOR.refundDelay,
    nonInteractiveParameters: {
      emulatorPubkey: hex.decode(OPERATOR.emulatorPubkey),
      receiverPkScript: hex.decode(params.receiverPkScript),
      senderPkScript: hex.decode(params.refundPkScript),
    },
  })
  return script.address(HRP, server).encode()
}

describe('the send quote', () => {
  /**
   * Built the way the orchestrator builds it: the SOLVER is the covenant's
   * receiver because the solver claims, and the client plays the `client` role.
   */
  const trueAddress = deriveAddress({
    receiverPubkey: SOLVER.pubkey,
    clientPubkey: CLIENT.refundPubkey,
    receiverPkScript: SOLVER.claimPkScript,
    refundPkScript: CLIENT.refundPkScript,
    refundLocktime: REFUND_LOCKTIME,
  })

  const row = {
    ...common,
    amountSats: 50_000,
    payoutSats: 49_500,
    evmAmount: '1000000',
    providerPubkey: SOLVER.pubkey,
    pkScript: '5120' + '00'.repeat(32),
    lockupAddress: trueAddress,
    refundPkScript: CLIENT.refundPkScript,
    clientRefundPubkey: CLIENT.refundPubkey,
    receiverPkScript: SOLVER.claimPkScript,
  } as unknown as EvmSendSwapRow

  it('carries enough for a client to derive the lockup address itself', () => {
    const payload = evmSendRfqQuotePayload(row, REFUND_LOCKTIME, 'rfq-1')
    const profile = payload.profile as Record<string, string | number>

    // Only the payload and the client's own inputs. The row is not consulted.
    const derived = deriveAddress({
      receiverPubkey: payload.solver_pubkey as string,
      clientPubkey: CLIENT.refundPubkey,
      receiverPkScript: profile.receiver_pk_script as string,
      refundPkScript: CLIENT.refundPkScript,
      refundLocktime: payload.refund_locktime as number,
    })

    expect(derived).toBe(profile.lockup_address)
  })

  it('carries the sixth field of the swap key, so a client can address the lock', () => {
    // The contract stores `mapping(bytes32 => bool)` and nothing else, so this
    // key IS the lock. Five of its six fields were already reachable from the
    // payload; `evm_refund_address` is the sixth, and without it a client can
    // neither prove the solver locked nor build the claim call.
    const bytes20 = (value: string): Uint8Array => hex.decode(value.startsWith('0x') ? value.slice(2) : value)
    const payload = evmSendRfqQuotePayload(row, REFUND_LOCKTIME, 'rfq-1')
    const profile = payload.profile as Record<string, string | number>

    // Built from the PAYLOAD and the client's own inputs only — never the row.
    // Drop the field from the builder and this cannot even be constructed.
    const fromPayload = {
      preimageHash: hex.decode(profile.payment_hash as string),
      amount: BigInt(payload.to_amount as string),
      tokenAddress: bytes20(TOKEN),
      // The client's own address, echoed back to it from its request.
      claimAddress: bytes20(common.evmClaimAddress),
      refundAddress: bytes20(profile.evm_refund_address as string),
      timelock: BigInt(profile.evm_timeout_block as number),
    }

    expect(hex.encode(swapKey(fromPayload))).toBe(hex.encode(swapKey(sendLockFromRow(row))))
  })

  it('refuses to build a quote whose row has no solver address', () => {
    // The invariant this field depends on. Emitting the value raw would put
    // `"0xundefined"` on the wire; omitting the field would ship exactly the
    // quote this change exists to prevent — one that parses, funds, and cannot
    // be claimed. Both are quieter than throwing, and both are worse.
    for (const missing of [undefined, '']) {
      const broken = { ...row, evmRefundAddress: missing }
      expect(() => evmSendRfqQuotePayload(broken as unknown as EvmSendSwapRow, REFUND_LOCKTIME, 'rfq-1')).toThrow(
        /evm refund address missing from the row/,
      )
    }
  })

  it('prefixes a stored refund address that was written without 0x', () => {
    // The row's two EVM addresses reach it by different routes and disagree:
    // `evmClaimAddress` is echoed from a request that already matched
    // `EVM_ADDRESS`, while `evmRefundAddress` is `hex.encode(solverEvmAddress)`
    // and bare. `bytesFromHex` accepts either, so nothing internal noticed —
    // the wire is the first reader that cares, and its regex is anchored.
    const bare = { ...row, evmRefundAddress: '3333333333333333333333333333333333333333' }
    const profile = evmSendRfqQuotePayload(bare as unknown as EvmSendSwapRow, REFUND_LOCKTIME, 'rfq-1')
      .profile as Record<string, string>
    expect(profile.evm_refund_address).toBe('0x3333333333333333333333333333333333333333')
    expect(profile.evm_refund_address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    // …and idempotent, so an already-prefixed row is passed through unchanged.
    const already = evmSendRfqQuotePayload(row, REFUND_LOCKTIME, 'rfq-1').profile as Record<string, string>
    expect(already.evm_refund_address).toBe('0x3333333333333333333333333333333333333333')
  })

  it('echoes the payment hash the swap is keyed by', () => {
    const payload = evmSendRfqQuotePayload(row, REFUND_LOCKTIME, 'rfq-1')
    expect((payload.profile as Record<string, unknown>).payment_hash).toBe(CLIENT.paymentHash)
  })

  it('names the block-denominated deadline with its unit, beside the seconds one', () => {
    // Nothing else pins this name: the quote is an object literal read back
    // through a `Record`, so a typo in the key type-checks and ships. The
    // inbound direction is safe by construction (strict Zod), which is why the
    // OUTBOUND one needs a test.
    const payload = evmSendRfqQuotePayload(row, REFUND_LOCKTIME, 'rfq-1')
    const profile = payload.profile as Record<string, unknown>

    expect(profile.evm_timeout_block, 'the EVM deadline lost its unit suffix').toBe(21_000_000)
    expect(profile.evm_timeout, 'the unsuffixed name is the trap the suffix exists to remove').toBeUndefined()
    // Concretely not interchangeable: read one as the other and the answer is
    // wrong by five orders of magnitude, which is the whole point.
    expect(payload.refund_locktime).toBe(REFUND_LOCKTIME)
    expect(profile.evm_timeout_block).not.toBe(payload.refund_locktime)
  })
})

describe('the receive quote', () => {
  /**
   * Roles exchanged: the CLIENT is the receiver because the client claims, and
   * the SOLVER plays the `client` role because it funded and needs the
   * funder-refund fallback.
   */
  const trueAddress = deriveAddress({
    receiverPubkey: CLIENT.payoutPubkey,
    clientPubkey: SOLVER.pubkey,
    receiverPkScript: CLIENT.payoutPkScript,
    refundPkScript: SOLVER.refundPkScript,
    refundLocktime: REFUND_LOCKTIME,
  })

  const row = {
    ...common,
    amountSats: 100_000,
    payoutSats: 99_000,
    evmAmount: '49500000',
    providerPubkey: SOLVER.pubkey,
    pkScript: '5120' + '00'.repeat(32),
    lockupAddress: trueAddress,
    refundPkScript: SOLVER.refundPkScript,
    clientRefundPubkey: SOLVER.pubkey,
    receiverPkScript: CLIENT.payoutPkScript,
    payoutPubkey: CLIENT.payoutPubkey,
  } as unknown as EvmReceiveSwapRow

  it('carries enough for a client to derive the lockup address itself', () => {
    const payload = evmReceiveRfqQuotePayload(row, REFUND_LOCKTIME, 'rfq-1')
    const profile = payload.profile as Record<string, string | number>

    // The client knows its own payout key and the script it encodes to; what it
    // cannot know is where the SOLVER's refund goes.
    const derived = deriveAddress({
      receiverPubkey: CLIENT.payoutPubkey,
      clientPubkey: payload.solver_pubkey as string,
      receiverPkScript: CLIENT.payoutPkScript,
      refundPkScript: profile.solver_refund_pk_script as string,
      refundLocktime: payload.refund_locktime as number,
    })

    expect(derived).toBe(profile.lockup_address)
  })

  it('echoes the payment hash the swap is keyed by', () => {
    const payload = evmReceiveRfqQuotePayload(row, REFUND_LOCKTIME, 'rfq-1')
    expect((payload.profile as Record<string, unknown>).payment_hash).toBe(CLIENT.paymentHash)
  })
})
