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

const sats = (swapId: string, amount: number) => ({ swapId, assetId: null, amount: BigInt(amount) })
const units = (swapId: string, assetId: string, amount: bigint) => ({ swapId, assetId, amount })

const gate = (
  thresholdSats: number | null,
  store = fakeStore(),
  held: SwapApprovalRequest[] = [],
  assetThresholds?: ReadonlyMap<string, bigint>,
) => ({
  check: approvalGateFor({
    thresholdSats,
    assetThresholds,
    corridor: 'arkade:BTC->lightning:BTC',
    store,
    onHeld: (request) => held.push(request),
  }),
  store,
  held,
})

const USDA = 'a'.repeat(68)
const OTHER = 'b'.repeat(68)

describe('approvalGateFor', () => {
  it('is UNDEFINED with no threshold, so the corridor is handed no gate at all', () => {
    expect(gate(null).check).toBeUndefined()
    expect(gate(null, fakeStore(), [], new Map()).check).toBeUndefined()
  })

  it('is built from an ASSET threshold alone, with no sats threshold at all', async () => {
    const { check, store } = gate(null, fakeStore(), [], new Map([[USDA, 1_000n]]))
    expect(check).toBeDefined()
    expect(await check!(units('swap-1', USDA, 1_000n))).toEqual({ proceed: false, reason: APPROVAL_REFUSAL })
    expect(store.requests).toEqual([
      { swapId: 'swap-1', corridor: 'arkade:BTC->lightning:BTC', assetId: USDA, amount: 1_000n },
    ])
  })

  it('holds at an asset threshold a double could not represent', async () => {
    const big = 2n ** 70n
    const { check } = gate(null, fakeStore(), [], new Map([[USDA, big]]))
    expect(await check!(units('swap-1', USDA, big - 1n))).toEqual({ proceed: true })
    expect(await check!(units('swap-1', USDA, big))).toEqual({ proceed: false, reason: APPROVAL_REFUSAL })
  })

  it('proceeds for an asset with no threshold of its own, leaving no row', async () => {
    const { check, store } = gate(null, fakeStore(), [], new Map([[USDA, 1n]]))
    expect(await check!(units('swap-1', OTHER, 10n ** 30n))).toEqual({ proceed: true })
    expect(store.requests).toEqual([])
  })

  describe('an asset with no threshold is announced, not silently waved through', () => {
    const withHook = (assetThresholds: ReadonlyMap<string, bigint>) => {
      const seen: string[] = []
      return {
        seen,
        check: approvalGateFor({
          thresholdSats: null,
          assetThresholds,
          corridor: 'arkade offer fill',
          store: fakeStore(),
          onUngatedAsset: (assetId) => seen.push(assetId),
        }),
      }
    }

    it('names the id ONCE, however many swaps pay it', async () => {
      const { seen, check } = withHook(new Map([[USDA, 1n]]))
      await check!(units('swap-1', OTHER, 5n))
      await check!(units('swap-2', OTHER, 9n))
      expect(seen).toEqual([OTHER])
    })

    it('says nothing about a configured asset, or about the BTC leg', async () => {
      const { seen, check } = withHook(new Map([[USDA, 1n]]))
      await check!(units('swap-1', USDA, 5n))
      await check!(sats('swap-2', 5))
      expect(seen).toEqual([])
    })
  })

  // Two units, two thresholds: neither may answer for the other.
  it('does not let an asset amount trip the SATS threshold, or the reverse', async () => {
    const { check } = gate(100_000, fakeStore(), [], new Map([[USDA, 10n ** 12n]]))
    expect(await check!(units('swap-1', USDA, 200_000n))).toEqual({ proceed: true })
    expect(await check!(sats('swap-1', 200_000))).toEqual({ proceed: false, reason: APPROVAL_REFUSAL })
  })

  it('proceeds under the threshold WITHOUT touching the store', async () => {
    const { check, store } = gate(100_000)
    expect(await check!(sats('swap-1', 99_999))).toEqual({ proceed: true })
    expect(store.requests).toEqual([])
  })

  it('holds at or above the threshold and records the request', async () => {
    const { check, store } = gate(100_000)
    expect(await check!(sats('swap-1', 100_000))).toEqual({
      proceed: false,
      reason: APPROVAL_REFUSAL,
    })
    expect(store.requests).toEqual([
      { swapId: 'swap-1', corridor: 'arkade:BTC->lightning:BTC', assetId: null, amount: 100_000n },
    ])
  })

  it('proceeds once the store says approved', async () => {
    const { check } = gate(100_000, fakeStore({ approved: true }))
    expect(await check!(sats('swap-1', 500_000))).toEqual({ proceed: true })
  })

  it('FAILS CLOSED when the store throws, and never rejects', async () => {
    const { check } = gate(100_000, fakeStore({ throws: true }))
    await expect(check!(sats('swap-1', 500_000))).resolves.toEqual({
      proceed: false,
      reason: APPROVAL_REFUSAL,
    })
  })

  it('notifies ONCE per swap however many ticks ask', async () => {
    const { check, held } = gate(100_000)
    await check!(sats('swap-1', 500_000))
    await check!(sats('swap-1', 500_000))
    await check!(sats('swap-2', 500_000))
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
    await expect(check!(sats('swap-1', 500_000))).resolves.toEqual({
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
    await expect(check!(sats('swap-1', 500_000))).resolves.toEqual({
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

  it.each([
    ['arkade:BTC->lightning:BTC'],
    ['arkade:BTC->onchain:BTC'],
    ['arkade:BTC->ethereum'],
    ['arkade offer fill'],
    ['arkade asset RFQ'],
  ])('%s is gated', (corridor) => {
    expect(servicesSource).toContain(`approvalGate: gateFor('${corridor}')`)
  })

  it('keeps the derivation for the asset receive leg next to the factory', () => {
    const approvalsSource = readFileSync(
      fileURLToPath(new URL('../../packages/solver-app/src/ops/approvals.ts', import.meta.url)),
      'utf8',
    )
    expect(approvalsSource).toContain('onchain:BTC->arkade:<asset>')
  })
})
