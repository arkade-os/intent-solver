import { describe, it, expect } from 'vitest'
import { hex } from '@scure/base'
import { addressFromHex, loadEvmChainConfig } from '@arkade-os/solver-rails-evm/evm/config.js'

const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678'

const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  EVM_RPC_URL: 'https://rpc.example',
  EVM_HTLC_ADDRESS: ADDRESS,
  EVM_CHAIN_ID: '8453',
  EVM_FASTEST_SECONDS_PER_BLOCK: '1.5',
  EVM_SLOWEST_SECONDS_PER_BLOCK: '4',
  EVM_MIN_CONFIRMATIONS: '12',
  EVM_MIN_AGE_SECONDS: '780',
  EVM_PRIVATE_KEY: '0x' + '11'.repeat(32),
  EVM_GAS_LIMIT: '300000',
  EVM_MAX_FEE_PER_GAS_CEILING: '500000000000',
  EVM_FEE_HEADROOM_SECONDS: '3600',
  ...over,
})

describe('loadEvmChainConfig', () => {
  it('reads a fully configured chain', () => {
    const config = loadEvmChainConfig(env())
    expect(config).not.toBeNull()
    expect(hex.encode(config!.contractAddress)).toBe(ADDRESS.slice(2))
    expect(config!.chainId).toBe(8453)
    expect(config!.cadence).toEqual({ fastestSecondsPerBlock: 1.5, slowestSecondsPerBlock: 4 })
    expect(config!.minConfirmations).toBe(12)
    expect(config!.minAgeSeconds).toBe(780)
  })

  it('treats a missing RPC url as "corridor not enabled", not an error', () => {
    expect(loadEvmChainConfig(env({ EVM_RPC_URL: undefined }))).toBeNull()
    expect(loadEvmChainConfig(env({ EVM_RPC_URL: '   ' }))).toBeNull()
  })

  it('refuses a half-configured chain rather than starting on defaults', () => {
    // Every missing value here is a safety knob. Defaulting one would be a
    // guess about a chain this service has never seen.
    for (const name of [
      'EVM_HTLC_ADDRESS',
      'EVM_CHAIN_ID',
      'EVM_FASTEST_SECONDS_PER_BLOCK',
      'EVM_SLOWEST_SECONDS_PER_BLOCK',
      'EVM_MIN_CONFIRMATIONS',
      'EVM_MIN_AGE_SECONDS',
    ]) {
      expect(() => loadEvmChainConfig(env({ [name]: undefined }))).toThrow(new RegExp(`${name} is not set`))
    }
  })

  it('treats a set-but-empty value as unset rather than as zero', () => {
    // `Number('')` is 0, which would silently become "no confirmations
    // required" while the logs claimed a configured value.
    expect(() => loadEvmChainConfig(env({ EVM_MIN_CONFIRMATIONS: '' }))).toThrow(/is not set/)
    expect(() => loadEvmChainConfig(env({ EVM_MIN_AGE_SECONDS: '  ' }))).toThrow(/is not set/)
  })

  /**
   * The check that has nowhere else to happen.
   *
   * Swapped cadence bounds do not throw downstream: both conversions keep
   * working and silently return the unsafe answer on every swap. Startup is
   * the only place it is catchable.
   */
  it('refuses swapped cadence bounds at startup', () => {
    expect(() =>
      loadEvmChainConfig(env({ EVM_FASTEST_SECONDS_PER_BLOCK: '4', EVM_SLOWEST_SECONDS_PER_BLOCK: '1.5' })),
    ).toThrow(/must be <=/)
  })

  it('accepts a sub-second cadence, which whole numbers would have excluded', () => {
    // Arbitrum-ish. Rounding this to an integer is how a fast chain silently
    // gets a conversion built for a slow one.
    const config = loadEvmChainConfig(env({ EVM_FASTEST_SECONDS_PER_BLOCK: '0.25' }))
    expect(config!.cadence.fastestSecondsPerBlock).toBe(0.25)
  })

  it('refuses nonsense numbers', () => {
    expect(() => loadEvmChainConfig(env({ EVM_CHAIN_ID: '0' }))).toThrow(/must be an integer >= 1/)
    expect(() => loadEvmChainConfig(env({ EVM_CHAIN_ID: '1.5' }))).toThrow(/must be an integer/)
    expect(() => loadEvmChainConfig(env({ EVM_MIN_CONFIRMATIONS: '0' }))).toThrow(/must be an integer >= 1/)
    expect(() => loadEvmChainConfig(env({ EVM_FASTEST_SECONDS_PER_BLOCK: 'fast' }))).toThrow(/finite number/)
    expect(() => loadEvmChainConfig(env({ EVM_MIN_AGE_SECONDS: '-1' }))).toThrow(/finite number/)
  })

  it('refuses a zero age, which would be depth-only in disguise', () => {
    // The field being REQUIRED is not enough. `EVM_MIN_AGE_SECONDS=0` passes a
    // presence check and then satisfies the age test on every block, collapsing
    // acceptance back to depth alone — the exact policy the second knob exists
    // to prevent. An operator wanting a short age must say a short one.
    expect(() => loadEvmChainConfig(env({ EVM_MIN_AGE_SECONDS: '0' }))).toThrow(/finite number/)
    // A short-but-real age is still allowed, including sub-second.
    expect(loadEvmChainConfig(env({ EVM_MIN_AGE_SECONDS: '0.5' }))!.minAgeSeconds).toBe(0.5)
  })

  it('requires an age as well as a depth, because depth is not finality', () => {
    // Both halves are mandatory. A depth-only policy reads conservative and is
    // not: 12 confirmations on a 250ms chain is three seconds of protection,
    // while the L1 posting it actually depends on takes minutes.
    expect(() => loadEvmChainConfig(env({ EVM_MIN_AGE_SECONDS: undefined }))).toThrow(/EVM_MIN_AGE_SECONDS is not set/)
  })
})

