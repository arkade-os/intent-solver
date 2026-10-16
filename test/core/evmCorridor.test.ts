/**
 * The corridor family that cannot be a compile-time union.
 *
 * A deployment serves whatever ERC20s it is configured for, and `tokenAddress`
 * is per-swap in the `ERC20Swap` binding rather than per-chain, so the set is
 * not known until runtime. These guard the two properties that keeps: the
 * spelling is canonical, and the two families stay distinguishable so no caller
 * has to split a pair string to tell them apart.
 */

import { describe, it, expect } from 'vitest'
import { CORRIDORS, evmCorridorFor, evmTokenOf, isCorridor } from '@arkade-os/solver-core/core/corridorPolicy.js'

const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

describe('EVM corridors', () => {
  it('builds both directions for a token', () => {
    expect(evmCorridorFor(TOKEN, 'send')).toBe(`arkade:BTC->ethereum:${TOKEN}`)
    expect(evmCorridorFor(TOKEN, 'receive')).toBe(`ethereum:${TOKEN}->arkade:BTC`)
  })

  it('refuses a token that is not canonically spelled', () => {
    // Lowercase only, for the reason `marketKey.ts` gives for asset ids: a pair
    // is compared byte for byte elsewhere, so a spelling normalised in one layer
    // and not another derives the right key and is then refused as unserved.
    // `0x` KEPT, hex uppercased. `TOKEN.toUpperCase()` would uppercase the
    // prefix too and fail on `^0x` instead — passing for a reason that has
    // nothing to do with the case rule this asserts.
    const upperHex = `0x${TOKEN.slice(2).toUpperCase()}`
    expect(() => evmCorridorFor(upperHex, 'send')).toThrow(/LOWERCASE/)
    expect(() => evmCorridorFor(TOKEN.toUpperCase(), 'send')).toThrow(/0x/)
    expect(() => evmCorridorFor('0xabc', 'send')).toThrow(/40/)
    expect(() => evmCorridorFor(TOKEN.slice(2), 'send')).toThrow(/0x/)
  })

  it('reads the token back out of either direction', () => {
    expect(evmTokenOf(evmCorridorFor(TOKEN, 'send'))).toBe(TOKEN)
    expect(evmTokenOf(evmCorridorFor(TOKEN, 'receive'))).toBe(TOKEN)
  })

  it('keeps the two families disjoint', () => {
    // The property every `Record<Corridor, …>` depends on: a fixed corridor is
    // never mistaken for an EVM one, so those maps stay exhaustive and adding a
    // fifth FIXED corridor still fails to compile.
    for (const corridor of CORRIDORS) {
      expect(isCorridor(corridor)).toBe(true)
      expect(evmTokenOf(corridor)).toBeNull()
    }
    const evm = evmCorridorFor(TOKEN, 'send')
    expect(evmTokenOf(evm)).toBe(TOKEN)
    expect(isCorridor(evm)).toBe(false)
  })

  it('does not accept a malformed EVM corridor as one', () => {
    expect(evmTokenOf('arkade:BTC->ethereum:0xNOTHEX')).toBeNull()
    expect(evmTokenOf('arkade:BTC->ethereum:')).toBeNull()
    expect(evmTokenOf(`ethereum:${TOKEN}->lightning:BTC`)).toBeNull()
    expect(evmTokenOf(`arkade:BTC->ethereum:${TOKEN.toUpperCase()}`)).toBeNull()
  })
})
