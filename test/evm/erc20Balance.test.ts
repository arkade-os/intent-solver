/**
 * The balance read, and the two ways it can lie if it is careless.
 */

import { describe, it, expect, vi } from 'vitest'
import { hex } from '@scure/base'
import { BALANCE_OF_SIGNATURE, encodeBalanceOf, erc20BalanceOf } from '@arkade-os/solver-rails-evm/evm/erc20Balance.js'

const TOKEN = Uint8Array.from(Buffer.from('a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'hex'))
const OWNER = Uint8Array.from(Buffer.from('2222222222222222222222222222222222222222', 'hex'))

describe('encodeBalanceOf', () => {
  it('is pinned to the 4byte registry selector', () => {
    // The registry value for balanceOf(address). Written out so a wrong
    // derivation fails here rather than as an eth_call that returns nothing
    // useful against a contract that does not have the function.
    expect(hex.encode(encodeBalanceOf(OWNER).subarray(0, 4))).toBe('70a08231')
    expect(BALANCE_OF_SIGNATURE).toBe('balanceOf(address)')
  })

  it('left-pads the address to a full word, as abi.encode does', () => {
    const data = encodeBalanceOf(OWNER)
    expect(data).toHaveLength(36)
    // 12 zero bytes then the 20 address bytes — not the address followed by
    // padding, which would address a different account entirely.
    expect(hex.encode(data.subarray(4, 16))).toBe('00'.repeat(12))
    expect(hex.encode(data.subarray(16))).toBe(hex.encode(OWNER))
  })

  it('refuses a wrong-length address rather than padding whatever it got', () => {
    expect(() => encodeBalanceOf(OWNER.slice(0, 19))).toThrow(/20 bytes/)
    expect(() => encodeBalanceOf(new Uint8Array(32))).toThrow(/20 bytes/)
  })
})

describe('erc20BalanceOf', () => {
  const word = (value: bigint) => '0x' + value.toString(16).padStart(64, '0')

  it('returns a bigint, so an 18-decimal balance is not rounded', () => {
    // 1234.5 tokens at 18 decimals is far past 2^53. Reading this into a float
    // would round the figure an operator is about to act on.
    const big = 1_234_500_000_000_000_000_000n
    expect(Number.isSafeInteger(Number(big))).toBe(false)
    const rpc = vi.fn().mockResolvedValue(word(big))
    return expect(erc20BalanceOf(rpc, TOKEN, OWNER)).resolves.toBe(big)
  })

  it('calls the TOKEN with the owner in the calldata', async () => {
    const rpc = vi.fn().mockResolvedValue(word(5n))
    await erc20BalanceOf(rpc, TOKEN, OWNER)
    expect(rpc).toHaveBeenCalledWith('eth_call', [
      { to: '0x' + hex.encode(TOKEN), data: '0x' + hex.encode(encodeBalanceOf(OWNER)) },
      'latest',
    ])
  })

  it('refuses a short answer instead of reading a confident number out of it', async () => {
    // A contract that is not an ERC20 at this address. Taking the first word of
    // whatever it returned would report a number derived from something else.
    const rpc = vi.fn().mockResolvedValue('0x2a')
    await expect(erc20BalanceOf(rpc, TOKEN, OWNER)).rejects.toThrow(/one 32-byte word/)
  })

  it('refuses a non-hex answer', async () => {
    await expect(erc20BalanceOf(vi.fn().mockResolvedValue(null), TOKEN, OWNER)).rejects.toThrow(/hex word/)
    await expect(erc20BalanceOf(vi.fn().mockResolvedValue('nope'), TOKEN, OWNER)).rejects.toThrow(/hex word/)
  })

  it('reads a zero balance as zero rather than as an error', async () => {
    const rpc = vi.fn().mockResolvedValue(word(0n))
    await expect(erc20BalanceOf(rpc, TOKEN, OWNER)).resolves.toBe(0n)
  })
})
