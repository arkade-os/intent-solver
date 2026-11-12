import { describe, it, expect } from 'vitest'
import { BITCOIN_EMULATOR_PUBKEY, MUTINYNET_EMULATOR_PUBKEY } from '@arkade-os/sdk'
import { covenantCosignerKey } from '@arkade-os/solver-app/ops/cosigner.js'

const operatorKey = '03' + '11'.repeat(32)

describe('covenantCosignerKey', () => {
  it('keeps the pin when the emulator reports the operator key', () => {
    expect(covenantCosignerKey('bitcoin', operatorKey)).toBe(BITCOIN_EMULATOR_PUBKEY)
    expect(covenantCosignerKey('mutinynet', operatorKey)).toBe(MUTINYNET_EMULATOR_PUBKEY)
  })

  it('uses the report on a network with no pin', () => {
    expect(covenantCosignerKey('signet', operatorKey)).toBe(operatorKey)
  })
})
