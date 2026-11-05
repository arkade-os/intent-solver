import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url), 'utf8')
const start = source.indexOf('const runAction = ')
const end = source.indexOf('/** A swap action', start)

const setup = (api: ReturnType<typeof vi.fn>) => {
  const state = {
    running: null,
    detail: null,
    dialog: { error: null },
    result: null,
    banner: null,
    data: {},
    view: 'wallet',
  } as any
  const runAction = new Function(
    'state',
    'api',
    'render',
    'load',
    'openDetail',
    'fail',
    `${source.slice(start, end)}; return runAction`,
  )(state, api, vi.fn(), vi.fn(), vi.fn(), vi.fn())
  return { state, runAction }
}

describe('pool reshape feedback', () => {
  it('keeps the refusal visible inside the confirmation dialog', async () => {
    const { state, runAction } = setup(vi.fn().mockRejectedValue(new Error('9758 sat committed; reshape deferred.')))
    await runAction('pool-mint', { confirm: 'MINT' })
    expect(state.dialog.error).toBe('9758 sat committed; reshape deferred.')
    expect(state.result).toBeNull()
    expect(state.running).toBeNull()
  })

  it('explains a pinned-input no-op after closing the dialog', async () => {
    const { state, runAction } = setup(vi.fn().mockResolvedValue({ result: { skipped: 'inputs-pinned' } }))
    await runAction('pool-mint', { confirm: 'MINT' })
    expect(state.dialog).toBeNull()
    expect(state.result.result).toContain('selected coins are in use')
    expect(state.result.result).not.toContain('reshaped into')
  })

  it('shows the completed shape and transaction when a mint actually succeeds', async () => {
    const { state, runAction } = setup(vi.fn().mockResolvedValue({ result: { minted: [100, 200], txid: 'tx-1' } }))
    await runAction('pool-mint', { confirm: 'MINT' })
    expect(state.result.result).toBe('Pool reshaped into 2 coins. Transaction: tx-1')
  })

  it('does not claim the pool has its requested shape when no transaction was planned', async () => {
    const { state, runAction } = setup(vi.fn().mockResolvedValue({ result: { skipped: 'nothing-to-do' } }))
    await runAction('pool-mint', { confirm: 'MINT' })
    expect(state.result.result).toBe('No pool transaction could be planned. No coins were moved.')
    expect(state.result.result).not.toContain('requested shape')
  })
})