describe('addressFromHex', () => {
  it('decodes a 20-byte address in either case', () => {
    expect(hex.encode(addressFromHex(ADDRESS, 'x'))).toBe(ADDRESS.slice(2))
    expect(hex.encode(addressFromHex(ADDRESS.toUpperCase().replace('0X', '0x'), 'x'))).toBe(ADDRESS.slice(2))
  })

  it('refuses anything that is not one', () => {
    for (const bad of ['', '0x', ADDRESS.slice(0, -2), `${ADDRESS}00`, ADDRESS.slice(2), '0xzz']) {
      expect(() => addressFromHex(bad, 'EVM_HTLC_ADDRESS')).toThrow(/must be a 0x-prefixed 20-byte address/)
    }
  })
})

describe('loadEvmChainConfig — signing and fees', () => {
  it('requires a key, because a solver that cannot sign cannot serve', () => {
    // No default. A generated-on-startup key would sign from an account holding
    // nothing, so every call fails for want of gas — and it reads as a chain
    // problem rather than a missing setting.
    expect(() => loadEvmChainConfig(env({ EVM_PRIVATE_KEY: undefined }))).toThrow(/EVM_PRIVATE_KEY/)
  })

  it('refuses a key that is not 32 bytes rather than padding it', () => {
    expect(() => loadEvmChainConfig(env({ EVM_PRIVATE_KEY: '0xabcd' }))).toThrow(/32 bytes/)
    expect(() => loadEvmChainConfig(env({ EVM_PRIVATE_KEY: '11'.repeat(31) }))).toThrow(/32 bytes/)
    expect(() => loadEvmChainConfig(env({ EVM_PRIVATE_KEY: 'zz'.repeat(32) }))).toThrow(/32 bytes/)
  })

  it('accepts a key with or without the 0x', () => {
    const withPrefix = loadEvmChainConfig(env({ EVM_PRIVATE_KEY: '0x' + '22'.repeat(32) }))
    const without = loadEvmChainConfig(env({ EVM_PRIVATE_KEY: '22'.repeat(32) }))
    expect(withPrefix?.privateKey).toEqual(without?.privateKey)
  })

  it('reads gas, the fee ceiling and the headroom', () => {
    const config = loadEvmChainConfig(env())
    expect(config?.gasLimit).toBe(300_000n)
    expect(config?.maxFeeCeilingPerGas).toBe(500n * 10n ** 9n)
    expect(config?.headroomSeconds).toBe(3600)
  })

  it('requires each of them, like every other knob here', () => {
    // No defaults even where an obvious one exists, matching the call
    // `EVM_MIN_CONFIRMATIONS` already makes: opting into a chain is the opt-in,
    // and the numbers bounding what a transaction may cost are the operator's to
    // state rather than this module's to guess.
    for (const name of ['EVM_GAS_LIMIT', 'EVM_MAX_FEE_PER_GAS_CEILING', 'EVM_FEE_HEADROOM_SECONDS']) {
      expect(() => loadEvmChainConfig(env({ [name]: undefined }))).toThrow(new RegExp(name))
    }
  })

  it('refuses a zero gas limit or fee ceiling, which are meaningless', () => {
    // Zero gas cannot execute anything; a zero ceiling refuses every price. Both
    // would fail per-swap rather than at startup.
    expect(() => loadEvmChainConfig(env({ EVM_GAS_LIMIT: '0' }))).toThrow(/positive/)
    expect(() => loadEvmChainConfig(env({ EVM_MAX_FEE_PER_GAS_CEILING: '0' }))).toThrow(/positive/)
    expect(() => loadEvmChainConfig(env({ EVM_GAS_LIMIT: 'lots' }))).toThrow(/decimal integer/)
  })
})
