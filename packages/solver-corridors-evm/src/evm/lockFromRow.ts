/**
 * Rebuilding the ERC20 lock from a swap row.
 *
 * FROM THE ROW, NEVER FROM LIVE CONFIG, and that is the whole reason this is its
 * own module rather than an inline object literal at each call site.
 *
 * The contract keys a lock by `keccak256(abi.encode(...))` of exactly these six
 * fields, so every one of them is part of its identity. If any were read from
 * current configuration instead of the row, a deployment repointed at a different
 * contract — or an operator widening a timeout — would derive a DIFFERENT swap
 * key after the lock was funded. The lock would then read as absent: not
 * claimable, not refundable, and not visibly broken. It would simply never be
 * found again, and the tokens would sit in the contract until someone
 * reconstructed the original six values by hand.
 *
 * The same rule the Arkade side already follows for `refund_locktime` and every
 * script parameter — @see db/evmSendSwaps.ts.
 */

import type { Erc20SwapLock } from '@arkade-os/solver-rails-evm/evm/erc20Swap.js'
import type { EvmSendSwapRow } from '../db/evmSendSwaps.js'
import type { EvmReceiveSwapRow } from '../db/evmReceiveSwaps.js'

const bytesFromHex = (value: string, name: string, length: number): Uint8Array => {
  const body = value.startsWith('0x') ? value.slice(2) : value
  if (body.length !== length * 2 || !/^[0-9a-fA-F]*$/.test(body)) {
    throw new Error(name + ' must be ' + length + ' bytes of hex, got ' + JSON.stringify(value))
  }
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * The amount as the contract holds it.
 *
 * `BigInt(row.evmAmount)` and NOT `BigInt(Number(...))`: the column is TEXT
 * precisely because an ERC20 amount is 256-bit, and routing it through a float
 * would round the figure the swap key is derived from — producing a lock that
 * cannot be found rather than a payout that is merely slightly wrong.
 */
const amountOf = (raw: string, name: string): bigint => {
  if (!/^[0-9]+$/.test(raw)) throw new Error(name + ' must be a decimal integer, got ' + JSON.stringify(raw))
  return BigInt(raw)
}

/**
 * The lock the SOLVER created, for `arkade:BTC->ethereum:<token>`.
 *
 * The solver claims nothing here — the CLIENT does, with the preimage — so
 * `claimAddress` is the client's and `refundAddress` is the solver's own.
 */
export const sendLockFromRow = (row: EvmSendSwapRow): Erc20SwapLock => ({
  preimageHash: bytesFromHex(row.paymentHash, 'paymentHash', 32),
  amount: amountOf(row.evmAmount, 'evmAmount'),
  tokenAddress: bytesFromHex(row.tokenAddress, 'tokenAddress', 20),
  claimAddress: bytesFromHex(row.evmClaimAddress, 'evmClaimAddress', 20),
  refundAddress: bytesFromHex(row.evmRefundAddress, 'evmRefundAddress', 20),
  timelock: BigInt(row.evmTimeout),
})

/**
 * The lock the CLIENT created, for `ethereum:<token>->arkade:BTC`.
 *
 * Mirrored: the SOLVER claims this one, so `claimAddress` is the solver's and
 * `refundAddress` is the client's. Getting these two the wrong way round yields
 * a lock the solver cannot claim and the client can refund immediately — which
 * is why they are two named functions rather than one with a direction flag.
 */
export const receiveLockFromRow = (row: EvmReceiveSwapRow): Erc20SwapLock => ({
  preimageHash: bytesFromHex(row.paymentHash, 'paymentHash', 32),
  amount: amountOf(row.evmAmount, 'evmAmount'),
  tokenAddress: bytesFromHex(row.tokenAddress, 'tokenAddress', 20),
  claimAddress: bytesFromHex(row.evmClaimAddress, 'evmClaimAddress', 20),
  refundAddress: bytesFromHex(row.evmRefundAddress, 'evmRefundAddress', 20),
  timelock: BigInt(row.evmTimeout),
})
