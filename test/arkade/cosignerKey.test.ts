import { describe, it, expect, vi } from 'vitest'
import { REGTEST_EMULATOR_PUBKEY, type ArkadeInfo } from '@arkade-os/sdk'
import { operatorCosignerKey, quoteCosignerKey } from '@arkade-os/solver-arkade/arkade/cosignerKey.js'

const PIN = REGTEST_EMULATOR_PUBKEY
const OPERATOR = `03${'11'.repeat(32)}`
const xOnly = (key: string) => key.slice(-64)

const arkd = (deprecated: string[], network = 'regtest'): ArkadeInfo =>
  ({
    network,
    signerPubkey: OPERATOR,
    deprecatedSigners: deprecated.map((pubkey) => ({ pubkey, cutoffDate: 0n })),
  }) as unknown as ArkadeInfo

const opsOver = (info: ArkadeInfo) => ({
  emulatorPubkey: PIN,
  cosignerKeyFor: async (requested: string) => operatorCosignerKey(requested, info),
})

describe('the co-signer key allowlist', () => {
  it('takes the default key, absent or named, without asking arkd', async () => {
    const ops = { emulatorPubkey: PIN, cosignerKeyFor: vi.fn() }
    expect(await quoteCosignerKey(ops, undefined)).toBe(PIN)
    expect(await quoteCosignerKey(ops, xOnly(PIN))).toBe(PIN)
    expect(ops.cosignerKeyFor).not.toHaveBeenCalled()
  })

  it("takes arkd's current signer only while arkd lists the network pin", async () => {
    expect(await quoteCosignerKey(opsOver(arkd([PIN])), xOnly(OPERATOR))).toBe(OPERATOR)
    expect(await quoteCosignerKey(opsOver(arkd([])), xOnly(OPERATOR))).toBeNull()
    expect(await quoteCosignerKey(opsOver(arkd([PIN], 'signet')), xOnly(OPERATOR))).toBeNull()
  })

  it('refuses any other key, and every non-default key when nothing can vouch for it', async () => {
    expect(await quoteCosignerKey(opsOver(arkd([PIN])), 'cd'.repeat(32))).toBeNull()
    expect(await quoteCosignerKey({ emulatorPubkey: PIN }, xOnly(OPERATOR))).toBeNull()
  })
})
