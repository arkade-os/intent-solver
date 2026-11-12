import { describe, it, expect } from 'vitest'
import { hex } from '@scure/base'
import { BITCOIN_EMULATOR_PUBKEY } from '@arkade-os/sdk'
import { covenantCosignerKey } from '@arkade-os/solver-app/ops/cosigner.js'

const operatorKey = hex.decode('11'.repeat(32))
const operatorReport = '03' + '11'.repeat(32)
const privateEmulator = '02' + '22'.repeat(32)

describe('covenantCosignerKey', () => {
  it("keeps the pin when the emulator reports arkd's own signer key", () => {
    expect(covenantCosignerKey('bitcoin', operatorReport, operatorKey)).toBe(BITCOIN_EMULATOR_PUBKEY)
  })

  it("keeps any other report, so a private emulator's rows still derive", () => {
    expect(covenantCosignerKey('bitcoin', privateEmulator, operatorKey)).toBe(privateEmulator)
    expect(covenantCosignerKey('bitcoin', BITCOIN_EMULATOR_PUBKEY, operatorKey)).toBe(BITCOIN_EMULATOR_PUBKEY)
  })

  it('keeps the report on a network with no pin', () => {
    expect(covenantCosignerKey('signet', operatorReport, operatorKey)).toBe(operatorReport)
  })
})
