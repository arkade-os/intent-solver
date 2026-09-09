import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { approvalGateFor } from '@arkade-os/solver-app/ops/approvals.js'
import { APPROVAL_REFUSAL } from '@arkade-os/solver-core/core/approvalGate.js'
import type { SwapApprovalRequest } from '@arkade-os/solver-app/admin/db.js'

const fakeStore = (over: Partial<Record<'approved' | 'throws', unknown>> = {}) => {
  const requests: SwapApprovalRequest[] = []
  const seen = new Set<string>()
  return {
    requests,
    isSwapApproved: async (id: string) => {
      if (over.throws) throw new Error('database is locked')
      return over.approved === true && id === 'swap-1'
    },
    recordApprovalRequest: async (request: SwapApprovalRequest) => {
      requests.push(request)
      if (seen.has(request.swapId)) return false
      seen.add(request.swapId)
      return true
    },
  }
}

const gate = (thresholdSats: number | null, store = fakeStore(), held: SwapApprovalRequest[] = []) => ({
  check: approvalGateFor({
    thresholdSats,
    corridor: 'arkade:BTC->lightning:BTC',
    store,
    onHeld: (request) => held.push(request),
  }),
  store,
  held,
})

describe('approvalGateFor', () => {
  it('is UNDEFINED with no threshold, so the corridor is handed no gate at all', () => {
    expect(gate(null).check).toBeUndefined()
  })

  it('proceeds under the threshold WITHOUT touching the store', async () => {
    const { check, store } = gate(100_000)
    expect(await check!({ swapId: 'swap-1', amountSats: 99_999 })).toEqual({ proceed: true })
    expect(store.requests).toEqual([])
  })

  it('holds at or above the threshold and records the request', async () => {
    const { check, store } = gate(100_000)
    expect(await check!({ swapId: 'swap-1', amountSats: 100_000 })).toEqual({
      proceed: false,
      reason: APPROVAL_REFUSAL,
    })
    expect(store.requests).toEqual([{ swapId: 'swap-1', corridor: 'arkade:BTC->lightning:BTC', amountSats: 100_000 }])
  })

  it('proceeds once the store says approved', async () => {
    const { check } = gate(100_000, fakeStore({ approved: true }))
    expect(await check!({ swapId: 'swap-1', amountSats: 500_000 })).toEqual({ proceed: true })
  })

  it('FAILS CLOSED when the store throws, and never rejects', async () => {
    const { check } = gate(100_000, fakeStore({ throws: true }))
    await expect(check!({ swapId: 'swap-1', amountSats: 500_000 })).resolves.toEqual({
      proceed: false,
      reason: APPROVAL_REFUSAL,
    })
  })

  it('notifies ONCE per swap however many ticks ask', async () => {
    const { check, held } = gate(100_000)
    await check!({ swapId: 'swap-1', amountSats: 500_000 })
    await check!({ swapId: 'swap-1', amountSats: 500_000 })
    await check!({ swapId: 'swap-2', amountSats: 500_000 })
    expect(held.map((h) => h.swapId)).toEqual(['swap-1', 'swap-2'])
  })

  // A notifier that throws must not become a tick failure on the money path.
  it('still holds when the notifier throws', async () => {
    const check = approvalGateFor({
      thresholdSats: 100_000,
      corridor: 'arkade:BTC->onchain:BTC',
      store: fakeStore(),
      onHeld: () => {
        throw new Error('telegram is down')
      },
    })
    await expect(check!({ swapId: 'swap-1', amountSats: 500_000 })).resolves.toEqual({
      proceed: false,
      reason: APPROVAL_REFUSAL,
    })
  })

  // Recording is best-effort; failing to record must not fail the swap OPEN.
  it('still holds when the request cannot be recorded', async () => {
    const check = approvalGateFor({
      thresholdSats: 100_000,
      corridor: 'arkade:BTC->onchain:BTC',
      store: {
        isSwapApproved: async () => false,
        recordApprovalRequest: async () => {
          throw new Error('disk full')
        },
      },
    })
    await expect(check!({ swapId: 'swap-1', amountSats: 500_000 })).resolves.toEqual({
      proceed: false,
      reason: APPROVAL_REFUSAL,
    })
  })
})

// A gate the daemon never passes is invisible at run time and silent in review —
// the same failure both asset stores shipped with for `announceOutcomes`. The e2e
// leg builds its own service, so nothing else can see this one go missing.
describe('every send leg is HANDED a gate on the shipped daemon', () => {
  const servicesSource = readFileSync(
    fileURLToPath(new URL('../../packages/solver-app/src/ops/services.ts', import.meta.url)),
    'utf8',
  )

  it.each([['arkade:BTC->lightning:BTC'], ['arkade:BTC->onchain:BTC'], ['arkade:BTC->ethereum']])(
    '%s is gated',
    (corridor) => {
      expect(servicesSource).toContain(`approvalGate: gateFor('${corridor}')`)
    },
  )
})
