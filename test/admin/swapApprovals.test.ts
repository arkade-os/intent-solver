import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AdminStore } from '@arkade-os/solver-app/admin/db.js'

let now = 1_000_000
const clock = () => now
let store: AdminStore

beforeEach(async () => {
  now = 1_000_000
  store = await AdminStore.open(':memory:', clock)
})

afterEach(async () => {
  await store.close()
})

const request = (id = 'swap-1', assetId: string | null = null, amount = 500_000n) =>
  store.recordApprovalRequest({ swapId: id, corridor: 'arkade:BTC->lightning:BTC', assetId, amount })

describe('swap approvals', () => {
  it('an unknown swap is not approved', async () => {
    expect(await store.isSwapApproved('never-seen')).toBe(false)
  })

  it('a recorded request is pending, not approved', async () => {
    await request()
    expect(await store.isSwapApproved('swap-1')).toBe(false)
    expect(await store.listPendingApprovals()).toMatchObject([
      {
        swapId: 'swap-1',
        corridor: 'arkade:BTC->lightning:BTC',
        assetId: null,
        amount: 500_000n,
        requestedAt: 1_000_000,
      },
    ])
  })

  it('round-trips an asset quantity a double would have rounded', async () => {
    const assetId = 'a'.repeat(68)
    const amount = 2n ** 70n + 1n
    await request('swap-asset', assetId, amount)
    expect(await store.listPendingApprovals()).toMatchObject([{ swapId: 'swap-asset', assetId, amount }])
  })

  it('approving flips the answer and clears it from pending', async () => {
    await request()
    now = 1_000_500
    expect(await store.approveSwap('swap-1')).toBe(true)
    expect(await store.isSwapApproved('swap-1')).toBe(true)
    expect(await store.listPendingApprovals()).toEqual([])
  })

  // The gate re-asks on every tick; the request must not re-notify or lose its age.
  it('re-recording a request is idempotent and keeps the ORIGINAL timestamp', async () => {
    expect(await request()).toBe(true)
    now = 1_009_999
    expect(await request()).toBe(false)
    expect(await store.listPendingApprovals()).toMatchObject([{ requestedAt: 1_000_000 }])
  })

  it('re-recording after approval does NOT reopen the approval', async () => {
    await request()
    await store.approveSwap('swap-1')
    expect(await request()).toBe(false)
    expect(await store.isSwapApproved('swap-1')).toBe(true)
  })

  // Approving a swap nobody asked about would let an operator pre-authorise an
  // id, which is the one way this table could be used to bypass the gate.
  it('refuses to approve a swap that never requested one', async () => {
    expect(await store.approveSwap('swap-never')).toBe(false)
    expect(await store.isSwapApproved('swap-never')).toBe(false)
  })

  it('keeps approvals per swap id', async () => {
    await request('a')
    await request('b')
    await store.approveSwap('a')
    expect(await store.isSwapApproved('a')).toBe(true)
    expect(await store.isSwapApproved('b')).toBe(false)
  })
})
