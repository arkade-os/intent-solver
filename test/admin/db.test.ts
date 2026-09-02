import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AdminStore, adminDbPath } from '@arkade-os/solver-app/admin/db.js'

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

describe('adminDbPath', () => {
  it('follows the same suffixing rule as onchainDbPath and receiveDbPath', () => {
    expect(adminDbPath('.data/swaps.sqlite')).toBe('.data/swaps-admin.sqlite')
  })

  it('handles a path with no .sqlite extension, like its siblings', () => {
    expect(adminDbPath('/data/swaps')).toBe('/data/swaps-admin')
  })

  it('never collides with a swap database', () => {
    const swap = '/data/swaps.sqlite'
    expect(adminDbPath(swap)).not.toBe(swap)
    expect(adminDbPath(swap)).not.toBe('/data/swaps-onchain.sqlite')
    expect(adminDbPath(swap)).not.toBe('/data/swaps-receive.sqlite')
  })
})

describe('overrides', () => {
  it('round-trips a value', async () => {
    await store.setOverride('LN_SEND_FEE_BPS', '25')
    expect(await store.getOverrides()).toEqual({ LN_SEND_FEE_BPS: '25' })
  })

  it('starts empty', async () => {
    expect(await store.getOverrides()).toEqual({})
  })

  it('clears an override when set to null, rather than storing the string "null"', async () => {
    await store.setOverride('LN_SEND_FEE_BPS', '25')
    await store.setOverride('LN_SEND_FEE_BPS', null)
    expect(await store.getOverrides()).toEqual({})
  })

  it('overwrites rather than duplicating — the key is the identity', async () => {
    await store.setOverride('LN_SEND_FEE_BPS', '25')
    await store.setOverride('LN_SEND_FEE_BPS', '50')
    expect(await store.getOverrides()).toEqual({ LN_SEND_FEE_BPS: '50' })
  })

  it('keeps unrelated keys independent', async () => {
    await store.setOverride('LN_SEND_FEE_BPS', '25')
    await store.setOverride('ONCHAIN_SEND_MAX_SATS', '50000')
    await store.setOverride('LN_SEND_FEE_BPS', null)
    expect(await store.getOverrides()).toEqual({ ONCHAIN_SEND_MAX_SATS: '50000' })
  })
})

describe('the action audit log', () => {
  it('records an action and reads it back newest-first', async () => {
    await store.recordAction({ action: 'refund-now', target: 'swap-1', params: '{}', outcome: 'ok', detail: 'txid-a' })
    now += 5
    await store.recordAction({ action: 'pool-mint', target: null, params: '{}', outcome: 'error', detail: 'boom' })
    const rows = await store.listActions()
    expect(rows.map((r) => r.action)).toEqual(['pool-mint', 'refund-now'])
    expect(rows[0]).toMatchObject({ outcome: 'error', detail: 'boom', at: 1_000_005, target: null })
  })

  it('records a FAILED action too — that is the one an operator needs the record of', async () => {
    await store.recordAction({
      action: 'onchain-refund-now',
      target: 'swap-9',
      params: '{"id":"swap-9"}',
      outcome: 'error',
      detail: 'emulator refused to co-sign',
    })
    const [row] = await store.listActions()
    expect(row).toMatchObject({ outcome: 'error', detail: 'emulator refused to co-sign' })
  })

  it('orders deterministically when two actions share a timestamp', async () => {
    await store.recordAction({ action: 'first', target: null, params: '{}', outcome: 'ok', detail: null })
    await store.recordAction({ action: 'second', target: null, params: '{}', outcome: 'ok', detail: null })
    expect((await store.listActions()).map((r) => r.action)).toEqual(['second', 'first'])
  })

  it('honours a limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.recordAction({ action: `a${i}`, target: null, params: '{}', outcome: 'ok', detail: null })
      now += 1
    }
    expect(await store.listActions(2)).toHaveLength(2)
  })
})
