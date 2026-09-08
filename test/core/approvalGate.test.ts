import { describe, expect, it } from 'vitest'
import { evaluateApproval, APPROVAL_REFUSAL } from '@arkade-os/solver-core/core/approvalGate.js'

const at = (amountSats: number, thresholdSats: number | null, approval: 'approved' | 'none' | 'unreadable') =>
  evaluateApproval({ amountSats, thresholdSats, approval })

describe('evaluateApproval', () => {
  it('proceeds when no threshold is configured, whatever the amount', () => {
    expect(at(1, null, 'none')).toEqual({ proceed: true })
    expect(at(Number.MAX_SAFE_INTEGER, null, 'none')).toEqual({ proceed: true })
  })

  it('proceeds under the threshold without consulting approval at all', () => {
    expect(at(999, 1_000, 'none')).toEqual({ proceed: true })
  })

  it('HOLDS at exactly the threshold: the boundary amount needs approval', () => {
    expect(at(1_000, 1_000, 'none')).toEqual({ proceed: false, reason: APPROVAL_REFUSAL })
  })

  it('holds above the threshold until an approval exists', () => {
    expect(at(5_000, 1_000, 'none')).toEqual({ proceed: false, reason: APPROVAL_REFUSAL })
  })

  it('proceeds above the threshold once approved', () => {
    expect(at(5_000, 1_000, 'approved')).toEqual({ proceed: true })
  })

  // The whole point of the gate: no answer is never a yes.
  it('FAILS CLOSED when the approval record cannot be read', () => {
    expect(at(5_000, 1_000, 'unreadable')).toEqual({ proceed: false, reason: APPROVAL_REFUSAL })
  })

  it('a zero threshold gates every swap rather than none', () => {
    expect(at(0, 0, 'none')).toEqual({ proceed: false, reason: APPROVAL_REFUSAL })
    expect(at(1, 0, 'approved')).toEqual({ proceed: true })
  })

  it('refuses a negative threshold rather than treating it as off', () => {
    expect(() => at(1, -1, 'none')).toThrow(/negative/i)
  })
})
