/**
 * How many of an ERC20 the solver holds.
 *
 * Needed because a corridor paying out in tokens cannot answer "can I honour my
 * advertised maximum" from the sats balances the other rails report. It is a
 * different unit, and this module deliberately does NOT try to reconcile them —
 * see the note at the bottom.
 *
 * The selector is derived rather than written down, for the reason
 * `erc20Swap.ts` gives for the same choice: a hardcoded `0x70a08231` is a fact
 * about a hash that nothing in the build would catch if it were wrong, and the
 * derivation costs one keccak at module load.
 */

import { keccak_256 } from '@noble/hashes/sha3.js'

const selectorFor = (signature: string): Uint8Array => keccak_256(new TextEncoder().encode(signature)).subarray(0, 4)

export const BALANCE_OF_SIGNATURE = 'balanceOf(address)'
const BALANCE_OF_SELECTOR = selectorFor(BALANCE_OF_SIGNATURE)

const WORD = 32

/** An address as a left-padded 32-byte word, which is how `abi.encode` carries one. */
const addressWord = (address: Uint8Array): Uint8Array => {
  if (address.length !== 20) throw new Error('address must be 20 bytes, got ' + address.length)
  const word = new Uint8Array(WORD)
  word.set(address, WORD - address.length)
  return word
}

export const encodeBalanceOf = (owner: Uint8Array): Uint8Array => {
  const out = new Uint8Array(BALANCE_OF_SELECTOR.length + WORD)
  out.set(BALANCE_OF_SELECTOR, 0)
  out.set(addressWord(owner), BALANCE_OF_SELECTOR.length)
  return out
}

const hexOf = (bytes: Uint8Array): string => '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/**
 * The owner's balance of one token, in the token's own base units.
 *
 * A BIGINT, never a number: an ERC20 balance is 256-bit and an 18-decimal token
 * holds values past 2^53 at entirely ordinary amounts, so reading one into a
 * float would round the figure an operator is about to make a decision on.
 */
export const erc20BalanceOf = async (
  rpc: (method: string, params: readonly unknown[]) => Promise<unknown>,
  token: Uint8Array,
  owner: Uint8Array,
): Promise<bigint> => {
  const result = await rpc('eth_call', [{ to: hexOf(token), data: hexOf(encodeBalanceOf(owner)) }, 'latest'])
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result)) {
    throw new Error('balanceOf: expected a hex word, got ' + JSON.stringify(result))
  }
  const body = result.slice(2)
  // A conforming token returns exactly one word. Anything else is a contract
  // that is not an ERC20 at this address, and reading the first 32 bytes of it
  // anyway would report a confident number derived from something else entirely.
  if (body.length !== WORD * 2) {
    throw new Error('balanceOf: expected one 32-byte word, got ' + body.length / 2 + ' bytes')
  }
  return BigInt(result)
}

/**
 * DELIBERATELY NOT CONVERTED TO SATS.
 *
 * The other payout rails report a sats balance, and the diagnostics page compares
 * it against a corridor's advertised `maxSats` to answer "can I honour this".
 * That question is not answerable for a token rail without a PRICE, and this
 * service has no oracle: the rate lives in whatever quoted the swap.
 *
 * So a caller wiring this into that page has a decision to make rather than a
 * conversion to perform — report the token figure in its own units and leave
 * "can honour max" UNKNOWN, or introduce a price source. Reporting a fabricated
 * sats number would be the one option that looks like an answer and is not,
 * which is why this module stops here.
 */
