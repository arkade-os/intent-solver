/**
 * Reconstructing a lock from a row, checked against the swap key the CONTRACT
 * would compute.
 *
 * That is the assertion that matters: the six fields are the lock's identity, so
 * a reconstruction that differs in any one of them yields a key the contract has
 * never heard of. The lock then reads as absent — not claimable, not refundable,
 * and not visibly broken.
 */

import { describe, it, expect } from 'vitest'
import { hex } from '@scure/base'
import { receiveLockFromRow, sendLockFromRow } from '@arkade-os/solver-corridors-evm/evm/lockFromRow.js'
import { swapKey } from '@arkade-os/solver-rails-evm/evm/erc20Swap.js'
import type { EvmSendSwapRow } from '@arkade-os/solver-corridors-evm/db/evmSendSwaps.js'
import type { EvmReceiveSwapRow } from '@arkade-os/solver-corridors-evm/db/evmReceiveSwaps.js'

const CLIENT = '0x2222222222222222222222222222222222222222'
const SOLVER = '0x3333333333333333333333333333333333333333'
const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

const sendRow = (over: Partial<EvmSendSwapRow> = {}): EvmSendSwapRow =>
  ({
    paymentHash: 'aa'.repeat(32),
    // Past 2^53 on purpose: the column is TEXT for this reason.
    evmAmount: '123456789012345678901234567890',
    tokenAddress: TOKEN,
    evmClaimAddress: CLIENT,
    evmRefundAddress: SOLVER,
    evmTimeout: 21_000_000,
    ...over,
  }) as EvmSendSwapRow

describe('sendLockFromRow', () => {
  it('carries all six fields the swap key is derived from', () => {
    const lock = sendLockFromRow(sendRow())
    expect(hex.encode(lock.preimageHash)).toBe('aa'.repeat(32))
    expect(lock.amount).toBe(123456789012345678901234567890n)
    expect('0x' + hex.encode(lock.tokenAddress)).toBe(TOKEN)
    expect('0x' + hex.encode(lock.claimAddress)).toBe(CLIENT)
    expect('0x' + hex.encode(lock.refundAddress)).toBe(SOLVER)
    expect(lock.timelock).toBe(21_000_000n)
  })

  it('does not round a 256-bit amount through a float', () => {
    // A rounded amount derives a DIFFERENT swap key, so the lock is not found at
    // all — a failure much worse than a payout that is slightly wrong.
    const lock = sendLockFromRow(sendRow())
    expect(lock.amount.toString()).toBe('123456789012345678901234567890')
    expect(Number.isSafeInteger(Number(lock.amount))).toBe(false)
  })

  it('gives a DIFFERENT key when any single field differs', () => {
    // Each of these is part of the lock's identity, so each must move the key.
    const base = hex.encode(swapKey(sendLockFromRow(sendRow())))
    const variants: Partial<EvmSendSwapRow>[] = [
      { paymentHash: 'bb'.repeat(32) },
      { evmAmount: '123456789012345678901234567891' },
      { tokenAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' },
      { evmClaimAddress: SOLVER },
      { evmRefundAddress: CLIENT },
      { evmTimeout: 21_000_001 },
    ]
    for (const over of variants) {
      expect(hex.encode(swapKey(sendLockFromRow(sendRow(over))))).not.toBe(base)
    }
  })

  it('refuses a malformed field rather than deriving a key from a guess', () => {
    expect(() => sendLockFromRow(sendRow({ tokenAddress: '0xabc' }))).toThrow(/20 bytes/)
    expect(() => sendLockFromRow(sendRow({ paymentHash: 'aa' }))).toThrow(/32 bytes/)
    expect(() => sendLockFromRow(sendRow({ evmAmount: '1.5' }))).toThrow(/decimal integer/)
    expect(() => sendLockFromRow(sendRow({ evmAmount: '0x10' }))).toThrow(/decimal integer/)
  })

  it('accepts an address with or without the 0x, but not a wrong length', () => {
    const withPrefix = sendLockFromRow(sendRow({ tokenAddress: TOKEN }))
    const without = sendLockFromRow(sendRow({ tokenAddress: TOKEN.slice(2) }))
    expect(hex.encode(withPrefix.tokenAddress)).toBe(hex.encode(without.tokenAddress))
  })
})

describe('receiveLockFromRow', () => {
  const receiveRow = (over: Partial<EvmReceiveSwapRow> = {}): EvmReceiveSwapRow =>
    ({
      paymentHash: 'aa'.repeat(32),
      evmAmount: '1000000',
      tokenAddress: TOKEN,
      // Mirrored: the SOLVER claims this one, the CLIENT refunds it.
      evmClaimAddress: SOLVER,
      evmRefundAddress: CLIENT,
      evmTimeout: 21_000_000,
      ...over,
    }) as EvmReceiveSwapRow

  it('puts the solver on the claim side and the client on the refund side', () => {
    // Reversed, the solver cannot claim and the client can refund at once. Two
    // named functions rather than a direction flag for exactly this reason.
    const lock = receiveLockFromRow(receiveRow())
    expect('0x' + hex.encode(lock.claimAddress)).toBe(SOLVER)
    expect('0x' + hex.encode(lock.refundAddress)).toBe(CLIENT)
  })

  it('derives a different key from the send leg with the sides swapped', () => {
    const receive = hex.encode(swapKey(receiveLockFromRow(receiveRow())))
    const send = hex.encode(
      swapKey(sendLockFromRow(sendRow({ evmAmount: '1000000', evmClaimAddress: CLIENT, evmRefundAddress: SOLVER }))),
    )
    expect(receive).not.toBe(send)
  })
})
