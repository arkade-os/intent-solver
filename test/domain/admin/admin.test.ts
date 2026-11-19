import { describe, expect, it } from 'vitest'
import { evaluateApproval } from '@arkade-os/solver-core/core/approvalGate.js'
import { Approval } from '@arkade-os/solver-core/domain/admin/approval.js'
import { Setting } from '@arkade-os/solver-core/domain/admin/setting.js'
import { RouteId, SwapId } from '@arkade-os/solver-core/domain/shared/ids.js'
import { btc, t } from '../support.js'

describe('approval', () => {
  it('decides exactly as the gate it replaces', () => {
    for (const threshold of [null, 0n, 1_000n]) {
      for (const amount of [0n, 999n, 1_000n, 5_000n]) {
        for (const approval of ['approved', 'none', 'unreadable'] as const) {
          expect(Approval.decide(btc(amount), threshold === null ? null : btc(threshold), approval)).toEqual(
            evaluateApproval({ amount, threshold, approval }),
          )
        }
      }
    }
  })

  it('starts as a request, and approving again moves the timestamp as it does today', () => {
    const approval = Approval.request(SwapId.of('swap-1'), RouteId.of('arkade:btc->onchain:btc'), btc(5_000n), t(100))
    expect(approval.verdict).toBe('pending')
    approval.approve(t(200))
    approval.approve(t(300))
    expect(approval.snapshot.approvedAt).toBe(300)
    expect(approval.verdict).toBe('approved')
  })
})

describe('setting', () => {
  it('bumps its revision on a change and refuses a stale writer', () => {
    const setting = Setting.initial('MAX_EXPOSED_SATS', '100000')
    const changed = setting.change('200000', 1)
    expect(changed.revision).toBe(2)
    expect(changed.change('200000', 2)).toBe(changed)
    expect(() => changed.change('300000', 1)).toThrow('is at revision 2, not 1')
    expect(changed.change(null, 2).value).toBeNull()
  })
})
