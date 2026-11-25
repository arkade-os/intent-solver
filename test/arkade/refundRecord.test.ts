import { describe, expect, it } from 'vitest'
import { MAX_LOCKUP_SPEND_INPUTS, refundRecord } from '@arkade-os/solver-arkade/arkade/wallet.js'

const NOW = 1_800_000_000
const outputs = (count: number, expiresAt?: number) =>
  Array.from({ length: count }, (_, i) => ({ txid: `t${i}`, vout: 0, value: 100, ...(expiresAt ? { expiresAt } : {}) }))

describe('refundRecord', () => {
  it('closes the row when one spend took every output', () => {
    expect(refundRecord(outputs(MAX_LOCKUP_SPEND_INPUTS), 'txid', NOW)).toEqual({
      refund_outcome: 'pushed',
      refund_ark_txid: 'txid',
    })
  })

  it('records only the txid when there were more outputs than one spend takes', () => {
    expect(refundRecord(outputs(MAX_LOCKUP_SPEND_INPUTS + 1), 'txid', NOW)).toEqual({ refund_ark_txid: 'txid' })
  })

  it('records only the txid when an output was too close to expiry to spend', () => {
    const closing = [...outputs(1), { txid: 'late', vout: 0, value: 100, expiresAt: NOW + 60 }]
    expect(refundRecord(closing, 'txid', NOW)).toEqual({ refund_ark_txid: 'txid' })
  })
})
