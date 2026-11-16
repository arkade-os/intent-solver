import { describe, it, expect } from 'vitest'
import { BITCOIN_EMULATOR_PUBKEY, MUTINYNET_EMULATOR_PUBKEY } from '@arkade-os/sdk'
import { covenantCosignerKey } from '@arkade-os/solver-app/ops/cosigner.js'

const otherKey = '03' + '11'.repeat(32)

describe('covenantCosignerKey', () => {
  it('uses the SDK pin whatever the emulator reports', () => {
    expect(covenantCosignerKey('bitcoin', otherKey)).toBe(BITCOIN_EMULATOR_PUBKEY)
    expect(covenantCosignerKey('mutinynet', otherKey)).toBe(MUTINYNET_EMULATOR_PUBKEY)
  })

  it('keeps the report on a network with no pin', () => {
    expect(covenantCosignerKey('signet', otherKey)).toBe(otherKey)
  })
})
