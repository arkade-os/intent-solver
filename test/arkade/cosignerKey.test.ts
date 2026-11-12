import { describe, it, expect, vi } from 'vitest'
import { REGTEST_EMULATOR_PUBKEY, type ArkadeInfo } from '@arkade-os/sdk'
import { operatorCosignerKey, quoteCosignerKey } from '@arkade-os/solver-arkade/arkade/cosignerKey.js'

const PIN = REGTEST_EMULATOR_PUBKEY
const OPERATOR = `03${'11'.repeat(32)}`
const xOnly = (key: string) => key.slice(-64)

const NOW = 1_800_000_000
const arkd = (deprecated: [string, bigint][]): ArkadeInfo =>
  ({
    network: 'regtest',
    signerPubkey: OPERATOR,
    deprecatedSigners: deprecated.map(([pubkey, cutoffDate]) => ({ pubkey, cutoffDate })),
  }) as unknown as ArkadeInfo

const opsOver = (info: ArkadeInfo) => ({
  emulatorPubkey: PIN,
  cosignerKeyFor: async (requested: string) => operatorCosignerKey(requested, info, NOW),
})

describe('the co-signer key allowlist', () => {
  it('takes the default key, absent or named, without asking arkd', async () => {
    const ops = { emulatorPubkey: PIN, cosignerKeyFor: vi.fn() }
    expect(await quoteCosignerKey(ops, undefined)).toBe(PIN)
    expect(await quoteCosignerKey(ops, xOnly(PIN))).toBe(PIN)
    expect(ops.cosignerKeyFor).not.toHaveBeenCalled()
  })

  it('takes a key arkd signs for: its current signer, or a deprecated one before its cutoff', async () => {
    const OLD = `02${'22'.repeat(32)}`
    expect(await quoteCosignerKey(opsOver(arkd([])), xOnly(OPERATOR))).toBe(OPERATOR)
    expect(await quoteCosignerKey(opsOver(arkd([[OLD, 0n]])), xOnly(OLD))).toBe(OLD)
    expect(await quoteCosignerKey(opsOver(arkd([[OLD, BigInt(NOW + 1)]])), xOnly(OLD))).toBe(OLD)
    expect(await quoteCosignerKey(opsOver(arkd([[OLD, BigInt(NOW)]])), xOnly(OLD))).toBeNull()
  })

  it('refuses any other key, and every non-default key when nothing can vouch for it', async () => {
    expect(await quoteCosignerKey(opsOver(arkd([[PIN, 0n]])), 'cd'.repeat(32))).toBeNull()
    expect(await quoteCosignerKey({ emulatorPubkey: PIN }, xOnly(OPERATOR))).toBeNull()
  })
})
